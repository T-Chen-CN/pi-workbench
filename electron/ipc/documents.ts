/**
 * 文档 IPC。
 *
 * 两个方向：
 * - `documents:preview`：渲染层要一份结构化预览模型（docx / xlsx / pptx / epub / odf）；
 * - `documents:render-result`：渲染层把扫描页 PNG 回传给主进程（Agent 视觉通道用）。
 *
 * 拉取式的文本抽取（`documents:extract`）没有暴露成 IPC：调用方是主进程里的
 * Agent 工具，渲染层拿到整篇文档文本没有意义，还会凭空多一条「任意路径读内容」的通道。
 */

import { handleIpc } from './register.js'
import { resolveAllowedFileTarget } from '../workspace-trust.js'
import { settleRenderRequest, type RenderResultPayload } from '../documents/render-bridge.js'
import { readDocumentPreview } from '../documents/preview.js'

export function registerDocumentsIpc(): void {
  handleIpc('documents:preview', async (_event, filePath: string) => {
    try {
      // 与 fs:readFile 同一条校验：受信任工作区 + 非受保护目录
      const target = resolveAllowedFileTarget(filePath)
      if (!target) {
        return { success: false, error: '路径不在当前工作区内' }
      }
      return { success: true, preview: await readDocumentPreview(target) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('documents:render-result', (_event, payload: RenderResultPayload) => {
    if (!payload || typeof payload.id !== 'string') {
      return { success: false, error: 'Invalid render result' }
    }
    settleRenderRequest(payload)
    return { success: true }
  })
}
