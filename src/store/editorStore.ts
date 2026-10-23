import { create } from 'zustand'
import { OpenFile, EditorState } from '../types'

interface EditorStore extends EditorState {
  /** 待定位的文件与行号（R-09），编辑器就绪后消费 */
  pendingReveal: { path: string; line: number } | null
  setCurrentFile: (file: OpenFile | null) => void
  addOpenFile: (file: OpenFile) => void
  revealLine: (path: string, line: number) => void
  consumeReveal: () => void
  removeOpenFile: (path: string) => void
  updateOpenFile: (path: string, changes: Partial<OpenFile>) => void
  markDirty: (path: string) => void
  markClean: (path: string) => void
  reset: () => void
  hasDirtyFiles: () => boolean
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  currentFile: null,
  openFiles: [],
  unsavedChanges: new Set(),
  pendingReveal: null,

  setCurrentFile: (file) => set({ currentFile: file }),

  revealLine: (path, line) =>
    set({ pendingReveal: { path, line: Math.max(1, Math.floor(line)) } }),

  consumeReveal: () => set({ pendingReveal: null }),

  addOpenFile: (file) =>
    set((state) => {
      const exists = state.openFiles.find((f) => f.path === file.path)
      if (exists) return { currentFile: exists }
      const newDirty = new Set(state.unsavedChanges)
      newDirty.delete(file.path)
      return {
        openFiles: [...state.openFiles, file],
        currentFile: file,
        unsavedChanges: newDirty,
      }
    }),

  removeOpenFile: (path) =>
    set((state) => {
      const newFiles = state.openFiles.filter((f) => f.path !== path)
      const newDirty = new Set(state.unsavedChanges)
      newDirty.delete(path)
      let currentFile = state.currentFile
      if (currentFile?.path === path) {
        currentFile = newFiles[newFiles.length - 1] || null
      }
      return {
        openFiles: newFiles,
        currentFile,
        unsavedChanges: newDirty,
      }
    }),

  updateOpenFile: (path, changes) =>
    set((state) => {
      const newFiles = state.openFiles.map((f) =>
        f.path === path ? { ...f, ...changes } : f
      )
      const currentFile =
        state.currentFile?.path === path
          ? { ...state.currentFile, ...changes }
          : state.currentFile

      return {
        openFiles: newFiles,
        currentFile,
      }
    }),

  markDirty: (path) =>
    set((state) => {
      const newDirty = new Set(state.unsavedChanges)
      newDirty.add(path)
      return {
        unsavedChanges: newDirty,
        openFiles: state.openFiles.map((file) =>
          file.path === path ? { ...file, isDirty: true } : file
        ),
        currentFile:
          state.currentFile?.path === path
            ? { ...state.currentFile, isDirty: true }
            : state.currentFile,
      }
    }),

  markClean: (path) =>
    set((state) => {
      const newDirty = new Set(state.unsavedChanges)
      newDirty.delete(path)
      return {
        unsavedChanges: newDirty,
        openFiles: state.openFiles.map((file) =>
          file.path === path ? { ...file, isDirty: false } : file
        ),
        currentFile:
          state.currentFile?.path === path
            ? { ...state.currentFile, isDirty: false }
            : state.currentFile,
      }
    }),

  reset: () =>
    set({
      currentFile: null,
      openFiles: [],
      unsavedChanges: new Set(),
      pendingReveal: null,
    }),

  hasDirtyFiles: () => {
    const state = get()
    return state.openFiles.some((file) => file.isDirty) || state.unsavedChanges.size > 0
  },
}))
