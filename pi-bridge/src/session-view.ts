/**
 * 会话渲染单一投影（chat-render-single-source）：
 *
 * 将会话分支时间线（`TimelineItem[]`）确定性地归一化为 `AgentMessage[]`，
 * 供历史重载、轮末对账与会话导出共用同一口径：
 * - 携带持久化 `entryId` 作为分支切换与虚拟列表的稳定锚点；
 * - 聚合多步 assistant 轮次的 `usage`（token 与费用），消除重载消失与多步漏计；
 * - 缺失时间戳时沿上一条 +1 推进（不调用 Date.now()），保证同份记录每次投影逐字段一致；
 * - 保留 `parentToolCallId`，使用基于 `entryId` 的确定性 part id。
 */

import type { AgentMessage, AgentTracePart, AgentUsage, MessageContext } from './types.js'
import type { TimelineItem } from './session-entries.js'
import { CLOUD_TASK_EVENT_CUSTOM_TYPE } from './cloud-protocol.js'
import {
  parseContextBlock,
  stripContextBlock,
  summarizeToolArgs,
  summarizeToolResult,
} from './text-utils.js'

export interface DeriveMessagesOptions {
  thinkingDurations: Record<string, number[]>
  toolFilePath: (toolName: string, args: any) => string | undefined
  /**
   * 正在流式执行时置 true：最后一个助手轮次中仍在执行的工具保持 `running`，
   * 仅把更早的历史轮次中因崩溃未闭合的工具归一为 `error`。缺省 false（历史加载全量归一）。
   */
  isLiveStreaming?: boolean
  /** 显式已知仍在执行的工具调用 ID 集合（优先于 isLiveStreaming 的整尾轮豁免） */
  activeToolCallIds?: ReadonlySet<string>
}

/** 从 assistant 消息中提取 usage */
export function readMessageUsage(message: any): AgentUsage | undefined {
  const raw = message?.usage
  if (!raw || typeof raw !== 'object') return undefined
  const value = (input: unknown): number =>
    typeof input === 'number' && Number.isFinite(input) ? input : 0
  return {
    input: value(raw.input),
    output: value(raw.output),
    reasoning: value(raw.reasoning),
    cacheRead: value(raw.cacheRead),
    cacheWrite: value(raw.cacheWrite),
    totalTokens: value(raw.totalTokens),
    cost: value(raw.cost?.total ?? raw.cost),
  }
}

/** 累加同一用户轮次内多步 assistant 消息的用量 */
export function mergeAgentUsage(
  base: AgentUsage | undefined,
  next: AgentUsage | undefined
): AgentUsage | undefined {
  if (!next) return base
  if (!base) return { ...next }
  return {
    input: base.input + next.input,
    output: base.output + next.output,
    reasoning: base.reasoning + next.reasoning,
    cacheRead: base.cacheRead + next.cacheRead,
    cacheWrite: base.cacheWrite + next.cacheWrite,
    totalTokens: base.totalTokens + next.totalTokens,
    cost: base.cost + next.cost,
  }
}

/** 用户消息：正文去掉内部块，随行的引用 / 附件单独携带，供界面回显 */
export function userMessageFromRaw(
  raw: string,
  timestamp: number,
  images?: AgentMessage['images'],
  entryId?: string
): AgentMessage {
  const context: MessageContext | null = parseContextBlock(raw)
  const stripped = stripContextBlock(raw)
  return {
    ...(entryId ? { entryId } : {}),
    role: 'user',
    // 纯附件消息的占位文案在有 chip 时不显示（否则气泡里会同时出现“已附加”与 chip）
    content: context && stripped === '(attached files)' ? '' : stripped,
    ...(images && images.length > 0 ? { images } : {}),
    ...(context ? { context } : {}),
    timestamp,
  }
}

