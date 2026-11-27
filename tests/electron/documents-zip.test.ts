import { describe, expect, it } from 'vitest'
import { crc32, deflateRawSync } from 'zlib'
import { ZipArchive, ZipError } from '../../electron/documents/zip'
import { buildZip } from './documents-fixtures'

/** 构造合法 ZIP64 归档：同时写入 ZIP64 扩展字段 (0x0001)、ZIP64 EOCD 与 ZIP64 Locator */
function buildZip64(
  files: Array<{ name: string; content: string | Buffer }>,
  options: { deflate?: boolean } = {}
): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const raw = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8')
    const name = Buffer.from(file.name, 'utf8')
    const method = options.deflate ? 8 : 0
    const body = method === 8 ? deflateRawSync(raw) : raw
    const checksum = crc32(raw) >>> 0

    // 本地头带 ZIP64 extra (uncompressedSize + compressedSize)
    const localExtra = Buffer.alloc(20)
    localExtra.writeUInt16LE(0x0001, 0)
    localExtra.writeUInt16LE(16, 2)
    localExtra.writeBigUInt64LE(BigInt(raw.length), 4)
    localExtra.writeBigUInt64LE(BigInt(body.length), 12)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(45, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(0xffffffff, 18)
    local.writeUInt32LE(0xffffffff, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(localExtra.length, 28)
    chunks.push(local, name, localExtra, body)

    // 中央目录带 ZIP64 extra (uncompressedSize + compressedSize + localOffset)
    const cdExtra = Buffer.alloc(28)
    cdExtra.writeUInt16LE(0x0001, 0)
    cdExtra.writeUInt16LE(24, 2)
    cdExtra.writeBigUInt64LE(BigInt(raw.length), 4)
    cdExtra.writeBigUInt64LE(BigInt(body.length), 12)
    cdExtra.writeBigUInt64LE(BigInt(offset), 20)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(45, 4)
    entry.writeUInt16LE(45, 6)
    entry.writeUInt16LE(0x800, 8)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(checksum, 16)
    entry.writeUInt32LE(0xffffffff, 20)
    entry.writeUInt32LE(0xffffffff, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt16LE(cdExtra.length, 30)
    entry.writeUInt32LE(0xffffffff, 42)
    central.push(Buffer.concat([entry, name, cdExtra]))

    offset += local.length + name.length + localExtra.length + body.length
  }

  const directory = Buffer.concat(central)
  const zip64EocdOffset = offset + directory.length

  const zip64Eocd = Buffer.alloc(56)
  zip64Eocd.writeUInt32LE(0x06064b50, 0)
  zip64Eocd.writeBigUInt64LE(44n, 4)
  zip64Eocd.writeUInt16LE(45, 12)
  zip64Eocd.writeUInt16LE(45, 14)
  zip64Eocd.writeUInt32LE(0, 16)
  zip64Eocd.writeUInt32LE(0, 20)
  zip64Eocd.writeBigUInt64LE(BigInt(files.length), 24)
  zip64Eocd.writeBigUInt64LE(BigInt(files.length), 32)
  zip64Eocd.writeBigUInt64LE(BigInt(directory.length), 40)
  zip64Eocd.writeBigUInt64LE(BigInt(offset), 48)

  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeUInt32LE(0, 4)
  locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8)
  locator.writeUInt32LE(1, 16)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0xffff, 8)
  eocd.writeUInt16LE(0xffff, 10)
  eocd.writeUInt32LE(0xffffffff, 12)
  eocd.writeUInt32LE(0xffffffff, 16)

  return Buffer.concat([...chunks, directory, zip64Eocd, locator, eocd])
}

