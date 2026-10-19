import { create } from 'zustand'
import { DiffResult } from '../api/diff'

export interface DiffState {
  currentDiff: DiffResult | null
  isOpen: boolean
  isLoading: boolean
  error: string | null

  // Actions
  setDiff: (diff: DiffResult) => void
  clearDiff: () => void
  setOpen: (open: boolean) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

export const useDiffStore = create<DiffState>((set) => ({
  currentDiff: null,
  isOpen: false,
  isLoading: false,
  error: null,

  setDiff: (diff) => set({ currentDiff: diff, isOpen: true, error: null }),
  clearDiff: () => set({ currentDiff: null, isOpen: false }),
  setOpen: (open) => set({ isOpen: open }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),
}))
