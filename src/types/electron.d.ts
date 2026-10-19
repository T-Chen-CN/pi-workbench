export interface ElectronAPI {
  // File system operations
  openDirectoryDialog: () => Promise<OpenDirectoryResult>
  readFile: (path: string) => Promise<ReadFileResult>
  writeFile: (path: string, content: string) => Promise<WriteFileResult>
  listDirectory: (path: string) => Promise<ListDirectoryResult>
  exists: (path: string) => Promise<ExistsResult>
  stat: (path: string) => Promise<StatResult>

  // App configuration (portable architecture)
  getAppDir: () => Promise<GetAppDirResult>
  getSettings: () => Promise<GetSettingsResult>
  saveSettings: (settings: any) => Promise<SaveSettingsResult>

  // Workspace configuration
  initWorkspace: (workspacePath: string) => Promise<WorkspaceResult>
  getWorkspaceConfig: (workspacePath: string) => Promise<GetWorkspaceConfigResult>
  saveWorkspaceConfig: (workspacePath: string, config: any) => Promise<WorkspaceResult>

  // Pi Agent API
  agentInitialize: (config: AgentInitConfig) => Promise<AgentInitResult>
  agentChat: (message: string) => Promise<AgentChatResult>
  agentIsInitialized: () => Promise<AgentStatusResult>
  agentGetHistory: () => Promise<AgentHistoryResult>
  agentDispose: () => Promise<AgentDisposeResult>

  // API Keys management (便携式架构)
  apiKeysGet: () => Promise<ApiKeysGetResult>
  apiKeysSave: (apiKeys: Record<string, string>) => Promise<ApiKeysResult>
}

export interface OpenDirectoryResult {
  success: boolean
  path?: string
  canceled?: boolean
  error?: string
}

export interface ListDirectoryResult {
  success: boolean
  items?: Array<{
    name: string
    path: string
    isDirectory: boolean
  }>
  error?: string
}

export interface ReadFileResult {
  success: boolean
  content?: string
  error?: string
}

export interface WriteFileResult {
  success: boolean
  error?: string
}

export interface ExistsResult {
  success: boolean
  exists?: boolean
  error?: string
}

export interface StatResult {
  success: boolean
  isFile?: boolean
  isDirectory?: boolean
  size?: number
  error?: string
}

export interface GetAppDirResult {
  success: boolean
  appDir?: string
  error?: string
}

export interface GetSettingsResult {
  success: boolean
  settings?: {
    language: string
    theme: string
    autoSave: boolean
    autoSaveDelay: number
    [key: string]: any
  }
  error?: string
}

export interface SaveSettingsResult {
  success: boolean
  error?: string
}

export interface WorkspaceResult {
  success: boolean
  error?: string
}

export interface GetWorkspaceConfigResult {
  success: boolean
  config?: {
    version: string
    enabledPlugins: string[]
    agentConfig: {
      model: string
      temperature: number
      [key: string]: any
    }
    [key: string]: any
  }
  error?: string
}

// Pi Agent types
export interface AgentInitConfig {
  workspaceDir: string
  apiKey: string
  provider?: 'anthropic' | 'openai' | 'google'
  model?: string
}

export interface AgentInitResult {
  success: boolean
  error?: string
}

export interface AgentChatResult {
  success: boolean
  response?: string
  error?: string
}

export interface AgentStatusResult {
  success: boolean
  initialized?: boolean
  error?: string
}

export interface AgentHistoryResult {
  success: boolean
  history?: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: number
  }>
  error?: string
}

export interface AgentDisposeResult {
  success: boolean
  error?: string
}

export interface ApiKeysGetResult {
  success: boolean
  apiKeys?: Record<string, string>
  error?: string
}

export interface ApiKeysResult {
  success: boolean
  error?: string
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

