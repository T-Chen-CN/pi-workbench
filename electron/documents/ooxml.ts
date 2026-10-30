/**
 * OOXML（docx / xlsx / pptx）、OpenDocument（odt / ods / odp）与 EPUB 的文本抽取。
 *
 * 只做 Agent 与预览真正需要的那部分结构：
 * - docx：段落、标题级别、项目符号、表格行
 * - xlsx：按 sheet 的二维网格（共享字符串 / 内联字符串 / 布尔 / 公式缓存值）
 * - pptx：按放映顺序的每页文本 + 内嵌位图
 * - odf：段落 + 表格行
 * - epub：按 spine 顺序的章节正文
 *
 * 刻意不做：样式、字体、颜色、批注、修订、域代码、图表数据、日期序列号换算。
 * 这些既不影响模型理解，也会把「零依赖」的简单实现拖成半个排版引擎。
 */

import { DocumentError } from './errors.js'
import { ZipArchive } from './zip.js'
import { attr, htmlToText, normalizeSpaces, scanXml } from './xml.js'

export interface WordDocumentModel {
  /** 扁平文本（Agent 读到的内容，标题 / 项目符号带 Markdown 前缀） */
  lines: string[]
  /** 结构化块：程序内预览用，与 lines 同源 */
  blocks: WordBlock[]
}

export type WordBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet'; text: string }
  | { type: 'table'; rows: string[][] }

export interface SpreadsheetSheet {
  name: string
  /** 行 × 列；缺失单元格为空字符串 */
  rows: string[][]
  /** 工作表自身声明的数据区域，例如 `A1:F42` */
  dimension?: string
  /** 合并单元格区域，例如 `A1:B1` */
  merges: string[]
}

export interface SpreadsheetModel {
  sheets: SpreadsheetSheet[]
}

export interface PresentationSlide {
  index: number
  lines: string[]
}

export interface PresentationImage {
  name: string
  dataUrl: string
}

export interface PresentationModel {
  slides: PresentationSlide[]
  images: PresentationImage[]
}

export interface OpenDocumentModel {
  lines: string[]
}

export interface EpubChapter {
  label: string
  lines: string[]
}

export interface EpubModel {
  chapters: EpubChapter[]
}

/** 单个 sheet 读取上限：超出按「文件异常」处理，避免超大表吃满内存 */
const MAX_ROWS_PER_SHEET = 20000
const MAX_COLUMNS_PER_SHEET = 1024
const MAX_SHARED_STRINGS = 200000
/** 预览时最多解码的内嵌图片数 */
const MAX_PRESENTATION_IMAGES = 60
const MAX_PRESENTATION_IMAGE_BYTES = 8 * 1024 * 1024

const RASTER_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function headingLevel(style: string | undefined, outlineLevel?: string): number {
  if (outlineLevel) {
    const level = Number.parseInt(outlineLevel, 10)
    if (Number.isFinite(level) && level >= 0 && level < 6) return level + 1
  }
  if (!style) return 0
  const match = /(?:heading|标题)\s*([1-6])/i.exec(style) ?? /^([1-6])$/.exec(style)
  return match ? Number.parseInt(match[1], 10) : 0
}

/** 段落 → 若干行（软换行拆开、空段落丢弃） */
function pushParagraph(target: string[], text: string, heading: number, bullet: boolean): void {
  for (const raw of text.split('\n')) {
    const line = normalizeSpaces(raw)
    if (!line) continue
    const prefix = heading > 0 ? `${'#'.repeat(Math.min(heading, 6))} ` : bullet ? '- ' : ''
    target.push(`${prefix}${line}`)
  }
}

// ==================== docx ====================

/** 段落 → 若干非空行（软换行拆开）；前缀由调用方按块类型补 */
function paragraphLines(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = normalizeSpaces(raw)
    if (line) out.push(line)
  }
  return out
}

function prefixedLine(line: string, heading: number, bullet: boolean): string {
  if (heading > 0) return `${'#'.repeat(Math.min(heading, 6))} ${line}`
  return bullet ? `- ${line}` : line
}

