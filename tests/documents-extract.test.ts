import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  readDocument,
  type DocumentReaderDeps,
  type RenderPagesRequest,
} from '../electron/documents/extract'
import {
  buildDocx,
  buildEpub,
  buildOle,
  buildPdf,
  buildPptx,
  buildXlsx,
  heading,
  paragraph,
  tableRows,
} from './documents-fixtures'

async function tempFile(name: string, bytes: Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-doc-'))
  const target = path.join(dir, name)
  await fs.writeFile(target, bytes)
  return target
}

function deps(render?: DocumentReaderDeps['renderPages']): DocumentReaderDeps {
  return {
    renderPages:
      render ??
      (async () => {
        throw new Error('本用例不应触发渲染')
      }),
  }
}

describe('readDocument', () => {
  it('docx：输出分节标记 + 正文', async () => {
    const target = await tempFile(
      '季度总结.docx',
      buildDocx([heading('季度总结'), paragraph('营收同比增长 12%。'), tableRows([['产品', '销量'], ['Aura', '1200']])].join(''))
    )
    const result = await readDocument({ path: target }, deps())
    expect(result.details.format).toBe('docx')
    expect(result.text).toContain('--- document: 季度总结.docx')
    expect(result.text).toContain('# 季度总结')
    expect(result.text).toContain('营收同比增长 12%。')
    expect(result.text).toContain('Aura\t1200')
    expect(result.images).toEqual([])
  })

  it('xlsx：默认输出所有工作表，可用 sheet 过滤', async () => {
    const target = await tempFile(
      '报表.xlsx',
      buildXlsx({
        sharedStrings: ['产品', 'Aura'],
        sheets: [
          { name: '汇总', xml: '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData>' },
          { name: '明细', xml: '<sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData>' },
        ],
      })
    )
    const all = await readDocument({ path: target }, deps())
    expect(all.details.sheets).toEqual(['汇总', '明细'])
    expect(all.text).toContain('--- sheet: 汇总 (2 rows) ---')
    expect(all.text).toContain('--- sheet: 明细 (1 rows) ---')

    const filtered = await readDocument({ path: target, sheet: '明细' }, deps())
    expect(filtered.text).toContain('42')
    expect(filtered.text).not.toContain('Aura')

    const missing = await readDocument({ path: target, sheet: '不存在' }, deps())
    expect(missing.text).toContain('没有名为「不存在」的工作表')
    expect(missing.text).toContain('汇总, 明细')
  })

  it('pptx：按放映顺序编号，slide 参数只取指定页', async () => {
    const target = await tempFile('提案.pptx', buildPptx({ slides: [['封面'], ['现状'], ['方案']] }))
    const all = await readDocument({ path: target }, deps())
    expect(all.details.slideCount).toBe(3)
    expect(all.text).toContain('--- slide 1 ---')
    expect(all.text).toContain('--- slide 3 ---')

    const range = await readDocument({ path: target, slide: '2-3' }, deps())
    expect(range.text).not.toContain('封面')
    expect(range.text).toContain('现状')
    expect(range.text).toContain('方案')
  })

  it('文字版 PDF：逐页输出文本', async () => {
    const target = await tempFile('报告.pdf', buildPdf({ text: 'Annual revenue reached twelve million', pageCount: 2 }))
    const result = await readDocument({ path: target }, deps())
    expect(result.details.pageCount).toBe(2)
    expect(result.text).toContain('--- page 1 ---')
    expect(result.text).toContain('Annual revenue')
    expect(result.images).toEqual([])
  })

  it('文字版 PDF：pages 参数只解析指定页', async () => {
    const target = await tempFile('多页.pdf', buildPdf({ text: 'Body text of the report', pageCount: 4 }))
    const result = await readDocument({ path: target, pages: '3' }, deps())
    expect(result.text).toContain('--- page 3 ---')
    expect(result.text).not.toContain('--- page 1 ---')
  })

  it('扫描版 PDF：回调渲染层，把图片交给视觉通道', async () => {
    const target = await tempFile('扫描件.pdf', buildPdf({ pageCount: 2 }))
    const render = vi.fn(async (request: RenderPagesRequest) => {
      expect(request.pages).toEqual([1, 2])
      expect(request.scale).toBeGreaterThan(1)
      return [
        { data: 'AAA', mimeType: 'image/png' },
        { data: 'BBB', mimeType: 'image/png' },
      ]
    })
    const result = await readDocument({ path: target }, deps(render))
    expect(render).toHaveBeenCalledTimes(1)
    expect(result.images).toHaveLength(2)
    expect(result.details.imagePages).toEqual([1, 2])
    expect(result.text).toContain('没有文本层')
    expect(result.text).toContain('已作为图片附上')
  })

  it('渲染失败时降级成文字说明而不是抛错', async () => {
    const target = await tempFile('无窗口.pdf', buildPdf({ pageCount: 1 }))
    const result = await readDocument(
      { path: target },
      deps(async () => {
        throw new Error('没有可用窗口')
      })
    )
    expect(result.images).toEqual([])
    expect(result.text).toContain('扫描页渲染失败')
  })

  it('没有注入渲染通道时说明扫描页无法转图', async () => {
    const target = await tempFile('无通道.pdf', buildPdf({ pageCount: 1 }))
    const result = await readDocument({ path: target })
    expect(result.images).toEqual([])
    expect(result.details.imagePages).toBeUndefined()
    expect(result.text).toContain('没有可用的渲染通道')
  })

  it('旧版 .doc 直接给另存指引', async () => {
    const target = await tempFile('老文档.doc', buildOle('doc'))
    const result = await readDocument({ path: target }, deps())
    expect(result.details.rejected).toBe(true)
    expect(result.text).toContain('Word 97-2003')
    expect(result.text).toContain('.docx')
  })

  it('epub：按章节输出', async () => {
    const target = await tempFile('book.epub', buildEpub([{ href: 'c1.xhtml', body: '<p>第一章正文</p>' }]))
    const result = await readDocument({ path: target }, deps())
    expect(result.text).toContain('1 chapters')
    expect(result.text).toContain('第一章正文')
  })

  it('文件不存在时给可读错误', async () => {
    const result = await readDocument({ path: path.join(os.tmpdir(), 'pi-doc-missing-xyz.docx') }, deps())
    expect(result.details.rejected).toBe(true)
    expect(result.text).toContain('文件不存在')
  })

  it('空文件不当作文档', async () => {
    const target = await tempFile('empty.docx', Buffer.alloc(0))
    const result = await readDocument({ path: target }, deps())
    expect(result.text).toContain('空文件')
  })
})
