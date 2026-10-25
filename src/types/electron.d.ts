export interface ElectronAPI {
  platform: string
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
  unwatchWorkspace: (workspacePath?: string) => Promise<WorkspaceResult>
  onFsChanged: (callback: (payload: { type: string; path: string }) => void) => () => void

  // App configuration (portable architecture)
  getAppDir: () => Promise<GetAppDirResult>
  logRenderer: (level: string, args: unknown[]) => Promise<{ success: boolean }>
  updateCheck: () => Promise<UpdateCheckResult>
  updateDownload: () => Promise<UpdateActionResult>
  updateInstall: () => Promise<UpdateActionResult>
  updateGetState: () => Promise<UpdateStateResult>
  updateOpenDownload: () => Promise<UpdateActionResult>
  onUpdateStatus: (callback: (status: UpdateState) => void) => () => void
  appGetInfo: () => Promise<AppInfoResult>
  appHasActiveWork: () => Promise<AppActiveWorkResult>
  getSettings: () => Promise<GetSettingsResult>
  saveSettings: (settings: any) => Promise<SaveSettingsResult>
  getRecentWorkspaces: () => Promise<RecentWorkspacesResult>
  addRecentWorkspace: (workspacePath: string) => Promise<RecentWorkspacesResult>
  minimizeWindow: () => Promise<{ success: boolean }>
  toggleMaximizeWindow: () => Promise<{ success: boolean; maximized: boolean }>
  closeWindow: () => Promise<{ success: boolean }>
  isWindowMaximized: () => Promise<{ success: boolean; maximized: boolean }>
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void

  // Workspace configuration
  initWorkspace: (workspacePath: string) => Promise<WorkspaceResult>
  disposeWorkspace: (workspacePath: string) => Promise<WorkspaceResult>
  draftSave: (workspacePath: string, filePath: string, content: string) => Promise<DraftResult>
  draftDelete: (workspacePath: string, filePath: string) => Promise<DraftResult>
  draftList: (workspacePath: string) => Promise<DraftListResult>
  draftClear: (workspacePath: string) => Promise<DraftResult>
  editorTabsGet: (workspacePath: string) => Promise<EditorTabsResult>
  editorTabsSet: (workspacePath: string, tabs: EditorTabs) => Promise<WorkspaceResult>

  // Pi Agent API
  agentInitialize: (config: AgentInitConfig) => Promise<AgentInitResult>
  agentChat: (
    message: string,
    requestId?: string,
    workspaceDir?: string,
    sessionId?: string,
    images?: AgentImagePayload[]
  ) => Promise<AgentChatResult>
  agentAbort: (workspaceDir?: string, sessionId?: string) => Promise<AgentDisposeResult>
  onAgentStream: (callback: (payload: AgentStreamPayload) => void) => () => void
  onAgentSessionTitle: (
    callback: (payload: { workspaceDir: string; sessionId: string; title: string }) => void
  ) => () => void
  agentDispose: (workspaceDir?: string) => Promise<AgentDisposeResult>
  agentSessionsList: (workspaceDir: string) => Promise<SessionListResult>
  agentSessionsOpen: (workspaceDir: string, sessionId?: string) => Promise<SessionOpenResult>
  agentSessionsCreate: (workspaceDir: string) => Promise<SessionOpenResult>
  agentSessionsClose: (workspaceDir: string, sessionId: string) => Promise<AgentDisposeResult>
  agentSessionsRename: (
    workspaceDir: string,
    sessionId: string,
    name: string
  ) => Promise<AgentDisposeResult>
  agentSessionsDelete: (workspaceDir: string, sessionId: string) => Promise<AgentDisposeResult>
  agentSessionsGetTabs: (workspaceDir: string) => Promise<SessionTabsResult>
  agentSessionsSetTabs: (workspaceDir: string, tabs: SessionTabs) => Promise<AgentDisposeResult>
  onNotifyClick: (
    callback: (payload: { workspaceDir: string; sessionId: string }) => void
  ) => () => void
  agentSteer: (
    workspaceDir: string,
    sessionId: string,
    message: string
  ) => Promise<{ success: boolean; error?: string }>
  agentContextUsage: (
    workspaceDir: string,
    sessionId: string
  ) => Promise<{ success: boolean; usage?: ContextUsageInfo; error?: string }>
  agentCompactContext: (
    workspaceDir: string,
    sessionId: string
  ) => Promise<{
    success: boolean
    tokensBefore?: number
    estimatedTokensAfter?: number
    error?: string
  }>
  agentRewind: (
    workspaceDir: string,
    sessionId: string,
    newText?: string
  ) => Promise<{ success: boolean; text?: string; error?: string }>
  agentBranchesList: (
    workspaceDir: string,
    sessionId: string
  ) => Promise<{ success: boolean; groups?: ConversationBranchGroup[]; error?: string }>
  agentBranchesSwitch: (
    workspaceDir: string,
    sessionId: string,
    entryId: string
  ) => Promise<{
    success: boolean
    history?: AgentHistoryResult['history']
    error?: string
  }>
  agentSessionSettings: (
    workspaceDir: string,
    sessionId: string
  ) => Promise<{
    success: boolean
    modelId?: string
    thinkingLevel?: string
    permission?: SessionPermission
    error?: string
  }>
  agentSessionSetPermission: (
    workspaceDir: string,
    sessionId: string,
    permission: SessionPermission
  ) => Promise<{ success: boolean; permission?: SessionPermission; error?: string }>
  agentSessionStats: (
    workspaceDir: string,
    sessionId: string
  ) => Promise<{ success: boolean; stats?: SessionStatsInfo; error?: string }>
  agentModelCapabilities: (
    workspaceDir: string
  ) => Promise<{ success: boolean; models?: ModelCapabilityInfo[]; selected?: string; error?: string }>
  agentPromptResources: (
    workspaceDir: string,
    sessionId: string
  ) => Promise<{
    success: boolean
    templates?: PromptTemplateInfo[]
    skills?: SkillInfo[]
    error?: string
  }>
  agentPlanGet: (
    workspaceDir: string,
    sessionId: string
  ) => Promise<{ success: boolean; plan?: StructuredPlan | null; error?: string }>
  agentPlanApprove: (
    workspaceDir: string,
    sessionId: string,
    planId: string,
    targetMode: 'ask' | 'auto'
  ) => Promise<{
    success: boolean
    plan?: StructuredPlan
    permission?: SessionPermission
    error?: string
  }>
  agentPlanReject: (
    workspaceDir: string,
    sessionId: string,
    planId: string
  ) => Promise<{ success: boolean; plan?: StructuredPlan; error?: string }>
  agentToolDiff: (
    workspaceDir: string,
    sessionId: string,
    toolCallId: string
  ) => Promise<{
    success: boolean
    edit?: { path: string; oldContent: string; newContent: string }
    error?: string
  }>
  agentToolResultMeta: (
    workspaceDir: string,
    sessionId: string,
    toolCallId: string
  ) => Promise<{ success: boolean; meta?: ToolResultMeta; error?: string }>
  agentToolResultChunk: (
    workspaceDir: string,
    sessionId: string,
    toolCallId: string,
    offset?: number,
    limit?: number
  ) => Promise<{
    success: boolean
    text?: string
    offset?: number
    nextOffset?: number
    chars?: number
    done?: boolean
    error?: string
  }>
  agentToolResultImage: (
    workspaceDir: string,
    sessionId: string,
    toolCallId: string,
    index?: number
  ) => Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }>
  agentToolResultOpen: (
    workspaceDir: string,
    sessionId: string,
    toolCallId: string
  ) => Promise<{ success: boolean; path?: string; error?: string }>
  agentExportSession: (
    workspaceDir: string,
    sessionId: string,
    format: ExportSessionFormat,
    language?: 'zh' | 'en'
  ) => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>
  agentSessionSetModel: (
    workspaceDir: string,
    sessionId: string,
    modelId: string
  ) => Promise<{ success: boolean; error?: string }>
  agentSessionSetThinking: (
    workspaceDir: string,
    sessionId: string,
    level: string
  ) => Promise<{ success: boolean; error?: string }>
  agentSessionsMetaGet: (
    workspaceDir: string
  ) => Promise<{ success: boolean; meta?: SessionMeta; error?: string }>
  agentSessionsMetaSet: (
    workspaceDir: string,
    meta: SessionMeta
  ) => Promise<{ success: boolean; error?: string }>
  chatPendingGet: (
    workspaceDir: string
  ) => Promise<{ success: boolean; sessions?: PendingMessagesMap; error?: string }>
  chatPendingSet: (
    workspaceDir: string,
    sessions: PendingMessagesMap
  ) => Promise<{ success: boolean; error?: string }>
  searchWorkspaceFiles: (
    workspaceDir: string,
    query: string,
    limit?: number
  ) => Promise<{ success: boolean; files?: string[]; error?: string }>
  getPathForFile: (file: File) => string
  onAgentApprovalRequest: (callback: (payload: ApprovalRequestPayload) => void) => () => void
  agentRespondApproval: (
    requestId: string,
    decision: ApprovalDecision
  ) => Promise<{ success: boolean; error?: string }>
  onAgentApprovalResolved: (
    callback: (payload: {
      requestId: string
      workspaceDir: string
      sessionId: string
      decision: ApprovalDecision
    }) => void
  ) => () => void

  // Terminal
  terminalCreate: (workspaceDir: string, cols: number, rows: number) => Promise<TerminalCreateResult>
  terminalWrite: (id: string, data: string) => Promise<TerminalResult>
  terminalResize: (id: string, cols: number, rows: number) => Promise<TerminalResult>
  terminalClose: (id: string) => Promise<TerminalResult>
  terminalFlush: (id: string) => Promise<TerminalResult>
  onTerminalData: (callback: (payload: { id: string; data: string }) => void) => () => void
  onTerminalExit: (callback: (payload: { id: string; exitCode: number }) => void) => () => void

  // Workbench plugins
  pluginsList: (workspaceDir: string) => Promise<PluginsListResult>
  pluginsInvoke: (
    workspaceDir: string,
    commandId: string,
    args?: unknown
  ) => Promise<PluginCommandResult>
  pluginsReload: (workspaceDir: string) => Promise<PluginsListResult>
  pluginsSetEnabled: (
    workspaceDir: string,
    pluginId: string,
    enabled: boolean
  ) => Promise<PluginsListResult>
  onPluginsChanged: (callback: (payload: { workspaceDir: string }) => void) => () => void

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
    runWhileBusy?: 'queue' | 'steer'
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

