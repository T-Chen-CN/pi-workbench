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
  path: string
  name: string
}

export interface ChatState {
  messages: ChatMessage[]
  isLoading: boolean
  error: string | null
  /** 下一条消息要附带的工作区文件 */
  attachments: ChatAttachment[]
  /** 欢迎页提问后带入聊天输入框的草稿 */
  draftInput: string

  // Actions
  addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => void
  /** 插入一条空的 assistant 消息并返回 id，供流式追加使用 */
  startStreamingMessage: () => string
  appendToMessage: (id: string, delta: string) => void
  finishStreamingMessage: (id: string, content?: string) => void
  /** 给一条 assistant 消息附上 token 用量 */
  setMessageUsage: (id: string, usage: ChatUsage) => void
  addAttachment: (attachment: ChatAttachment) => void
  removeAttachment: (path: string) => void
  clearAttachments: () => void
  setDraftInput: (value: string) => void
  clearDraftInput: () => void
  setMessages: (messages: Array<Omit<ChatMessage, 'id'>>) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  clearMessages: () => void
  reset: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isLoading: false,
  error: null,
  attachments: [],
  draftInput: '',

  addMessage: (message) =>
    set((state) => ({
      messages: [
        ...state.messages,
        {
          ...message,
          id: `msg-${Date.now()}-${Math.random()}`,
          timestamp: Date.now(),
        },
      ],
    })),

  setMessages: (messages) =>
    set({
      messages: messages.map((message, index) => ({
        ...message,
        id: `msg-${message.timestamp}-${index}`,
      })),
    }),

  startStreamingMessage: () => {
    const id = `msg-${Date.now()}-${Math.random()}`
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
        },
      ],
    }))
    return id
  },

  appendToMessage: (id, delta) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id
          ? { ...message, content: message.content + delta }
          : message
      ),
    })),

  finishStreamingMessage: (id, content) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id
          ? { ...message, content: content ?? message.content, isStreaming: false }
          : message
      ),
    })),

  setMessageUsage: (id, usage) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id ? { ...message, usage } : message
      ),
    })),

  addAttachment: (attachment) =>
    set((state) => ({
      attachments: state.attachments.some((item) => item.path === attachment.path)
        ? state.attachments
        : [...state.attachments, attachment],
    })),

  removeAttachment: (path) =>
    set((state) => ({
      attachments: state.attachments.filter((item) => item.path !== path),
    })),

  clearAttachments: () => set({ attachments: [] }),
  setDraftInput: (value) => set({ draftInput: value }),
  clearDraftInput: () => set({ draftInput: '' }),

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  clearMessages: () => set({ messages: [] }),
  reset: () =>
    set({
      messages: [],
      isLoading: false,
      error: null,
      attachments: [],
      draftInput: '',
    }),
}))