/** 全量投影：时间线 → AgentMessage[] */
export function deriveMessages(
  items: TimelineItem[],
  options: DeriveMessagesOptions
): AgentMessage[] {
  const { thinkingDurations, toolFilePath } = options

  const result: AgentMessage[] = []
  let turn: {
    entryId?: string
    parts: AgentTracePart[]
    timestamp?: number
    usage?: AgentUsage
  } | null = null
  let partSeq = 0
  let lastTimestamp = 0

  const resolveTimestamp = (msgTs: unknown, itemTs?: number): number => {
    if (typeof msgTs === 'number' && Number.isFinite(msgTs) && msgTs > 0) {
      lastTimestamp = Math.max(lastTimestamp, msgTs)
      return msgTs
    }
    if (typeof itemTs === 'number' && Number.isFinite(itemTs) && itemTs > 0) {
      lastTimestamp = Math.max(lastTimestamp, itemTs)
      return itemTs
    }
    lastTimestamp += 1
    return lastTimestamp
  }

  const nextId = (prefix: string, entryId?: string) => {
    partSeq += 1
    return entryId ? `${entryId}:${prefix}:${partSeq}` : `${prefix}-${partSeq}`
  }

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
      ...(turn.entryId ? { entryId: turn.entryId } : {}),
      role: 'assistant',
      content,
      parts: turn.parts,
      ...(turn.usage ? { usage: turn.usage } : {}),
      timestamp: turn.timestamp ?? resolveTimestamp(undefined),
    })
    turn = null
    partSeq = 0
  }

  const pushCompaction = (item: Extract<TimelineItem, { kind: 'compaction' }>) => {
    const ts = resolveTimestamp(item.timestamp)
    // turn.entryId 严格留给首条 assistant 消息，不能被前置 compaction 的 entryId 占掉
    if (!turn) turn = { parts: [], timestamp: ts }
    turn.parts.push({
      type: 'compaction',
      id: item.entryId ? `compaction-${item.entryId}` : nextId('compaction'),
      entryId: item.entryId || undefined,
      timestamp: ts,
      tokensBefore: item.tokensBefore,
    })
  }

  for (const item of items) {
    if (item.kind === 'compaction') {
      // 不 flush 轮次：压缩点落在它发生的那一轮里，位置与实时一致
      pushCompaction(item)
      continue
    }

    if (item.kind === 'custom_message') {
      // 事件唤醒（task-event）或显式展示的自定义消息作为轮次边界：先收束前一轮，
      // 防止连续事件触发的助手回复合并为同一条消息，同时绝不伪造用户气泡。
      if (item.customType === CLOUD_TASK_EVENT_CUSTOM_TYPE || item.display === true) {
        flushTurn()
      }
      continue
    }

    const msg = item.message as any
    if (!msg) continue
    const entryId = item.entryId || undefined

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
        userMessageFromRaw(raw, resolveTimestamp(msg.timestamp, item.timestamp), images, entryId)
      )
      continue
    }

    if (msg.role === 'assistant') {
      if (!turn) turn = { entryId, parts: [] }
      else if (!turn.entryId && entryId) turn.entryId = entryId
      if (turn.timestamp === undefined) {
        turn.timestamp = resolveTimestamp(msg.timestamp, item.timestamp)
      }
      turn.usage = mergeAgentUsage(turn.usage, readMessageUsage(msg))

      if (typeof msg.content === 'string') {
        if (msg.content.trim()) {
          turn.parts.push({ type: 'text', id: nextId('text', entryId), text: msg.content })
        }
      } else if (Array.isArray(msg.content)) {
        let thinkingIndex = 0
        for (const part of msg.content) {
          if (!part) continue
          if (part.type === 'text' && typeof part.text === 'string') {
            // 跳过空串与纯空白 text 块（Gemini toolUse 末尾会附带 text:""），避免切碎过程轨迹与产生前导空行
            if (part.text.trim()) {
              turn.parts.push({ type: 'text', id: nextId('text', entryId), text: part.text })
            }
          } else if (part.type === 'thinking') {
            const durations =
              typeof msg.timestamp === 'number'
                ? thinkingDurations[String(msg.timestamp)] ?? []
                : []
            turn.parts.push({
              type: 'thinking',
              id: nextId('thinking', entryId),
              text: typeof part.thinking === 'string' ? part.thinking : '',
              redacted: part.redacted === true,
              durationMs: durations[thinkingIndex],
            })
            thinkingIndex++
          } else if (part.type === 'toolCall') {
            const toolName = String(part.name ?? 'tool')
            const toolCallId = String(part.id ?? nextId('tool', entryId))
            const parentToolCallId =
              typeof part.parentToolCallId === 'string' ? part.parentToolCallId : undefined
            turn.parts.push({
              type: 'tool',
              id: toolCallId,
              toolCallId,
              toolName,
              argsSummary: summarizeToolArgs(toolName, part.arguments ?? {}),
              status: 'running',
              filePath: toolFilePath(toolName, part.arguments ?? {}),
              ...(parentToolCallId ? { parentToolCallId } : {}),
            })
          }
        }
      }
      continue
    }

    if (msg.role === 'toolResult') {
      if (!turn) continue
      const toolPartIndex = turn.parts.findIndex(
        (part) => part.type === 'tool' && part.toolCallId === msg.toolCallId
      )
      if (toolPartIndex < 0) continue
      const toolPart = turn.parts[toolPartIndex]
      if (toolPart.type !== 'tool') continue
      toolPart.status = msg.isError ? 'error' : 'success'
      toolPart.isError = Boolean(msg.isError)
      if (typeof msg.durationMs === 'number') toolPart.durationMs = msg.durationMs
      if (typeof msg.parentToolCallId === 'string' && !toolPart.parentToolCallId) {
        toolPart.parentToolCallId = msg.parentToolCallId
      }
      toolPart.resultPreview = summarizeToolResult(
        { content: msg.content, details: msg.details },
        msg.toolName === 'bash' || msg.toolName === 'powershell'
      )

      // 投影子工具/嵌套调用记录（SDK 保存在 toolResult.nestedCalls.calls），使轮末对账与重载不丢失嵌套轨迹
      const nestedRaw = msg.nestedCalls?.calls
      if (Array.isArray(nestedRaw) && nestedRaw.length > 0) {
        const existingIds = new Set<string>()
        for (const existingPart of turn.parts) {
          if (existingPart.type === 'tool') existingIds.add(existingPart.toolCallId)
        }
        const nestedParts: Array<Extract<AgentTracePart, { type: 'tool' }>> = []
        for (const call of nestedRaw) {
          if (!call || typeof call !== 'object') continue
          const nestedId =
            typeof call.id === 'string' && call.id ? call.id : nextId('nested-tool', entryId)
          if (existingIds.has(nestedId)) continue
          existingIds.add(nestedId)
          const nestedName = typeof call.name === 'string' && call.name ? call.name : 'tool'
          const hasArgs = Boolean(call.arguments && typeof call.arguments === 'object')
          const nestedArgs = hasArgs ? call.arguments : {}
          const argsSummary = hasArgs
            ? summarizeToolArgs(nestedName, nestedArgs)
            : typeof call.argumentsBytes === 'number'
              ? `(${call.argumentsBytes} bytes)`
              : ''
          const isOk = call.status === 'ok'
          const slashIndex = nestedId.lastIndexOf('/')
          const directParent =
            slashIndex > 0 && existingIds.has(nestedId.slice(0, slashIndex))
              ? nestedId.slice(0, slashIndex)
              : toolPart.toolCallId
          const nestedFilePath = hasArgs ? toolFilePath(nestedName, nestedArgs) : undefined
          nestedParts.push({
            type: 'tool',
            id: nestedId,
            toolCallId: nestedId,
            toolName: nestedName,
            argsSummary,
            status: isOk ? 'success' : 'error',
            isError: !isOk,
            ...(typeof call.durationMs === 'number' ? { durationMs: call.durationMs } : {}),
            ...(typeof call.error === 'string' && call.error.trim()
              ? { resultPreview: call.error.trim() }
              : {}),
            ...(nestedFilePath ? { filePath: nestedFilePath } : {}),
            parentToolCallId: directParent,
          })
        }
        if (nestedParts.length > 0) {
          turn.parts.splice(toolPartIndex + 1, 0, ...nestedParts)
        }
      }
    }
  }

  flushTurn()
  // 历史中因崩溃截断未闭合的工具调用不能永久保持 running 状态，统一归一为 error；
  // 仅在显式声明活跃流式快照时豁免仍在执行的工具调用。
  const lastMessage = result[result.length - 1]
  for (const message of result) {
    if (!message.parts) continue
    const preserveLiveTurn =
      options.isLiveStreaming === true &&
      !options.activeToolCallIds &&
      message === lastMessage &&
      message.role === 'assistant'
    for (const part of message.parts) {
      if (part.type !== 'tool' || part.status !== 'running') continue
      if (preserveLiveTurn || options.activeToolCallIds?.has(part.toolCallId)) continue
      part.status = 'error'
      part.isError = true
    }
  }
  return result
}

/** 单轮投影：供流式尾轮或局部片段复用同一归一化逻辑 */
export function deriveMessage(
  items: TimelineItem[],
  options: DeriveMessagesOptions
): AgentMessage | null {
  const messages = deriveMessages(items, options)
  return messages.length > 0 ? messages[messages.length - 1] : null
}
