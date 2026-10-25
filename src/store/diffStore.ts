import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { mergeFileEdits } from '../api/diff'
import type { FileEdit } from '../types/electron'

export interface DiffState {
  /** 本轮需要审阅的文件修改（按文件去重） */
  edits: FileEdit[]
  currentIndex: number
  isOpen: boolean
  isLoading: boolean
  error: string | null

  // Actions
  openEdits: (edits: FileEdit[]) => void
  setCurrentIndex: (index: number) => void
  removeEdit: (path: string) => void
  clearDiff: () => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

/** 每个工作区各持有一份 Diff 状态，隐藏的工作区保留自己的审阅进度 */
export function createDiffStore(): StoreApi<DiffState> {
  return createStore<DiffState>((set) => ({
    edits: [],
    currentIndex: 0,
    isOpen: false,
    isLoading: false,
    error: null,

    openEdits: (edits) => {
      const merged = mergeFileEdits(edits)
      set({
        edits: merged,
        currentIndex: 0,
        isOpen: merged.length > 0,
        error: null,
      })
    },

    setCurrentIndex: (index) =>
      set((state) => ({
        currentIndex: Math.min(Math.max(index, 0), Math.max(state.edits.length - 1, 0)),
      })),

    removeEdit: (path) =>
      set((state) => {
        const edits = state.edits.filter((edit) => edit.path !== path)
        if (edits.length === 0) {
          return { edits: [], currentIndex: 0, isOpen: false }
        }
        return {
          edits,
          currentIndex: Math.min(state.currentIndex, edits.length - 1),
        }
      }),

    clearDiff: () => set({ edits: [], currentIndex: 0, isOpen: false }),
    setLoading: (loading) => set({ isLoading: loading }),
    setError: (error) => set({ error }),
  }))
}

const stores = new Map<string, StoreApi<DiffState>>()
const EMPTY_STORE = createDiffStore()

export function diffStoreFor(workspacePath: string | null | undefined): StoreApi<DiffState> {
  if (!workspacePath) return EMPTY_STORE
  let store = stores.get(workspacePath)
  if (!store) {
    store = createDiffStore()
    stores.set(workspacePath, store)
  }
  return store
}

export function disposeDiffStore(workspacePath: string): void {
  stores.delete(workspacePath)
}

/** 仅供测试：清空所有工作区的 Diff store */
export function resetDiffStores(): void {
  stores.clear()
}

export function useDiffStore(workspacePath: string | null | undefined): DiffState
export function useDiffStore<T>(
  workspacePath: string | null | undefined,
  selector: (state: DiffState) => T
): T
export function useDiffStore<T>(
  workspacePath: string | null | undefined,
  selector?: (state: DiffState) => T
): DiffState | T {
  const store = diffStoreFor(workspacePath)
  return useStore(store, selector ?? ((state) => state as unknown as T))
}
