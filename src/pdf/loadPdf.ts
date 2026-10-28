/**
 * pdf.js 入口：只在真正打开 PDF 时被动态导入。
 *
 * - worker 走 Vite 的 `?worker`（与 Monaco 同一个套路），生产环境从 `file://` 加载也能跑；
 * - CMap / 标准字体 / wasm 由 `BundledBinaryDataFactory` 直接给字节，不发起任何协议请求；
 * - 文档本体仍由 `pw-file://` 提供，pdf.js 会按 `rangeChunkSize` 分块拉取。
 */
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'
import { BundledBinaryDataFactory } from './pdfAssets'

let workerReady = false

function ensureWorker(): void {
  if (workerReady) return
  pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()
  workerReady = true
}

export interface LoadPdfResult {
  document: PDFDocumentProxy
  destroy: () => void
}

export async function loadPdf(url: string): Promise<LoadPdfResult> {
  ensureWorker()
  const task = pdfjsLib.getDocument({
    url,
    // 资源随包分发，不让 worker 自己去 fetch
    BinaryDataFactory: BundledBinaryDataFactory,
    // 标准字体用随包的 Foxit 字体，避免依赖宿主系统缺字
    useSystemFonts: false,
    rangeChunkSize: 256 * 1024,
    disableAutoFetch: false,
  })
  const document = await task.promise
  return {
    document,
    destroy: () => {
      void task.destroy()
    },
  }
}
