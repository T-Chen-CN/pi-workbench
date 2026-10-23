import { create } from 'zustand'
import type { AgentStreamEvent, AgentTracePart } from '../types/electron'

export interface ChatUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  /** 按发生顺序排列的文本 / 思考 / 工具片段（assistant） */
  parts?: AgentTracePart[]
  /** 内部：当前 thinking 片段的开始时间，用于计算时长 */
  thinkingStartedAt?: number
  isLoading?: boolean
  /** 正在流式接收文本增量 */
  isStreaming?: boolean
  /** 本轮模型调用的 token 用量 */
  usage?: ChatUsage
}

export interface ChatAttachment {
  id: string
  kind: 'file' | 'snippet'
  path: string
  name: string
  /** 片段起止行（1-based，含端点） */
  startLine?: number
  endLine?: number
  /** 片段附加时的内容快照；整文件在发送时实时读取 */
  content?: string
}

export type NewChatAttachment = Omit<ChatAttachment, 'id'> & { id?: string }

export interface PendingMessage {
  id: string
  text: string
  /** queue：本轮结束后发送；steer：注入当前轮 */
  behavior: 'queue' | 'steer'
}

export interface ConversationState {
  messages: ChatMessage[]
  isLoading: boolean
  error: string | null
  attachments: ChatAttachment[]
  draftInput: string
  /** Plan 只读 / Act 可写；默认 Act */
  mode: 'plan' | 'act'
  /** 运行中排队的待发送消息 */
  pending: PendingMessage[]
}

const EMPTY_CONVERSATION: ConversationState = {
  messages: [],
  isLoading: false,
  error: null,
  attachments: [],
  draftInput: '',
  mode: 'act',
  pending: [],
}

/** 会话在 store 中的键：工作区 + 会话，避免跨工作区串数据 */
export function conversationKey(workspacePath: string, sessionId: string): string {
  return `${workspacePath}\u0000${sessionId}`
}

type ToolStartEvent = Extract<AgentStreamEvent, { type: 'tool_start' }>
type ToolUpdateEvent = Extract<AgentStreamEvent, { type: 'tool_update' }>
type ToolEndEvent = Extract<AgentStreamEvent, { type: 'tool_end' }>

interface ChatState {
  conversations: Record<string, ConversationState>
  /** 欢迎页带入的草稿，等工作区会话初始化后写入激活会话 */
  pendingDraft: string

  ensureConversation: (key: string) => void
  removeConversation: (key: string) => void
  setPendingDraft: (value: string) => void
  clearPendingDraft: () => void
  addMessage: (key: string, message: Omit<ChatMessage, 'id' | 'timestamp'>) => void
  startStreamingMessage: (key: string) => string
  appendTextPart: (key: string, id: string, delta: string) => void
  appendThinkingPart: (
    key: string,
    id: string,
    delta: string,
    options?: { redacted?: boolean }
  ) => void
  startToolPart: (key: string, id: string, event: ToolStartEvent) => void
  updateToolPart: (key: string, id: string, event: ToolUpdateEvent) => void
  endToolPart: (key: string, id: string, event: ToolEndEvent) => void
  /** @deprecated 使用 appendTextPart；保留给旧调用方与测试 */
  appendToMessage: (key: string, id: string, delta: string) => void
  finishStreamingMessage: (key: string, id: string, content?: string) => void
  setMessageUsage: (key: string, id: string, usage: ChatUsage) => void
  addAttachment: (key: string, attachment: NewChatAttachment) => void
  removeAttachment: (key: string, id: string) => void
  clearAttachments: (key: string) => void
  setDraftInput: (key: string, value: string) => void
  clearDraftInput: (key: string) => void
  setMode: (key: string, mode: 'plan' | 'act') => void
  addPending: (key: string, text: string, behavior: PendingMessage['behavior']) => PendingMessage
  removePending: (key: string, id: string) => void
  setPendingBehavior: (key: string, id: string, behavior: PendingMessage['behavior']) => void
  setMessages: (key: string, messages: Array<Omit<ChatMessage, 'id'>>) => void
  setLoading: (key: string, loading: boolean) => void
  setError: (key: string, error: string | null) => void
  clearMessages: (key: string) => void
  reset: () => void
}

function conversation(state: ChatState, key: string): ConversationState {
  return state.conversations[key] ?? EMPTY_CONVERSATION
}

/** 只更新已存在的会话；关闭标签后迟到的流式回调不能把会话重新创建出来 */
function updateExisting(
  state: ChatState,
  key: string,
  updater: (current: ConversationState) => ConversationState
): Partial<ChatState> | ChatState {
  const current = state.conversations[key]
  if (!current) return state
  return {
    conversations: { ...state.conversations, [key]: updater(current) },
  }
}

