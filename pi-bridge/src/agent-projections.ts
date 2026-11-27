/**
 * 会话时间线投影辅助：会话导出轮次构建、工具参数/负载序列化与标题源消息提取。
 * 纯数据投影逻辑（不持有运行时状态），遵循 ADR-003 只读完整会话记录。
 */

import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { activeTimeline } from './session-entries.js'
import type { ExportTurn } from './session-export.js'
import { messageText as toMessageText, parseContextBlock, stripContextBlock } from './text-utils.js'
import type { AgentLogger } from './types.js'

/**
 * 纯图片消息的占位文本：Anthropic 拒绝空 text 块（400），
 * 其他 OpenAI 兼容端点接受空文本，因此只在需要时补。
 */
export const IMAGE_ONLY_PROMPTS = ['请看这些图片。', 'Please look at the attached image(s).'] as const

/** 用户消息是否带图片块（纯图片对话用于跳过标题模型调用） */
export function hasImageBlocks(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some((part: any) => part?.type === 'image')
}

export function isImageOnlyPrompt(text: string): boolean {
  const trimmed = text.trim()
  return (IMAGE_ONLY_PROMPTS as readonly string[]).includes(trimmed)
}

export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part?.type === 'text')
      .map((part: any) => part.text)
      .join('\n')
  }
  return ''
}

export function serializeToolArgs(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}, null, 2)
  } catch {
    return String(args ?? '')
  }
}

export function payloadFromMessage(message: any): {
  toolName: string
  text: string
  images: Array<{ data: string; mimeType: string }>
} {
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

/** 从当前分支完整时间线构建会话导出轮次（含压缩点与工具结果） */
export function buildExportTurns(sessionManager: SessionManager): ExportTurn[] {
  const items = activeTimeline(sessionManager)
  const messages = items
    .filter(
      (item): item is Extract<(typeof items)[number], { kind: 'message' }> =>
        item.kind === 'message'
    )
    .map((item) => item.message)

  const results = new Map<string, any>()
  for (const message of messages) {
    if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
      results.set(message.toolCallId, message)
    }
  }

  const turns: ExportTurn[] = []
  const currentTurn = (timestamp: number): ExportTurn => {
    const existing = turns[turns.length - 1]
    if (existing) return existing
    const created: ExportTurn = { user: { text: '', timestamp }, parts: [] }
    turns.push(created)
    return created
  }

  for (const item of items) {
    if (item.kind === 'compaction') {
      currentTurn(item.timestamp).parts.push({
        type: 'compaction',
        timestamp: item.timestamp,
        tokensBefore: item.tokensBefore,
      })
      continue
    }

    if (item.kind === 'custom_message') continue

    const message = item.message as any

    if (message?.role === 'user') {
      const raw = toMessageText(message)
      const context = parseContextBlock(raw)
      const stripped = stripContextBlock(raw)
      turns.push({
        user: {
          // 有引用 / 附件时导出渲染引用块，不再重复占位文案
          text: context && stripped === '(attached files)' ? '' : stripped,
          timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
          ...(context ? { context } : {}),
        },
        parts: [],
      })
      continue
    }

    const turn = turns[turns.length - 1]
    if (!turn || message?.role !== 'assistant') continue
    const content: any[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : []
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
        turn.parts.push({ type: 'text', text: part.text })
      } else if (
        part?.type === 'thinking' &&
        !part.redacted &&
        typeof part.thinking === 'string' &&
        part.thinking
      ) {
        turn.parts.push({ type: 'thinking', text: part.thinking })
      } else if (part?.type === 'toolCall') {
        const raw = typeof part.id === 'string' ? results.get(part.id) : undefined
        const payload = raw ? payloadFromMessage(raw) : null
        turn.parts.push({
          type: 'tool',
          name: String(part.name ?? 'tool'),
          args: serializeToolArgs(part.arguments),
          result: payload?.text ?? '',
          isError: Boolean(raw?.isError),
          images: payload?.images ?? [],
        })
      }
    }
  }
  return turns
}

/**
 * 命名输入：当前活跃分支里首条用户消息 + 最早一条带文本的回复。
 * - 只读活跃分支记录（getBranch）：压缩后的模型上下文不含首条消息，而 getEntries 会混入已回退/废弃分支。
 * - 首条 assistant 常常只有 thinking / toolCall，必须跳过它们取最后一条带文本的回复。
 */
export function extractTitleSourceTexts(
  sessionManager: SessionManager,
  logger: AgentLogger
): {
  userText: string
  assistantText: string
  imageOnly: boolean
} {
  let firstUser: any = null
  let assistantText = ''
  try {
    const entries = (
      typeof sessionManager.getBranch === 'function'
        ? sessionManager.getBranch()
        : sessionManager.getEntries()
    ) as any[]
    for (const entry of entries) {
      if (entry?.type !== 'message' || !entry.message) continue
      const message = entry.message
      if (message.role === 'user') {
        if (firstUser) continue
        firstUser = message
        continue
      }
      if (!firstUser || message.role !== 'assistant') continue
      const text = extractMessageText(message.content).trim()
      if (text) assistantText = text
    }
  } catch (error) {
    logger.warn('[Agent Manager] Failed to read the title source messages:', error)
    return { userText: '', assistantText: '', imageOnly: false }
  }

  if (!firstUser) return { userText: '', assistantText, imageOnly: false }
  const userText = stripContextBlock(extractMessageText(firstUser.content)).trim()
  const imageOnly =
    hasImageBlocks(firstUser.content) && (!userText || isImageOnlyPrompt(userText))
  return { userText: imageOnly ? '' : userText, assistantText, imageOnly }
}
