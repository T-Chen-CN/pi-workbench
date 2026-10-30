import { describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { readDocumentPreview } from '../electron/documents/preview'
import {
  buildDocx,
  buildEpub,
  buildOdt,
  buildOle,
  buildPdf,
  buildPptx,
  buildXlsx,
  bullet,
  heading,
  paragraph,
  tableRows,
} from './documents-fixtures'

async function writeTemp(name: string, bytes: Buffer | string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-preview-'))
  const target = path.join(dir, name)
  await fs.writeFile(target, bytes)
  return target
}

function sheetXml(cells: string[]): string {
  const row = cells
    .map(
      (value, index) =>
        `<c r="${String.fromCharCode(65 + index)}1" t="inlineStr"><is><t>${value}</t></is></c>`
    )
    .join('')
  return `<sheetData><row r="1">${row}</row></sheetData>`
}

describe('readDocumentPreview', () => {
  it('docx 拆成标题 / 段落 / 列表 / 表格块', async () => {
    const xml =
      heading('年度总结', 1) +
      paragraph('今年完成了三件事。') +
      bullet('第一件') +
      bullet('第二件') +
      tableRows([['项目', '状态'], ['文档阅读', '完成']])
    const target = await writeTemp('报告.docx', buildDocx(xml))
    const preview = await readDocumentPreview(target)
    expect(preview.kind).toBe('word')
    if (preview.kind !== 'word') return
    expect(preview.blocks).toEqual([
      { type: 'heading', level: 1, text: '年度总结' },
      { type: 'paragraph', text: '今年完成了三件事。' },
      { type: 'bullet', text: '第一件' },
      { type: 'bullet', text: '第二件' },
      {
        type: 'table',
        rows: [
          ['项目', '状态'],
          ['文档阅读', '完成'],
        ],
      },
    ])
    expect(preview.truncated).toBe(false)
  })

  it('xlsx 每个工作表给出行列网格，并标出裁剪', async () => {
    const target = await writeTemp(
      '预算.xlsx',
      buildXlsx({
        sheets: [
          { name: '汇总', xml: sheetXml(['一月', '二月']) },
          { name: '明细', xml: sheetXml(['甲']) },
        ],
      })
    )
    const preview = await readDocumentPreview(target)
    expect(preview.kind).toBe('sheet')
    if (preview.kind !== 'sheet') return
    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(['汇总', '明细'])
    expect(preview.sheets[0].rows).toEqual([['一月', '二月']])
    expect(preview.sheets[0].truncated).toBe(false)
  })

  it('xlsx 表格行超过预览上限时标记 truncated', async () => {
    const rows = Array.from({ length: 320 }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>r${index}</t></is></c></row>`).join('')
    const target = await writeTemp(
      '长表.xlsx',
      buildXlsx({ sheets: [{ name: '数据', xml: `<sheetData>${rows}</sheetData>` }] })
    )
    const preview = await readDocumentPreview(target)
    if (preview.kind !== 'sheet') throw new Error('expected sheet')
    expect(preview.sheets[0].rows).toHaveLength(300)
    expect(preview.sheets[0].truncated).toBe(true)
  })

  it('pptx 按放映顺序给出每页文字与图片', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const target = await writeTemp(
      '汇报.pptx',
      buildPptx({
        slides: [['封面', '副标题'], ['第二页']],
        media: [{ name: 'image1.png', bytes: png }],
      })
    )
    const preview = await readDocumentPreview(target)
    expect(preview.kind).toBe('slide')
    if (preview.kind !== 'slide') return
    expect(preview.slides).toHaveLength(2)
    expect(preview.slides[0]).toMatchObject({ index: 1, lines: ['封面', '副标题'] })
    expect(preview.slides[1].lines).toEqual(['第二页'])
    // 测试夹具没有 slide rels：退回全局图片，至少不丢内容
    expect(preview.slides[0].images[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('odt 把制表符分隔的表格行还原成表格块', async () => {
    const content =
      '<text:h text:outline-level="1">标题</text:h>' +
      '<text:p>正文</text:p>' +
      '<table:table>' +
      '<table:table-row><table:table-cell><text:p>甲</text:p></table:table-cell><table:table-cell><text:p>乙</text:p></table:table-cell></table:table-row>' +
      '</table:table>'
    const target = await writeTemp('说明.odt', buildOdt(content))
    const preview = await readDocumentPreview(target)
    if (preview.kind !== 'word') throw new Error('expected word')
    expect(preview.blocks[0]).toMatchObject({ type: 'heading', level: 1, text: '标题' })
    expect(preview.blocks).toContainEqual({ type: 'table', rows: [['甲', '乙']] })
  })

  it('epub 给出章节列表', async () => {
    const target = await writeTemp(
      'book.epub',
      buildEpub([
        { href: 'c1.xhtml', body: '<h1>第一章</h1><p>开头</p>' },
        { href: 'c2.xhtml', body: '<h1>第二章</h1><p>结尾</p>' },
      ])
    )
    const preview = await readDocumentPreview(target)
    if (preview.kind !== 'epub') throw new Error('expected epub')
    expect(preview.chapters.map((chapter) => chapter.label)).toEqual(['chapter 1', 'chapter 2'])
    expect(preview.chapters[1].lines).toContain('结尾')
  })

  it('旧格式返回另存为指引，而不是一句 unsupported', async () => {
    const target = await writeTemp('旧报告.doc', buildOle('doc'))
    const preview = await readDocumentPreview(target)
    expect(preview.kind).toBe('legacy')
    if (preview.kind !== 'legacy') return
    expect(preview.message).toMatch(/docx/i)
  })

  it('PDF 交给现成的阅读视图，主进程不重复解析', async () => {
    const target = await writeTemp('扫件.pdf', buildPdf({ text: 'hi' }))
    expect((await readDocumentPreview(target)).kind).toBe('pdf')
  })

  it('非文档与缺失文件给出错误说明', async () => {
    const text = await writeTemp('notes.txt', 'hello')
    expect(await readDocumentPreview(text)).toEqual({
      kind: 'error',
      message: '不是可预览的文档格式',
    })
    const missing = path.join(path.dirname(text), 'missing.docx')
    const preview = await readDocumentPreview(missing)
    expect(preview.kind).toBe('error')
  })

  it('损坏的 docx 给错误而不是抛异常', async () => {
    const target = await writeTemp('坏文件.docx', 'PK\u0003\u0004 not really a zip')
    const preview = await readDocumentPreview(target)
    expect(preview.kind).toBe('error')
  })

  it('多行表格的每一行都保留，顺序与原文一致', async () => {
    const xml = tableRows([
      ['表头甲', '表头乙'],
      ['数据甲', '数据乙'],
    ])
    const target = await writeTemp('两行.docx', buildDocx(xml))
    const preview = await readDocumentPreview(target)
    if (preview.kind !== 'word') throw new Error('expected word')
    expect(preview.blocks).toEqual([
      {
        type: 'table',
        rows: [
          ['表头甲', '表头乙'],
          ['数据甲', '数据乙'],
        ],
      },
    ])
  })
})
