/**
 * 只读 ZIP 容器解析器（基于 `fflate` DEFLATE 解压与 `node:zlib` CRC32 校验）。
 *
 * docx / xlsx / pptx / odt / ods / odp / epub 都是 ZIP 容器，Agent 只需按需读取其中
 * 少数 XML / XHTML 或媒体条目。`open()` 仅解析中央目录（含 ZIP64 扩展记录与扩展字段），
 * 不预解压整包；单条目与累计解压体积在真正解压前与流式解压过程中双重受限，防止 ZIP 炸弹。
 */

import { Inflate, strFromU8 } from 'fflate'
import { crc32 } from 'zlib'

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_EXTRA_ID = 0x0001

const EOCD_MIN_BYTES = 22
const ZIP64_LOCATOR_BYTES = 20
const ZIP64_EOCD_MIN_BYTES = 56
/** ZIP 注释上限，决定从文件尾部往前搜多远 */
const EOCD_MAX_SEARCH = 0xffff
/** 单个条目的解压上限：超出按损坏处理，避免 zip 炸弹吃满内存 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
/** 单个文档所有条目的累计解压上限：防止多条目 ZIP 炸弹累积耗尽内存 */
const MAX_TOTAL_DECOMPRESSED_BYTES = 128 * 1024 * 1024
/**
 * 流式送入 fflate Inflate 的分片大小（4 KiB）。
 * DEFLATE 理论最高压缩比约 1032:1，按 4 KiB 分片可保证即使伪造未压缩体积的炸弹，
 * 单次回调最多仅展开约 4 MiB 就会触发上限中止，不会出现无界分配。
 */
const INFLATE_CHUNK_BYTES = 4096

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

interface ZipEntryRecord {
  name: string
  flags: number
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

function readUInt64LEAsSafeNumber(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 8 > buffer.length) {
    throw new ZipError('ZIP64 字段被截断')
  }
  const low = buffer.readUInt32LE(offset)
  const high = buffer.readUInt32LE(offset + 4)
  if (high > 0x1fffff) {
    throw new ZipError('ZIP64 数值超出安全范围')
  }
  return high * 0x100000000 + low
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - EOCD_MAX_SEARCH - EOCD_MIN_BYTES)
  for (let offset = buffer.length - EOCD_MIN_BYTES; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    // EOCD 注释必须恰好抵到文件尾，避免注释或条目体内恰好出现 0x06054b50 导致误命中
    if (offset + EOCD_MIN_BYTES + commentLength !== buffer.length) continue
    const directorySize = buffer.readUInt32LE(offset + 12)
    const directoryOffset = buffer.readUInt32LE(offset + 16)
    const isZip64Sentinel = directorySize === 0xffffffff || directoryOffset === 0xffffffff
    if (!isZip64Sentinel && directoryOffset + directorySize > offset) continue
    return offset
  }
  return -1
}

function resolveZip64EntryFields(
  buffer: Buffer,
  extraStart: number,
  extraEnd: number,
  uncompressedSize: number,
  compressedSize: number,
  localOffset: number
): { uncompressedSize: number; compressedSize: number; localOffset: number } {
  const needUncompressed = uncompressedSize === 0xffffffff
  const needCompressed = compressedSize === 0xffffffff
  const needOffset = localOffset === 0xffffffff
  if (!needUncompressed && !needCompressed && !needOffset) {
    return { uncompressedSize, compressedSize, localOffset }
  }

  let cursor = extraStart
  while (cursor + 4 <= extraEnd) {
    const headerId = buffer.readUInt16LE(cursor)
    const dataSize = buffer.readUInt16LE(cursor + 2)
    const fieldStart = cursor + 4
    const fieldEnd = fieldStart + dataSize
    if (fieldEnd > extraEnd) {
      throw new ZipError('ZIP64 扩展字段被截断')
    }
    if (headerId === ZIP64_EXTRA_ID) {
      let pos = fieldStart
      let nextUncompressed = uncompressedSize
      let nextCompressed = compressedSize
      let nextOffset = localOffset
      if (needUncompressed) {
        if (pos + 8 > fieldEnd) throw new ZipError('ZIP64 扩展字段缺少未压缩大小')
        nextUncompressed = readUInt64LEAsSafeNumber(buffer, pos)
        pos += 8
      }
      if (needCompressed) {
        if (pos + 8 > fieldEnd) throw new ZipError('ZIP64 扩展字段缺少压缩大小')
        nextCompressed = readUInt64LEAsSafeNumber(buffer, pos)
        pos += 8
      }
      if (needOffset) {
        if (pos + 8 > fieldEnd) throw new ZipError('ZIP64 扩展字段缺少本地头偏移')
        nextOffset = readUInt64LEAsSafeNumber(buffer, pos)
      }
      return {
        uncompressedSize: nextUncompressed,
        compressedSize: nextCompressed,
        localOffset: nextOffset,
      }
    }
    cursor = fieldEnd
  }

  throw new ZipError('ZIP64 扩展字段缺失，无法读取条目元信息')
}

