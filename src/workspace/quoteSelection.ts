/**
 * 划词引用：把选区落成会话附件里的「引用块」。
 *
 * 选区来源有两种：文档阅读视图（Markdown / 纯文本）与对话里的 Agent 回复。
 * 两者都只产出一条 `snippet` 附件（`label` 说明来源），发送时由
 * `buildContextPrompt` 包进上下文块，AgentManager 恢复历史时仍按老规则剥离。
 */

import { conversationKey, useChatStore } from '../store/chatStore'
import { useSessionStore } from '../store/sessionStore'
import { useWorkspaceStore } from '../store/workspaceStore'

/** 单条引用上限：超过这个量已经不是"引用"而是"整篇粘贴" */
export const MAX_QUOTE_CHARS = 8000

export type QuoteResult = 'ok' | 'empty' | 'too-long' | 'no-session'

export interface QuoteRequest {
  text: string
  /** 引用块标题，如「对话引用」「README.md」 */
  title: string
  /** 来源文件路径；对话引用没有路径 */
  sourcePath?: string
}

/** 当前激活会话的 conversationKey；没有打开的会话时返回 null */
export function activeConversationKey(): string | null {
  const workspacePath = useWorkspaceStore.getState().workspacePath
  if (!workspacePath) return null
  const sessionId = useSessionStore.getState().byWorkspace[workspacePath]?.active
  if (!sessionId) return null
  return conversationKey(workspacePath, sessionId)
}

let quoteSeq = 0

export function addChatQuote({ text, title, sourcePath }: QuoteRequest): QuoteResult {
  const content = text.trim()
  if (!content) return 'empty'
  if (content.length > MAX_QUOTE_CHARS) return 'too-long'
  const key = activeConversationKey()
  if (!key) return 'no-session'

  const chat = useChatStore.getState()
  chat.ensureConversation(key)
  quoteSeq += 1
  chat.addAttachment(key, {
    // 同一来源可以引用多次，id 不能按内容去重
    id: `quote:${Date.now()}-${quoteSeq}`,
    kind: 'snippet',
    path: sourcePath ?? '',
    name: title,
    label: title,
    content
  })
  return 'ok'
}
