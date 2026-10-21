import { create } from 'zustand'

export interface TextSelection {
  path: string
  name: string
  startLine: number
  endLine: number
  text: string
}

interface SelectionState {
  selection: TextSelection | null
  setSelection: (selection: TextSelection | null) => void
  clearSelection: () => void
  clearForPath: (path: string) => void
}

/**
 * 编辑器当前选区。ChatPanel 用它提供“附加选区为上下文”，
 * Monaco 在光标/选区变化时写入；空选区或切换文件时清空。
 */
export const useSelectionStore = create<SelectionState>((set) => ({
  selection: null,
  setSelection: (selection) => set({ selection }),
  clearSelection: () => set({ selection: null }),
  clearForPath: (path) =>
    set((state) =>
      state.selection && state.selection.path !== path ? { selection: null } : state
    ),
}))
