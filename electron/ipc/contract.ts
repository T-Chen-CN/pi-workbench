/**
 * 单源强类型 IPC 契约（Main / Preload / Renderer 共享）。
 *
 * 铁律：
 * - 零 `electron` 依赖、零 `node:*` 依赖、零 `Buffer`（使用标准 `TextEncoder`），
 *   确保 Electron 主进程、沙盒 preload bundle 与 Vite 浏览器包都能直接引入。
 * - 所有已有通道名不可修改（兼容性与落盘约束见 AGENTS.md §3）。
 */

import { z } from 'zod'

// ============================================================================
// 1. 领域契约类型（主进程 / 预加载 / 渲染层共用）
// ============================================================================

/** 拖出拆窗时主进程返回的落点判定 */
export interface AuxDetachResult {
  success: boolean
  /** 光标仍在主窗口内：不拆 */
  inside?: boolean
  rect?: { x: number; y: number; width: number; height: number }
  /** 光标离拖动起点的 DIP 距离（主进程按同一坐标源计算） */
  distance?: number
  error?: string
}

/** 自绘窗口按钮的最大化状态：主窗口与辅助窗口各自上报 */
export interface WindowMaximizedState {
  host: string
  maximized: boolean
}

/** 自绘窗口按钮的三种动作，主窗口 / 辅助窗口共用 */
export type WindowCommand = 'minimize' | 'toggleMaximize' | 'close'

export interface AuxWindowCommandResult {
  success: boolean
  maximized?: boolean
  error?: string
}

export interface GitRepoInfo {
  root: string
  gitDir: string
  commonDir: string
  bare: boolean
  linkedWorktree: boolean
  branch: string | null
  head: string | null
  detached: boolean
  remoteUrl: string | null
  github: { owner: string; repo: string } | null
  /** git config user.email；用于把当前用户的提交标成「你」 */
  userEmail: string | null
}

/** 链接工作树的依赖安装状态（GIT-118） */
export type GitWorktreeDepsState = 'none' | 'idle' | 'installing' | 'ready' | 'failed'

export interface GitWorktreeDepsStatus {
  state: GitWorktreeDepsState
  manager: 'pnpm' | 'bun' | 'yarn' | 'npm' | 'uv' | null
  /** `${manager}:${sha1}`；无 lockfile 时为 null */
  hash: string | null
  error?: string
  startedAt?: string
}

/** 主进程推送的依赖状态变化：只带渲染层需要的字段 */
export interface GitWorktreeDepsPayload {
  workspaceDir: string
  key: string
  state: GitWorktreeDepsState
  manager: GitWorktreeDepsStatus['manager']
  error?: string
}

export interface GitWorktreeView {
  id: string
  path: string
  relativePath: string
  branch: string | null
  base: string
  managed: boolean
  isMain: boolean
  missing: boolean
  boundSessionCount: number
  boundToActiveSession: boolean
  /** 云端工作单元复用合成绑定 `cloud:<unitId>`；有值时可从 Git 视图结束该单元（F-19a） */
  cloudUnitId?: string | null
  dirtyCount: number
  ahead: number
  behind: number
  /** 依赖安装状态；主工作树与失效工作树恒为 none */
  deps: GitWorktreeDepsStatus
}

export interface GitBranchInfo {
  name: string
  fullName: string
  sha: string
  upstream: string | null
  current: boolean
  remote: boolean
}

export interface GitStatusInfo {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
  clean: boolean
  files: Array<{ status: string; path: string }>
}

export interface GitCommitInfo {
  sha: string
  shortSha: string
  author: string
  email: string
  date: string
  subject: string
  refs: string
  parents: string[]
}

export interface GitCommitStats {
  additions: number
  deletions: number
  addedFiles: number
  modifiedFiles: number
  deletedFiles: number
}

export interface GitCommitDetail {
  commit: GitCommitInfo
  /** 提交信息中标题之后的正文，可能为空 */
  body: string
  files: Array<{ status: string; path: string }>
  patch: string
  truncated: boolean
}

export interface GithubPrStatus {
  available: boolean
  reason?: string
  pull?: {
    number: number
    title: string
    url: string
    state: string
    draft: boolean
  }
  checks?: {
    state: 'success' | 'failure' | 'pending' | 'none'
    total: number
    failing: string[]
  }
}

export interface GithubAuthUser {
  login: string
  name: string | null
  avatarUrl: string | null
}

export interface GithubAuthConfigResult {
  success: boolean
  /** 本地是否配置了 OAuth App（client id/secret） */
  appConfigured?: boolean
  /** 是否已经保存了 token */
  linked?: boolean
  error?: string
}

export interface GithubAuthStartResult {
  success: boolean
  authUrl?: string
  error?: string
}

export interface GithubAuthCompletePayload {
  success: boolean
  user?: GithubAuthUser | null
  error?: string
}

export interface GithubAuthStatusResult {
  success: boolean
  configured?: boolean
  user?: GithubAuthUser | null
  error?: string
}

export interface GithubDeviceLoginStartResult {
  success: boolean
  userCode?: string
  verificationUri?: string
  expiresIn?: number
  interval?: number
  error?: string
}

export type GithubDeviceLoginEvent =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' | 'denied' | 'error'; error: string }

export interface GitSessionBinding {
  key: string
  path: string
  branch: string | null
}

/** Git 面板自动同步：refs = 分支/提交/提交图；status = 工作树脏状态 */
export type GitChangeScope = 'refs' | 'status'

export interface GitChangedPayload {
  workspaceDir: string
  repoRoot: string
  scopes: GitChangeScope[]
  reason: 'watch' | 'fetch'
}

export interface GitFetchResult {
  success: boolean
  skipped?: boolean
  error?: string
}

/** 云端配对状态（与 electron/cloud/link-store.ts 的 CloudLinkView 对应） */
export interface CloudLinkView {
  linked: boolean
  baseUrl?: string
  deviceId?: string
  deviceName?: string
  pairedAt?: number
  lastConnectedAt?: number
}

/** 终端侧连接状态（与 electron/cloud/device-agent.ts 的 DeviceLinkState 对应） */
export interface CloudDeviceState {
  status: 'unlinked' | 'connecting' | 'online' | 'offline' | 'error'
  deviceId?: string
  baseUrl?: string
  lastError?: string
  lastConnectedAt?: number
  /** 已被云端解绑（F-08 / A-15）：重连已停手，UI 应引导重新配对 */
  revoked?: boolean
  /** 离线队列里还没送出去的帧数 */
  pending: number
}

/** 上报给云端的工作区条目（与 electron/cloud/inventory.ts 对应） */
export interface CloudWorkspaceEntry {
  path: string
  name: string
  remote?: string
  defaultBranch?: string
  isGit: boolean
}

/** 云端模型目录条目（来自 /v1/cloud-config/catalog） */
export interface CloudCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  vision?: boolean
}

/** 云端记忆类型（与 @pi-workbench/cloud-ui 保持结构一致） */
export type CloudMemoryKindContract = 'fact' | 'preference' | 'project' | 'decision' | 'todo'