export function readWordDocument(zip: ZipArchive): WordDocumentModel {
  const xml = zip.readText('word/document.xml')
  if (!xml) {
    throw new DocumentError('这个 .docx 里没有 word/document.xml，文件可能已损坏', 'corrupt')
  }
  const lines: string[] = []
  const blocks: WordBlock[] = []
  let text = ''
  let heading = 0
  let bullet = false
  let inText = false
  let inCell = 0
  let cellLines: string[] = []
  let rowCells: string[] = []
  /** 表格嵌套层数：块只记最外层表格，行仍然按现在的方式进 lines */
  let tableDepth = 0
  let tableRows: string[][] = []

  for (const token of scanXml(xml)) {
    if (token.type === 'text') {
      if (inText) text += token.text
      continue
    }
    if (token.type === 'open') {
      switch (token.name) {
        case 't':
          inText = !token.selfClosing
          break
        case 'tab':
          text += '\t'
          break
        case 'br':
          text += '\n'
          break
        case 'pStyle':
          heading = headingLevel(token.attrs.val)
          break
        case 'outlineLvl':
          heading = headingLevel(undefined, token.attrs.val)
          break
        case 'numPr':
          bullet = true
          break
        case 'p':
          if (!token.selfClosing) {
            text = ''
            heading = 0
            bullet = false
          }
          break
        case 'tbl':
          if (!token.selfClosing) {
            tableDepth += 1
            if (tableDepth === 1) tableRows = []
          }
          break
        case 'tc':
          if (!token.selfClosing) {
            inCell += 1
            cellLines = []
          }
          break
        case 'tr':
          if (!token.selfClosing) rowCells = []
          break
        default:
          break
      }
      continue
    }
    switch (token.name) {
      case 't':
        inText = false
        break
      case 'p': {
        const produced = paragraphLines(text)
        if (inCell > 0) {
          for (const line of produced) cellLines.push(prefixedLine(line, heading, bullet))
        } else {
          for (const line of produced) {
            lines.push(prefixedLine(line, heading, bullet))
            if (heading > 0) blocks.push({ type: 'heading', level: Math.min(heading, 6), text: line })
            else if (bullet) blocks.push({ type: 'bullet', text: line })
            else blocks.push({ type: 'paragraph', text: line })
          }
        }
        text = ''
        break
      }
      case 'tc': {
        inCell = Math.max(0, inCell - 1)
        rowCells.push(cellLines.join(' ').trim())
        cellLines = []
        break
      }
      case 'tr': {
        const row = normalizeSpaces(rowCells.join('\t')).replace(/\t+$/g, '')
        if (row) lines.push(row)
        if (tableDepth > 0) tableRows.push(rowCells.map((cell) => normalizeSpaces(cell)))
        rowCells = []
        break
      }
      case 'tbl': {
        tableDepth = Math.max(0, tableDepth - 1)
        if (tableDepth === 0) {
          if (tableRows.length > 0) blocks.push({ type: 'table', rows: tableRows })
          tableRows = []
        }
        break
      }
      default:
        break
    }
  }
  return { lines, blocks }
}

// ==================== xlsx ====================

function parseRelationships(xml: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!xml) return map
  for (const token of scanXml(xml)) {
    if (token.type !== 'open' || token.name !== 'Relationship') continue
    const id = token.attrs.Id ?? token.attrs.id
    const target = token.attrs.Target ?? token.attrs.target
    if (id && target) map.set(id, target)
  }
  return map
}

/** `worksheets/sheet1.xml` / `/xl/worksheets/sheet1.xml` → ZIP 内的路径 */
function resolveZipPath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const segments = [...base.split('/').filter(Boolean)]
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/')
}

function readSharedStrings(zip: ZipArchive): string[] {
  const xml = zip.readText('xl/sharedStrings.xml')
  const values: string[] = []
  if (!xml) return values
  let current = ''
  let inItem = false
  let inText = false
  let phoneticDepth = 0
  for (const token of scanXml(xml)) {
    if (token.type === 'text') {
      if (inText && phoneticDepth === 0) current += token.text
      continue
    }
    if (token.type === 'open') {
      switch (token.name) {
        case 'si':
          if (!token.selfClosing) {
            inItem = true
            current = ''
          }
          break
        case 't':
          inText = !token.selfClosing
          break
        case 'rPh':
          phoneticDepth += 1
          break
        default:
          break
      }
      continue
    }
    switch (token.name) {
      case 'si':
        if (inItem) {
          values.push(current)
          if (values.length >= MAX_SHARED_STRINGS) return values
          inItem = false
          current = ''
        }
        break
      case 't':
        inText = false
        break
      case 'rPh':
        phoneticDepth = Math.max(0, phoneticDepth - 1)
        break
      default:
        break
    }
  }
  return values
}

