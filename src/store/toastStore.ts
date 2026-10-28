import { create } from 'zustand'
import type { ToastMessage, ToastType } from '../components/Toast'
import { focusedHostId } from '../panelHost/focus'

interface ToastState {
  messages: ToastMessage[]
  show: (message: string, type?: ToastType, duration?: number, host?: string) => void
  remove: (id: string) => void
}

export const useToastStore = create<ToastState>((set) => ({
  messages: [],

  show: (message, type = 'info', duration, host) => {
    const id = Math.random().toString(36).slice(2, 11)
    // 用户在哪一类窗口里操作，提示就落在哪：辅助窗口获得焦点时不再弹回主窗口
    const targetHost = host ?? focusedHostId()
    set((state) => ({
      messages: [...state.messages, { id, message, type, duration, host: targetHost }],
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
