import { create } from 'zustand'
import type { ToastMessage, ToastType } from '../components/Toast'

interface ToastState {
  messages: ToastMessage[]
  show: (message: string, type?: ToastType, duration?: number) => void
  remove: (id: string) => void
}

export const useToastStore = create<ToastState>((set) => ({
  messages: [],

  show: (message, type = 'info', duration) => {
    const id = Math.random().toString(36).slice(2, 11)
    set((state) => ({
      messages: [...state.messages, { id, message, type, duration }],
    }))
  },

  remove: (id) =>
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== id),
    })),
}))

// 全局 toast 快捷方法（可在任意组件/非组件代码中调用）
export const toast = {
  success: (message: string, duration = 3000) =>
    useToastStore.getState().show(message, 'success', duration),
  error: (message: string, duration = 8000) =>
    useToastStore.getState().show(message, 'error', duration),
  warning: (message: string, duration = 5000) =>
    useToastStore.getState().show(message, 'warning', duration),
  info: (message: string, duration = 3000) =>
    useToastStore.getState().show(message, 'info', duration),
}
