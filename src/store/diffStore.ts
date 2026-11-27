import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStoreWithComparator } from './useStoreWithComparator'
import { mergeFileEdits } from '../api/diff'
import type { FileEdit } from '../types/electron'

export interface DiffState {
  /** 本轮需要审阅的文件修改（按文件去重） */
  edits: FileEdit[]
  currentIndex: number
  isOpen: boolean

  // Actions
  openEdits: (edits: FileEdit[]) => void
  setCurrentIndex: (index: number) => void
  removeEdit: (path: string) => void
  clearDiff: () => void
}

/** 每个工作区各持有一份 Diff 状态，隐藏的工作区保留自己的审阅进度 */
export function createDiffStore(): StoreApi<DiffState> {
  return createStore<DiffState>((set) => ({
    edits: [],
    currentIndex: 0,
    isOpen: false,

    openEdits: (edits) => {
      const merged = mergeFileEdits(edits)
      set({
        edits: merged,
        currentIndex: 0,
        isOpen: merged.length > 0,
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
  }))
}

const stores = new Map<string, StoreApi<DiffState>>()
const EMPTY_STORE = createDiffStore()

/** 只读查询某个工作区的 Diff store；未挂载或已关闭时返回 null，绝不分配僵尸 store */
export function peekDiffStore(
  workspacePath: string | null | undefined
): StoreApi<DiffState> | null {
  if (!workspacePath) return null
  return stores.get(workspacePath) ?? null
}

/** 将既有 store 重新登记到注册表（供 WorkspaceStoresProvider 在 StrictMode 挂载期复用） */
export function attachDiffStore(workspacePath: string, store: StoreApi<DiffState>): void {
  if (!workspacePath) return
  if (!stores.has(workspacePath)) {
    stores.set(workspacePath, store)
  }
}

export function diffStoreFor(workspacePath: string | null | undefined): StoreApi<DiffState> {
  if (!workspacePath) return EMPTY_STORE
  let store = stores.get(workspacePath)
  if (!store) {
    store = createDiffStore()
    stores.set(workspacePath, store)
  }
  return store
}

export function disposeDiffStore(
  workspacePath: string,
  expectedStore?: StoreApi<DiffState>
): void {
  if (expectedStore && stores.get(workspacePath) !== expectedStore) return
  stores.delete(workspacePath)
}

/** 仅供测试：清空所有工作区的 Diff store */
export function resetDiffStores(): void {
  stores.clear()
}

export function useDiffStore(workspacePath: string | null | undefined): DiffState
export function useDiffStore<T>(
  workspacePath: string | null | undefined,
  selector: (state: DiffState) => T,
  isEqual?: (a: T, b: T) => boolean
): T
export function useDiffStore<T>(
  workspacePath: string | null | undefined,
  selector?: (state: DiffState) => T,
  isEqual?: (a: T, b: T) => boolean
): DiffState | T {
  const store = diffStoreFor(workspacePath)
  return useStoreWithComparator(store, selector, isEqual)
}