/** `A1` → 0；`AB12` → 27；无法解析返回 -1 */
export function columnIndexFromRef(ref: string): number {
  let value = 0
  let matched = false
  for (const char of ref) {
    const code = char.charCodeAt(0)
    if (code >= 65 && code <= 90) {
      value = value * 26 + (code - 64)
      matched = true
      continue
    }
    if (code >= 97 && code <= 122) {
      value = value * 26 + (code - 96)
      matched = true
      continue
    }
    break
  }
  return matched ? value - 1 : -1
}

function readSheet(
  xml: string,
  name: string,
  sharedStrings: string[]
): SpreadsheetSheet | null {
  const rows = new Map<number, string[]>()
  const merges: string[] = []
  let dimension: string | undefined
  let rowIndex = 0
  let currentRow: string[] = []
  let cellColumn = -1
  let cellType: string | undefined
  let cellValue = ''
  let inValue = false
  let inInlineText = false
  let maxColumns = 0

  const flushRow = () => {
    if (currentRow.length === 0) return
    maxColumns = Math.max(maxColumns, currentRow.length)
    if (rows.size < MAX_ROWS_PER_SHEET) rows.set(rowIndex, currentRow)
    currentRow = []
  }

  for (const token of scanXml(xml)) {
    if (token.type === 'text') {
      if (inValue || inInlineText) cellValue += token.text
      continue
    }
    if (token.type === 'open') {
      switch (token.name) {
        case 'dimension':
          dimension = token.attrs.ref ?? dimension
          break
        case 'row':
          rowIndex = Math.max(0, Number.parseInt(token.attrs.r ?? '0', 10) - 1)
          if (!Number.isFinite(rowIndex)) rowIndex = 0
          currentRow = []
          break
        case 'c':
          if (token.selfClosing) {
            cellColumn = -1
            break
          }
          cellColumn = columnIndexFromRef(token.attrs.r ?? '')
          if (cellColumn < 0) cellColumn = currentRow.length
          cellType = token.attrs.t
          cellValue = ''
          break
        case 'v':
          inValue = !token.selfClosing
          break
        case 'is':
          if (!token.selfClosing) cellValue = ''
          break
        case 't':
          inInlineText = !token.selfClosing
          break
        case 'mergeCell': {
          const ref = token.attrs.ref
          if (ref) merges.push(ref)
          break
        }
        default:
          break
      }
      continue
    }
    switch (token.name) {
      case 'v':
        inValue = false
        break
      case 't':
        inInlineText = false
        break
      case 'c': {
        if (cellColumn >= 0 && cellColumn < MAX_COLUMNS_PER_SHEET) {
          const raw = normalizeSpaces(cellValue)
          const resolved =
            cellType === 's'
              ? (sharedStrings[Number.parseInt(raw, 10)] ?? '')
              : cellType === 'b'
                ? raw === '1'
                  ? 'TRUE'
                  : 'FALSE'
                : raw
          while (currentRow.length < cellColumn) currentRow.push('')
          currentRow[cellColumn] = resolved
        }
        cellColumn = -1
        cellValue = ''
        break
      }
      case 'row':
        flushRow()
        break
      default:
        break
    }
  }
  flushRow()

  if (rows.size === 0 && maxColumns === 0) return { name, rows: [], dimension, merges }
  const ordered: string[][] = []
  const highest = Math.max(...rows.keys())
  for (let index = 0; index <= highest; index += 1) {
    const row = rows.get(index) ?? []
    while (row.length < maxColumns) row.push('')
    ordered.push(row)
  }
  return { name, rows: ordered, dimension, merges }
}

