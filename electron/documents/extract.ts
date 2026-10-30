/**
 * 文档读取统一入口：路径 + 页码范围 / 工作表 / 幻灯片 → 文本（+ 扫描页图片）。
 *
 * 输出契约（Agent 侧的 `read` 直接把它当文件内容用）：
 * ```
 * --- document: 销售报表.xlsx (3 sheets) ---
 * --- sheet: 汇总 (A1:F42) ---
 * 产品	一月	二月
 * ```
 * 分节标记让模型能引用「第 3 页 / 汇总表 / 第 5 页幻灯片」，也是本方案对
 * 「一个 read 工具覆盖所有格式」承诺的具体形态。
 *
 * 扫描页（没有文本层的 PDF 页）不在这里渲染：主进程没有 canvas。这里只回调
 * 注入的 `renderPages`，由渲染进程用现成的 pdf.js 渲成 PNG 再回传。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { DocumentError } from './errors.js'
import { ZipError, ZipArchive } from './zip.js'
import { legacyOfficeMessage } from './legacy.js'
import { detectDocument, extensionOfPath, type DocumentFormat } from './detect.js'
import {
  readEpub,
  readOpenDocument,
  readPresentation,
  readSpreadsheet,
  readWordDocument,
  type SpreadsheetSheet,
} from './ooxml.js'
import { extractPdfText, isScannedPage } from './pdf.js'

export interface DocumentReadRequest {
  /** 绝对路径（由工具侧解析好） */
  path: string
  /** PDF 页码范围：`3`、`1-5`、`1,3,5` */
  pages?: string
  /** xlsx 工作表名 */
  sheet?: string
  /** pptx 页码范围：`2`、`2-4`（按放映顺序，1 起始） */
  slide?: string
}

export interface DocumentImage {
  data: string
  mimeType: string
}

export interface DocumentDetails {
  format: DocumentFormat
  pageCount?: number
  sheets?: string[]
  slideCount?: number
  /** 被转成图片交给视觉通道的页码 */
  imagePages?: number[]
  /** true 表示没有产出内容，`text` 是给用户看的说明 */
  rejected?: boolean
}

export interface DocumentReadResult {
  text: string
  images: DocumentImage[]
  details: DocumentDetails
}

export interface RenderPagesRequest {
  path: string
  /** 1 起始页码 */
  pages: number[]
  scale: number
}

export interface DocumentReaderDeps {
  /** 渲染层渲页回调；没有窗口时会抛错，由这里降级成文字说明 */
  renderPages?: (request: RenderPagesRequest) => Promise<DocumentImage[]>
}

/** 单次读入的文本上限：工具侧还会按 50KB / 2000 行再截断一次 */
const MAX_TEXT_BYTES = 1_000_000
/** 不指定 pages 时最多解析多少 PDF 页 */
const DEFAULT_PDF_PAGES = 20
/** 扫描页默认渲染几页 / 最多几页 */
const DEFAULT_SCAN_IMAGES = 3
const MAX_SCAN_IMAGES = 10
const SCAN_RENDER_SCALE = 2
/** 单个 sheet 输出上限（行），防止巨型表把上下文塞满 */
const MAX_SHEET_ROWS = 5000

function parsePageRange(spec: string | undefined, max: number): number[] | undefined {
  if (!spec) return undefined
  const pages = new Set<number>()
  for (const part of spec.split(/[,，\s]+/)) {
    if (!part) continue
    const range = /^(\d+)\s*[-~到至]\s*(\d+)$/.exec(part)
    if (range) {
      const start = Number.parseInt(range[1], 10)
      const end = Number.parseInt(range[2], 10)
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      for (let page = Math.min(start, end); page <= Math.max(start, end); page += 1) {
        if (page >= 1 && page <= max) pages.add(page)
        if (pages.size >= 200) break
      }
      continue
    }
    const single = Number.parseInt(part, 10)
    if (Number.isFinite(single) && single >= 1 && single <= max) pages.add(single)
  }
  return pages.size > 0 ? [...pages].sort((a, b) => a - b) : undefined
}

/** 累加文本并守住总字节上限；超限后只追加一次说明 */
class TextSink {
  private readonly lines: string[] = []
  private bytes = 0
  private overflowed = false

  push(line: string): void {
    if (this.overflowed) return
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (this.bytes + size > MAX_TEXT_BYTES) {
      this.overflowed = true
      this.lines.push(
        `（内容超过 ${Math.round(MAX_TEXT_BYTES / 1024)}KB，已停止读取；可用 pages / sheet / slide 参数分段读取）`
      )
      return
    }
    this.bytes += size
    this.lines.push(line)
  }

