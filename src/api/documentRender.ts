/**
 * 扫描页渲染桥（渲染层）。
 *
 * 主进程向渲染层要「这几页的 PNG」，因为只有渲染进程有 canvas 与已装配好的 pdf.js。
 * 这里只做三件事：接请求 → 渲图 → 回结果；失败也回结果（带 error），
 * 不能让主进程侧的超时白白等 60 秒。
 */

import { api } from './index'
import { renderPdfPagesToImages } from '../pdf/renderPages'

export interface DocumentRenderRequest {
  id: string
  name: string
  bytes: Uint8Array
  pages: number[]
  scale: number
}

let installed = false

export function installDocumentRenderBridge(): () => void {
  if (installed) return () => {}
  installed = true

  return api.onDocumentRenderRequest((request) => {
    void (async () => {
      try {
        if (!request?.bytes || request.pages.length === 0) {
          await api.documentRenderResult({ id: request?.id ?? '', error: '渲染请求缺少数据' })
          return
        }
        const images = await renderPdfPagesToImages(request.bytes, request.pages, request.scale)
        await api.documentRenderResult({ id: request.id, images })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn('[Documents] Failed to render pages:', message)
        await api.documentRenderResult({ id: request?.id ?? '', error: message }).catch(() => undefined)
      }
    })()
  })
}
