/**
 * PDF 文本层抽取（主进程，pdf.js legacy 构建）。
 *
 * 只做「有没有文字」这件事：逐页 `getTextContent()`，不下载字体、不取图、
 * 不渲染。拿不到文字的页就是扫描页，交给渲染层渲成 PNG 走视觉通道
 * （本机 pdf.js 需要 canvas，只能在渲染进程做）。
 *
 * pdfjs-dist 已在 `dependencies` 里（渲染层在用），主进程复用同一份包，
 * 因此这条链路没有新增任何依赖。
 */

import * as fs from 'fs/promises'
import { DocumentError } from './errors.js'

type PdfjsModule = typeof import('pdfjs-dist')

/** 一页里少于这个字数就当作「没有文本层」（页眉页脚 / 页码不算内容） */
export const SCANNED_CHAR_THRESHOLD = 20

let cachedModule: Promise<PdfjsModule> | null = null

/**
 * legacy 构建面向 Node，不依赖 DOM / Worker。
 * 用变量说明符是为了让类型来自根包（`pdfjs-dist`），运行时指向 legacy 产物。
 */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!cachedModule) {
    const specifier = 'pdfjs-dist/legacy/build/pdf.mjs'
    cachedModule = import(specifier) as Promise<PdfjsModule>
    cachedModule.catch(() => {
      cachedModule = null
    })
  }
  return cachedModule
}

export interface PdfPageText {
  /** 1 起始页码 */
  index: number
  text: string
  /** 去掉空白后的字数：判定是否为扫描页 */
  charCount: number
}

export interface PdfTextResult {
  pageCount: number
  pages: PdfPageText[]
  /** 文档元数据里的标题（常常为空） */
  title?: string
}

function textFromItems(items: readonly unknown[]): string {
  let output = ''
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { str?: unknown; hasEOL?: unknown }
    if (typeof record.str !== 'string') continue
    output += record.str
    if (record.hasEOL === true) output += '\n'
  }
  return output
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function describePdfError(error: unknown): DocumentError {
  const name = typeof error === 'object' && error !== null ? (error as { name?: string }).name : ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'PasswordException') {
    return new DocumentError('这个 PDF 有密码保护，请先在阅读器里解除密码后再试', 'unsupported')
  }
  if (name === 'InvalidPDFException') {
    return new DocumentError('这个文件不是有效的 PDF，或内容已损坏', 'corrupt')
  }
  if (name === 'MissingPDFException') {
    return new DocumentError('找不到这个 PDF 文件', 'corrupt')
  }
  return new DocumentError(`PDF 读取失败：${message}`, 'corrupt')
}

export interface PdfTextOptions {
  /** 只解析这些页（1 起始）；省略则全部解析 */
  pages?: number[]
  /** 省略 `pages` 时最多解析多少页 */
  maxPages?: number
}

export async function extractPdfText(
  targetPath: string,
  options: PdfTextOptions = {}
): Promise<PdfTextResult> {
  const buffer = await fs.readFile(targetPath)
  const pdfjs = await loadPdfjs()
  // 复制一份：pdf.js 会接管（并可能分离）传入的 TypedArray
  const data = new Uint8Array(buffer.byteLength)
  data.set(buffer)

  const task = pdfjs.getDocument({
    data,
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
  })

  let document: Awaited<typeof task.promise>
  try {
    document = await task.promise
  } catch (error) {
    void task.destroy()
    throw describePdfError(error)
  }

  try {
    const pageCount = document.numPages
    const requested = options.pages?.length
      ? options.pages.filter((page) => page >= 1 && page <= pageCount)
      : Array.from(
          { length: Math.min(pageCount, options.maxPages ?? pageCount) },
          (_, index) => index + 1
        )

    const pages: PdfPageText[] = []
    for (const pageNumber of requested) {
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const text = textFromItems(content.items)
        pages.push({
          index: pageNumber,
          text,
          charCount: text.replace(/\s/g, '').length,
        })
      } finally {
        page.cleanup()
      }
    }

    let title: string | undefined
    try {
      const metadata = await document.getMetadata()
      const raw = (metadata.info as { Title?: unknown } | undefined)?.Title
      if (typeof raw === 'string' && raw.trim()) title = raw.trim()
    } catch {
      // 元数据读不出来不影响正文
    }

    return { pageCount, pages, title }
  } catch (error) {
    throw describePdfError(error)
  } finally {
    // pdf.js v6 把销毁挂在 loadingTask 上（document 只有 cleanup）
    await task.destroy()
  }
}

export function isScannedPage(page: PdfPageText): boolean {
  return page.charCount < SCANNED_CHAR_THRESHOLD
}
