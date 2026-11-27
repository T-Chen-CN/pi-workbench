/**
 * 文档解析工作线程客户端：
 * 编译态走独立 `documents-worker.js`，Vitest 直跑 `.ts` 源码时自动回退进程内执行。
 */

import { WorkerClient } from '../worker-runner.js'
import {
  readDocument,
  type DocumentReaderDeps,
  type DocumentReadRequest,
  type DocumentReadResult,
  type RenderPagesRequest,
} from './extract.js'
import { readDocumentPreview, type DocumentPreview } from './preview.js'

const workerClient = new WorkerClient(
  new URL('./documents-worker.js', import.meta.url),
  'documents'
)

export async function readDocumentPreviewOffThread(filePath: string): Promise<DocumentPreview> {
  if (!workerClient.isWorkerAvailable()) {
    return readDocumentPreview(filePath)
  }
  return workerClient.call<DocumentPreview>('preview', filePath)
}

export async function readDocumentOffThread(
  request: DocumentReadRequest,
  deps: DocumentReaderDeps = {}
): Promise<DocumentReadResult> {
  if (!workerClient.isWorkerAvailable()) {
    return readDocument(request, deps)
  }
  return workerClient.call<DocumentReadResult>('extract', request, {
    timeoutMs: 90_000,
    onCallback: async (name, payload) => {
      if (name === 'renderPages') {
        if (!deps.renderPages) {
          throw new Error('renderPages callback is unavailable')
        }
        return deps.renderPages(payload as RenderPagesRequest)
      }
      throw new Error(`Unexpected worker callback: ${name}`)
    },
  })
}