// Pi Agent types
export type ApiProvider = 'anthropic' | 'openai' | 'custom'

export interface ApiConfig {
  provider: ApiProvider
  apiUrl: string
  apiKey: string
  availableModels: string[]
  selectedModel: string
  /** 用户勾选为“支持图片”的模型（R-08 优化）；缺省时由主进程填充内置默认值 */
  imageModels?: string[]
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

/** 发送给 Agent 的图像附件（base64，不含 data: 前缀） */
export interface AgentImagePayload {
  data: string
  mimeType: string
}

// 工具审批（AF-01）

export type ToolCategory = 'read' | 'write' | 'command' | 'other'

export type PermissionAction = 'allow' | 'ask' | 'deny'

export interface PermissionPolicy {
  read: PermissionAction
  write: PermissionAction
  command: PermissionAction
  other: PermissionAction
}

/** 默认权限档位（AF-02）：全局只提供新会话的默认档 */
export type PermissionLevel = 'readonly' | 'ask' | 'auto'

/** 会话模式：权限档位 + 计划工作流；计划可选但不作为默认档 */
export type SessionMode = PermissionLevel | 'plan'

export interface SessionPermission {
  mode: SessionMode
  /** 会话内额外允许的类别；只在 ask 模式下有效 */
  grants: ToolCategory[]
}

export interface ApprovalRequestPayload {
  requestId: string
  workspaceDir: string
  sessionId: string
  toolCallId: string
  toolName: string
  category: ToolCategory
  summary: string
  details: {
    path?: string
    command?: string
    preview?: string
    editCount?: number
  }
  createdAt: number
  expiresAt: number
}

export type ApprovalDecision =
  | { action: 'allow-once' }
  | { action: 'allow-always' }
  | { action: 'deny'; reason?: string }

/** 上下文窗口占用 */
export interface ContextUsageInfo {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

/** 会话置顶 / 归档元数据 */
export interface SessionMeta {
  pinned: string[]
  archived: string[]
}

/** 同一条用户消息下的可切换回复（R-03） */
export interface ConversationBranchOption {
  entryId: string
  preview: string
}

export interface ConversationBranchGroup {
  /** 该轮用户消息的时间戳，与历史消息的 timestamp 对应 */
  userTimestamp: number
  activeIndex: number
  branches: ConversationBranchOption[]
}

/** 排队消息（按会话分组持久化） */
export interface PendingMessageRecord {
  id: string
  text: string
}

export type PendingMessagesMap = Record<string, PendingMessageRecord[]>

/** 会话导出格式（R-10） */
export type ExportSessionFormat = 'md' | 'html' | 'jsonl'

/** 工具结果全量查看（R-20） */
export interface ToolResultMeta {
  toolName: string
  kind: 'text' | 'image'
  chars: number
  bytes: number
  lines: number
  imageCount: number
}

/** 模型能力提示（R-06） */
export interface ModelCapabilityInfo {
  id: string
  available: boolean
  /** catalog：应用内置已知元数据；default：供应商未声明（显示未知） */
  source: 'catalog' | 'default'
  contextWindow: number | null
  maxTokens: number | null
  reasoning: boolean | null
  vision: boolean | null
  thinkingLevels: string[]
}

/** 提示模板与技能（R-13） */
export interface PromptTemplateInfo {
  name: string
  description: string
  argumentHint?: string
  scope: 'user' | 'project' | 'temporary'
}

export interface SkillInfo {
  name: string
  description: string
  scope: 'user' | 'project' | 'temporary'
  disableModelInvocation: boolean
}

/** 结构化计划（R-04） */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped'
export type PlanStatus = 'proposed' | 'approved' | 'rejected'

export interface PlanStep {
  id: string
  title: string
  files: string[]
  risk?: string
  status: PlanStepStatus
}

export interface StructuredPlan {
  id: string
  summary: string
  steps: PlanStep[]
  status: PlanStatus
  createdAt: number
  updatedAt: number
}

/** 会话累计用量与成本 */
export interface SessionStatsInfo {
  tokens: number
  input: number
  output: number
  cost: number
  toolCalls: number
  messages: number
}

export interface FileEdit {
  path: string
  oldContent: string
  newContent: string
  /** 触发该修改的工具调用；用于在工具步骤里打开对应 Diff */
  toolCallId?: string
}

/** 助手消息中的有序过程 / 正文片段 */
export type AgentTracePart =
  | { type: 'text'; id: string; text: string }
  | {
      type: 'thinking'
      id: string
      text: string
      redacted?: boolean
      durationMs?: number
    }
  | {
      type: 'tool'
      id: string
      toolCallId: string
      toolName: string
      argsSummary: string
      status: 'running' | 'success' | 'error'
      isError?: boolean
      durationMs?: number
      resultPreview?: string
      filePath?: string
      /** 历史工具行有保存的 Diff */
      hasDiff?: boolean
      /** 嵌套调用的父级工具调用（R-16） */
      parentToolCallId?: string
    }
  | {
      /** Plan 模式提交的结构化计划（R-04），只读展示 */
      type: 'plan'
      id: string
      plan: StructuredPlan
    }

/** 主进程归一化后的流式事件（不含路由字段） */
export type AgentStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_redacted' }
  | {
      type: 'tool_start'
      toolCallId: string
      toolName: string
      argsSummary: string
      startedAt: number
      parentToolCallId?: string
    }
  | {
      type: 'tool_update'
      toolCallId: string
      resultPreview?: string
      parentToolCallId?: string
    }
  | {
      type: 'tool_end'
      toolCallId: string
      toolName: string
      status: 'success' | 'error'
      durationMs?: number
      resultPreview?: string
      filePath?: string
      parentToolCallId?: string
    }
  | {
      type: 'retry_start'
      attempt: number
      maxAttempts: number
      delayMs: number
      message?: string
    }
  | { type: 'retry_end'; success: boolean }
  | { type: 'compaction_start'; reason: 'manual' | 'threshold' | 'overflow' }
  | {
      type: 'compaction_end'
      reason: 'manual' | 'threshold' | 'overflow'
      tokensBefore?: number
      error?: string
    }
  | { type: 'plan_submitted'; plan: StructuredPlan }
  | { type: 'plan_updated'; plan: StructuredPlan }

export type AgentStreamPayload = {
  /** 发起请求时生成，用于忽略过期会话的增量 */
  requestId?: string
  /** 产生增量的工作区与会话（多会话/多工作区路由） */
  workspaceDir?: string
  sessionId?: string
} & AgentStreamEvent

export interface AgentChatResult {
  success: boolean
  response?: string
  error?: string
  /** Agent 本轮修改过的文件（用于 Diff 展示） */
  edits?: FileEdit[]
  /** 本轮 Plan 模式新提交的结构化计划（R-04） */
  plan?: StructuredPlan
}

export interface SessionSummary {
  id: string
  title: string
  messageCount: number
  createdAt: number
  updatedAt: number
}

export interface SessionListResult {
  success: boolean
  sessions?: SessionSummary[]
  currentId?: string | null
  error?: string
}

export interface SessionOpenResult {
  success: boolean
  session?: SessionSummary
  history?: AgentHistoryResult['history']
  error?: string
}

export interface SessionTabs {
  open: string[]
  active: string | null
}

export interface SessionTabsResult {
  success: boolean
  tabs?: SessionTabs
  error?: string
}

export interface EditorTabs {
  open: string[]
  active: string | null
}

export interface EditorTabsResult {
  success: boolean
  tabs?: EditorTabs
  error?: string
}

export interface AgentHistoryResult {
  success: boolean
  history?: Array<{
    role: 'user' | 'assistant'
    content: string
    parts?: AgentTracePart[]
    /** 用户消息附带的图片（R-08） */
    images?: AgentImagePayload[]
    timestamp: number
  }>
  error?: string
}

export interface AgentDisposeResult {
  success: boolean
  error?: string
}

export interface TerminalCreateResult {
  success: boolean
  id?: string
  logPath?: string | null
  /** 实际启动的 shell 名称（用于终端标题） */
  shell?: string
  error?: string
}

export interface TerminalResult {
  success: boolean
  error?: string
}

export interface PluginCommandInfo {
  id: string
  title: string
  description?: string
  pluginId: string
  pluginName: string
}

export interface PluginInfo {
  id: string
  name: string
  version?: string
  description?: string
  enabled: boolean
  commands: PluginCommandInfo[]
  error?: string
}

export interface PluginsListResult {
  success: boolean
  plugins: PluginInfo[]
  error?: string
}

export interface PluginCommandResult {
  success: boolean
  message?: string
  output?: string
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

export interface DraftRecord {
  workspace: string
  path: string
  content: string
  updatedAt: number
}

export interface DraftResult {
  success: boolean
  error?: string
}

export interface DraftListResult {
  success: boolean
  drafts: DraftRecord[]
  error?: string
}

export type UpdateStatusKind =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

export interface UpdateState {
  status: UpdateStatusKind
  currentVersion: string
  platform: string
  /** Windows / Linux 可自动下载并安装；macOS 需手动下载 */
  canAutoInstall: boolean
  version?: string
  percent?: number
  releaseNotes?: string
  message?: string
  checkedAt?: number
  downloadUrl?: string
}

export interface UpdateCheckResult {
  success: boolean
  state: UpdateState
  error?: string
}

export interface UpdateActionResult {
  success: boolean
  error?: string
}

export interface UpdateStateResult {
  success: boolean
  state: UpdateState
  error?: string
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  appDir: string
}

export interface AppInfoResult {
  success: boolean
  info: AppInfo
}

export interface AppActiveWorkResult {
  success: boolean
  terminal: boolean
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

