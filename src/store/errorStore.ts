import { create } from 'zustand'

export interface AppError {
  id: string
  title: string
  message: string
  details?: string
  timestamp: number
}

interface ErrorStore {
  errors: AppError[]
  addError: (title: string, message: string, details?: string) => void
  removeError: (id: string) => void
  clearErrors: () => void
  getLastError: () => AppError | null
}

export const useErrorStore = create<ErrorStore>((set, get) => ({
  errors: [],

  addError: (title, message, details) => {
    const error: AppError = {
      id: Math.random().toString(36).substr(2, 9),
      title,
      message,
      details,
      timestamp: Date.now(),
    }
    set((state) => ({
      errors: [...state.errors, error],
    }))
    // Auto-remove after 10 seconds
    setTimeout(() => {
      get().removeError(error.id)
    }, 10000)
  },

  removeError: (id) =>
    set((state) => ({
      errors: state.errors.filter((e) => e.id !== id),
    })),

  clearErrors: () => set({ errors: [] }),

  getLastError: () => {
    const state = get()
    return state.errors.length > 0 ? state.errors[state.errors.length - 1] : null
  },
}))

/**
 * 统一错误处理
 */
export const handleError = (error: unknown, context: string, notify?: (msg: string) => void) => {
  let message = 'Unknown error'
  let details = ''

  if (error instanceof Error) {
    message = error.message
    details = error.stack || ''
  } else if (typeof error === 'string') {
    message = error
  } else {
    message = JSON.stringify(error)
  }

  console.error(`[${context}]`, error)

  useErrorStore.getState().addError(context, message, details)

  if (notify) {
    notify(`${context}: ${message}`)
  }
}
