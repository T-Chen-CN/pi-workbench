import { create } from 'zustand'

export interface ConfirmDialogOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export interface PromptDialogOptions {
  title?: string
  message?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
}

type DialogRequest =
  | {
      id: number
      kind: 'confirm'
      options: ConfirmDialogOptions
      resolve: (value: boolean) => void
    }
  | {
      id: number
      kind: 'prompt'
      options: PromptDialogOptions
      resolve: (value: string | null) => void
    }

interface DialogState {
  current: DialogRequest | null
  open: (dialog: DialogRequest) => void
  close: (result: boolean | string | null) => void
}

let nextId = 1

export const useDialogStore = create<DialogState>((set, get) => ({
  current: null,

  open: (dialog) => {
    // 同时只展示一个对话框；新的请求到来时把旧的按“取消”结算，避免 Promise 悬空
    const current = get().current
    if (current) {
      if (current.kind === 'confirm') current.resolve(false)
      else current.resolve(null)
    }
    set({ current: dialog })
  },

  close: (result) => {
    const current = get().current
    if (!current) return
    set({ current: null })
    if (current.kind === 'confirm') {
      current.resolve(Boolean(result))
    } else {
      current.resolve(typeof result === 'string' ? result : null)
    }
  },
}))

/** 用应用内 Modal 替代 window.confirm */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({ id: nextId++, kind: 'confirm', options, resolve })
  })
}

/** 用应用内 Modal 替代 window.prompt */
export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({ id: nextId++, kind: 'prompt', options, resolve })
  })
}
