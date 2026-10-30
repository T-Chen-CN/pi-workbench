import { describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { extractPdfText, isScannedPage, SCANNED_CHAR_THRESHOLD } from '../electron/documents/pdf'
import { buildPdf } from './documents-fixtures'

async function withTempFile(name: string, bytes: Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pdf-'))
  const target = path.join(dir, name)
  await fs.writeFile(target, bytes)
  return target
}

describe('extractPdfText', () => {
  it('抽出文本层与页数', async () => {
    const target = await withTempFile('text.pdf', buildPdf({ text: 'Quarterly revenue grew by twelve percent' }))
    const result = await extractPdfText(target)
    expect(result.pageCount).toBe(1)
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0].text).toContain('Quarterly revenue')
    expect(isScannedPage(result.pages[0])).toBe(false)
  })

  it('maxPages 限制解析页数', async () => {
    const target = await withTempFile('three.pdf', buildPdf({ text: 'Body text for page', pageCount: 3 }))
    const result = await extractPdfText(target, { maxPages: 2 })
    expect(result.pageCount).toBe(3)
    expect(result.pages.map((page) => page.index)).toEqual([1, 2])
  })

  it('pages 指定页码只解析这些页', async () => {
    const target = await withTempFile('pages.pdf', buildPdf({ text: 'Body text for page', pageCount: 3 }))
    const result = await extractPdfText(target, { pages: [3] })
    expect(result.pages.map((page) => page.index)).toEqual([3])
  })

  it('没有文本层的页判定为扫描页', async () => {
    const target = await withTempFile('scan.pdf', buildPdf({ pageCount: 1 }))
    const result = await extractPdfText(target)
    expect(result.pages[0].charCount).toBeLessThan(SCANNED_CHAR_THRESHOLD)
    expect(isScannedPage(result.pages[0])).toBe(true)
  })

  it('非 PDF 内容报可读错误', async () => {
    const target = await withTempFile('broken.pdf', Buffer.from('this is definitely not a pdf'))
    await expect(extractPdfText(target)).rejects.toThrow(/PDF/)
  })
})
