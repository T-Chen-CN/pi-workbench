/**
 * pdf.js Worker 单例装配：由 PDF 预览（loadPdf）与扫描页离屏渲染（renderPages）共用，
 * 避免各自维护就绪标志导致重复创建并覆盖 GlobalWorkerOptions.workerPort。
 */
import type * as PdfjsLib from 'pdfjs-dist'

let workerInitPromise: Promise<void> | null = null

export function ensurePdfWorker(pdfjs: typeof PdfjsLib): Promise<void> {
  if (pdfjs.GlobalWorkerOptions.workerPort) {
    return Promise.resolve()
  }
  if (!workerInitPromise) {
    workerInitPromise = import('pdfjs-dist/build/pdf.worker.min.mjs?worker')
      .then(({ default: PdfWorker }) => {
        if (!pdfjs.GlobalWorkerOptions.workerPort) {
          pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()
        }
      })
      .catch((error) => {
        workerInitPromise = null
        throw error
      })
  }
  return workerInitPromise
}