/** 只更新指定消息；消息不存在时保持原状态 */
function updateMessage(
  state: ChatState,
  key: string,
  id: string,
  updater: (message: ChatMessage) => ChatMessage
): Partial<ChatState> | ChatState {
  return updateExisting(state, key, (current) => {
    let found = false
    const messages = current.messages.map((message) => {
      if (message.id !== id) return message
      found = true
      return updater(message)
    })
    if (!found) return current
    return { ...current, messages }
  })
}

function nextPartId(parts: AgentTracePart[], prefix: string): string {
  const ids = new Set(parts.map((part) => part.id))
  let index = 1
  while (ids.has(`${prefix}-${index}`)) index += 1
  return `${prefix}-${index}`
}

function textFromParts(parts: AgentTracePart[] | undefined): string {
  return (parts ?? [])
    .filter(
      (part): part is Extract<AgentTracePart, { type: 'text' }> => part.type === 'text'
    )
    .map((part) => part.text)
    .join('\n')
}

/** 在写入 text/tool 之前结束当前 thinking 片段并记录时长 */
function closeThinking(message: ChatMessage, now = Date.now()): ChatMessage {
  if (!message.thinkingStartedAt) return message
  const parts = message.parts ? [...message.parts] : []
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part.type !== 'thinking') continue
    if (part.durationMs === undefined) {
      parts[index] = { ...part, durationMs: Math.max(0, now - message.thinkingStartedAt) }
    }
    break
  }
  return { ...message, parts, thinkingStartedAt: undefined }
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: {},
  pendingDraft: '',

  setPendingDraft: (value) => set({ pendingDraft: value }),
  clearPendingDraft: () => set({ pendingDraft: '' }),

  ensureConversation: (key) =>
    set((state) =>
      state.conversations[key]
        ? state
        : { conversations: { ...state.conversations, [key]: { ...EMPTY_CONVERSATION } } }
    ),

  removeConversation: (key) =>
    set((state) => {
      if (!state.conversations[key]) return state
      const conversations = { ...state.conversations }
      delete conversations[key]
      return { conversations }
    }),

  addMessage: (key, message) =>
    set((state) => ({
      conversations: {
        ...state.conversations,
        [key]: {
          ...conversation(state, key),
          messages: [
            ...conversation(state, key).messages,
            {
              ...message,
              id: `msg-${Date.now()}-${Math.random()}`,
              timestamp: Date.now(),
            },
          ],
        },
      },
    })),

  startStreamingMessage: (key) => {
    const id = `msg-${Date.now()}-${Math.random()}`
    set((state) => ({
      conversations: {
        ...state.conversations,
        [key]: {
          ...conversation(state, key),
          messages: [
            ...conversation(state, key).messages,
            {
              id,
              role: 'assistant',
              content: '',
              parts: [],
              timestamp: Date.now(),
              isStreaming: true,
            },
          ],
        },
      },
    }))
    return id
  },

  appendTextPart: (key, id, delta) =>
    set((state) =>
      updateMessage(state, key, id, (message) => {
        const next = closeThinking(message)
        const parts = next.parts ? [...next.parts] : []
        const last = parts[parts.length - 1]
        if (last?.type === 'text') {
          parts[parts.length - 1] = { ...last, text: last.text + delta }
        } else {
          parts.push({ type: 'text', id: nextPartId(parts, 'text'), text: delta })
        }
        return { ...next, parts, content: next.content + delta }
      })
    ),

  appendThinkingPart: (key, id, delta, options) =>
    set((state) =>
      updateMessage(state, key, id, (message) => {
        const parts = message.parts ? [...message.parts] : []
        const last = parts[parts.length - 1]
        const redacted = options?.redacted === true
        if (last?.type === 'thinking' && !last.redacted && !redacted) {
          parts[parts.length - 1] = { ...last, text: last.text + delta }
        } else {
          parts.push({
            type: 'thinking',
            id: nextPartId(parts, 'thinking'),
            text: delta,
            redacted,
          })
        }
        return {
          ...message,
          parts,
          thinkingStartedAt: message.thinkingStartedAt ?? Date.now(),
        }
      })
    ),

  startToolPart: (key, id, event) =>
    set((state) =>
      updateMessage(state, key, id, (message) => {
        const next = closeThinking(message)
        const parts = next.parts ? [...next.parts] : []
        const part: AgentTracePart = {
          type: 'tool',
          id: event.toolCallId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          argsSummary: event.argsSummary,
          status: 'running',
        }
        const existing = parts.findIndex(
          (item) => item.type === 'tool' && item.toolCallId === event.toolCallId
        )
        if (existing >= 0) parts[existing] = part
        else parts.push(part)
        return { ...next, parts }
      })
    ),

  updateToolPart: (key, id, event) =>
    set((state) =>
      updateMessage(state, key, id, (message) => {
        if (!message.parts) return message
        const parts = message.parts.map((part) =>
          part.type === 'tool' && part.toolCallId === event.toolCallId
            ? { ...part, resultPreview: event.resultPreview ?? part.resultPreview }
            : part
        )
        return { ...message, parts }
      })
    ),

  endToolPart: (key, id, event) =>
    set((state) =>
      updateMessage(state, key, id, (message) => {
        if (!message.parts) return message
        let found = false
        const parts = message.parts.map((part) => {
          if (part.type !== 'tool' || part.toolCallId !== event.toolCallId) return part
          found = true
          return {
            ...part,
            status: event.status,
            isError: event.status === 'error',
            durationMs: event.durationMs,
            resultPreview: event.resultPreview ?? part.resultPreview,
            filePath: event.filePath ?? part.filePath,
          }
        })
        if (!found) {
          parts.push({
            type: 'tool',
            id: event.toolCallId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            argsSummary: '',
            status: event.status,
            isError: event.status === 'error',
            durationMs: event.durationMs,
            resultPreview: event.resultPreview,
            filePath: event.filePath,
          })
        }
        return { ...message, parts }
      })
    ),

  appendToMessage: (key, id, delta) => get().appendTextPart(key, id, delta),

  finishStreamingMessage: (key, id, content) =>
    set((state) =>
      updateMessage(state, key, id, (message) => {
        const next = closeThinking(message)
        let parts = (next.parts ?? []).map((part) =>
          part.type === 'tool' && part.status === 'running'
            ? { ...part, status: 'error' as const, isError: true }
            : part
        )
        if (parts.length === 0) {
          const text = content ?? next.content
          parts = text
            ? [{ type: 'text', id: nextPartId(parts, 'text'), text }]
            : []
        } else if (!parts.some((part) => part.type === 'text') && content) {
          parts.push({ type: 'text', id: nextPartId(parts, 'text'), text: content })
        }
        return {
          ...next,
          parts,
          content: textFromParts(parts) || next.content,
          isStreaming: false,
          thinkingStartedAt: undefined,
        }
      })
    ),

  setMessageUsage: (key, id, usage) =>
    set((state) =>
      updateMessage(state, key, id, (message) => ({ ...message, usage }))
    ),

  addAttachment: (key, attachment) =>
    set((state) =>
      updateExisting(state, key, (current) => {
        const id =
          attachment.id ??
          (attachment.kind === 'snippet'
            ? `snippet:${attachment.path}:${attachment.startLine}-${attachment.endLine}`
            : `file:${attachment.path}`)
        if (current.attachments.some((item) => item.id === id)) return current
        return {
          ...current,
          attachments: [...current.attachments, { ...attachment, id }],
        }
      })
    ),

  removeAttachment: (key, id) =>
    set((state) =>
      updateExisting(state, key, (current) => ({
        ...current,
        attachments: current.attachments.filter((item) => item.id !== id),
      }))
    ),

  clearAttachments: (key) =>
    set((state) =>
      updateExisting(state, key, (current) => ({ ...current, attachments: [] }))
    ),

  setDraftInput: (key, value) =>
    set((state) =>
      updateExisting(state, key, (current) => ({ ...current, draftInput: value }))
    ),

  clearDraftInput: (key) =>
    set((state) =>
      updateExisting(state, key, (current) => ({ ...current, draftInput: '' }))
    ),

  setMode: (key, mode) =>
    set((state) => updateExisting(state, key, (current) => ({ ...current, mode }))),

  addPending: (key, text, behavior) => {
    const item: PendingMessage = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      behavior,
    }
    set((state) =>
      updateExisting(state, key, (current) => ({
        ...current,
        pending: [...current.pending, item],
      }))
    )
    return item
  },

  removePending: (key, id) =>
    set((state) =>
      updateExisting(state, key, (current) => ({
        ...current,
        pending: current.pending.filter((item) => item.id !== id),
      }))
    ),

  setPendingBehavior: (key, id, behavior) =>
    set((state) =>
      updateExisting(state, key, (current) => ({
        ...current,
        pending: current.pending.map((item) =>
          item.id === id ? { ...item, behavior } : item
        ),
      }))
    ),

  setMessages: (key, messages) =>
    set((state) => ({
      conversations: {
        ...state.conversations,
        [key]: {
          ...conversation(state, key),
          messages: messages.map((message, index) => {
            const parts =
              message.parts ??
              (message.role === 'assistant' && message.content
                ? [
                    {
                      type: 'text' as const,
                      id: `text-${index + 1}`,
                      text: message.content,
                    },
                  ]
                : undefined)
            return {
              ...message,
              id: `msg-${message.timestamp}-${index}`,
              parts,
              thinkingStartedAt: undefined,
            }
          }),
        },
      },
    })),

  setLoading: (key, loading) =>
    set((state) =>
      updateExisting(state, key, (current) => ({ ...current, isLoading: loading }))
    ),

  setError: (key, error) =>
    set((state) =>
      updateExisting(state, key, (current) => ({ ...current, error }))
    ),

  clearMessages: (key) =>
    set((state) =>
      updateExisting(state, key, (current) => ({ ...current, messages: [] }))
    ),

  reset: () => set({ conversations: {}, pendingDraft: '' }),
}))
