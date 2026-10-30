import { describe, expect, it } from 'vitest'
import { ZipArchive } from '../electron/documents/zip'
import {
  readEpub,
  readOpenDocument,
  readPresentation,
  readSpreadsheet,
  readWordDocument,
} from '../electron/documents/ooxml'
import {
  buildDocx,
  buildEpub,
  buildOdt,
  buildPptx,
  buildXlsx,
  buildZip,
  bullet,
  heading,
  paragraph,
  tableRows,
} from './documents-fixtures'

describe('readWordDocument', () => {
  it('抽取标题 / 段落 / 项目符号 / 表格', () => {
    const zip = ZipArchive.open(
      buildDocx(
        [
          heading('季度总结'),
          paragraph('第一段内容。'),
          bullet('要点一'),
          tableRows([
            ['产品', '销量'],
            ['Aura', '1200'],
          ]),
        ].join('')
      )
    )
    expect(readWordDocument(zip).lines).toEqual([
      '# 季度总结',
      '第一段内容。',
      '- 要点一',
      '产品\t销量',
      'Aura\t1200',
    ])
  })

  it('H2 用二级标记，空段落不占行', () => {
    const zip = ZipArchive.open(buildDocx([heading('小节', 2), paragraph(''), paragraph('正文')].join('')))
    expect(readWordDocument(zip).lines).toEqual(['## 小节', '正文'])
  })

  it('缺 document.xml 时报损坏', () => {
    const zip = ZipArchive.open(buildZip([{ name: '[Content_Types].xml', content: '<Types/>' }]))
    expect(() => readWordDocument(zip)).toThrow(/word\/document\.xml/)
  })
})

describe('readSpreadsheet', () => {
  const buffer = buildXlsx({
    sharedStrings: ['产品', '一月', 'Aura'],
    sheets: [
      {
        name: '汇总',
        xml:
          '<dimension ref="A1:B2"/><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row>' +
          '</sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells>',
      },
      {
        name: '明细',
        xml: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>备注</t></is></c></row></sheetData>',
      },
    ],
  })

  it('按 sheet 顺序解析共享字符串、内联字符串与数值', () => {
    const model = readSpreadsheet(ZipArchive.open(buffer))
    expect(model.sheets.map((sheet) => sheet.name)).toEqual(['汇总', '明细'])
    expect(model.sheets[0].rows).toEqual([
      ['产品', '一月'],
      ['Aura', '1200'],
    ])
    expect(model.sheets[0].dimension).toBe('A1:B2')
    expect(model.sheets[0].merges).toEqual(['A1:B1'])
    expect(model.sheets[1].rows).toEqual([['备注']])
  })

  it('列引用按字母定位，缺列补空字符串', () => {
    const model = readSpreadsheet(
      ZipArchive.open(
        buildXlsx({
          sheets: [
            {
              name: 'S',
              xml: '<sheetData><row r="1"><c r="C1"><v>3</v></c></row></sheetData>',
            },
          ],
        })
      )
    )
    expect(model.sheets[0].rows).toEqual([['', '', '3']])
  })

  it('缺 workbook.xml 时报损坏', () => {
    const zip = ZipArchive.open(buildZip([{ name: '[Content_Types].xml', content: '<Types/>' }]))
    expect(() => readSpreadsheet(zip)).toThrow(/xl\/workbook\.xml/)
  })
})

describe('readPresentation', () => {
  it('按 sldIdLst 顺序输出每页文本，并收集内嵌图片', () => {
    const buffer = buildPptx({
      slides: [
        ['标题一', '正文一'],
        ['第二页'],
      ],
      media: [{ name: 'image1.png', bytes: Buffer.from([1, 2, 3]) }],
    })
    const model = readPresentation(ZipArchive.open(buffer))
    expect(model.slides).toEqual([
      { index: 1, lines: ['标题一', '正文一'] },
      { index: 2, lines: ['第二页'] },
    ])
    expect(model.images).toHaveLength(1)
    expect(model.images[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })
})

describe('readOpenDocument', () => {
  it('抽取段落、标题级别与表格行', () => {
    const zip = ZipArchive.open(
      buildOdt(
        '<text:h text:outline-level="1">文档标题</text:h>' +
          '<text:p>正文段落</text:p>' +
          '<table:table><table:table-row><table:table-cell><text:p>A</text:p></table:table-cell>' +
          '<table:table-cell><text:p>B</text:p></table:table-cell></table:table-row></table:table>'
      )
    )
    expect(readOpenDocument(zip).lines).toEqual(['# 文档标题', '正文段落', 'A\tB'])
  })
})

describe('readEpub', () => {
  it('按 spine 顺序抽取章节正文', () => {
    const zip = ZipArchive.open(
      buildEpub([
        { href: 'ch1.xhtml', body: '<h1>第一章</h1><p>开场白</p>' },
        { href: 'ch2.xhtml', body: '<p>第二章内容</p>' },
      ])
    )
    const model = readEpub(zip)
    expect(model.chapters).toHaveLength(2)
    expect(model.chapters[0].lines).toEqual(['第一章', '开场白'])
    expect(model.chapters[1].lines).toEqual(['第二章内容'])
  })
})