  pushAll(lines: readonly string[]): void {
    for (const line of lines) this.push(line)
  }

  toString(): string {
    return this.lines.join('\n')
  }
}

function describeError(error: unknown): string {
  if (error instanceof DocumentError) return error.message
  if (error instanceof ZipError) return `文件容器损坏：${error.message}`
  if (error instanceof Error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '文件不存在或已被移动'
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return '没有权限读取这个文件'
    return error.message
  }
  return String(error)
}

function rejectedResult(format: DocumentFormat, message: string): DocumentReadResult {
  return { text: message, images: [], details: { format, rejected: true } }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function sheetRowsText(sheet: SpreadsheetSheet, sink: TextSink): void {
  const dataset = sheet.dimension ? `, ${sheet.dimension}` : ''
  const totalRows = sheet.rows.length
  sink.push(`--- sheet: ${sheet.name} (${totalRows} rows${dataset}) ---`)
  if (sheet.merges.length > 0) sink.push(`（合并单元格：${sheet.merges.slice(0, 20).join(', ')}）`)
  const limit = Math.min(totalRows, MAX_SHEET_ROWS)
  for (let index = 0; index < limit; index += 1) {
    const row = sheet.rows[index]
    if (!row || row.every((cell) => cell === '')) continue
    sink.push(row.join('\t'))
  }
  if (totalRows > limit) {
    sink.push(`（只显示前 ${limit} 行，共 ${totalRows} 行）`)
  }
}

async function readPdf(
  targetPath: string,
  request: DocumentReadRequest,
  deps: DocumentReaderDeps
): Promise<DocumentReadResult> {
  const first = await extractPdfText(targetPath, { maxPages: DEFAULT_PDF_PAGES })
  const pageCount = first.pageCount
  const wanted = parsePageRange(request.pages, pageCount)
  // 指定了页码范围时再单独解析一次（默认那次只覆盖前 N 页）
  const pages =
    wanted && wanted.some((page) => page > DEFAULT_PDF_PAGES)
      ? await extractPdfText(targetPath, { pages: wanted })
      : { ...first, pages: first.pages.filter((page) => !wanted || wanted.includes(page.index)) }

  const sink = new TextSink()
  sink.push(`--- document: ${path.basename(targetPath)} (${pageCount} pages${first.title ? `, title: ${first.title}` : ''}) ---`)
  const scanned: number[] = []
  for (const page of pages.pages) {
    if (isScannedPage(page)) {
      scanned.push(page.index)
      sink.push(`--- page ${page.index} ---`)
      sink.push('（这一页没有文本层）')
      continue
    }
    sink.push(`--- page ${page.index} ---`)
    sink.pushAll(page.text.split('\n'))
  }
  if (!wanted && pageCount > pages.pages.length) {
    sink.push(
      `（只解析了前 ${pages.pages.length} 页，共 ${pageCount} 页；继续读用 pages="1-${DEFAULT_PDF_PAGES}" 之后的页码）`
    )
  }

  const images: DocumentImage[] = []
  const imagePages: number[] = []
  if (scanned.length > 0) {
    const targets = scanned.slice(0, Math.min(DEFAULT_SCAN_IMAGES, MAX_SCAN_IMAGES))
    if (!deps.renderPages) {
      sink.push('')
      sink.push('（没有可用的渲染通道，扫描页无法转成图片；可以先用系统阅读器打开该文件）')
    } else {
      try {
        const rendered = await deps.renderPages({
          path: targetPath,
          pages: targets,
          scale: SCAN_RENDER_SCALE,
        })
        for (const image of rendered) images.push(image)
        if (images.length > 0) {
          imagePages.push(...targets)
          sink.push('')
          sink.push(`（以上第 ${targets.join(', ')} 页已作为图片附上）`)
        }
      } catch (error) {
        sink.push('')
        sink.push(`（扫描页渲染失败：${describeError(error)}；可以先用系统阅读器打开该文件）`)
      }
    }
    if (scanned.length > targets.length) {
      sink.push(`（还有 ${scanned.length - targets.length} 页扫描页未渲染，可用 pages 指定后重试）`)
    }
  }

  return {
    text: sink.toString(),
    images,
    details: { format: 'pdf', pageCount, imagePages: imagePages.length > 0 ? imagePages : undefined },
  }
}

async function readZipDocument(
  targetPath: string,
  format: DocumentFormat,
  request: DocumentReadRequest
): Promise<DocumentReadResult> {
  const buffer = await fs.readFile(targetPath)
  const zip = ZipArchive.open(buffer)
  const sink = new TextSink()
  const name = path.basename(targetPath)

  if (format === 'docx' || (!zip.has('xl/workbook.xml') && zip.has('word/document.xml'))) {
    const model = readWordDocument(zip)
    sink.push(`--- document: ${name} (${model.lines.length} lines) ---`)
    sink.pushAll(model.lines)
    return { text: sink.toString(), images: [], details: { format: 'docx' } }
  }

  if (format === 'xlsx' || zip.has('xl/workbook.xml')) {
    const model = readSpreadsheet(zip)
    const wanted = request.sheet?.trim().toLowerCase()
    const sheets = wanted
      ? model.sheets.filter((sheet) => sheet.name.trim().toLowerCase() === wanted)
      : model.sheets
    const names = model.sheets.map((sheet) => sheet.name)
    sink.push(`--- document: ${name} (${names.length} sheets: ${names.join(', ')}) ---`)
    if (sheets.length === 0) {
      sink.push(`（没有名为「${request.sheet}」的工作表；可用工作表：${names.join(', ')}）`)
      return { text: sink.toString(), images: [], details: { format: 'xlsx', sheets: names } }
    }
    for (const sheet of sheets) sheetRowsText(sheet, sink)
    return { text: sink.toString(), images: [], details: { format: 'xlsx', sheets: names } }
  }

  if (format === 'pptx' || zip.has('ppt/presentation.xml')) {
    const model = readPresentation(zip)
    const wanted = parsePageRange(request.slide, model.slides.length)
    const slides = wanted ? model.slides.filter((slide) => wanted.includes(slide.index)) : model.slides
    sink.push(`--- document: ${name} (${model.slides.length} slides) ---`)
    for (const slide of slides) {
      sink.push(`--- slide ${slide.index} ---`)
      if (slide.lines.length === 0) sink.push('（这一页只有图或表格，没有可提取的文字）')
      else sink.pushAll(slide.lines)
    }
    if (model.images.length > 0) {
      sink.push(`（演示文稿内含 ${model.images.length} 张图片，可在程序内的预览里查看）`)
    }
    return {
      text: sink.toString(),
      images: [],
      details: { format: 'pptx', slideCount: model.slides.length },
    }
  }

  if (format === 'odt' || format === 'ods' || format === 'odp') {
    const model = readOpenDocument(zip)
    sink.push(`--- document: ${name} (${model.lines.length} lines) ---`)
    sink.pushAll(model.lines)
    return { text: sink.toString(), images: [], details: { format } }
  }

  if (format === 'epub' || zip.has('META-INF/container.xml')) {
    const model = readEpub(zip)
    sink.push(`--- document: ${name} (${model.chapters.length} chapters) ---`)
    for (const chapter of model.chapters) {
      sink.push(`--- ${chapter.label} ---`)
      sink.pushAll(chapter.lines)
    }
    return { text: sink.toString(), images: [], details: { format: 'epub' } }
  }

  throw new DocumentError(
    '这个 ZIP 容器里没有找到可识别的文档结构（既不是 docx / xlsx / pptx，也不是 ODF 或 EPUB）',
    'unsupported'
  )
}

/**
 * 读取一个文档。已知问题不抛异常，而是返回带说明的文本：
 * 模型读到说明后能直接告诉用户怎么做（另存、去密码、指定页码）。
 */
export async function readDocument(
  request: DocumentReadRequest,
  deps: DocumentReaderDeps = {}
): Promise<DocumentReadResult> {
  const targetPath = request.path
  try {
    const stats = await fs.stat(targetPath)
    if (!stats.isFile()) return rejectedResult('unknown', `${targetPath} 不是一个文件`)
    if (stats.size === 0) return rejectedResult('unknown', `${path.basename(targetPath)} 是空文件`)

    const sniff = await detectDocument(targetPath)
    if (sniff.legacy || sniff.format === 'legacy-office') {
      return { ...rejectedResult('legacy-office', legacyOfficeMessage(sniff.extension)), details: { format: 'legacy-office', rejected: true } }
    }
    if (sniff.format === 'pdf') return await readPdf(targetPath, request, deps)
    if (!sniff.isDocument) {
      return rejectedResult(sniff.format, `${path.basename(targetPath)}（${formatSize(stats.size)}）不是可提取内容的文档格式`)
    }
    return await readZipDocument(targetPath, sniff.format, request)
  } catch (error) {
    const extension = extensionOfPath(targetPath)
    return rejectedResult(extension === 'pdf' ? 'pdf' : 'unknown', describeError(error))
  }
}