describe('ZipArchive', () => {
  const files = [
    { name: 'word/document.xml', content: '<w:document/>' },
    { name: 'word/media/image1.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { name: 'xl/workbook.xml', content: '<workbook/>' },
  ]

  it('读取 deflate 压缩的条目', () => {
    const zip = ZipArchive.open(buildZip(files, { deflate: true }))
    expect(zip.names().sort()).toEqual([
      'word/document.xml',
      'word/media/image1.png',
      'xl/workbook.xml',
    ])
    expect(zip.readText('word/document.xml')).toBe('<w:document/>')
    expect(zip.read('word/media/image1.png')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('读取 store（未压缩）条目，保留 UTF-8 中文', () => {
    const zip = ZipArchive.open(buildZip([{ name: 'a.txt', content: '中文内容' }]))
    expect(zip.readText('a.txt')).toBe('中文内容')
  })

  it('不存在的条目返回 null 而不是抛错', () => {
    const zip = ZipArchive.open(buildZip(files))
    expect(zip.has('nope.xml')).toBe(false)
    expect(zip.read('nope.xml')).toBeNull()
    expect(zip.readText('nope.xml')).toBeNull()
  })

  it('children 只列直接子项', () => {
    const zip = ZipArchive.open(buildZip(files))
    expect(zip.children('word')).toEqual(['word/document.xml'])
    expect(zip.children('word/media')).toEqual(['word/media/image1.png'])
  })

  it('非 ZIP 数据抛可读错误', () => {
    expect(() => ZipArchive.open(Buffer.from('not a zip at all'))).toThrow(ZipError)
  })

  it('截断的中央目录抛错', () => {
    const buffer = buildZip(files, { deflate: true })
    expect(() => ZipArchive.open(buffer.subarray(0, 40))).toThrow(ZipError)
  })

  it('注释内含伪造 EOCD 魔数时仍严格定位注释结束恰好等于文件尾的真实 EOCD', () => {
    const base = buildZip([{ name: 'a.txt', content: 'ok' }])
    // 真实 EOCD 位于 base 末尾 22 字节；给它附加一条包含 0x06054b50 魔数的注释
    const fakeComment = Buffer.alloc(24)
    fakeComment.writeUInt32LE(0x06054b50, 0)
    fakeComment.writeUInt16LE(0, 20)
    const withComment = Buffer.concat([base, fakeComment])
    withComment.writeUInt16LE(fakeComment.length, base.length - 2)

    const zip = ZipArchive.open(withComment)
    expect(zip.readText('a.txt')).toBe('ok')
  })

  it('支持读取合法的 ZIP64 归档（store 与 deflate）', () => {
    const storeZip64 = ZipArchive.open(
      buildZip64(
        [
          { name: 'word\\document.xml', content: '<w:document>ZIP64中文</w:document>' },
          { name: 'data/bin.dat', content: Buffer.from([1, 2, 3, 4, 5]) },
        ],
        { deflate: false }
      )
    )
    expect(storeZip64.has('word/document.xml')).toBe(true)
    expect(storeZip64.readText('word/document.xml')).toBe('<w:document>ZIP64中文</w:document>')
    expect(storeZip64.read('data/bin.dat')).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect(storeZip64.entrySize('data/bin.dat')).toBe(5)

    const deflateZip64 = ZipArchive.open(buildZip64(files, { deflate: true }))
    expect(deflateZip64.readText('word/document.xml')).toBe('<w:document/>')
    expect(deflateZip64.read('word/media/image1.png')).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    )
  })

  it('遇到缺失定位记录或扩展字段的损坏 ZIP64 哨兵值明确报 ZipError', () => {
    const zipTotal64 = Buffer.from(buildZip([{ name: 'a.txt', content: 'ok' }]))
    zipTotal64.writeUInt16LE(0xffff, zipTotal64.length - 12)
    expect(() => ZipArchive.open(zipTotal64)).toThrow(ZipError)
    expect(() => ZipArchive.open(zipTotal64)).toThrow(/ZIP64/)

    const zipSize64 = Buffer.from(buildZip([{ name: 'a.txt', content: 'ok' }]))
    const cdOffset = zipSize64.readUInt32LE(zipSize64.length - 6)
    zipSize64.writeUInt32LE(0xffffffff, cdOffset + 24)
    expect(() => ZipArchive.open(zipSize64)).toThrow(ZipError)
    expect(() => ZipArchive.open(zipSize64)).toThrow(/ZIP64/)
  })

  it('拒绝加密条目与 CRC32 损坏的条目', () => {
    const encrypted = Buffer.from(buildZip([{ name: 'secret.txt', content: 'top-secret' }]))
    const cdOffset = encrypted.readUInt32LE(encrypted.length - 6)
    encrypted.writeUInt16LE(0x801, cdOffset + 8)
    const encZip = ZipArchive.open(encrypted)
    expect(() => encZip.read('secret.txt')).toThrow(ZipError)

    const badCrc = Buffer.from(buildZip([{ name: 'bad.txt', content: 'hello' }], { deflate: true }))
    const badCdOffset = badCrc.readUInt32LE(badCrc.length - 6)
    badCrc.writeUInt32LE(0xdeadbeef, badCdOffset + 16)
    const crcZip = ZipArchive.open(badCrc)
    expect(() => crcZip.read('bad.txt')).toThrow(ZipError)
  })
})
