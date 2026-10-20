import { create } from 'zustand'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  isLoading?: boolean
}

export interface ChatState {
  messages: ChatMessage[]
  isInitialized: boolean
  isLoading: boolean
  error: string | null

  // Actions
  addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => void
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

  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
  clearMessages: () => set({ messages: [] }),
  reset: () => set({ messages: [], isLoading: false, error: null, isInitialized: false }),
  setInitialized: (initialized) => set({ isInitialized: initialized }),
}))
