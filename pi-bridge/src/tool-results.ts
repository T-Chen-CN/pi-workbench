/** 工具结果读取（R-20）：按 toolCallId 从会话消息中提取文本与图片 */

export interface ToolResultPayload {
  toolName: string
  text: string
  images: Array<{ data: string; mimeType: string }>
}

export function findToolResultPayload(
  messages: any[],
  toolCallId: string
): ToolResultPayload | null {
  for (const message of messages) {
    if (!message || message.role !== 'toolResult' || message.toolCallId !== toolCallId) continue
    const content: any[] = Array.isArray(message.content)
      ? message.content
      : typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : []
    const texts: string[] = []
    const images: Array<{ data: string; mimeType: string }> = []
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        texts.push(part.text)
      } else if (part?.type === 'image' && typeof part.data === 'string') {
        images.push({
          data: part.data,
          mimeType: typeof part.mimeType === 'string' ? part.mimeType : 'image/png',
        })
      }
    }
    return {
      toolName: typeof message.toolName === 'string' ? message.toolName : 'tool',
      text: texts.join('\n'),
      images,
    }
  }
  return null
}

export function describeToolResult(payload: ToolResultPayload) {
  const imageBytes = payload.images.reduce(
    (total, image) => total + Math.floor((image.data.length * 3) / 4),
    0
  )
  return {
    toolName: payload.toolName,
    kind: payload.images.length > 0 && payload.text.length === 0 ? ('image' as const) : ('text' as const),
    chars: payload.text.length,
    bytes: Buffer.byteLength(payload.text, 'utf8') + imageBytes,
    lines: payload.text.length === 0 ? 0 : payload.text.split('\n').length,
    imageCount: payload.images.length,
  }
}

/** offset / nextOffset 以 UTF-16 字符计，避免把代理对切成两半 */
export function readToolResultChunk(
  text: string,
  offset = 0,
  limit = 65_536
): { text: string; offset: number; nextOffset: number; chars: number; done: boolean } {
  const start = Math.max(0, Math.min(Math.floor(offset) || 0, text.length))
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, 1_000_000))
  let end = Math.min(text.length, start + size)
  if (end < text.length) {
    const code = text.charCodeAt(end)
    if (code >= 0xdc00 && code <= 0xdfff) end += 1
  }
  return {
    text: text.slice(start, end),
    offset: start,
    nextOffset: end,
    chars: text.length,
    done: end >= text.length,
  }
}