function inflateBounded(raw: Uint8Array, maxAllowed: number, name: string): Buffer {
  if (raw.length === 0) {
    throw new ZipError(`${name} 解压失败：DEFLATE 数据为空`)
  }
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  const inflater = new Inflate((chunk) => {
    if (chunk.length === 0) return
    totalBytes += chunk.length
    if (totalBytes > maxAllowed) {
      throw new ZipError(`${name} 解压后超过大小上限，已跳过`)
    }
    chunks.push(chunk)
  })

  try {
    for (let pos = 0; pos < raw.length; pos += INFLATE_CHUNK_BYTES) {
      const end = Math.min(pos + INFLATE_CHUNK_BYTES, raw.length)
      inflater.push(raw.subarray(pos, end), end >= raw.length)
    }
  } catch (error) {
    if (error instanceof ZipError) throw error
    throw new ZipError(`${name} 解压失败：${error instanceof Error ? error.message : '未知错误'}`)
  }

  return Buffer.concat(chunks, totalBytes)
}

export class ZipArchive {
  private totalDecompressedBytes = 0

  private constructor(
    private readonly buffer: Buffer,
    private readonly records: Map<string, ZipEntryRecord>
  ) {}

  /** 解析中央目录（含 ZIP64）；不是合法 ZIP 时抛 `ZipError` */
  static open(buffer: Buffer): ZipArchive {
    if (buffer.length < EOCD_MIN_BYTES) throw new ZipError('文件太短，不是有效的 ZIP 容器')
    const eocd = findEndOfCentralDirectory(buffer)
    if (eocd < 0) throw new ZipError('找不到 ZIP 目录结构，文件可能已损坏')

    const diskNumber = buffer.readUInt16LE(eocd + 4)
    const centralDirDisk = buffer.readUInt16LE(eocd + 6)
    const entriesOnDisk = buffer.readUInt16LE(eocd + 8)
    let total = buffer.readUInt16LE(eocd + 10)
    let directorySize = buffer.readUInt32LE(eocd + 12)
    let directoryOffset = buffer.readUInt32LE(eocd + 16)

    const needsZip64 =
      diskNumber === 0xffff ||
      centralDirDisk === 0xffff ||
      entriesOnDisk === 0xffff ||
      total === 0xffff ||
      directorySize === 0xffffffff ||
      directoryOffset === 0xffffffff

    const hasZip64Locator =
      eocd >= ZIP64_LOCATOR_BYTES &&
      buffer.readUInt32LE(eocd - ZIP64_LOCATOR_BYTES) === ZIP64_LOCATOR_SIGNATURE

    if (needsZip64 && !hasZip64Locator) {
      throw new ZipError('ZIP64 目录定位记录缺失或已损坏')
    }

    let directoryEndBound = eocd
    if (hasZip64Locator) {
      const locatorOffset = eocd - ZIP64_LOCATOR_BYTES
      const locatorDisk = buffer.readUInt32LE(locatorOffset + 4)
      const zip64EocdOffset = readUInt64LEAsSafeNumber(buffer, locatorOffset + 8)
      const totalDisks = buffer.readUInt32LE(locatorOffset + 16)
      if (
        zip64EocdOffset + ZIP64_EOCD_MIN_BYTES > locatorOffset ||
        buffer.readUInt32LE(zip64EocdOffset) !== ZIP64_EOCD_SIGNATURE
      ) {
        throw new ZipError('ZIP64 中央目录结尾记录已损坏')
      }
      const z64RecordSize = readUInt64LEAsSafeNumber(buffer, zip64EocdOffset + 4)
      if (z64RecordSize < 44 || zip64EocdOffset + 12 + z64RecordSize > locatorOffset) {
        throw new ZipError('ZIP64 中央目录结尾记录长度非法')
      }
      const z64Disk = buffer.readUInt32LE(zip64EocdOffset + 16)
      const z64CdDisk = buffer.readUInt32LE(zip64EocdOffset + 20)
      const z64EntriesOnDisk = readUInt64LEAsSafeNumber(buffer, zip64EocdOffset + 24)
      const z64Total = readUInt64LEAsSafeNumber(buffer, zip64EocdOffset + 32)
      const z64DirectorySize = readUInt64LEAsSafeNumber(buffer, zip64EocdOffset + 40)
      const z64DirectoryOffset = readUInt64LEAsSafeNumber(buffer, zip64EocdOffset + 48)
      if ((totalDisks > 1 && z64Disk !== z64CdDisk) || locatorDisk !== z64Disk || z64EntriesOnDisk !== z64Total) {
        throw new ZipError('不支持分卷 ZIP64 归档')
      }
      total = z64Total
      directorySize = z64DirectorySize
      directoryOffset = z64DirectoryOffset
      directoryEndBound = zip64EocdOffset
    } else if (diskNumber !== centralDirDisk || entriesOnDisk !== total) {
      throw new ZipError('不支持分卷 ZIP 归档')
    }

    const directoryEnd = directoryOffset + directorySize
    if (directoryOffset < 0 || directorySize < 0 || directoryEnd > directoryEndBound) {
      throw new ZipError('ZIP 目录结构已损坏')
    }
    if (total * 46 > directorySize) {
      throw new ZipError('ZIP 目录条目数与目录长度不匹配')
    }

    const records = new Map<string, ZipEntryRecord>()
    let offset = directoryOffset
    for (let index = 0; index < total; index += 1) {
      if (offset + 46 > directoryEnd) throw new ZipError('ZIP 目录被截断')
      if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
        throw new ZipError('ZIP 目录结构已损坏')
      }
      const flags = buffer.readUInt16LE(offset + 8)
      const method = buffer.readUInt16LE(offset + 10)
      const entryCrc32 = buffer.readUInt32LE(offset + 16)
      const rawCompressedSize = buffer.readUInt32LE(offset + 20)
      const rawUncompressedSize = buffer.readUInt32LE(offset + 24)
      const nameLength = buffer.readUInt16LE(offset + 28)
      const extraLength = buffer.readUInt16LE(offset + 30)
      const commentLength = buffer.readUInt16LE(offset + 32)
      const rawLocalOffset = buffer.readUInt32LE(offset + 42)
      const nameStart = offset + 46
      const extraStart = nameStart + nameLength
      const extraEnd = extraStart + extraLength
      const nextOffset = extraEnd + commentLength
      if (nameLength === 0 || nextOffset > directoryEnd) {
        throw new ZipError('ZIP 条目名被截断')
      }

      const resolved = resolveZip64EntryFields(
        buffer,
        extraStart,
        extraEnd,
        rawUncompressedSize,
        rawCompressedSize,
        rawLocalOffset
      )

      // 条目名在 UTF-8 标记缺失时按 Latin-1/CP437 解码；OOXML / EPUB 的条目名均为 ASCII 或 UTF-8
      const nameBytes = buffer.subarray(nameStart, extraStart)
      const name = (flags & 0x800 ? strFromU8(nameBytes, false) : buffer.toString('latin1', nameStart, extraStart)).replace(
        /\\/g,
        '/'
      )
      records.set(name, {
        name,
        flags,
        method,
        crc32: entryCrc32,
        compressedSize: resolved.compressedSize,
        uncompressedSize: resolved.uncompressedSize,
        localOffset: resolved.localOffset,
      })
      offset = nextOffset
    }
    if (records.size === 0) throw new ZipError('ZIP 容器里没有任何条目')
    return new ZipArchive(buffer, records)
  }

  names(): string[] {
    return [...this.records.keys()]
  }

  has(name: string): boolean {
    return this.records.has(name)
  }

  /** 返回中央目录声明的未压缩大小（读取前可用于预检，避免先解压超大媒体） */
  entrySize(name: string): number | null {
    const record = this.records.get(name)
    return record ? record.uncompressedSize : null
  }

  /** 直接位于 `prefix` 下的条目名（不递归） */
  children(prefix: string): string[] {
    const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`
    return this.names().filter((name) => {
      if (!name.startsWith(normalized)) return false
      return !name.slice(normalized.length).includes('/')
    })
  }

  read(name: string): Buffer | null {
    const record = this.records.get(name)
    if (!record) return null
    if (record.flags & 0x1) throw new ZipError(`${name} 已加密，无法读取`)
    const remainingBudget = MAX_TOTAL_DECOMPRESSED_BYTES - this.totalDecompressedBytes
    if (remainingBudget <= 0) {
      throw new ZipError(`文档累计解压体积超过 ${MAX_TOTAL_DECOMPRESSED_BYTES / 1024 / 1024}MB 上限`)
    }
    const maxAllowed = Math.min(MAX_ENTRY_BYTES, remainingBudget)
    if (record.uncompressedSize > maxAllowed) {
      throw new ZipError(`${name} 解压后超过大小上限，已跳过`)
    }

    const local = record.localOffset
    if (local + 30 > this.buffer.length || this.buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
      throw new ZipError(`${name} 的本地头已损坏`)
    }
    const localFlags = this.buffer.readUInt16LE(local + 6)
    if (localFlags & 0x1) throw new ZipError(`${name} 已加密，无法读取`)

    const nameLength = this.buffer.readUInt16LE(local + 26)
    const extraLength = this.buffer.readUInt16LE(local + 28)
    const start = local + 30 + nameLength + extraLength
    const end = start + record.compressedSize
    if (end > this.buffer.length) throw new ZipError(`${name} 的数据被截断`)
    const raw = this.buffer.subarray(start, end)

    let output: Buffer
    if (record.method === 0) {
      if (raw.length > maxAllowed) {
        throw new ZipError(`${name} 解压后超过大小上限，已跳过`)
      }
      output = Buffer.from(raw)
    } else if (record.method === 8) {
      output = inflateBounded(raw, maxAllowed, name)
    } else {
      throw new ZipError(`${name} 使用了不支持的压缩方式（${record.method}）`)
    }

    const actualCrc = crc32(output) >>> 0
    if (actualCrc !== record.crc32) {
      throw new ZipError(`${name} CRC32 校验失败，数据可能已损坏`)
    }
    this.totalDecompressedBytes += output.length
    return output
  }

  readText(name: string): string | null {
    const buffer = this.read(name)
    return buffer ? buffer.toString('utf8') : null
  }
}
