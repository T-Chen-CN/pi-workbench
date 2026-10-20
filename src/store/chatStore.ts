import { create } from 'zustand'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  isLoading?: boolean
  /** 正在流式接收文本增量 */
  isStreaming?: boolean
}

export interface ChatState {
  messages: ChatMessage[]
  isInitialized: boolean
  isLoading: boolean
  error: string | null

  // Actions
  addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => void
  /** 插入一条空的 assistant 消息并返回 id，供流式追加使用 */
  startStreamingMessage: () => string
  appendToMessage: (id: string, delta: string) => void
  finishStreamingMessage: (id: string, content?: string) => void
  setMessages: (messages: Array<Omit<ChatMessage, 'id'>>) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  clearMessages: () => void
  reset: () => void
  setInitialized: (initialized: boolean) => void
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isInitialized: false,
  isLoading: false,
  error: null,

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

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  clearMessages: () => set({ messages: [] }),
  reset: () => set({ messages: [], isLoading: false, error: null, isInitialized: false }),
  setInitialized: (initialized) => set({ isInitialized: initialized }),
}))
