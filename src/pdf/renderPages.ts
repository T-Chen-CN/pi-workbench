/**
 * 把 PDF 指定页渲成 PNG（渲染进程），供 Agent 的视觉通道读取扫描件。
 *
 * 复用 `loadPdf` 的 worker 与随包资源装配，只是数据源换成主进程递过来的字节：
 * 渲染层始终没有「按任意路径读文件」的能力，路径权限边界不动。
 *
 * 画布只用于这一张临时图，不需要进 DOM：pdf.js 只要拿到 2D context 就能画。
 */

import { BundledBinaryDataFactory } from './pdfAssets'

/** 单页最长边上限：2 倍缩放后再收敛，避免 4K 屏上生成 8000px 的大图 */
const MAX_EDGE = 2400
/** 单张 PNG 上限：超过就降到 JPEG，避免 base64 撑爆上下文 */
const MAX_PNG_BYTES = 3 * 1024 * 1024

export interface RenderedPageImage {
  data: string
  mimeType: string
}

async function loadFromBytes(bytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist')
  // worker 已在 loadPdf 里装配；这里也装一次以防先渲染后阅读
  const PdfWorker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?worker')).default
  if (!pdfjs.GlobalWorkerOptions.workerPort) {
    pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()
  }
  const task = pdfjs.getDocument({
    data: bytes,
    BinaryDataFactory: BundledBinaryDataFactory,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
  })
  return { document: await task.promise, destroy: () => void task.destroy() }
}

function toDataUrl(canvas: HTMLCanvasElement): RenderedPageImage {
  const png = canvas.toDataURL('image/png')
  // base64 长度 ≈ 字节 × 4/3
  if (png.length * 0.75 <= MAX_PNG_BYTES) return { data: png, mimeType: 'image/png' }
  const jpeg = canvas.toDataURL('image/jpeg', 0.9)
  return { data: jpeg, mimeType: 'image/jpeg' }
}

/** 只返回 `data`（base64）与 mimeType，主进程侧直接包进 ImageContent */
export async function renderPdfPagesToImages(
  bytes: Uint8Array,
  pages: number[],
  scale: number
): Promise<RenderedPageImage[]> {
  const { document: pdfDocument, destroy } = await loadFromBytes(bytes)
  const images: RenderedPageImage[] = []
  try {
    for (const pageNumber of pages) {
      if (pageNumber < 1 || pageNumber > pdfDocument.numPages) continue
      const page = await pdfDocument.getPage(pageNumber)
      const base = page.getViewport({ scale: 1 })
      const longest = Math.max(base.width, base.height)
      const effective = Math.min(scale, MAX_EDGE / Math.max(longest, 1))
      const viewport = page.getViewport({ scale: Math.max(effective, 0.5) })
      const canvas = window.document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建画布上下文')
      // 白底：扫描件常自带透明区域，落成 PNG 会是黑底
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: context, viewport }).promise
      images.push(toDataUrl(canvas))
      page.cleanup()
      canvas.width = 0
      canvas.height = 0
    }
  } finally {
    destroy()
  }
  return images
}
