import { create } from 'zustand'

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

export interface ConversationState {
  messages: ChatMessage[]
  isLoading: boolean
  error: string | null
  attachments: ChatAttachment[]
  draftInput: string
}

const EMPTY_CONVERSATION: ConversationState = {
  messages: [],
  isLoading: false,
  error: null,
  attachments: [],
  draftInput: '',
}

/** 会话在 store 中的键：工作区 + 会话，避免跨工作区串数据 */
export function conversationKey(workspacePath: string, sessionId: string): string {
  return `${workspacePath}\u0000${sessionId}`
}

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
  appendToMessage: (key: string, id: string, delta: string) => void
  finishStreamingMessage: (key: string, id: string, content?: string) => void
  setMessageUsage: (key: string, id: string, usage: ChatUsage) => void
  addAttachment: (key: string, attachment: NewChatAttachment) => void
  removeAttachment: (key: string, id: string) => void
  clearAttachments: (key: string) => void
  setDraftInput: (key: string, value: string) => void
  clearDraftInput: (key: string) => void
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

export const useChatStore = create<ChatState>((set) => ({
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
              timestamp: Date.now(),
              isStreaming: true,
            },
          ],
        },
      },
    }))
    return id
  },

  appendToMessage: (key, id, delta) =>
    set((state) =>
      updateExisting(state, key, (current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === id ? { ...message, content: message.content + delta } : message
        ),
      }))
    ),

  finishStreamingMessage: (key, id, content) =>
    set((state) =>
      updateExisting(state, key, (current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === id
            ? {
                ...message,
                content: content ?? message.content,
                isStreaming: false,
              }
            : message
        ),
      }))
    ),

  setMessageUsage: (key, id, usage) =>
    set((state) =>
      updateExisting(state, key, (current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === id ? { ...message, usage } : message
        ),
      }))
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

  setMessages: (key, messages) =>
    set((state) => ({
      conversations: {
        ...state.conversations,
        [key]: {
          ...conversation(state, key),
          messages: messages.map((message, index) => ({
            ...message,
            id: `msg-${message.timestamp}-${index}`,
          })),
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
