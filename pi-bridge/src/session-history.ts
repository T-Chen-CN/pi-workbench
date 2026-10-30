/**
 * 会话消息归一化：把会话时间线转成聊天面板的 parts 时间线。
 *
 * 输入是 session-entries 的 `activeTimeline()`（当前分支的完整 entry 路径），
 * 因此压缩前的历史与压缩点位置都能还原；`role:'compactionSummary'` 这类
 * 投影产物不再参与，历史不再从 `session.messages` 截断而来。
 */
import type { AgentMessage, AgentTracePart, MessageContext } from './types.js'
import type { TimelineItem } from './session-entries.js'
import { parseContextBlock, stripContextBlock, summarizeToolArgs, summarizeToolResult } from './text-utils.js'

/** 用户消息：正文去掉内部块，随行的引用 / 附件单独携带，供界面回显 */
export function userMessageFromRaw(
  raw: string,
  timestamp: number,
  images?: AgentMessage['images']
): AgentMessage {
  const context: MessageContext | null = parseContextBlock(raw)
  const stripped = stripContextBlock(raw)
  return {
    role: 'user',
    // 纯附件消息的占位文案在有 chip 时不显示（否则气泡里会同时出现“已附加”与 chip）
    content: context && stripped === '(attached files)' ? '' : stripped,
    ...(images && images.length > 0 ? { images } : {}),
    ...(context ? { context } : {}),
    timestamp,
  }
}

export function buildSessionMessagesFromEntries(
  items: TimelineItem[],
  options: {
    thinkingDurations: Record<string, number[]>
    toolFilePath: (toolName: string, args: any) => string | undefined
  }
): AgentMessage[] {
  const { thinkingDurations, toolFilePath } = options

  const result: AgentMessage[] = []
  let turn: { parts: AgentTracePart[]; timestamp?: number } | null = null
  let partSeq = 0

  const nextId = (prefix: string) => `${prefix}-${++partSeq}`

  const flushTurn = () => {
    if (!turn || turn.parts.length === 0) {
      turn = null
      partSeq = 0
      return
    }
    const content = turn.parts
      .filter((part): part is Extract<AgentTracePart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    result.push({
      role: 'assistant',
      content,
      parts: turn.parts,
      timestamp: turn.timestamp ?? Date.now(),
    })
    turn = null
    partSeq = 0
  }

  const pushCompaction = (item: Extract<TimelineItem, { kind: 'compaction' }>) => {
    if (!turn) turn = { parts: [], timestamp: item.timestamp }
    turn.parts.push({
      type: 'compaction',
      id: item.entryId ? `compaction-${item.entryId}` : nextId('compaction'),
      entryId: item.entryId || undefined,
      timestamp: item.timestamp,
      tokensBefore: item.tokensBefore,
    })
  }

  for (const item of items) {
    if (item.kind === 'compaction') {
      // 不 flush 轮次：压缩点落在它发生的那一轮里，位置与实时一致
      pushCompaction(item)
      continue
    }

    const msg = item.message as any
    if (!msg) continue

    if (msg.role === 'user') {
      flushTurn()
      const raw =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((part: any) => part?.type === 'text')
                .map((part: any) => part.text)
                .join('\n')
            : ''
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((part: any) => part?.type === 'image' && typeof part.data === 'string')
            .map((part: any) => ({
              data: part.data as string,
              mimeType: typeof part.mimeType === 'string' ? part.mimeType : 'image/png',
            }))
        : []
      result.push(
        userMessageFromRaw(
          raw,
          typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
          images
        )
      )
      continue
    }

    if (msg.role === 'assistant') {
      if (!turn) turn = { parts: [] }
      if (turn.timestamp === undefined) {
        turn.timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
      }

      if (typeof msg.content === 'string') {
        if (msg.content) {
          turn.parts.push({ type: 'text', id: nextId('text'), text: msg.content })
        }
      } else if (Array.isArray(msg.content)) {
        let thinkingIndex = 0
        for (const part of msg.content) {
          if (!part) continue
          if (part.type === 'text' && typeof part.text === 'string') {
            turn.parts.push({ type: 'text', id: nextId('text'), text: part.text })
          } else if (part.type === 'thinking') {
            const durations = thinkingDurations[String(msg.timestamp)] ?? []
            turn.parts.push({
              type: 'thinking',
              id: nextId('thinking'),
              text: typeof part.thinking === 'string' ? part.thinking : '',
              redacted: part.redacted === true,
              durationMs: durations[thinkingIndex],
            })
            thinkingIndex++
          } else if (part.type === 'toolCall') {
            const toolName = String(part.name ?? 'tool')
            const toolCallId = String(part.id ?? nextId('tool'))
            turn.parts.push({
              type: 'tool',
              id: toolCallId,
              toolCallId,
              toolName,
              argsSummary: summarizeToolArgs(toolName, part.arguments ?? {}),
              status: 'running',
              filePath: toolFilePath(toolName, part.arguments ?? {}),
            })
          }
        }
      }
      continue
    }

    if (msg.role === 'toolResult') {
      if (!turn) continue
      const toolPart = turn.parts.find(
        (part): part is Extract<AgentTracePart, { type: 'tool' }> =>
          part.type === 'tool' && part.toolCallId === msg.toolCallId
      )
      if (!toolPart) continue
      toolPart.status = msg.isError ? 'error' : 'success'
      toolPart.isError = Boolean(msg.isError)
      if (typeof msg.durationMs === 'number') toolPart.durationMs = msg.durationMs
      toolPart.resultPreview = summarizeToolResult(
        { content: msg.content, details: msg.details },
        msg.toolName === 'bash' || msg.toolName === 'powershell'
      )
    }
  }

  flushTurn()
  return result
}
