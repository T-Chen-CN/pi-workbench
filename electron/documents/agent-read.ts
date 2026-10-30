/**
 * `read` 工具的文档回调实现（主进程侧）。
 *
 * 判断「是不是文档」用魔数（`detectDocument`），所以：
 * - `.pdf` 其实是纯文本 → 返回 null，Agent 的内置 read 照常按文本读；
 * - `.docx` 其实是 OLE 旧格式（改后缀）→ 走文档管线给出「另存为」提示。
 */

import { detectDocument } from './detect.js'
import { readDocument } from './extract.js'
import { renderDocumentPages } from './render-bridge.js'

export interface AgentDocumentRequest {
  path: string
  pages?: string
  sheet?: string
  slide?: string
}

export interface AgentDocumentContent {
  text: string
  images: { data: string; mimeType: string }[]
  rejected?: boolean
  format?: string
}

/** 返回 null 表示「不是文档」，交回内置 read */
export async function readDocumentForAgent(
  request: AgentDocumentRequest
): Promise<AgentDocumentContent | null> {
  if (!request || typeof request.path !== 'string' || !request.path) return null
  let isDocument = false
  try {
    isDocument = (await detectDocument(request.path)).isDocument
  } catch {
    // 文件不存在 / 无权限：让内置 read 去报标准错误
    return null
  }
  if (!isDocument) return null

  const result = await readDocument(
    {
      path: request.path,
      pages: request.pages,
      sheet: request.sheet,
      slide: request.slide,
    },
    { renderPages: renderDocumentPages }
  )
  return {
    text: result.text,
    images: result.images,
    rejected: result.details.rejected,
    format: result.details.format,
  }
}