export interface CloudMemoryItemContract {
  id: string
  kind: CloudMemoryKindContract
  content: string
  tags: string[]
  source: 'auto' | 'dream' | 'manual'
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface CloudDocItemContract {
  name: 'AGENTS.md' | 'SOUL.md'
  content: string
  exists: boolean
  updatedAt: number | null
}

export interface CloudDreamItemContract {
  id: string
  at: number
  trigger: 'idle' | 'manual'
  summary: string
  added: number
  merged: number
  removed: number
}

/** 云端模型配置（只回掩码，Key 永不出服务器） */
export interface CloudConfigResult {
  success: boolean
  config?: {
    configured: boolean
    providerId?: string
    model?: string
    credentialType?: string
    apiKeyMasked?: string
    updatedAt?: number
  }
  error?: string
}

export interface CloudConfigInput {
  providerId: string
  model: string
  apiKey: string
}

/** 客户端通道状态（与 electron/cloud/client-link.ts 的 CloudClientState 对应） */
export type CloudClientState =
  | { status: 'closed' }
  | { status: 'connecting' }
  | { status: 'open'; lastSeq: number }
  | { status: 'error'; error: string; revoked?: boolean; fatal?: boolean }

/** 渲染层能发的客户端帧（不再新增类型：帧格式由 pi-bridge 冻结） */
export type CloudClientOutgoingFrame =
  | { type: 'say'; text: string; clientMessageId: string }
  | {
      type: 'confirm_plan'
      planText: string
      items: Array<{ deviceId: string; workspacePath: string }>
      quota: number
    }
  | { type: 'stop_reply' }
  | { type: 'stop_task'; taskId: string }
  /** F-19a：结束工作单元（回收工作树）；脏树才会真的保留 */
  | { type: 'close_unit'; unitId: string }
  /** F-52 / C-03c：客户端上报已读游标 */
  | { type: 'mark_read'; seq?: number; at?: number }
  /** C-03d：向运行中或待回答工单发送追加指令 / 回复 */
  | { type: 'task_message'; taskId: string; text: string; at?: number }
  | { type: 'ack'; seq: number }
  | { type: 'ping'; at: number }

export interface CloudLinkStatusResult {
  success: boolean
  link: CloudLinkView
  state: CloudDeviceState
  dataDir?: string
  error?: string
}

export interface CloudPairInput {
  baseUrl: string
  code: string
  deviceName?: string
}

export interface CloudPairResult {
  success: boolean
  link?: CloudLinkView
  state?: CloudDeviceState
  error?: string
}

export interface OpenDirectoryResult {
  success: boolean
  path?: string
  canceled?: boolean
  error?: string
}

/** 通过原生对话框选中的附件：任意路径与格式 */
export interface PickedAttachment {
  path: string
  name: string
  size: number
  /** 最后修改时间（ms） */
  mtime: number
  mime: string
  /** 仅图片类型填充：base64（不含 data: 前缀）；其余文件不读内容 */
  data?: string
}

export interface AttachmentPickResult {
  success: boolean
  canceled: boolean
  files: PickedAttachment[]
  error?: string
}

/** 扫描页渲染请求：字节由主进程给，渲染层不需要文件访问能力 */
export interface DocumentRenderRequestPayload {
  id: string
  name: string
  bytes: Uint8Array
  pages: number[]
  scale: number
}

export interface DocumentRenderResultPayload {
  id: string
  images?: { data: string; mimeType: string }[]
  error?: string
}

/** 程序内只读预览的数据模型（主进程 `electron/documents/preview.ts` 产出） */
export type DocumentPreviewBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet'; text: string }
  | { type: 'table'; rows: string[][] }

export interface DocumentPreviewSheet {
  name: string
  rows: string[][]
  dimension?: string
  merges: string[]
  truncated: boolean
}

export interface DocumentPreviewSlide {
  index: number
  lines: string[]
  images: { name: string; dataUrl: string }[]
}

export interface DocumentPreviewChapter {
  label: string
  lines: string[]
}

export type DocumentPreview =
  | { kind: 'word'; format: string; blocks: DocumentPreviewBlock[]; truncated: boolean }
  | { kind: 'sheet'; format: string; sheets: DocumentPreviewSheet[] }
  | { kind: 'slide'; format: string; slides: DocumentPreviewSlide[] }
  | { kind: 'epub'; format: string; chapters: DocumentPreviewChapter[] }
  | { kind: 'pdf'; format: 'pdf' }
  | { kind: 'legacy'; format: 'legacy-office'; message: string }
  | { kind: 'error'; message: string }

export interface DocumentPreviewResult {
  success: boolean
  preview?: DocumentPreview
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
  /** 二进制文件：不返回 content，交给 pw-file:// 协议渲染 */
  binary?: boolean
  /** 二进制探测得到的 MIME 猜测 */
  mime?: string
  size?: number
  error?: string
}

export interface WriteFileResult {
  success: boolean
  error?: string
}

export interface CreateFileResult {
  success: boolean
  code?: string
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

export interface AppSettingsRecord {
  language: string
  theme: string
  autoSave: boolean
  autoSaveDelay: number
  runWhileBusy?: 'queue' | 'steer'
  [key: string]: unknown
}

export interface GetSettingsResult {
  success: boolean
  settings?: AppSettingsRecord
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

/** 固定供应商白名单（8 家）；模型能力与协议由 Pi catalog 提供 */
export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'xiaomi'
  | 'xiaomi-token-plan-cn'
  | 'openai-codex'

export type ProviderAuthMethod = 'api_key' | 'oauth'

/** 按模型存的下调值；缺省 = catalog 真值 */
export interface ProviderModelOverrides {
  contextWindow?: number
  maxTokens?: number
}

/** 生效容量：catalog 真值与用户下调值中的较小者 */
export interface ProviderModelLimits {
  contextWindow: number
  maxTokens: number
}

export interface ProviderModelEnrichmentCost {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

export interface ProviderModelEnrichment {
  description?: string
  cost?: ProviderModelEnrichmentCost
  modalities?: { input: string[]; output: string[] }
  knowledge?: string
  releaseDate?: string
  openWeights?: boolean
  status?: string
}

export interface ProviderModelView {
  id: string
  name: string
  limits: ProviderModelLimits
  /** 目录原始上限（用于设置下拉允许把已下调的值调回更高档位） */
  catalogLimits?: ProviderModelLimits
  /** 归一化后的下调值；没有覆盖时不出现 */
  overrides?: ProviderModelOverrides
  reasoning: boolean
  vision: boolean
  /** 请求协议（能力表展示） */
  api: string
  thinkingLevels: string[]
  input: string[]
  cost?: unknown
  /** models.dev 独立富数据（可选展示增强） */
  enrichment?: ProviderModelEnrichment
}

export interface ProviderDirectoryView {
  source: 'remote' | 'bundled'
  checkedAt?: number
  lastModified?: number
}

export interface ProviderView {
  id: ProviderId
  name: string
  connected: boolean
  credentialType?: 'api_key' | 'oauth'
  authMethods: ProviderAuthMethod[]
  active: boolean
  model?: string
  models: ProviderModelView[]
  directory?: ProviderDirectoryView
}

export interface ProvidersListResult {
  success: boolean
  providers?: ProviderView[]
  activeProvider?: string | null
  offline?: boolean
  builtinGeneratedAt?: number
  error?: string
}

/** 登录过程中需要用户输入的一步 */
export interface ProviderAuthPrompt {
  requestId: string
  prompt: {
    type: 'text' | 'secret' | 'select' | 'manual_code'
    message: string
    placeholder?: string
    options?: Array<{ id: string; label: string; description?: string }>
  }
}

/** 登录事件：授权链接 / 设备码 / 进度 / 需要输入 / 结果 */
export type ProviderAuthEvent =
  | { providerId: string; kind: 'prompt'; prompt: ProviderAuthPrompt }
  | { providerId: string; kind: 'info'; message: string; links?: Array<{ url: string; label?: string }> }
  | { providerId: string; kind: 'auth_url'; url: string; instructions?: string }
  | {
      providerId: string
      kind: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | { providerId: string; kind: 'progress'; message: string }
  | { providerId: string; kind: 'result'; success: boolean; error?: string }

// 联网搜索（内置能力）
export type WebSearchProviderId =
  | 'tavily'
  | 'exa'
  | 'brave'
  | 'firecrawl'
  | 'perplexity'
  | 'parallel'
  | 'jina'
  | 'bocha'
  | 'zai'
  | 'duckduckgo'

export type WebSearchEndpoint = 'global' | 'china'

export interface WebSearchConfig {
  /** null 表示尚未选择来源 */
  provider: WebSearchProviderId | null
  endpoint: WebSearchEndpoint
  /** 按供应商提交的新 Key（读取时永不返回明文） */
  keys: Partial<Record<WebSearchProviderId, string>>
  /** 读取时标记哪些供应商已在主进程安全保存 Key */
  configuredKeys?: Partial<Record<WebSearchProviderId, boolean>>
}

export interface WebSearchGetResult {
  success: boolean
  config?: WebSearchConfig
  error?: string
}

export interface WebSearchSaveResult {
  success: boolean
  error?: string
}

export interface AgentInitConfig {
  workspaceDir: string
  /** Agent 数据目录（主进程默认使用 {appDir}/data/agent） */
  agentDir?: string
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
  /** 触发自动压缩的近似占比（整数百分比） */
  autoCompactPercent?: number
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
  /** 该轮用户消息在 JSONL 中的持久化 entryId（优先匹配锚点） */
  userEntryId?: string
  activeIndex: number
  branches: ConversationBranchOption[]
}

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
  contextWindow: number
  maxTokens: number | null
  /** 生效值来源：auto=档位推导，user=用户档位，clamped=被 catalog 封顶 */
  maxTokensSource?: 'auto' | 'user' | 'clamped'
  reasoning: boolean | null
  vision: boolean
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
      /** 嵌套调用的父级工具调用（R-16） */
      parentToolCallId?: string
    }
  | {
      /** Plan 模式提交的结构化计划（R-04），只读展示 */
      type: 'plan'
      id: string
      plan: StructuredPlan
    }
  | {
      /** 上下文压缩点：随 parts 时间线排序，位置跟随压缩发生的先后 */
      type: 'compaction'
      id: string
      /** 对应 JSONL compaction entry id；实时与重载后共用同一锚点 */
      entryId?: string
      timestamp: number
      tokensBefore?: number
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
      /** 压缩被取消或未完成：不画分隔线 */
      aborted?: boolean
      willRetry?: boolean
      /** 已落盘的 compaction entry id 与时间戳 */
      entryId?: string
      timestamp?: number
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
  /** 前置手动压缩失败导致本轮未发送即终止 */
  compactionFailed?: boolean
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

/** 引用块：划词引用 / 选区快照（正文内联） */
export interface MessageContextQuote {
  /** 来源标题：「对话引用」或文件名 */
  label?: string
  /** 来源文件路径；对话引用没有路径 */
  path?: string
  startLine?: number
  endLine?: number
  content: string
}

/** 文件附件：只交路径与元信息，内容由 Agent 自己读 */
export interface MessageContextFile {
  path: string
  name?: string
  size?: number
  mime?: string
  mtime?: number
  /** 位于工作区之外 */
  external?: boolean
}

/** 一条用户消息随行的附件 / 引用 */
export interface MessageContext {
  quotes: MessageContextQuote[]
  files: MessageContextFile[]
}

export interface AgentHistoryResult {
  success: boolean
  history?: Array<{
    entryId?: string
    role: 'user' | 'assistant'
    content: string
    parts?: AgentTracePart[]
    usage?: {
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheWrite: number
      totalTokens: number
      cost: number
    }
    /** 用户消息附带的图片（R-08） */
    images?: AgentImagePayload[]
    /** 用户消息随行的引用与附件；从会话记录里的上下文块解析而来 */
    context?: MessageContext
    timestamp: number
  }>
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
  /** 标签所属的工作树根；主工作树时省略 */
  root?: string
}

export interface EditorTabsResult {
  success: boolean
  tabs?: EditorTabs
  error?: string
}

/** 仓库地图：文件在工作区里的角色（与 i18n 的 repoMapRole* 一一对应） */
export type RepoMapRole =
  | 'component'
  | 'state'
  | 'ipc'
  | 'util'
  | 'type'
  | 'style'
  | 'test'
  | 'doc'
  | 'config'
  | 'asset'
  | 'other'

/** 仓库地图条目：事实（与语言无关）+ 相对仓库根的路径 */
export interface RepoMapFile {
  path: string
  role: RepoMapRole
  binary: boolean
  size: number
  mtimeMs: number
  /** 是否已生成描述；降级模式下未展开的文件为 false */
  described: boolean
  /** 文件首部注释（原文摘要，渲染层再截断） */
  headComment?: string
  exports?: string[]
  symbol?: string
}

export interface RepoMapResult {
  success: boolean
  isRepo: boolean
  repoRoot?: string
  total: number
  described: number
  /** 仓库超过全量扫描上限时为 true：描述按目录 / 搜索补齐 */
  truncated: boolean
  files: RepoMapFile[]
  error?: string
}

export interface RepoMapScanOptions {
  /** 忽略指纹缓存，全部重读 */
  force?: boolean
  /** 需要确保已描述的路径（降级模式下展开 / 搜索时传入） */
  paths?: string[]
}

/** 画布上的点（世界坐标，与缩放无关） */
export interface RepoMapPoint {
  x: number
  y: number
}

/** 顶层文件夹：只记手动拖过的位置；缺省表示由底层布局决定 */
export interface RepoMapFolderState {
  x?: number
  y?: number
}

/** 画布视图状态：落盘在 `.pi-workbench/repo-map-canvas.json`（只含底层地图） */
export interface RepoMapCanvasState {
  version: number
  /** 底层布局版本：升级时旧坐标整批作废 */
  layoutVersion: number
  zoom: number
  pan: RepoMapPoint
  /** 键是顶层目录相对路径（无尾斜杠） */
  folders: Record<string, RepoMapFolderState>
  /** 键是根目录文件相对路径；只有手动拖过的才在这里 */
  files: Record<string, RepoMapPoint>
}

export interface RepoMapCanvasGetResult {
  success: boolean
  state: RepoMapCanvasState
  error?: string
}

export interface RepoMapCanvasSetResult {
  success: boolean
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

export interface UpdateNoticeResult {
  success: boolean
  notice?: { from: string; to: string } | null
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
  portable?: boolean
}

export interface AppInfoResult {
  success: boolean
  info: AppInfo
}

export interface AppActiveWorkResult {
  success: boolean
  terminal: boolean
}

export interface NotifyClickPayload {
  /** 本地工作区会话才有 */
  workspaceDir: string | null
  sessionId: string
}

// ============================================================================
// 2. 通道映射单源真值表（Invoke / Event / Send）
// ============================================================================

/** ElectronAPI invoke 方法名 → 主进程 ipcMain.handle 通道名 */
export const IPC_INVOKE_CHANNELS = {
  // 文件系统与外部打开
  openDirectoryDialog: 'dialog:openDirectory',
  readFile: 'fs:readFile',
  createFile: 'fs:createFile',
  writeFile: 'fs:writeFile',
  openPathExternally: 'fs:openExternally',
  openExternalUrl: 'shell:openExternal',
  writeClipboardText: 'clipboard:writeText',
  listDirectory: 'fs:listDirectory',
  exists: 'fs:exists',
  stat: 'fs:stat',
  deletePath: 'fs:delete',
  renamePath: 'fs:rename',
  watchWorkspace: 'fs:watch',
  unwatchWorkspace: 'fs:unwatch',

  // 自动更新与应用信息
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateGetState: 'update:getState',
  updateOpenDownload: 'update:openDownload',
  consumeUpdateNotice: 'app:consumeUpdateNotice',
  appGetInfo: 'app:getInfo',
  appHasActiveWork: 'app:hasActiveWork',
  logRenderer: 'log:renderer',

  // 应用配置与数据目录
  getAppDir: 'app:getAppDir',
  openDataDir: 'app:openDataDir',
  getSettings: 'app:getSettings',
  saveSettings: 'app:saveSettings',
  getRecentWorkspaces: 'app:getRecentWorkspaces',
  addRecentWorkspace: 'app:addRecentWorkspace',

  // 窗口与辅助面板窗口
  minimizeWindow: 'window:minimize',
  toggleMaximizeWindow: 'window:toggleMaximize',
  closeWindow: 'window:close',
  isWindowMaximized: 'window:isMaximized',
  auxDetachAt: 'aux:detach-at',
  auxDragBegin: 'aux:drag-begin',
  auxWindowCommand: 'aux:window-command',
  auxWindowState: 'aux:window-state',

  // 工作区、草稿、标签与仓库地图
  initWorkspace: 'workspace:init',
  disposeWorkspace: 'workspace:dispose',
  draftSave: 'draft:save',
  draftDelete: 'draft:delete',
  draftList: 'draft:list',
  draftClear: 'draft:clear',
  editorTabsGet: 'workspace:editorTabs:get',
  editorTabsSet: 'workspace:editorTabs:set',
  repoMapScan: 'repo-map:scan',
  repoMapDescribe: 'repo-map:describe',
  repoMapCanvasGet: 'repo-map:canvas:get',
  repoMapCanvasSet: 'repo-map:canvas:set',
  searchWorkspaceFiles: 'workspace:searchFiles',
  pickAttachments: 'attachment:pick',

  // Pi Agent
  agentInitialize: 'agent:initialize',
  agentChat: 'agent:chat',
  agentAbort: 'agent:abort',
  agentDispose: 'agent:dispose',
  agentSessionsList: 'agent:sessions:list',
  agentSessionsOpen: 'agent:sessions:open',
  agentSessionsCreate: 'agent:sessions:create',
  agentSessionsClose: 'agent:sessions:close',
  agentSessionsRename: 'agent:sessions:rename',
  agentSessionsDelete: 'agent:sessions:delete',
  agentSessionsGetTabs: 'agent:sessions:getTabs',
  agentSessionsSetTabs: 'agent:sessions:setTabs',
  agentSteer: 'agent:steer',
  agentContextUsage: 'agent:context:usage',
  agentCompactContext: 'agent:context:compact',
  agentRewind: 'agent:rewind',
  agentBranchesList: 'agent:branches:list',
  agentBranchesSwitch: 'agent:branches:switch',
  agentSessionSettings: 'agent:session:settings',
  agentSessionSetPermission: 'agent:session:setPermission',
  agentSessionStats: 'agent:session:stats',
  agentModelCapabilities: 'agent:models:capabilities',
  agentPromptResources: 'agent:prompt-resources',
  agentPlanGet: 'agent:plan:get',
  agentPlanApprove: 'agent:plan:approve',
  agentPlanReject: 'agent:plan:reject',
  agentToolResultMeta: 'agent:tool-result:meta',
  agentToolResultChunk: 'agent:tool-result:chunk',
  agentToolResultImage: 'agent:tool-result:image',
  agentToolResultOpen: 'agent:tool-result:open',
  agentExportSession: 'agent:export-session',
  agentSessionSetModel: 'agent:session:setModel',
  agentSessionSetThinking: 'agent:session:setThinking',
  agentSessionsMetaGet: 'agent:sessions:meta:get',
  agentSessionsMetaSet: 'agent:sessions:meta:set',
  agentRespondApproval: 'agent:approval:respond',

  // 终端
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalFlush: 'terminal:flush',

  // Git 与 GitHub 认证
  gitRepoInfo: 'git:repoInfo',
  gitFetch: 'git:fetch',
  gitListWorktrees: 'git:listWorktrees',
  gitForgetWorktree: 'git:forgetWorktree',
  gitInstallWorktreeDeps: 'git:installWorktreeDeps',
  gitBranches: 'git:branches',
  gitStatus: 'git:status',
  gitSessionBinding: 'git:sessionBinding',
  gitBindWorktree: 'git:bindWorktree',
  gitReleaseSession: 'git:releaseSession',
  gitCleanupOrphans: 'git:cleanupOrphans',
  gitLog: 'git:log',
  gitCommitStats: 'git:commitStats',
  gitCreateBranch: 'git:createBranch',
  gitCommitDetail: 'git:commitDetail',
  gitDiff: 'git:diff',
  gitCheckout: 'git:checkout',
  gitMerge: 'git:merge',
  gitGithubTokenStatus: 'git:githubTokenStatus',
  githubAuthConfig: 'github:auth:config',
  githubAuthStart: 'github:auth:start',
  githubAuthStatus: 'github:auth:status',
  githubAuthLogout: 'github:auth:logout',
  githubAuthDeviceStart: 'github:auth:device:start',
  githubAuthDeviceCancel: 'github:auth:device:cancel',
  githubAuthDeviceOpen: 'github:auth:device:open',
  gitSetGithubToken: 'git:setGithubToken',
  gitPrStatus: 'git:prStatus',

  // 云端连接与云端记忆
  cloudLinkStatus: 'cloud:linkStatus',
  cloudPair: 'cloud:pair',
  cloudUnlink: 'cloud:unlink',
  cloudReconnect: 'cloud:reconnect',
  cloudRefreshWorkspaces: 'cloud:refreshWorkspaces',
  cloudListWorkspaces: 'cloud:listWorkspaces',
  cloudClientOpen: 'cloud:clientOpen',
  cloudClientClose: 'cloud:clientClose',
  cloudClientSend: 'cloud:clientSend',
  cloudClientState: 'cloud:clientState',
  cloudGetConfig: 'cloud:getConfig',
  cloudSaveConfig: 'cloud:saveConfig',
  cloudFetchModels: 'cloud:fetchModels',
  cloudGetMemoryData: 'cloud:getMemoryData',
  cloudAddMemory: 'cloud:addMemory',
  cloudUpdateMemory: 'cloud:updateMemory',
  cloudDeleteMemory: 'cloud:deleteMemory',
  cloudSaveDoc: 'cloud:saveDoc',
  cloudRunDream: 'cloud:runDream',

  // 工作台插件
  pluginsList: 'plugins:list',
  pluginsInvoke: 'plugins:invoke',
  pluginsReload: 'plugins:reload',
  pluginsSetEnabled: 'plugins:setEnabled',

  // 供应商与凭证
  providersList: 'providers:list',
  providersSetActive: 'providers:setActive',
  providersSetOverrides: 'providers:setOverrides',
  providersRefresh: 'providers:refresh',
  providersSetApiKey: 'providers:setApiKey',
  providersForget: 'providers:forget',
  providersLogin: 'providers:login',
  providersAuthAnswer: 'providers:authAnswer',
  providersCancelLogin: 'providers:cancelLogin',

  // 联网搜索
  webSearchGet: 'webSearch:get',
  webSearchSave: 'webSearch:save',

  // 文档预览与扫描页渲染回传
  documentsPreview: 'documents:preview',
  documentRenderResult: 'documents:render-result',
} as const

/** ElectronAPI 事件订阅方法名 → 主进程 webContents.send 推送通道名 */
export const IPC_EVENT_CHANNELS = {
  onFsChanged: 'fs:changed',
  onUpdateStatus: 'update:status',
  onWindowMaximizedChange: 'window:maximized-changed',
  onAuxWindowClosed: 'aux:window-closed',
  onAppBootExpanded: 'app:boot-expanded',
  onAgentStream: 'agent:stream',
  onAgentSessionTitle: 'agent:session-title',
  onNotifyClick: 'app:notify-click',
  onAgentApprovalRequest: 'agent:approval-request',
  onAgentApprovalResolved: 'agent:approval-resolved',
  onTerminalData: 'terminal:data',
  onTerminalExit: 'terminal:exit',
  onGitChanged: 'git:changed',
  onGitWorktreeDeps: 'git:worktree-deps',
  onGithubAuthComplete: 'github:auth:complete',
  onGithubAuthDeviceEvent: 'github:auth:device:event',
  onAgentSessionRootChanged: 'agent:session-root-changed',
  onCloudState: 'cloud:state',
  onCloudClientFrame: 'cloud:client-frame',
  onCloudClientState: 'cloud:client-state',
  onPluginsChanged: 'plugins:changed',
  onProvidersAuthEvent: 'providers:auth-event',
  onDocumentRenderRequest: 'documents:render-request',
} as const

/** 单向通知（ipcRenderer.send → ipcMain.on）通道名 */
export const IPC_SEND_CHANNELS = {
  appBootReady: 'app:boot-ready',
} as const

export type IpcInvokeMethod = keyof typeof IPC_INVOKE_CHANNELS
export type IpcInvokeChannel = (typeof IPC_INVOKE_CHANNELS)[IpcInvokeMethod]
export type IpcEventMethod = keyof typeof IPC_EVENT_CHANNELS
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[IpcEventMethod]
export type IpcSendMethod = keyof typeof IPC_SEND_CHANNELS
export type IpcSendChannel = (typeof IPC_SEND_CHANNELS)[IpcSendMethod]

// ============================================================================
// 3. 强类型 Invoke / Event 契约映射
// ============================================================================

export interface IpcInvokeContract {
  // 文件系统与外部打开
  'dialog:openDirectory': { args: []; result: OpenDirectoryResult }
  'fs:readFile': { args: [path: string]; result: ReadFileResult }
  'fs:createFile': { args: [filePath: string]; result: CreateFileResult }
  'fs:writeFile': { args: [path: string, content: string]; result: WriteFileResult }
  'fs:openExternally': { args: [path: string]; result: WorkspaceResult }
  'shell:openExternal': { args: [url: string]; result: WorkspaceResult }
  'clipboard:writeText': { args: [text: string]; result: { success: boolean; error?: string } }
  'fs:listDirectory': { args: [path: string]; result: ListDirectoryResult }
  'fs:exists': { args: [path: string]; result: ExistsResult }
  'fs:stat': { args: [path: string]; result: StatResult }
  'fs:delete': { args: [path: string]; result: WorkspaceResult }
  'fs:rename': { args: [oldPath: string, newPath: string]; result: WorkspaceResult }
  'fs:watch': { args: [workspacePath: string]; result: WorkspaceResult }
  'fs:unwatch': { args: [workspacePath?: string]; result: WorkspaceResult }

  // 自动更新与应用信息
  'update:check': { args: []; result: UpdateCheckResult }
  'update:download': { args: []; result: UpdateActionResult }
  'update:install': { args: []; result: UpdateActionResult }
  'update:getState': { args: []; result: UpdateStateResult }
  'update:openDownload': { args: []; result: UpdateActionResult }
  'app:consumeUpdateNotice': { args: []; result: UpdateNoticeResult }
  'app:getInfo': { args: []; result: AppInfoResult }
  'app:hasActiveWork': { args: []; result: AppActiveWorkResult }
  'log:renderer': { args: [level: string, args: unknown[]]; result: { success: boolean } }

  // 应用配置与数据目录
  'app:getAppDir': { args: []; result: GetAppDirResult }
  'app:openDataDir': { args: []; result: { success: boolean; error?: string } }
  'app:getSettings': { args: []; result: GetSettingsResult }
  'app:saveSettings': { args: [settings: Record<string, unknown>]; result: SaveSettingsResult }
  'app:getRecentWorkspaces': { args: []; result: RecentWorkspacesResult }
  'app:addRecentWorkspace': { args: [workspacePath: string]; result: RecentWorkspacesResult }

  // 窗口与辅助面板窗口
  'window:minimize': { args: []; result: { success: boolean } }
  'window:toggleMaximize': { args: []; result: { success: boolean; maximized: boolean } }
  'window:close': { args: []; result: { success: boolean } }
  'window:isMaximized': { args: []; result: { success: boolean; maximized: boolean } }
  'aux:detach-at': { args: []; result: AuxDetachResult }
  'aux:drag-begin': { args: []; result: { success: boolean } }
  'aux:window-command': { args: [host: string, command: WindowCommand]; result: AuxWindowCommandResult }
  'aux:window-state': { args: [host: string]; result: AuxWindowCommandResult }

  // 工作区、草稿、标签与仓库地图
  'workspace:init': { args: [workspacePath: string]; result: WorkspaceResult }
  'workspace:dispose': { args: [workspacePath: string]; result: WorkspaceResult }
  'draft:save': { args: [workspacePath: string, filePath: string, content: string]; result: DraftResult }
  'draft:delete': { args: [workspacePath: string, filePath: string]; result: DraftResult }
  'draft:list': { args: [workspacePath: string]; result: DraftListResult }
  'draft:clear': { args: [workspacePath: string]; result: DraftResult }
  'workspace:editorTabs:get': { args: [workspacePath: string]; result: EditorTabsResult }
  'workspace:editorTabs:set': { args: [workspacePath: string, tabs: EditorTabs]; result: WorkspaceResult }
  'repo-map:scan': { args: [workspacePath: string, options?: RepoMapScanOptions]; result: RepoMapResult }
  'repo-map:describe': { args: [workspacePath: string, paths: string[]]; result: RepoMapResult }
  'repo-map:canvas:get': { args: [workspacePath: string]; result: RepoMapCanvasGetResult }
  'repo-map:canvas:set': {
    args: [workspacePath: string, state: RepoMapCanvasState]
    result: RepoMapCanvasSetResult
  }
  'workspace:searchFiles': {
    args: [workspaceDir: string, query: string, limit?: number]
    result: { success: boolean; files?: string[]; error?: string }
  }
  'attachment:pick': { args: []; result: AttachmentPickResult }

  // Pi Agent
  'agent:initialize': { args: [config: AgentInitConfig]; result: AgentInitResult }
  'agent:chat': {
    args: [
      message: string,
      requestId?: string,
      workspaceDir?: string,
      sessionId?: string,
      images?: AgentImagePayload[],
    ]
    result: AgentChatResult
  }
  'agent:abort': { args: [workspaceDir?: string, sessionId?: string]; result: AgentDisposeResult }
  'agent:dispose': { args: [workspaceDir?: string]; result: AgentDisposeResult }
  'agent:sessions:list': { args: [workspaceDir: string]; result: SessionListResult }
  'agent:sessions:open': { args: [workspaceDir: string, sessionId?: string]; result: SessionOpenResult }
  'agent:sessions:create': { args: [workspaceDir: string, root?: string]; result: SessionOpenResult }
  'agent:sessions:close': { args: [workspaceDir: string, sessionId: string]; result: AgentDisposeResult }
  'agent:sessions:rename': {
    args: [workspaceDir: string, sessionId: string, name: string]
    result: AgentDisposeResult
  }
  'agent:sessions:delete': { args: [workspaceDir: string, sessionId: string]; result: AgentDisposeResult }
  'agent:sessions:getTabs': { args: [workspaceDir: string]; result: SessionTabsResult }
  'agent:sessions:setTabs': { args: [workspaceDir: string, tabs: SessionTabs]; result: AgentDisposeResult }
  'agent:steer': {
    args: [workspaceDir: string, sessionId: string, message: string, images?: AgentImagePayload[]]
    result: { success: boolean; error?: string }
  }
  'agent:context:usage': {
    args: [workspaceDir: string, sessionId: string]
    result: { success: boolean; usage?: ContextUsageInfo; error?: string }
  }
  'agent:context:compact': {
    args: [workspaceDir: string, sessionId: string]
    result: {
      success: boolean
      tokensBefore?: number
      estimatedTokensAfter?: number
      entryId?: string
      timestamp?: number
      error?: string
    }
  }
  'agent:rewind': {
    args: [workspaceDir: string, sessionId: string, newText?: string]
    result: {
      success: boolean
      text?: string
      context?: MessageContext
      error?: string
    }
  }
  'agent:branches:list': {
    args: [workspaceDir: string, sessionId: string]
    result: { success: boolean; groups?: ConversationBranchGroup[]; error?: string }
  }
  'agent:branches:switch': {
    args: [workspaceDir: string, sessionId: string, entryId: string]
    result: { success: boolean; history?: AgentHistoryResult['history']; error?: string }
  }
  'agent:session:settings': {
    args: [workspaceDir: string, sessionId: string]
    result: {
      success: boolean
      modelId?: string
      thinkingLevel?: string
      permission?: SessionPermission
      error?: string
    }
  }
  'agent:session:setPermission': {
    args: [workspaceDir: string, sessionId: string, permission: SessionPermission]
    result: { success: boolean; permission?: SessionPermission; error?: string }
  }
  'agent:session:stats': {
    args: [workspaceDir: string, sessionId: string]
    result: { success: boolean; stats?: SessionStatsInfo; error?: string }
  }
  'agent:models:capabilities': {
    args: [workspaceDir: string]
    result: { success: boolean; models?: ModelCapabilityInfo[]; selected?: string; error?: string }
  }
  'agent:prompt-resources': {
    args: [workspaceDir: string, sessionId: string]
    result: {
      success: boolean
      templates?: PromptTemplateInfo[]
      skills?: SkillInfo[]
      error?: string
    }
  }
  'agent:plan:get': {
    args: [workspaceDir: string, sessionId: string]
    result: { success: boolean; plan?: StructuredPlan | null; error?: string }
  }
  'agent:plan:approve': {
    args: [workspaceDir: string, sessionId: string, planId: string, targetMode: 'ask' | 'auto']
    result: {
      success: boolean
      plan?: StructuredPlan
      permission?: SessionPermission
      error?: string
    }
  }
  'agent:plan:reject': {
    args: [workspaceDir: string, sessionId: string, planId: string]
    result: { success: boolean; plan?: StructuredPlan; error?: string }
  }
  'agent:tool-result:meta': {
    args: [workspaceDir: string, sessionId: string, toolCallId: string]
    result: { success: boolean; meta?: ToolResultMeta; error?: string }
  }
  'agent:tool-result:chunk': {
    args: [
      workspaceDir: string,
      sessionId: string,
      toolCallId: string,
      offset?: number,
      limit?: number,
    ]
    result: {
      success: boolean
      text?: string
      offset?: number
      nextOffset?: number
      chars?: number
      done?: boolean
      error?: string
    }
  }
  'agent:tool-result:image': {
    args: [workspaceDir: string, sessionId: string, toolCallId: string, index?: number]
    result: { success: boolean; data?: string; mimeType?: string; error?: string }
  }
  'agent:tool-result:open': {
    args: [workspaceDir: string, sessionId: string, toolCallId: string]
    result: { success: boolean; path?: string; error?: string }
  }
  'agent:export-session': {
    args: [
      workspaceDir: string,
      sessionId: string,
      format: ExportSessionFormat,
      language?: 'zh' | 'en',
    ]
    result: { success: boolean; path?: string; canceled?: boolean; error?: string }
  }
  'agent:session:setModel': {
    args: [workspaceDir: string, sessionId: string, modelId: string]
    result: { success: boolean; error?: string }
  }
  'agent:session:setThinking': {
    args: [workspaceDir: string, sessionId: string, level: string]
    result: { success: boolean; error?: string }
  }
  'agent:sessions:meta:get': {
    args: [workspaceDir: string]
    result: { success: boolean; meta?: SessionMeta; error?: string }
  }
  'agent:sessions:meta:set': {
    args: [workspaceDir: string, meta: SessionMeta]
    result: { success: boolean; error?: string }
  }
  'agent:approval:respond': {
    args: [requestId: string, decision: ApprovalDecision]
    result: { success: boolean; error?: string }
  }

  // 终端
  'terminal:create': {
    args: [workspaceDir: string, cols: number, rows: number, cwd?: string]
    result: TerminalCreateResult
  }
  'terminal:write': { args: [id: string, data: string]; result: TerminalResult }
  'terminal:resize': { args: [id: string, cols: number, rows: number]; result: TerminalResult }
  'terminal:close': { args: [id: string]; result: TerminalResult }
  'terminal:flush': { args: [id: string]; result: TerminalResult }

  // Git 与 GitHub 认证
  'git:repoInfo': {
    args: [workspaceDir: string]
    result: {
      success: boolean
      repo?: GitRepoInfo | null
      worktrees?: GitWorktreeView[]
      error?: string
    }
  }
  'git:fetch': { args: [workspaceDir: string, options?: { force?: boolean }]; result: GitFetchResult }
  'git:listWorktrees': {
    args: [workspaceDir: string, activeSessionId?: string]
    result: { success: boolean; worktrees?: GitWorktreeView[]; error?: string }
  }
  'git:forgetWorktree': {
    args: [workspaceDir: string, id: string, activeSessionId?: string]
    result: { success: boolean; worktrees?: GitWorktreeView[]; error?: string }
  }
  'git:installWorktreeDeps': {
    args: [workspaceDir: string, id: string]
    result: { success: boolean; deps?: GitWorktreeDepsStatus; error?: string }
  }
  'git:branches': {
    args: [workspaceDir: string]
    result: { success: boolean; branches?: GitBranchInfo[]; error?: string }
  }
  'git:status': {
    args: [workspaceDir: string, worktreePath?: string]
    result: { success: boolean; status?: GitStatusInfo; error?: string }
  }
  'git:sessionBinding': {
    args: [workspaceDir: string, sessionId: string]
    result: { success: boolean; binding?: GitSessionBinding; error?: string }
  }
  'git:bindWorktree': {
    args: [workspaceDir: string, sessionId: string, target: string, base?: string]
    result: {
      success: boolean
      worktree?: GitWorktreeView
      sharedWith?: number
      switched?: { success: boolean; scheduled?: boolean; error?: string }
      error?: string
    }
  }
  'git:releaseSession': {
    args: [workspaceDir: string, sessionId: string]
    result: {
      success: boolean
      removed?: boolean
      dirty?: boolean
      worktreePath?: string
      error?: string
    }
  }
  'git:cleanupOrphans': {
    args: [workspaceDir: string]
    result: {
      success: boolean
      removed?: string[]
      dirty?: string[]
      external?: string[]
      error?: string
    }
  }
  'git:log': {
    args: [workspaceDir: string, limit?: number, branch?: string, all?: boolean]
    result: { success: boolean; commits?: GitCommitInfo[]; error?: string }
  }
  'git:commitStats': {
    args: [workspaceDir: string, limit?: number, branch?: string, all?: boolean]
    result: { success: boolean; stats?: Record<string, GitCommitStats>; error?: string }
  }
  'git:createBranch': {
    args: [workspaceDir: string, sha: string, name: string]
    result: { success: boolean; error?: string }
  }
  'git:commitDetail': {
    args: [workspaceDir: string, sha: string]
    result: { success: boolean; detail?: GitCommitDetail; error?: string }
  }
  'git:diff': {
    args: [workspaceDir: string, from: string, to: string]
    result: { success: boolean; patch?: string; error?: string }
  }
  'git:checkout': {
    args: [workspaceDir: string, worktreePath: string, branch: string]
    result: { success: boolean; error?: string }
  }
  'git:merge': {
    args: [workspaceDir: string, worktreePath: string, branch: string, strategy?: 'merge' | 'squash' | 'rebase']
    result: { success: boolean; error?: string }
  }
  'git:githubTokenStatus': { args: []; result: { success: boolean; configured?: boolean } }
  'github:auth:config': { args: []; result: GithubAuthConfigResult }
  'github:auth:start': { args: []; result: GithubAuthStartResult }
  'github:auth:status': { args: []; result: GithubAuthStatusResult }
  'github:auth:logout': { args: []; result: { success: boolean; error?: string } }
  'github:auth:device:start': { args: []; result: GithubDeviceLoginStartResult }
  'github:auth:device:cancel': { args: []; result: { success: boolean; cancelled?: boolean } }
  'github:auth:device:open': { args: []; result: { success: boolean } }
  'git:setGithubToken': { args: [token: string]; result: { success: boolean; error?: string } }
  'git:prStatus': {
    args: [workspaceDir: string, worktreePath?: string]
    result: { success: boolean; status?: GithubPrStatus; error?: string }
  }

  // 云端连接与云端记忆
  'cloud:linkStatus': { args: []; result: CloudLinkStatusResult }
  'cloud:pair': { args: [input: CloudPairInput]; result: CloudPairResult }
  'cloud:unlink': { args: []; result: { success: boolean; error?: string } }
  'cloud:reconnect': { args: []; result: { success: boolean; state?: CloudDeviceState; error?: string } }
  'cloud:refreshWorkspaces': {
    args: []
    result: { success: boolean; workspaces?: CloudWorkspaceEntry[]; error?: string }
  }
  'cloud:listWorkspaces': { args: []; result: { success: boolean; workspaces: CloudWorkspaceEntry[] } }
  'cloud:clientOpen': { args: []; result: { success: boolean; state: CloudClientState; error?: string } }
  'cloud:clientClose': { args: []; result: { success: boolean } }
  'cloud:clientSend': { args: [frame: CloudClientOutgoingFrame]; result: { success: boolean; error?: string } }
  'cloud:clientState': { args: []; result: { success: boolean; state: CloudClientState } }
  'cloud:getConfig': { args: []; result: CloudConfigResult }
  'cloud:saveConfig': {
    args: [config: CloudConfigInput]
    result: {
      success: boolean
      result?: { ok?: boolean; apiKeyMasked?: string; takesEffect?: string; warning?: string }
      error?: string
    }
  }
  'cloud:fetchModels': {
    args: [input: { providerId: string }]
    result: { success: boolean; models: string[]; catalog?: CloudCatalogModel[]; error?: string }
  }
  'cloud:getMemoryData': {
    args: []
    result: {
      success: boolean
      memories?: CloudMemoryItemContract[]
      docs?: CloudDocItemContract[]
      dreams?: CloudDreamItemContract[]
      error?: string
    }
  }
  'cloud:addMemory': {
    args: [input: { kind?: string; content: string; tags?: string[]; pinned?: boolean }]
    result: { success: boolean; memory?: CloudMemoryItemContract; error?: string }
  }
  'cloud:updateMemory': {
    args: [input: { id: string; kind?: string; content?: string; tags?: string[]; pinned?: boolean }]
    result: { success: boolean; memory?: CloudMemoryItemContract; error?: string }
  }
  'cloud:deleteMemory': { args: [id: string]; result: { success: boolean; error?: string } }
  'cloud:saveDoc': {
    args: [input: { name: 'AGENTS.md' | 'SOUL.md'; content: string }]
    result: { success: boolean; doc?: CloudDocItemContract; error?: string }
  }
  'cloud:runDream': {
    args: []
    result: { success: boolean; dream?: CloudDreamItemContract | null; error?: string }
  }

  // 工作台插件
  'plugins:list': { args: [workspaceDir: string]; result: PluginsListResult }
  'plugins:invoke': {
    args: [workspaceDir: string, commandId: string, args?: unknown]
    result: PluginCommandResult
  }
  'plugins:reload': { args: [workspaceDir: string]; result: PluginsListResult }
  'plugins:setEnabled': {
    args: [workspaceDir: string, pluginId: string, enabled: boolean]
    result: PluginsListResult
  }

  // 供应商与凭证
  'providers:list': { args: []; result: ProvidersListResult }
  'providers:setActive': {
    args: [providerId: string, modelId?: string]
    result: { success: boolean; error?: string }
  }
  'providers:setOverrides': {
    args: [providerId: string, modelId: string, overrides: ProviderModelOverrides]
    result: {
      success: boolean
      error?: string
      effective?: ProviderModelLimits
      /** true：正在跑的会话会在轮次边界才用新上限（D23） */
      pending?: boolean
    }
  }
  'providers:refresh': {
    args: [force?: boolean]
    result: {
      success: boolean
      added: number
      removed: number
      checkedAt: number
      error?: string
    }
  }
  'providers:setApiKey': {
    args: [providerId: string, apiKey: string]
    result: { success: boolean; error?: string }
  }
  'providers:forget': { args: [providerId: string]; result: { success: boolean } }
  'providers:login': {
    args: [providerId: string, type: ProviderAuthMethod]
    result: { success: boolean; error?: string }
  }
  'providers:authAnswer': { args: [requestId: string, value: string]; result: { ok: boolean } }
  'providers:cancelLogin': { args: [providerId: string]; result: { ok: boolean } }

  // 联网搜索
  'webSearch:get': { args: []; result: WebSearchGetResult }
  'webSearch:save': { args: [config: WebSearchConfig]; result: WebSearchSaveResult }

  // 文档预览与扫描页渲染回传
  'documents:preview': { args: [path: string]; result: DocumentPreviewResult }
  'documents:render-result': {
    args: [payload: DocumentRenderResultPayload]
    result: { success: boolean }
  }
}

export interface IpcEventContract {
  'fs:changed': { payload: { type: string; path: string } }
  'update:status': { payload: UpdateState }
  'window:maximized-changed': { payload: WindowMaximizedState }
  'aux:window-closed': { payload: string }
  'app:boot-expanded': { payload: void }
  'agent:stream': { payload: AgentStreamPayload }
  'agent:session-title': { payload: { workspaceDir: string; sessionId: string; title: string } }
  'app:notify-click': { payload: NotifyClickPayload }
  'agent:approval-request': { payload: ApprovalRequestPayload }
  'agent:approval-resolved': {
    payload: {
      requestId: string
      workspaceDir: string
      sessionId: string
      decision: ApprovalDecision
    }
  }
  'terminal:data': { payload: { id: string; data: string } }
  'terminal:exit': { payload: { id: string; exitCode: number } }
  'git:changed': { payload: GitChangedPayload }
  'git:worktree-deps': { payload: GitWorktreeDepsPayload }
  'github:auth:complete': { payload: GithubAuthCompletePayload }
  'github:auth:device:event': { payload: GithubDeviceLoginEvent }
  'agent:session-root-changed': { payload: { workspaceDir: string; sessionId: string; root: string } }
  'cloud:state': { payload: CloudDeviceState }
  'cloud:client-frame': { payload: unknown }
  'cloud:client-state': { payload: CloudClientState }
  'plugins:changed': { payload: { workspaceDir: string } }
  'providers:auth-event': { payload: ProviderAuthEvent }
  'documents:render-request': { payload: DocumentRenderRequestPayload }
}

// 编译期完备性断言：确保通道表与契约映射 100% 严格一一对应
type AssertExactKeys<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : never
type _CheckInvokeKeys = AssertExactKeys<IpcInvokeChannel, keyof IpcInvokeContract>
type _CheckEventKeys = AssertExactKeys<IpcEventChannel, keyof IpcEventContract>
const _ASSERT_INVOKE_COMPLETE: _CheckInvokeKeys = true
const _ASSERT_EVENT_COMPLETE: _CheckEventKeys = true
void _ASSERT_INVOKE_COMPLETE
void _ASSERT_EVENT_COMPLETE

export type IpcMethodArgs<M extends IpcInvokeMethod> =
  IpcInvokeContract[(typeof IPC_INVOKE_CHANNELS)[M]]['args']

export type IpcMethodResult<M extends IpcInvokeMethod> =
  IpcInvokeContract[(typeof IPC_INVOKE_CHANNELS)[M]]['result']

export type IpcEventPayload<M extends IpcEventMethod> =
  IpcEventContract[(typeof IPC_EVENT_CHANNELS)[M]]['payload']

export type IpcEventCallback<M extends IpcEventMethod> =
  IpcEventPayload<M> extends void ? () => void : (payload: IpcEventPayload<M>) => void

export type IpcInvokeBridge = {
  [M in IpcInvokeMethod]: (...args: IpcMethodArgs<M>) => Promise<IpcMethodResult<M>>
}

export type IpcEventBridge = {
  [M in IpcEventMethod]: (callback: IpcEventCallback<M>) => () => void
}

export interface IpcSendBridge {
  appBootReady: () => void
}

export interface ElectronAPIContract extends IpcInvokeBridge, IpcEventBridge, IpcSendBridge {
  platform: string
  /** Windows / Linux 原生 titleBarOverlay 已启用时为 true，渲染层仅预留右侧安全区不重复渲染按钮 */
  nativeTitleBarOverlay?: boolean
  getPathForFile: (file: File) => string
}

// ============================================================================
// 4. 高危通道纯 JS Zod 校验表（零 Node 全局依赖，可 tree-shake）
// ============================================================================

const MAX_PATH_LEN = 4096
const MAX_TEXT_WRITE_BYTES = 32 * 1024 * 1024
const MAX_TERMINAL_WRITE_BYTES = 1024 * 1024
const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024

let cachedEncoder: { encode(input?: string): Uint8Array } | null = null
function utf8ByteLength(value: string): number {
  if (!cachedEncoder) cachedEncoder = new TextEncoder()
  return cachedEncoder.encode(value).length
}

function buildIpcInvokeSchemas(): Partial<Record<IpcInvokeChannel, z.ZodType<readonly unknown[]>>> {
  const safePath = z
    .string()
    .min(1, 'Path is required')
    .max(MAX_PATH_LEN, 'Path is too long')
    .refine((v) => !v.includes('\0'), 'Path must not contain NUL bytes')

  const terminalId = z.string().min(1).max(128)

  const appSaveSettings = z.object({
    language: z.enum(['zh', 'en', 'zh-CN', 'en-US']).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    autoSave: z.boolean().optional(),
    autoSaveDelay: z.number().int().min(200).max(60_000).optional(),
    runWhileBusy: z.enum(['queue', 'steer']).optional(),
    permissionLevel: z.enum(['readonly', 'ask', 'auto']).optional().catch(undefined),
    notifications: z
      .object({
        enabled: z.boolean().optional(),
        approval: z.boolean().optional(),
        complete: z.boolean().optional(),
        error: z.boolean().optional(),
      })
      .optional(),
    budgetUsd: z.number().finite().min(0).max(100_000).optional(),
    keybindings: z.record(z.string().max(64), z.string().max(64)).optional(),
    explorerSortBy: z.enum(['name', 'type']).optional().catch(undefined),
    explorerFoldersFirst: z.boolean().optional().catch(undefined),
    explorerSortReverse: z.boolean().optional().catch(undefined),
    closeToTray: z.boolean().optional().catch(undefined),
    autoInstallWorktreeDeps: z.boolean().optional().catch(undefined),
    useSystemProxy: z.boolean().optional().catch(undefined),
    autoRefreshCatalog: z.boolean().optional().catch(undefined),
    panelWidths: z
      .object({
        sidebar: z.number().int().min(160).max(600).optional(),
        chat: z.number().int().min(260).max(900).optional(),
        terminalHeight: z.number().int().min(100).max(700).optional(),
      })
      .optional()
      .catch(undefined),
    permissions: z.record(z.string().max(32), z.enum(['allow', 'ask', 'deny'])).optional(),
  })

  return {
    'fs:createFile': z.tuple([safePath]),
    'fs:writeFile': z.tuple([
      safePath,
      z
        .string()
        .refine((v) => utf8ByteLength(v) <= MAX_TEXT_WRITE_BYTES, 'File content exceeds 32 MB write limit'),
    ]),
    'fs:delete': z.tuple([safePath]),
    'fs:rename': z.tuple([safePath, safePath]),
    'draft:save': z.tuple([safePath, safePath, z.string()]),
    'draft:delete': z.tuple([safePath, safePath]),
    'terminal:create': z.tuple([
      safePath,
      z.number().int().min(1).max(1000).catch(80),
      z.number().int().min(1).max(500).catch(24),
      safePath.optional(),
    ]),
    'terminal:write': z.tuple([
      terminalId,
      z
        .string()
        .refine((v) => utf8ByteLength(v) <= MAX_TERMINAL_WRITE_BYTES, 'Terminal input chunk exceeds 1 MB limit'),
    ]),
    'terminal:resize': z.tuple([
      terminalId,
      z.number().int().min(1).max(1000),
      z.number().int().min(1).max(500),
    ]),
    'terminal:close': z.tuple([terminalId]),
    'terminal:flush': z.tuple([terminalId]),
    'plugins:setEnabled': z.tuple([safePath, z.string().min(1).max(128), z.boolean()]),
    'shell:openExternal': z.tuple([z.string().min(1).max(4096)]),
    'clipboard:writeText': z.tuple([
      z
        .string()
        .refine((v) => utf8ByteLength(v) <= MAX_CLIPBOARD_BYTES, 'Clipboard text exceeds 4 MB limit'),
    ]),
    'app:saveSettings': z.tuple([appSaveSettings]),
    'git:bindWorktree': z.tuple([
      safePath,
      z.string().min(1).max(128),
      z.string().min(1).max(MAX_PATH_LEN),
      z.string().max(256).optional(),
    ]),
    'git:createBranch': z.tuple([
      safePath,
      z.string().regex(/^[0-9a-f]{4,64}$/i, 'Invalid commit sha'),
      z.string().min(1).max(256),
    ]),
    'git:checkout': z.tuple([safePath, safePath, z.string().min(1).max(256)]),
    'git:merge': z.tuple([
      safePath,
      safePath,
      z.string().min(1).max(256),
      z.enum(['merge', 'squash', 'rebase']).optional(),
    ]),
    'cloud:pair': z.tuple([
      z.object({
        baseUrl: z.string().min(1).max(2048),
        code: z.string().min(1).max(128),
        deviceName: z.string().max(128).optional(),
      }),
    ]),
    'cloud:saveConfig': z.tuple([
      z
        .object({
          providerId: z.string().min(1).max(64).optional(),
          modelId: z.string().min(1).max(256).optional(),
          model: z.string().min(1).max(256).optional(),
          apiKey: z.string().max(4096).optional(),
          thinkingLevel: z.string().max(32).optional(),
        })
        .loose(),
    ]),
  }
}

/**
 * 高危通道的运行时入参校验表（纯 JS + Zod，零 Node 全局）。
 * 标注 PURE 以便 preload / 渲染层不引用它时被 esbuild / Rollup 完整 tree-shake。
 */
export const IPC_INVOKE_SCHEMAS: Partial<Record<IpcInvokeChannel, z.ZodType<readonly unknown[]>>> =
  /*#__PURE__*/ buildIpcInvokeSchemas()

export function parseContractArgs<K extends IpcInvokeChannel>(
  channel: K,
  rawArgs: readonly unknown[]
): { ok: true; data: IpcInvokeContract[K]['args'] } | { ok: false; error: string } {
  const schema = IPC_INVOKE_SCHEMAS[channel]
  if (!schema) {
    return { ok: true, data: rawArgs as unknown as IpcInvokeContract[K]['args'] }
  }
  const result = schema.safeParse(rawArgs)
  if (result.success) {
    return { ok: true, data: result.data as unknown as IpcInvokeContract[K]['args'] }
  }
  const first = result.error.issues[0]
  const loc = first && first.path.length > 0 ? `${first.path.join('.')}: ` : ''
  return { ok: false, error: `${loc}${first?.message ?? 'Invalid IPC payload'}` }
}

// ============================================================================
// 5. Preload 桥接构建器 & 渲染层统一调用辅助
// ============================================================================

export type PreloadInvoker = (channel: IpcInvokeChannel, ...args: unknown[]) => Promise<unknown>
export type PreloadEventSubscriber = (
  channel: IpcEventChannel,
  listener: (event: unknown, payload: unknown) => void
) => () => void

/**
 * 按 `IPC_INVOKE_CHANNELS` 机械构造全部 preload invoke 转发函数，消除手工拼写通道名漂移。
 */
export function buildPreloadInvokeApi(invoke: PreloadInvoker): IpcInvokeBridge {
  const bridge: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
  for (const [method, channel] of Object.entries(IPC_INVOKE_CHANNELS) as Array<
    [IpcInvokeMethod, IpcInvokeChannel]
  >) {
    bridge[method] = (...args: unknown[]) => invoke(channel, ...args)
  }
  return bridge as unknown as IpcInvokeBridge
}

/**
 * 按 `IPC_EVENT_CHANNELS` 机械构造全部 preload 事件订阅函数，统一返回取消订阅闭包。
 */
export function buildPreloadEventApi(on: PreloadEventSubscriber): IpcEventBridge {
  const bridge: Record<string, (callback: (...args: unknown[]) => void) => () => void> = {}
  for (const [method, channel] of Object.entries(IPC_EVENT_CHANNELS) as Array<
    [IpcEventMethod, IpcEventChannel]
  >) {
    bridge[method] = (callback: (...args: unknown[]) => void) => {
      const listener = (_event: unknown, payload: unknown) => {
        if (channel === IPC_EVENT_CHANNELS.onAppBootExpanded) {
          ;(callback as () => void)()
          return
        }
        callback(payload)
      }
      return on(channel, listener)
    }
  }
  return bridge as unknown as IpcEventBridge
}

/** 统一归一化主进程 / IPC 传输抛出的异常，剥离 Electron 的 `Error invoking remote method` 前缀 */
export function normalizeIpcError(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? 'Unknown IPC error')
  const stripped = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').trim()
  return stripped || 'Unknown IPC error'
}

export interface ContractApiCallOptions<R> {
  /** preload 尚未暴露该接口（热更新旧主进程或纯 Web 环境）时的降级返回值 */
  fallback?: () => R
  /** 底层 IPC 抛错时的错误结果构造函数；缺省时返回 `{ success: false, error }` */
  onError?: (error: string) => R
}

/**
 * 渲染层统一的强类型 IPC 转发构造器：
 * - 自动校验 preload 桥是否存在对应方法；
 * - 自动捕获 IPC 传输异常并用 `normalizeIpcError` 归一化。
 */
export function createContractApiCall<M extends IpcInvokeMethod>(
  getBridge: () => Partial<IpcInvokeBridge>,
  method: M,
  options?: ContractApiCallOptions<IpcMethodResult<M>>
): (...args: IpcMethodArgs<M>) => Promise<IpcMethodResult<M>> {
  return async (...args: IpcMethodArgs<M>): Promise<IpcMethodResult<M>> => {
    const fn = getBridge()[method]
    if (typeof fn !== 'function') {
      if (options?.fallback) return options.fallback()
      if (options?.onError) return options.onError('Electron preload bridge is unavailable')
      return { success: false, error: 'Electron preload bridge is unavailable' } as IpcMethodResult<M>
    }
    try {
      return await (fn as (...callArgs: IpcMethodArgs<M>) => Promise<IpcMethodResult<M>>)(...args)
    } catch (err: unknown) {
      const error = normalizeIpcError(err)
      if (options?.onError) return options.onError(error)
      if (options?.fallback) return options.fallback()
      return { success: false, error } as IpcMethodResult<M>
    }
  }
}

/** 渲染层统一的强类型 IPC 事件订阅转发构造器 */
export function createContractEventSub<M extends IpcEventMethod>(
  getBridge: () => Partial<IpcEventBridge>,
  method: M
): (callback: IpcEventCallback<M>) => () => void {
  return (callback: IpcEventCallback<M>): (() => void) => {
    const fn = getBridge()[method]
    if (typeof fn !== 'function') return () => {}
    return (fn as (cb: IpcEventCallback<M>) => () => void)(callback)
  }
}
