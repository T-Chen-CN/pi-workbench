/**
 * 文档解析与预览工作线程：
 * 承载 ZIP 解压、OOXML/ODF/EPUB 解析与 pdf.js 文本抽取，避免阻塞 Electron 主线程。
 * 扫描 PDF 仍需渲染进程 canvas 渲页时，通过 `cb` 消息回调主线程 `renderDocumentPages`。
 */

import { parentPort } from 'worker_threads'
import { readDocument, type DocumentImage, type DocumentReadRequest, type RenderPagesRequest } from './extract.js'
import { readDocumentPreview } from './preview.js'
import type {
  WorkerCallbackMessage,
  WorkerCallbackReplyMessage,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from '../worker-runner.js'

if (!parentPort) {
  throw new Error('documents-worker must run inside a worker_threads Worker')
}
const port = parentPort

let nextCallId = 1
const pendingCallbacks = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

function invokeHostCallback<T>(requestId: number, name: string, payload: unknown): Promise<T> {
  const callId = nextCallId++
  return new Promise<T>((resolve, reject) => {
    pendingCallbacks.set(callId, {
      resolve: resolve as (value: unknown) => void,
      reject,
    })
    const msg: WorkerCallbackMessage = { type: 'cb', requestId, callId, name, payload }
    port.postMessage(msg)
  })
}

port.on('message', (msg: WorkerRequestMessage | WorkerCallbackReplyMessage) => {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'cb-res') {
    const pending = pendingCallbacks.get(msg.callId)
    if (!pending) return
    pendingCallbacks.delete(msg.callId)
    if (msg.ok) pending.resolve(msg.result)
    else pending.reject(new Error(msg.error || 'Host callback failed'))
    return
  }
  if (msg.type !== 'req') return

  void (async () => {
    try {
      let result: unknown
      if (msg.method === 'preview') {
        result = await readDocumentPreview(String(msg.payload))
      } else if (msg.method === 'extract') {
        const request = msg.payload as DocumentReadRequest
        result = await readDocument(request, {
          renderPages: (renderReq: RenderPagesRequest) =>
            invokeHostCallback<DocumentImage[]>(msg.id, 'renderPages', renderReq),
        })
      } else {
        throw new Error(`Unknown documents-worker method: ${msg.method}`)
      }
      const res: WorkerResponseMessage = { type: 'res', id: msg.id, ok: true, result }
      port.postMessage(res)
    } catch (error) {
      const res: WorkerResponseMessage = {
        type: 'res',
        id: msg.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
      port.postMessage(res)
    }
  })()
})
