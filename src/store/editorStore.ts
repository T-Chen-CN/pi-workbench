import { create } from 'zustand'
import { OpenFile, EditorState } from '../types'

interface EditorStore extends EditorState {
  setCurrentFile: (file: OpenFile | null) => void
  addOpenFile: (file: OpenFile) => void
  removeOpenFile: (path: string) => void
  updateOpenFile: (path: string, changes: Partial<OpenFile>) => void
  markDirty: (path: string) => void
  markClean: (path: string) => void
}

export const useEditorStore = create<EditorStore>((set) => ({
  currentFile: null,
  openFiles: [],
  unsavedChanges: new Set(),

  setCurrentFile: (file) => set({ currentFile: file }),

  addOpenFile: (file) =>
    set((state) => {
      const exists = state.openFiles.find((f) => f.path === file.path)
      if (exists) return { currentFile: exists }
      return {
        openFiles: [...state.openFiles, file],
        currentFile: file,
      }
    }),

  removeOpenFile: (path) =>
    set((state) => {
      const newFiles = state.openFiles.filter((f) => f.path !== path)
      let currentFile = state.currentFile
      if (currentFile?.path === path) {
        currentFile = newFiles[newFiles.length - 1] || null
      }
      return {
        openFiles: newFiles,
        currentFile,
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
      return { unsavedChanges: newDirty }
    }),

  markClean: (path) =>
    set((state) => {
      const newDirty = new Set(state.unsavedChanges)
      newDirty.delete(path)
      return { unsavedChanges: newDirty }
    }),
}))
