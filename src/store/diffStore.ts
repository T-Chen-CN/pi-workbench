import { create } from 'zustand'
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

export const useDiffStore = create<DiffState>((set) => ({
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
