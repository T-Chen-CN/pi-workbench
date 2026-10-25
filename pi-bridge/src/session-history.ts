/** 会话消息归一化：把 Pi JSONL 消息转成聊天面板的 parts 时间线 */
import type { AgentMessage, AgentTracePart } from './types.js'
import { stripContextBlock, summarizeToolArgs, summarizeToolResult } from './text-utils.js'

export function buildSessionMessages(
  messages: any[],
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

    for (const msg of messages as any[]) {
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
              .filter(
                (part: any) => part?.type === 'image' && typeof part.data === 'string'
              )
              .map((part: any) => ({
                data: part.data as string,
                mimeType:
                  typeof part.mimeType === 'string' ? part.mimeType : 'image/png',
              }))
          : []
        result.push({
          role: 'user',
          content: stripContextBlock(raw),
          images: images.length > 0 ? images : undefined,
          timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
        })
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
              const durations =
                thinkingDurations[String(msg.timestamp)] ?? []
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
