export interface ElectronAPI {
  // File system operations
  openDirectoryDialog: () => Promise<OpenDirectoryResult>
  readFile: (path: string) => Promise<ReadFileResult>
  writeFile: (path: string, content: string) => Promise<WriteFileResult>
  listDirectory: (path: string) => Promise<ListDirectoryResult>
  exists: (path: string) => Promise<ExistsResult>
  stat: (path: string) => Promise<StatResult>
  deletePath: (path: string) => Promise<WorkspaceResult>
  renamePath: (oldPath: string, newPath: string) => Promise<WorkspaceResult>
  watchWorkspace: (workspacePath: string) => Promise<WorkspaceResult>
  unwatchWorkspace: () => Promise<WorkspaceResult>
  onFsChanged: (callback: (payload: { type: string; path: string }) => void) => () => void

  // App configuration (portable architecture)
  getAppDir: () => Promise<GetAppDirResult>
  getSettings: () => Promise<GetSettingsResult>
  saveSettings: (settings: any) => Promise<SaveSettingsResult>
  getRecentWorkspaces: () => Promise<RecentWorkspacesResult>
  addRecentWorkspace: (workspacePath: string) => Promise<RecentWorkspacesResult>

  // Workspace configuration
  initWorkspace: (workspacePath: string) => Promise<WorkspaceResult>
  getWorkspaceConfig: (workspacePath: string) => Promise<GetWorkspaceConfigResult>
  saveWorkspaceConfig: (workspacePath: string, config: any) => Promise<WorkspaceResult>

  // Pi Agent API
  agentInitialize: (config: AgentInitConfig) => Promise<AgentInitResult>
  agentChat: (message: string, requestId?: string) => Promise<AgentChatResult>
  onAgentStream: (callback: (payload: AgentStreamPayload) => void) => () => void
  agentIsInitialized: () => Promise<AgentStatusResult>
  agentGetHistory: () => Promise<AgentHistoryResult>
  agentDispose: () => Promise<AgentDisposeResult>

  // API Configuration management (便携式架构)
  apiConfigGet: () => Promise<ApiConfigGetResult>
  apiConfigSave: (config: ApiConfig) => Promise<ApiConfigSaveResult>
  apiConfigFetchModels: (apiUrl: string, apiKey: string, provider: ApiProvider) => Promise<FetchModelsResult>
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
export type ApiProvider = 'anthropic' | 'openai' | 'custom'

export interface ApiConfig {
  provider: ApiProvider
  apiUrl: string
  apiKey: string
  availableModels: string[]
  selectedModel: string
}

export interface AgentInitConfig {
  workspaceDir: string
  /** Agent 数据目录（主进程默认使用 {appDir}/data/agent） */
  agentDir?: string
  apiConfig: ApiConfig
}

export interface AgentInitResult {
  success: boolean
  error?: string
}

export interface FileEdit {
  path: string
  oldContent: string
  newContent: string
}

export interface AgentChatResult {
  success: boolean
  response?: string
  error?: string
  /** Agent 本轮修改过的文件（用于 Diff 展示） */
  edits?: FileEdit[]
}

export interface AgentStreamPayload {
  /** 发起请求时生成，用于忽略过期会话的增量 */
  requestId?: string
  /** 本次推送的文本增量 */
  delta: string
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

export interface RecentWorkspacesResult {
  success: boolean
  workspaces: string[]
  error?: string
}

export interface ApiConfigGetResult {
  success: boolean
  config?: ApiConfig
  error?: string
}

export interface ApiConfigSaveResult {
  success: boolean
  error?: string
}

export interface FetchModelsResult {
  success: boolean
  models?: string[]
  error?: string
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

