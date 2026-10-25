// File and workspace types
export interface OpenFile {
  path: string
  name: string
  content: string
  isDirty: boolean
  isSaving: boolean
}

// Editor state
export interface EditorState {
  currentFile: OpenFile | null
  openFiles: OpenFile[]
  unsavedChanges: Set<string>
}
