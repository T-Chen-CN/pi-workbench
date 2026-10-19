// File and workspace types
export interface FileEntry {
  name: string
  is_dir: boolean
  path: string
}

export interface OpenFile {
  path: string
  name: string
  content: string
  isDirty: boolean
  isSaving: boolean
}

// Chat and Agent types
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  codeBlock?: {
    language: string
    code: string
    suggestedPath?: string
  }
}

export interface AgentState {
  isInitialized: boolean
  isLoading: boolean
  error: string | null
  messages: ChatMessage[]
}

// Editor state
export interface EditorState {
  currentFile: OpenFile | null
  openFiles: OpenFile[]
  unsavedChanges: Set<string>
}
