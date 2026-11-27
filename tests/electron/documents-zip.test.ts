import { describe, expect, it } from 'vitest'
import { ZipArchive, ZipError } from '../../electron/documents/zip'
import { buildZip } from './documents-fixtures'

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

  it('遇到 ZIP64 哨兵值（0xffff 条目数 / 0xffffffff 未压缩体积）明确报 ZipError', () => {
    const zipTotal64 = Buffer.from(buildZip([{ name: 'a.txt', content: 'ok' }]))
    zipTotal64.writeUInt16LE(0xffff, zipTotal64.length - 12)
    expect(() => ZipArchive.open(zipTotal64)).toThrow(/ZIP64/)

    const zipSize64 = Buffer.from(buildZip([{ name: 'a.txt', content: 'ok' }]))
    const cdOffset = zipSize64.readUInt32LE(zipSize64.length - 6)
    zipSize64.writeUInt32LE(0xffffffff, cdOffset + 24)
    expect(() => ZipArchive.open(zipSize64)).toThrow(/ZIP64/)
  })
})