export function readSpreadsheet(zip: ZipArchive): SpreadsheetModel {
  const workbookXml = zip.readText('xl/workbook.xml')
  if (!workbookXml) {
    throw new DocumentError('这个 .xlsx 里没有 xl/workbook.xml，文件可能已损坏', 'corrupt')
  }
  const relationships = parseRelationships(zip.readText('xl/_rels/workbook.xml.rels'))
  const declared: { name: string; target?: string }[] = []
  for (const token of scanXml(workbookXml)) {
    if (token.type !== 'open' || token.name !== 'sheet') continue
    const name = token.attrs.name ?? `Sheet${declared.length + 1}`
    const relId = token.attrs.id
    declared.push({ name, target: relId ? relationships.get(relId) : undefined })
  }

  const sharedStrings = readSharedStrings(zip)
  const sheets: SpreadsheetSheet[] = []
  const sheetFiles = zip
    .names()
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => {
      const left = Number.parseInt(a.replace(/\D+/g, ''), 10)
      const right = Number.parseInt(b.replace(/\D+/g, ''), 10)
      return left - right
    })

  const targets = declared.map((entry, index) => {
    const resolved = entry.target ? resolveZipPath('xl', entry.target) : undefined
    const fallback = sheetFiles[index]
    return { name: entry.name, path: resolved && zip.has(resolved) ? resolved : fallback }
  })

  for (const target of targets) {
    if (!target.path) continue
    const xml = zip.readText(target.path)
    if (!xml) continue
    const sheet = readSheet(xml, target.name, sharedStrings)
    if (sheet) sheets.push(sheet)
  }
  if (sheets.length === 0) {
    throw new DocumentError('这个 .xlsx 里没有可读的工作表', 'corrupt')
  }
  return { sheets }
}

// ==================== pptx ====================

function sortedSlideFiles(zip: ZipArchive): string[] {
  return zip
    .names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number.parseInt(a.replace(/\D+/g, ''), 10) - Number.parseInt(b.replace(/\D+/g, ''), 10))
}

function readSlideLines(xml: string): string[] {
  const lines: string[] = []
  let current = ''
  let inText = false
  for (const token of scanXml(xml)) {
    if (token.type === 'text') {
      if (inText) current += token.text
      continue
    }
    if (token.type === 'open') {
      if (token.name === 't') inText = !token.selfClosing
      if (token.name === 'p' && !token.selfClosing) current = ''
      continue
    }
    if (token.name === 't') inText = false
    if (token.name === 'p') {
      const line = normalizeSpaces(current)
      if (line) lines.push(line)
      current = ''
    }
  }
  return lines
}

