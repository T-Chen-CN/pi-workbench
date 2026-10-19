import { create } from 'zustand'
import { AgentState, ChatMessage } from '../types'

interface AgentStoreState extends AgentState {
  addMessage: (message: ChatMessage) => void
  clearMessages: () => void
  setLoading: (isLoading: boolean) => void
  setError: (error: string | null) => void
  setInitialized: (isInitialized: boolean) => void
}

export const useAgentStore = create<AgentStoreState>((set) => ({
  isInitialized: false,
  isLoading: false,
  error: null,
  messages: [],

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),

  clearMessages: () =>
    set({
      messages: [],
    }),

  setLoading: (isLoading) =>
    set({
      isLoading,
    }),

  setError: (error) =>
    set({
      error,
    }),

  setInitialized: (isInitialized) =>
    set({
      isInitialized,
    }),
}))
