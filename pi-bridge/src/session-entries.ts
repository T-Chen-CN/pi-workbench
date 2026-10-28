/**
 * 会话时间线（单一真相源）
 *
 * Pi 有两份数据：会话记录（JSONL 的全部 entry，只增不删）与模型上下文
 * （压缩裁剪后的投影）。历史与导出必须取前者，否则会出现「压缩前历史消失」
 * 「压缩点没有位置」这类问题。
 *
 * 这里沿当前分支的 parentId 链取回完整 entry 路径，应用 context_edit，
 * 并把 compaction 还原成时间线上的一个位置点，供聊天面板与 md/html 导出共用。
 */

import type { SessionManager } from '@earendil-works/pi-coding-agent'

export type TimelineItem =
  | { kind: 'message'; message: any }
  | {
      kind: 'compaction'
      entryId: string
      timestamp: number
      tokensBefore?: number
    }

/** entry.timestamp 既可能是 ISO 字符串，也可能是毫秒数 */
export function entryTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

/** 按 context_edit 的 replacement 改写消息内容，语义与 Pi 的投影保持一致 */
function applyReplacement(message: any, replacement: any): any {
  if (!replacement || typeof replacement !== 'object' || !('content' in replacement)) {
    return message
  }
  const role = message?.role
  const content =
    (role === 'assistant' || role === 'toolResult') && typeof replacement.content === 'string'
      ? [{ type: 'text', text: replacement.content }]
      : replacement.content
  return { ...message, content }
}

/**
 * 当前分支的完整时间线：root → leaf，含已被压缩摘要掉的旧消息。
 * 废弃分支不会出现（沿 parentId 链而非文件行序）。
 */
export function activeTimeline(manager: SessionManager): TimelineItem[] {
  const branch = (manager.getBranch() ?? []) as any[]

  // 同一目标可能被多次编辑，取最后一次（路径是时间顺序，后写覆盖先写）
  const edits = new Map<string, any>()
  for (const entry of branch) {
    if (entry?.type !== 'context_edit') continue
    if (typeof entry.targetId !== 'string') continue
    edits.set(entry.targetId, entry.replacement ?? null)
  }

  const items: TimelineItem[] = []
  for (const entry of branch) {
    if (!entry) continue

    if (entry.type === 'compaction') {
      items.push({
        kind: 'compaction',
        entryId: String(entry.id ?? ''),
        timestamp: entryTimestamp(entry.timestamp),
        tokensBefore:
          typeof entry.tokensBefore === 'number' ? entry.tokensBefore : undefined,
      })
      continue
    }

    if (entry.type !== 'message' || !entry.message) continue

    if (edits.has(entry.id)) {
      const replacement = edits.get(entry.id)
      // replacement === null：该条被省略（overflow 恢复会这样隐藏失败的那次尝试）
      if (replacement === null) continue
      items.push({ kind: 'message', message: applyReplacement(entry.message, replacement) })
      continue
    }

    items.push({ kind: 'message', message: entry.message })
  }

  return items
}
