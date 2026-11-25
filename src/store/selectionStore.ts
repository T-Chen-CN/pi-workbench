import { create } from 'zustand'

export interface TextSelection {
  path: string
  name: string
  startLine: number
  endLine: number
  text: string
}

const DEFAULT_SCOPE = '__default__'

interface SelectionState {
  /** 兼容无作用域调用方的最近选区；多工作区一律按 byWorkspace[workspacePath] 隔离 */
  selection: TextSelection | null
  byWorkspace: Record<string, TextSelection | null>
  setSelection: (selection: TextSelection | null, workspacePath?: string) => void
  clearSelection: (workspacePath?: string) => void
  clearForPath: (path: string, workspacePath?: string) => void
  clearWorkspace: (workspacePath: string) => void
}

/**
 * 编辑器当前选区（按工作区隔离）。ChatPanel 用它提供“附加选区为上下文”，
 * Monaco 在光标/选区变化时写入；空选区或切换文件时清空。
 */
export const useSelectionStore = create<SelectionState>((set) => ({
  selection: null,
  byWorkspace: {},
  setSelection: (selection, workspacePath) =>
    set((state) => {
      const scope = workspacePath || DEFAULT_SCOPE
      return {
        selection,
        byWorkspace: { ...state.byWorkspace, [scope]: selection },
      }
    }),
  clearSelection: (workspacePath) =>
    set((state) => {
      if (!workspacePath) {
        return {
          selection: null,
          byWorkspace: {},
        }
      }
      const prev = state.byWorkspace[workspacePath]
      if (!prev) return state
      return {
        selection: state.selection === prev ? null : state.selection,
        byWorkspace: { ...state.byWorkspace, [workspacePath]: null },
      }
    }),
  clearForPath: (path, workspacePath) =>
    set((state) => {
      if (!workspacePath) {
        return state.selection && state.selection.path !== path
          ? {
              selection: null,
              byWorkspace: { ...state.byWorkspace, [DEFAULT_SCOPE]: null },
            }
          : state
      }
      const current = state.byWorkspace[workspacePath]
      if (!current || current.path === path) return state
      return {
        selection: state.selection === current ? null : state.selection,
        byWorkspace: { ...state.byWorkspace, [workspacePath]: null },
      }
    }),
  clearWorkspace: (workspacePath) =>
    set((state) => {
      if (!(workspacePath in state.byWorkspace)) return state
      const prev = state.byWorkspace[workspacePath]
      const byWorkspace = { ...state.byWorkspace }
      delete byWorkspace[workspacePath]
      return {
        selection: prev && state.selection === prev ? null : state.selection,
        byWorkspace,
      }
    }),
}))

export function selectionForWorkspace(
  state: SelectionState,
  workspacePath: string | null | undefined
): TextSelection | null {
  if (!workspacePath) return state.selection
  if (workspacePath in state.byWorkspace) {
    return state.byWorkspace[workspacePath] ?? null
  }
  return state.byWorkspace[DEFAULT_SCOPE] ?? null
}
