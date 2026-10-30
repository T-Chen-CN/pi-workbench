/**
 * 程序内只读预览的数据模型。
 *
 * 为什么先转成结构化模型、再交给渲染层画，而不是把原始字节丢给某个第三方
 * 渲染器：
 * - **一个解析器两种用途**：Agent 读到的文字和用户在预览里看到的块来自同一份
 *   `ooxml` / `epub` 解析结果，用户能直接核对「模型到底读到了什么」；
 * - docx-preview 之类的渲染器会注入自己的字体、颜色与白色纸张底，和 Paper / Ink
 *   两套主题、设计系统的 token 打架，还要额外 0.9MB；
 * - 只读预览不需要排版引擎级别的保真，标题 / 段落 / 列表 / 表格 / 图片已经够用。
 *
 * 与 `extract.ts` 的分工：那边产出给模型看的**文本**（带 `--- page N ---` 分节、
 * 50KB 截断），这里产出给界面看的**结构**（行数上限更小，避免一屏画十万个格子）。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { DocumentError } from './errors.js'
import { ZipArchive, ZipError } from './zip.js'
import { legacyOfficeMessage } from './legacy.js'
import { detectDocument, extensionOfPath, type DocumentFormat } from './detect.js'
import {
  readEpub,
  readOpenDocument,
  readPresentation,
  readSpreadsheet,
  readWordDocument,
  type PresentationImage,
  type WordBlock,
} from './ooxml.js'

export type PreviewBlock = WordBlock

export interface PreviewSheet {
  name: string
  /** 表头行号起点固定为 1；预览只画有限行列 */
  rows: string[][]
  dimension?: string
  merges: string[]
  /** 行列被裁剪过 */
  truncated: boolean
}

export interface PreviewSlide {
  index: number
  lines: string[]
  images: PresentationImage[]
}

export interface PreviewChapter {
  label: string
  lines: string[]
}

export type DocumentPreview =
  | { kind: 'word'; format: DocumentFormat; blocks: PreviewBlock[]; truncated: boolean }
  | { kind: 'sheet'; format: DocumentFormat; sheets: PreviewSheet[] }
  | { kind: 'slide'; format: DocumentFormat; slides: PreviewSlide[] }
  | { kind: 'epub'; format: DocumentFormat; chapters: PreviewChapter[] }
  /** PDF 交给渲染层现成的 PdfReadingView，主进程不需要再抽一遍 */
  | { kind: 'pdf'; format: 'pdf' }
  | { kind: 'legacy'; format: 'legacy-office'; message: string }
  | { kind: 'error'; message: string }

/** 预览行列上限：一屏几百行足够，再多也是滚动找罪受 */
const PREVIEW_ROWS = 300
const PREVIEW_COLUMNS = 60
const PREVIEW_BLOCKS = 4000
const PREVIEW_SLIDES = 200
const PREVIEW_CHAPTERS = 200
const PREVIEW_LINES_PER_SECTION = 400

function blocksFromLines(lines: string[]): PreviewBlock[] {
  const blocks: PreviewBlock[] = []
  for (const line of lines.slice(0, PREVIEW_BLOCKS)) {
    // ODF 把表格行拼成制表符分隔的一行：还原成表格块，预览才有列
    if (line.includes('\t')) {
      blocks.push({ type: 'table', rows: [line.split('\t')] })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }
    if (line.startsWith('- ')) {
      blocks.push({ type: 'bullet', text: line.slice(2) })
      continue
    }
    blocks.push({ type: 'paragraph', text: line })
  }
  return blocks
}

