/**
 * 附件 ↔ 上下文块的唯一转换点。
 *
 * 发送（普通发送 / 插话 / 排队重放）与「按历史消息重发」（编辑重发）必须走同一套映射，
 * 否则同一份附件在不同路径上会被解读成不同的东西（历史 bug：插话把所有附件都当成文件，
 * 划词引用的正文因此丢失）。
 */

import type { ContextEntry } from '../api/chatContext'
import type { ChatAttachment } from '../store/chatStore'
import type { MessageContext } from '../types/electron'

let restoreSeq = 0

/** 输入框附件 → 上下文条目：`snippet` 是内联引用，其余按文件只交路径 */
export function attachmentsToContextEntries(list: ChatAttachment[]): ContextEntry[] {
  const entries: ContextEntry[] = []
  for (const attachment of list) {
    if (attachment.kind === 'image') continue
    if (attachment.kind === 'snippet') {
      const content = attachment.content ?? ''
      if (!content) continue
      entries.push({
        kind: 'quote',
        content,
        path: attachment.path || undefined,
        label: attachment.label ?? attachment.name,
        startLine: attachment.startLine,
        endLine: attachment.endLine,
      })
      continue
    }
    entries.push({
      kind: 'file',
      path: attachment.path,
      name: attachment.name,
      size: attachment.size,
      mime: attachment.mime,
      mtime: attachment.mtime,
      external: attachment.external,
    })
  }
  return entries
}

/**
 * 历史消息的 `context` → 附件 chip，用于「编辑重发」把引用/附件重新带上。
 * id 每次重新生成：这些附件不会进输入框，只在本轮发送时消费。
 */
export function contextToAttachments(context: MessageContext): ChatAttachment[] {
  const attachments: ChatAttachment[] = []
  for (const quote of context.quotes) {
    restoreSeq += 1
    attachments.push({
      id: `restored-quote:${Date.now()}-${restoreSeq}`,
      kind: 'snippet',
      path: quote.path ?? '',
      name: quote.label ?? 'quote',
      label: quote.label,
      startLine: quote.startLine,
      endLine: quote.endLine,
      content: quote.content,
    })
  }
  for (const file of context.files) {
    restoreSeq += 1
    attachments.push({
      id: `restored-file:${Date.now()}-${restoreSeq}`,
      kind: 'file',
      path: file.path,
      name: file.name ?? file.path.split(/[\\/]/).filter(Boolean).pop() ?? file.path,
      size: file.size,
      mime: file.mime,
      mtime: file.mtime,
      external: file.external,
    })
  }
  return attachments
}

/** 是否需要把附件写进用户消息的 `context`（用于发送后回显） */
export function hasMessageContext(list: ChatAttachment[]): boolean {
  return list.some((attachment) => attachment.kind !== 'image')
}

/** 输入框附件 → 消息随行上下文（图片走视觉通道，不在这里） */
export function attachmentsToMessageContext(
  list: ChatAttachment[],
  extraFiles: Array<{ path: string; name?: string }> = []
): MessageContext | undefined {
  const entries = attachmentsToContextEntries(list)
  const quotes: MessageContext['quotes'] = []
  const files: MessageContext['files'] = []
  for (const entry of entries) {
    if (entry.kind === 'quote') {
      quotes.push({
        label: entry.label,
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        content: entry.content,
      })
      continue
    }
    files.push({
      path: entry.path,
      name: entry.name,
      size: entry.size,
      mime: entry.mime,
      mtime: entry.mtime,
      external: entry.external,
    })
  }
  for (const file of extraFiles) {
    files.push({ path: file.path, name: file.name })
  }
  if (quotes.length === 0 && files.length === 0) return undefined
  return { quotes, files }
}
