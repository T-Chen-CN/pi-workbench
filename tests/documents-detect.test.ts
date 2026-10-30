import { describe, expect, it } from 'vitest'
import { extensionOfPath, isDocumentExtension, sniffDocument } from '../electron/documents/detect'
import { buildOle, buildPdf, buildZip } from './documents-fixtures'

const ZIP_HEAD = buildZip([{ name: 'a.txt', content: 'a' }])
const PDF_HEAD = buildPdf()
const OLE_HEAD = buildOle('doc')

describe('sniffDocument', () => {
  it('按魔数识别 PDF，与扩展名无关', () => {
    expect(sniffDocument('C:/tmp/报告.pdf', PDF_HEAD)).toMatchObject({ format: 'pdf', isDocument: true })
    expect(sniffDocument('C:/tmp/报告.bin', PDF_HEAD)).toMatchObject({ format: 'pdf', isDocument: true })
  })

  it('按扩展名识别 ZIP 系文档格式', () => {
    for (const [name, format] of [
      ['a.docx', 'docx'],
      ['a.xlsx', 'xlsx'],
      ['a.pptx', 'pptx'],
      ['a.odt', 'odt'],
      ['a.ods', 'ods'],
      ['a.odp', 'odp'],
      ['a.epub', 'epub'],
    ] as const) {
      expect(sniffDocument(`C:/tmp/${name}`, ZIP_HEAD).format).toBe(format)
    }
  })

  it('后缀不认识但内容是 ZIP：交给文档管线再判', () => {
    expect(sniffDocument('C:/tmp/a.zip', ZIP_HEAD)).toMatchObject({ format: 'unknown', isDocument: true })
  })

  it('OLE 容器一律判为旧版格式（含改后缀的情况）', () => {
    expect(sniffDocument('C:/tmp/a.doc', OLE_HEAD)).toMatchObject({ format: 'legacy-office', legacy: true })
    expect(sniffDocument('C:/tmp/a.docx', OLE_HEAD)).toMatchObject({ format: 'legacy-office', legacy: true })
  })

  it('扩展名像旧版格式但魔数不符：仍然按旧版提示，避免误读二进制', () => {
    expect(sniffDocument('C:/tmp/a.xls', Buffer.from('plain text'))).toMatchObject({
      format: 'legacy-office',
      legacy: true,
    })
  })

  it('普通文本不是文档', () => {
    expect(sniffDocument('C:/tmp/a.ts', Buffer.from('export const a = 1'))).toMatchObject({
      isDocument: false,
      legacy: false,
    })
  })

  it('扩展名工具函数', () => {
    expect(extensionOfPath('C:/a/b/报表.XLSX')).toBe('xlsx')
    expect(extensionOfPath('C:/a/b/Makefile')).toBe('')
    expect(extensionOfPath('.gitignore')).toBe('')
    expect(isDocumentExtension('docx')).toBe(true)
    expect(isDocumentExtension('doc')).toBe(true)
    expect(isDocumentExtension('csv')).toBe(false)
  })
})