/** xx.xml → `../media/image1.png` 之类的相对目标解析成 ZIP 内路径 */
function slideImages(zip: ZipArchive, slidePath: string): PresentationImage[] {
  const relsPath = slidePath.replace(/slides\/([^/]+)$/, 'slides/_rels/$1.rels')
  const rels = zip.readText(relsPath)
  if (!rels) return []
  const images: PresentationImage[] = []
  for (const token of scanRelationships(rels)) {
    if (!token) continue
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(slidePath), token))
    if (!resolved.startsWith('ppt/media/')) continue
    const mime = MIME_BY_EXTENSION[extensionOfPath(resolved)]
    if (!mime) continue
    const buffer = zip.read(resolved)
    if (!buffer || buffer.length > 8 * 1024 * 1024) continue
    images.push({ name: resolved, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` })
  }
  return images
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

/** 从 rels XML 里取 Target（只关心图片关系） */
function* scanRelationships(xml: string): Generator<string> {
  const pattern = /<Relationship\b[^>]*\/?>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    const target = /\bTarget="([^"]+)"/.exec(match[0])
    if (target) yield target[1]
  }
}

function previewWord(zip: ZipArchive, format: DocumentFormat): DocumentPreview {
  const model = readWordDocument(zip)
  return {
    kind: 'word',
    format,
    blocks: model.blocks.slice(0, PREVIEW_BLOCKS),
    truncated: model.blocks.length > PREVIEW_BLOCKS,
  }
}

function previewOpenDocument(zip: ZipArchive, format: DocumentFormat): DocumentPreview {
  const model = readOpenDocument(zip)
  return {
    kind: 'word',
    format,
    blocks: blocksFromLines(model.lines),
    truncated: model.lines.length > PREVIEW_BLOCKS,
  }
}

function previewSheet(zip: ZipArchive, format: DocumentFormat): DocumentPreview {
  const model = readSpreadsheet(zip)
  const sheets: PreviewSheet[] = model.sheets.map((sheet) => {
    const rows = sheet.rows.slice(0, PREVIEW_ROWS).map((row) => row.slice(0, PREVIEW_COLUMNS))
    // 尾部整行空白没有意义（Excel 常在格式刷后留下大量空行）
    while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === '')) rows.pop()
    const truncated =
      sheet.rows.length > PREVIEW_ROWS ||
      sheet.rows.some((row) => row.length > PREVIEW_COLUMNS)
    return { name: sheet.name, rows, dimension: sheet.dimension, merges: sheet.merges, truncated }
  })
  return { kind: 'sheet', format, sheets }
}

function previewSlide(zip: ZipArchive, format: DocumentFormat): DocumentPreview {
  const model = readPresentation(zip)
  const slides = model.slides.slice(0, PREVIEW_SLIDES).map((slide) => {
    const file = `ppt/slides/slide${slide.index}.xml`
    return {
      index: slide.index,
      lines: slide.lines.slice(0, PREVIEW_LINES_PER_SECTION),
      images: slideImages(zip, file),
    }
  })
  // 幻灯片的图片挂在各自的 rels 上；解析不到时退回全局图片，至少别丢内容
  const hasSlideImages = slides.some((slide) => slide.images.length > 0)
  if (!hasSlideImages && model.images.length > 0) {
    slides.forEach((slide) => {
      slide.images = model.images
    })
  }
  return { kind: 'slide', format, slides }
}

function previewEpub(zip: ZipArchive, format: DocumentFormat): DocumentPreview {
  const model = readEpub(zip)
  return {
    kind: 'epub',
    format,
    chapters: model.chapters.slice(0, PREVIEW_CHAPTERS).map((chapter) => ({
      label: chapter.label,
      lines: chapter.lines.slice(0, PREVIEW_LINES_PER_SECTION),
    })),
  }
}

/**
 * 读取一个文档的预览模型。
 *
 * 与 `readDocument` 一样：已知问题不抛异常，返回 `error` / `legacy` 分支，
 * 由界面直接展示（这里不用抛错是因为预览不是工具调用，没有失败语义）。
 */
export async function readDocumentPreview(targetPath: string): Promise<DocumentPreview> {
  try {
    const stats = await fs.stat(targetPath)
    if (!stats.isFile()) return { kind: 'error', message: '目标不是一个文件' }
    if (stats.size === 0) return { kind: 'error', message: '文件是空的' }

    const sniff = await detectDocument(targetPath)
    if (sniff.legacy || sniff.format === 'legacy-office') {
      return {
        kind: 'legacy',
        format: 'legacy-office',
        message: legacyOfficeMessage(sniff.extension),
      }
    }
    if (sniff.format === 'pdf') return { kind: 'pdf', format: 'pdf' }
    if (!sniff.isDocument) return { kind: 'error', message: '不是可预览的文档格式' }

    const zip = ZipArchive.open(await fs.readFile(targetPath))
    const format = sniff.format
    if (format === 'docx' || (!zip.has('xl/workbook.xml') && zip.has('word/document.xml'))) {
      return previewWord(zip, format)
    }
    if (format === 'xlsx' || zip.has('xl/workbook.xml')) return previewSheet(zip, format)
    if (format === 'pptx' || zip.has('ppt/presentation.xml')) return previewSlide(zip, format)
    if (format === 'epub' || zip.has('META-INF/container.xml')) return previewEpub(zip, format)
    if (format === 'odt' || format === 'ods' || format === 'odp') {
      return previewOpenDocument(zip, format)
    }
    return { kind: 'error', message: '这个 ZIP 里没有可识别的文档结构' }
  } catch (error) {
    if (error instanceof DocumentError || error instanceof ZipError) {
      return { kind: 'error', message: error.message }
    }
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}