function readPresentationImages(zip: ZipArchive): PresentationImage[] {
  const images: PresentationImage[] = []
  const names = zip
    .names()
    .filter((name) => name.startsWith('ppt/media/'))
    .sort((a, b) => a.localeCompare(b, 'en'))
  for (const name of names) {
    if (images.length >= MAX_PRESENTATION_IMAGES) break
    const mime = RASTER_IMAGE_MIME[extensionOf(name)]
    if (!mime) continue
    const buffer = zip.read(name)
    if (!buffer || buffer.length > MAX_PRESENTATION_IMAGE_BYTES) continue
    images.push({ name, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` })
  }
  return images
}

export function readPresentation(zip: ZipArchive): PresentationModel {
  const presentationXml = zip.readText('ppt/presentation.xml')
  if (!presentationXml) {
    throw new DocumentError('这个 .pptx 里没有 ppt/presentation.xml，文件可能已损坏', 'corrupt')
  }
  const relationships = parseRelationships(zip.readText('ppt/_rels/presentation.xml.rels'))
  const ordered: string[] = []
  for (const token of scanXml(presentationXml)) {
    if (token.type !== 'open' || token.name !== 'sldId') continue
    const target = relationships.get(token.attrs.id ?? '')
    if (!target) continue
    const resolved = resolveZipPath('ppt', target)
    if (zip.has(resolved)) ordered.push(resolved)
  }
  const files = ordered.length > 0 ? ordered : sortedSlideFiles(zip)

  const slides: PresentationSlide[] = []
  files.forEach((file, index) => {
    const xml = zip.readText(file)
    if (!xml) return
    slides.push({ index: index + 1, lines: readSlideLines(xml) })
  })
  if (slides.length === 0) {
    throw new DocumentError('这个 .pptx 里没有可读的幻灯片', 'corrupt')
  }
  return { slides, images: readPresentationImages(zip) }
}

// ==================== OpenDocument（odt / ods / odp） ====================

export function readOpenDocument(zip: ZipArchive): OpenDocumentModel {
  const xml = zip.readText('content.xml')
  if (!xml) {
    throw new DocumentError('这个 OpenDocument 文件里没有 content.xml，文件可能已损坏', 'corrupt')
  }
  const lines: string[] = []
  let current = ''
  let heading = 0
  let inCell = 0
  let rowCells: string[] = []
  let cellLines: string[] = []

  const flush = (target: string[]) => {
    pushParagraph(target, current, heading, false)
    current = ''
    heading = 0
  }

  for (const token of scanXml(xml)) {
    if (token.type === 'text') {
      current += token.text
      continue
    }
    if (token.type === 'open') {
      switch (token.name) {
        case 'h':
          heading = Math.min(6, Math.max(1, Number.parseInt(token.attrs['outline-level'] ?? '1', 10) || 1))
          break
        case 'tab':
          current += '\t'
          break
        case 'line-break':
          current += '\n'
          break
        case 's': {
          const count = Number.parseInt(token.attrs.c ?? '1', 10)
          current += ' '.repeat(Number.isFinite(count) && count > 0 ? Math.min(count, 32) : 1)
          break
        }
        case 'table-cell':
        case 'covered-table-cell':
          if (!token.selfClosing) {
            inCell += 1
            cellLines = []
            current = ''
          }
          break
        case 'table-row':
          if (!token.selfClosing) rowCells = []
          break
        default:
          break
      }
      continue
    }
    switch (token.name) {
      case 'h':
      case 'p':
        flush(inCell > 0 ? cellLines : lines)
        break
      case 'table-cell':
      case 'covered-table-cell': {
        inCell = Math.max(0, inCell - 1)
        rowCells.push(cellLines.join(' ').trim())
        cellLines = []
        break
      }
      case 'table-row': {
        const row = normalizeSpaces(rowCells.join('\t')).replace(/\t+$/g, '')
        if (row) lines.push(row)
        rowCells = []
        break
      }
      default:
        break
    }
  }
  flush(lines)
  return { lines }
}

// ==================== EPUB ====================

function readContainerRootFile(zip: ZipArchive): string | null {
  const xml = zip.readText('META-INF/container.xml')
  if (!xml) return null
  for (const token of scanXml(xml)) {
    if (token.type !== 'open' || token.name !== 'rootfile') continue
    const fullPath = token.attrs['full-path']
    if (fullPath) return fullPath
  }
  return null
}

export function readEpub(zip: ZipArchive): EpubModel {
  const rootFile = readContainerRootFile(zip) ?? zip.names().find((name) => name.endsWith('.opf')) ?? null
  if (!rootFile) throw new DocumentError('这个 EPUB 里找不到 OPF 包文件，文件可能已损坏', 'corrupt')
  const opfXml = zip.readText(rootFile)
  if (!opfXml) throw new DocumentError('EPUB 的 OPF 包文件无法读取', 'corrupt')

  const manifest = new Map<string, string>()
  const spine: string[] = []
  for (const token of scanXml(opfXml)) {
    if (token.type !== 'open') continue
    if (token.name === 'item') {
      const id = token.attrs.id
      const href = token.attrs.href
      const mediaType = token.attrs['media-type'] ?? ''
      if (id && href && /xhtml|html/.test(mediaType)) manifest.set(id, href)
      continue
    }
    if (token.name === 'itemref') {
      const idref = token.attrs.idref
      if (idref) spine.push(idref)
    }
  }

  const baseDir = rootFile.includes('/') ? rootFile.slice(0, rootFile.lastIndexOf('/')) : ''
  const chapters: EpubChapter[] = []
  spine.forEach((idref, index) => {
    const href = manifest.get(idref)
    if (!href) return
    const target = resolveZipPath(baseDir, decodeURIComponent(href.split('#')[0]))
    const xml = zip.readText(target)
    if (!xml) return
    const lines = htmlToText(xml)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length === 0) return
    chapters.push({ label: `chapter ${index + 1}`, lines })
  })
  if (chapters.length === 0) throw new DocumentError('这个 EPUB 里没有可读的章节', 'corrupt')
  return { chapters }
}

export { attr }
