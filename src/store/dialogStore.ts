import { create } from 'zustand'
import { focusedHostId } from '../panelHost/focus'
import { MAIN_HOST } from '../panelHost/types'

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

export interface AlertDialogOptions {
  title?: string
  message: string
  confirmLabel?: string
}

type DialogRequest =
  | {
      kind: 'confirm'
      options: ConfirmDialogOptions
      resolve: (value: boolean) => void
    }
  | {
      kind: 'prompt'
      options: PromptDialogOptions
      resolve: (value: string | null) => void
    }
  | {
      kind: 'alert'
      options: AlertDialogOptions
      resolve: () => void
    }

interface DialogState {
  current: DialogRequest | null
  /** 对话框出现在哪个宿主窗口 */
  currentHost: string
  open: (dialog: DialogRequest) => void
  close: (result: boolean | string | null) => void
}

export const useDialogStore = create<DialogState>((set, get) => ({
  current: null,
  currentHost: MAIN_HOST,

  open: (dialog) => {
    // 同时只展示一个对话框；新的请求到来时把旧的按“取消”结算，避免 Promise 悬空
    const current = get().current
    if (current) {
      if (current.kind === 'confirm') current.resolve(false)
      else if (current.kind === 'prompt') current.resolve(null)
      else current.resolve()
    }
    set({ current: dialog, currentHost: focusedHostId() })
  },

  close: (result) => {
    const current = get().current
    if (!current) return
    set({ current: null })
    if (current.kind === 'confirm') {
      current.resolve(Boolean(result))
    } else if (current.kind === 'prompt') {
      current.resolve(typeof result === 'string' ? result : null)
    } else {
      current.resolve()
    }
  },
}))

/** 用应用内 Modal 替代 window.confirm */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({ kind: 'confirm', options, resolve })
  })
}

/** 用应用内 Modal 替代 window.prompt */
export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({ kind: 'prompt', options, resolve })
  })
}

/** 单按钮提示弹窗：只告知，不做选择（操作未执行时说明原因） */
export function alertDialog(options: AlertDialogOptions): Promise<void> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({ kind: 'alert', options, resolve })
  })
}
