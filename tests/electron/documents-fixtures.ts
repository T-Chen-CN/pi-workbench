/**
 * 文档测试夹具：现场生成 ZIP / docx / xlsx / pptx / ODF / EPUB / PDF 字节。
 *
 * 仓库里不提交二进制样本：测试自己写 ZIP（store 或 deflate）与 PDF xref，
 * 既避免「测试依赖某个具体文件」，也让每个条目单独可控。
 */

import { deflateRawSync } from 'zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipFileInput {
  name: string
  content: string | Buffer
}

/** 生成一个最小合法 ZIP；`deflate` 决定用 store(0) 还是 deflate(8) */
export function buildZip(files: ZipFileInput[], options: { deflate?: boolean } = {}): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const raw = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8')
    const name = Buffer.from(file.name, 'utf8')
    const method = options.deflate ? 8 : 0
    const body = method === 8 ? deflateRawSync(raw) : raw
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, body)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x800, 8)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt16LE(0, 12)
    entry.writeUInt16LE(0, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([entry, name]))

    offset += local.length + name.length + body.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, end])
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'

export function buildDocx(bodyXml: string): Buffer {
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    bodyXml +
    '</w:body></w:document>'
  return buildZip(
    [
      { name: '[Content_Types].xml', content: CONTENT_TYPES },
      { name: 'word/document.xml', content: document },
    ],
    { deflate: true }
  )
}

export function paragraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

export function heading(text: string, level = 1): string {
  return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
}

export function bullet(text: string): string {
  return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
}

export function tableRow(cells: string[]): string {
  const value = cells.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join('')
  return `<w:tbl><w:tr>${value}</w:tr></w:tbl>`
}

export function tableRows(rows: string[][]): string {
  const value = rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`).join('')
  return `<w:tbl>${value}</w:tbl>`
}

export interface SheetFixture {
  name: string
  /** 直接给 sheet XML */
  xml: string
}

export function buildXlsx(input: {
  sharedStrings?: string[]
  sheets: SheetFixture[]
}): Buffer {
  const shared = input.sharedStrings ?? []
  const sheetElements = input.sheets
    .map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')
  const workbook =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheetElements}</sheets></workbook>`
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    input.sheets
      .map(
        (_, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
      )
      .join('') +
    '</Relationships>'

  const sharedXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((value) => `<si><t>${value}</t></si>`).join('') +
    '</sst>'

  return buildZip(
    [
      { name: '[Content_Types].xml', content: CONTENT_TYPES },
      { name: 'xl/workbook.xml', content: workbook },
      { name: 'xl/_rels/workbook.xml.rels', content: rels },
      { name: 'xl/sharedStrings.xml', content: sharedXml },
      ...input.sheets.map((sheet, index) => ({
        name: `xl/worksheets/sheet${index + 1}.xml`,
        content:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheet.xml}</worksheet>`,
      })),
    ],
    { deflate: true }
  )
}

export function buildPptx(input: { slides: string[][]; media?: { name: string; bytes: Buffer }[] }): Buffer {
  const slideIds = input.slides
    .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`)
    .join('')
  const presentation =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<p:sldIdLst>${slideIds}</p:sldIdLst></p:presentation>`
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    input.slides
      .map(
        (_, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
      )
      .join('') +
    '</Relationships>'

  const slideXml = (lines: string[]) =>
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>' +
    lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join('') +
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'

  return buildZip(
    [
      { name: '[Content_Types].xml', content: CONTENT_TYPES },
      { name: 'ppt/presentation.xml', content: presentation },
      { name: 'ppt/_rels/presentation.xml.rels', content: rels },
      ...input.slides.map((lines, index) => ({
        name: `ppt/slides/slide${index + 1}.xml`,
        content: slideXml(lines),
      })),
      ...(input.media ?? []).map((item) => ({ name: `ppt/media/${item.name}`, content: item.bytes })),
    ],
    { deflate: true }
  )
}

export function buildOdt(contentXml: string): Buffer {
  return buildZip(
    [
      { name: 'mimetype', content: 'application/vnd.oasis.opendocument.text' },
      {
        name: 'content.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">' +
          `<office:body><office:text>${contentXml}</office:text></office:body></office:document-content>`,
      },
    ],
    { deflate: true }
  )
}

export function buildEpub(chapters: { href: string; body: string }[]): Buffer {
  const manifest = chapters
    .map((chapter, index) => `<item id="c${index + 1}" href="${chapter.href}" media-type="application/xhtml+xml"/>`)
    .join('')
  const spine = chapters.map((_, index) => `<itemref idref="c${index + 1}"/>`).join('')
  return buildZip(
    [
      {
        name: 'META-INF/container.xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">' +
          '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      },
      {
        name: 'OEBPS/content.opf',
        content:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>' +
          manifest +
          `</manifest><spine>${spine}</spine></package>`,
      },
      ...chapters.map((chapter) => ({
        name: `OEBPS/${chapter.href}`,
        content:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          `<html xmlns="http://www.w3.org/1999/xhtml"><body>${chapter.body}</body></html>`,
      })),
    ],
    { deflate: true }
  )
}

/** 最小合法 PDF（1 页 + 可选文本）；escaped 只处理括号与反斜杠 */
export function buildPdf(input: { text?: string; pageCount?: number } = {}): Buffer {
  const pageCount = input.pageCount ?? 1
  const text = input.text ?? 'Hello Document'
  const objects: string[] = []
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  const kids = Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`).join(' ')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`)
  for (let index = 0; index < pageCount; index += 1) {
    const contentRef = 4 + index * 2
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 ${3 + pageCount * 2} 0 R >> >> /Contents ${contentRef} 0 R >>`
    )
    const stream = text ? `BT /F1 14 Tf 20 120 Td (${escapePdfText(text)}) Tj ET` : 'q Q'
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** OLE 复合文档头（旧版 .doc/.xls/.ppt 都是它），后面跟任意垃圾字节 */
export function buildOle(extension: string): Buffer {
  void extension
  return Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(512, 0),
  ])
}
