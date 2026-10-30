import { describe, expect, it } from 'vitest'
import { ZipArchive, ZipError } from '../electron/documents/zip'
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
})
