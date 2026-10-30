/**
 * 最小 ZIP 读取器：只读、进程内、零依赖（`node:zlib`）。
 *
 * docx / xlsx / pptx / odt / ods / odp / epub 都是 ZIP 容器，Agent 需要的只是里面
 * 少数几个 XML / XHTML 条目。这里不支持 ZIP64、加密、以及 deflate / store 之外的
 * 压缩方式：Office 与 EPUB 生成器都不会用它们，遇到就直接报可读的错误。
 *
 * 只读设计意味着解析出错的最坏结果是「读不出内容」，不会破坏用户的文件。
 */

import { inflateRawSync } from 'zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_BYTES = 22
/** ZIP 注释上限，决定从文件尾部往前搜多远 */
const EOCD_MAX_SEARCH = 0xffff
/** 单个条目的解压上限：超出按损坏处理，避免 zip 炸弹吃满内存 */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024

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
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - EOCD_MAX_SEARCH - EOCD_MIN_BYTES)
  for (let offset = buffer.length - EOCD_MIN_BYTES; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + EOCD_MIN_BYTES + commentLength <= buffer.length) return offset
  }
  return -1
}

export class ZipArchive {
  private constructor(
    private readonly buffer: Buffer,
    private readonly records: Map<string, ZipEntryRecord>
  ) {}

  /** 解析中央目录；不是合法 ZIP 时抛 `ZipError` */
  static open(buffer: Buffer): ZipArchive {
    if (buffer.length < EOCD_MIN_BYTES) throw new ZipError('文件太短，不是有效的 ZIP 容器')
    const eocd = findEndOfCentralDirectory(buffer)
    if (eocd < 0) throw new ZipError('找不到 ZIP 目录结构，文件可能已损坏')

    const total = buffer.readUInt16LE(eocd + 10)
    const directorySize = buffer.readUInt32LE(eocd + 12)
    let offset = buffer.readUInt32LE(eocd + 16)
    if (directorySize === 0xffffffff || offset === 0xffffffff) {
      throw new ZipError('不支持 ZIP64 格式的文档')
    }

    const records = new Map<string, ZipEntryRecord>()
    for (let index = 0; index < total; index += 1) {
      if (offset + 46 > buffer.length) throw new ZipError('ZIP 目录被截断')
      if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
        throw new ZipError('ZIP 目录结构已损坏')
      }
      const flags = buffer.readUInt16LE(offset + 8)
      const method = buffer.readUInt16LE(offset + 10)
      const compressedSize = buffer.readUInt32LE(offset + 20)
      const uncompressedSize = buffer.readUInt32LE(offset + 24)
      const nameLength = buffer.readUInt16LE(offset + 28)
      const extraLength = buffer.readUInt16LE(offset + 30)
      const commentLength = buffer.readUInt16LE(offset + 32)
      const localOffset = buffer.readUInt32LE(offset + 42)
      if (nameLength === 0 || offset + 46 + nameLength > buffer.length) {
        throw new ZipError('ZIP 条目名被截断')
      }
      if (localOffset === 0xffffffff || compressedSize === 0xffffffff) {
        throw new ZipError('不支持 ZIP64 格式的文档')
      }
      // 条目名在 UTF-8 标记缺失时按 CP437 编码；OOXML / EPUB 的条目名都是 ASCII
      const name = buffer
        .toString(flags & 0x800 ? 'utf8' : 'latin1', offset + 46, offset + 46 + nameLength)
        .replace(/\\/g, '/')
      records.set(name, { name, flags, method, compressedSize, uncompressedSize, localOffset })
      offset += 46 + nameLength + extraLength + commentLength
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
    if (record.uncompressedSize > MAX_ENTRY_BYTES) {
      throw new ZipError(`${name} 解压后超过 ${MAX_ENTRY_BYTES / 1024 / 1024}MB，已跳过`)
    }
    const local = record.localOffset
    if (local + 30 > this.buffer.length || this.buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
      throw new ZipError(`${name} 的本地头已损坏`)
    }
    const nameLength = this.buffer.readUInt16LE(local + 26)
    const extraLength = this.buffer.readUInt16LE(local + 28)
    const start = local + 30 + nameLength + extraLength
    const end = start + record.compressedSize
    if (end > this.buffer.length) throw new ZipError(`${name} 的数据被截断`)
    const raw = this.buffer.subarray(start, end)

    if (record.method === 0) return Buffer.from(raw)
    if (record.method === 8) {
      try {
        return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES })
      } catch (error) {
        throw new ZipError(`${name} 解压失败：${error instanceof Error ? error.message : '未知错误'}`)
      }
    }
    throw new ZipError(`${name} 使用了不支持的压缩方式（${record.method}）`)
  }

  readText(name: string): string | null {
    const buffer = this.read(name)
    return buffer ? buffer.toString('utf8') : null
  }
}
