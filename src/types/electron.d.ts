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

export interface ElectronAPI {
  platform: string
  /** Windows / Linux 原生 titleBarOverlay 已启用时为 true，渲染层仅预留右侧安全区不重复渲染按钮 */
  nativeTitleBarOverlay?: boolean
  // File system operations
  openDirectoryDialog: () => Promise<OpenDirectoryResult>
  readFile: (path: string) => Promise<ReadFileResult>
  writeFile: (path: string, content: string) => Promise<WriteFileResult>
  /** 用系统默认程序打开文件（媒体与不支持预览的类型） */
  openPathExternally: (path: string) => Promise<WorkspaceResult>
  /** 外部链接（http / https / mailto）：交给系统浏览器打开 */
  openExternalUrl: (url: string) => Promise<WorkspaceResult>
  /** 写入系统剪贴板（自定义协议下 navigator.clipboard 不可用；由主进程执行） */
  writeClipboardText: (text: string) => Promise<boolean>
  listDirectory: (path: string) => Promise<ListDirectoryResult>
  exists: (path: string) => Promise<ExistsResult>
  stat: (path: string) => Promise<StatResult>
  deletePath: (path: string) => Promise<WorkspaceResult>
  renamePath: (oldPath: string, newPath: string) => Promise<WorkspaceResult>
  watchWorkspace: (workspacePath: string) => Promise<WorkspaceResult>
  unwatchWorkspace: (workspacePath?: string) => Promise<WorkspaceResult>
  onFsChanged: (callback: (payload: { type: string; path: string }) => void) => () => void

  /** 主进程请求渲染 PDF 扫描页（只有渲染层有 canvas 与 pdf.js） */
  onDocumentRenderRequest: (
    callback: (payload: DocumentRenderRequestPayload) => void
  ) => () => void
  /** 文档只读预览模型（docx / xlsx / pptx / epub / odf） */
  documentsPreview: (path: string) => Promise<DocumentPreviewResult>
  /** 渲染层回传 PNG 或错误 */
  documentRenderResult: (payload: DocumentRenderResultPayload) => Promise<{ success: boolean }>

  // App configuration & data directory
  getAppDir: () => Promise<GetAppDirResult>
  openDataDir: () => Promise<{ success: boolean; error?: string }>
  logRenderer: (level: string, args: unknown[]) => Promise<{ success: boolean }>
  updateCheck: () => Promise<UpdateCheckResult>
  updateDownload: () => Promise<UpdateActionResult>
  updateInstall: () => Promise<UpdateActionResult>
  updateGetState: () => Promise<UpdateStateResult>
  updateOpenDownload: () => Promise<UpdateActionResult>
  consumeUpdateNotice: () => Promise<UpdateNoticeResult>
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
  onWindowMaximizedChange: (callback: (state: WindowMaximizedState) => void) => () => void
  /** 辅助窗口被关闭时回调（参数是 window.open 的 frameName） */
  onAuxWindowClosed: (callback: (frameName: string) => void) => () => void
  /** 拖出拆窗：由主进程读取真实光标位置并给出新窗口矩形 */
  auxDetachAt: () => Promise<AuxDetachResult>
  /** 拖动开始：让主进程记下拖动起点，用于判断拖动距离 */
  auxDragBegin: () => Promise<{ success: boolean }>
  /** 辅助窗口的自绘窗口按钮：按 frameName 寻址，不操作主窗口 */
  auxWindowCommand: (host: string, command: WindowCommand) => Promise<AuxWindowCommandResult>
  auxWindowState: (host: string) => Promise<AuxWindowCommandResult>
  /** 启动闸门：渲染层数据就绪后通知主进程放大窗口 */
  appBootReady: () => void
  onAppBootExpanded: (callback: () => void) => () => void

  // Workspace configuration
  initWorkspace: (workspacePath: string) => Promise<WorkspaceResult>
  disposeWorkspace: (workspacePath: string) => Promise<WorkspaceResult>
  draftSave: (workspacePath: string, filePath: string, content: string) => Promise<DraftResult>
  draftDelete: (workspacePath: string, filePath: string) => Promise<DraftResult>
  draftList: (workspacePath: string) => Promise<DraftListResult>
  draftClear: (workspacePath: string) => Promise<DraftResult>
  editorTabsGet: (workspacePath: string) => Promise<EditorTabsResult>
  editorTabsSet: (workspacePath: string, tabs: EditorTabs) => Promise<WorkspaceResult>
  /** 仓库地图扫描：只读，缓存写在工作区的 .pi-workbench 里 */
  repoMapScan: (workspacePath: string, options?: RepoMapScanOptions) => Promise<RepoMapResult>
  /** 降级模式下补齐指定文件的描述 */
  repoMapDescribe: (workspacePath: string, paths: string[]) => Promise<RepoMapResult>
  /** 读取画布视图状态（位置 / 折叠 / 视口） */
  repoMapCanvasGet: (workspacePath: string) => Promise<RepoMapCanvasGetResult>
  /** 保存画布视图状态 */
  repoMapCanvasSet: (
    workspacePath: string,
    state: RepoMapCanvasState
  ) => Promise<RepoMapCanvasSetResult>

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
  agentSessionsCreate: (workspaceDir: string, root?: string) => Promise<SessionOpenResult>
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
    callback: (payload: {
      /** 本地工作区会话才有 */
      workspaceDir: string | null
      sessionId: string
    }) => void
  ) => () => void
  agentSteer: (
    workspaceDir: string,
    sessionId: string,
    message: string,
    images?: AgentImagePayload[]
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
    entryId?: string
    timestamp?: number
    error?: string
  }>
  agentRewind: (
    workspaceDir: string,
    sessionId: string,
    newText?: string
  ) => Promise<{
    success: boolean
    text?: string
    /** 被回退的那条用户消息随行的引用 / 附件；重发时重新打包，不丢引用 */
    context?: MessageContext
    error?: string
  }>
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
  searchWorkspaceFiles: (
    workspaceDir: string,
    query: string,
    limit?: number
  ) => Promise<{ success: boolean; files?: string[]; error?: string }>
  getPathForFile: (file: File) => string
  /** 原生文件选择：任意路径 / 任意格式；除图片外只回传元信息 */
  pickAttachments: () => Promise<AttachmentPickResult>
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
  terminalCreate: (
    workspaceDir: string,
    cols: number,
    rows: number,
    cwd?: string
  ) => Promise<TerminalCreateResult>
  terminalWrite: (id: string, data: string) => Promise<TerminalResult>
  terminalResize: (id: string, cols: number, rows: number) => Promise<TerminalResult>
  terminalClose: (id: string) => Promise<TerminalResult>
  terminalFlush: (id: string) => Promise<TerminalResult>
  onTerminalData: (callback: (payload: { id: string; data: string }) => void) => () => void
  onTerminalExit: (callback: (payload: { id: string; exitCode: number }) => void) => () => void

  // Git worktrees / read-only history / GitHub status
  gitRepoInfo: (workspaceDir: string) => Promise<{
    success: boolean
    repo?: GitRepoInfo | null
    worktrees?: GitWorktreeView[]
    error?: string
  }>
  /** 拉取远端更新；force 用于手动刷新，默认受最小间隔限制 */
  gitFetch: (workspaceDir: string, options?: { force?: boolean }) => Promise<GitFetchResult>
  onGitChanged: (callback: (payload: GitChangedPayload) => void) => () => void
  gitListWorktrees: (
    workspaceDir: string,
    activeSessionId?: string
  ) => Promise<{ success: boolean; worktrees?: GitWorktreeView[]; error?: string }>
  gitForgetWorktree: (
    workspaceDir: string,
    id: string,
    activeSessionId?: string
  ) => Promise<{ success: boolean; worktrees?: GitWorktreeView[]; error?: string }>
  /** 手动重试 / 首次触发某个链接工作树的依赖安装（后台执行） */
  gitInstallWorktreeDeps: (
    workspaceDir: string,
    id: string
  ) => Promise<{ success: boolean; deps?: GitWorktreeDepsStatus; error?: string }>
  onGitWorktreeDeps: (callback: (payload: GitWorktreeDepsPayload) => void) => () => void
  gitBranches: (
    workspaceDir: string
  ) => Promise<{ success: boolean; branches?: GitBranchInfo[]; error?: string }>
  gitStatus: (
    workspaceDir: string,
    worktreePath?: string
  ) => Promise<{ success: boolean; status?: GitStatusInfo; error?: string }>
  gitSessionBinding: (
    workspaceDir: string,
    sessionId: string
  ) => Promise<{ success: boolean; binding?: GitSessionBinding; error?: string }>
  gitBindWorktree: (
    workspaceDir: string,
    sessionId: string,
    target: string,
    base?: string
  ) => Promise<{
    success: boolean
    worktree?: GitWorktreeView
    sharedWith?: number
    switched?: { success: boolean; scheduled?: boolean; error?: string }
    error?: string
  }>
  gitReleaseSession: (
    workspaceDir: string,
    sessionId: string
  ) => Promise<{
    success: boolean
    removed?: boolean
    dirty?: boolean
    worktreePath?: string
    error?: string
  }>
  gitCleanupOrphans: (
    workspaceDir: string
  ) => Promise<{
    success: boolean
    removed?: string[]
    dirty?: string[]
    external?: string[]
    error?: string
  }>
  gitLog: (
    workspaceDir: string,
    limit?: number,
    branch?: string,
    all?: boolean
  ) => Promise<{ success: boolean; commits?: GitCommitInfo[]; error?: string }>
  gitCommitStats: (
    workspaceDir: string,
    limit?: number,
    branch?: string,
    all?: boolean
  ) => Promise<{
    success: boolean
    stats?: Record<string, GitCommitStats>
    error?: string
  }>
  gitCreateBranch: (
    workspaceDir: string,
    sha: string,
    name: string
  ) => Promise<{ success: boolean; error?: string }>
  gitCommitDetail: (
    workspaceDir: string,
    sha: string
  ) => Promise<{ success: boolean; detail?: GitCommitDetail; error?: string }>
  gitDiff: (
    workspaceDir: string,
    from: string,
    to: string
  ) => Promise<{ success: boolean; patch?: string; error?: string }>
  gitCheckout: (
    workspaceDir: string,
    worktreePath: string,
    branch: string
  ) => Promise<{ success: boolean; error?: string }>
  gitMerge: (
    workspaceDir: string,
    worktreePath: string,
    branch: string,
    strategy?: 'merge' | 'squash' | 'rebase'
  ) => Promise<{ success: boolean; error?: string }>
  gitGithubTokenStatus: () => Promise<{ success: boolean; configured?: boolean }>
  githubAuthConfig: () => Promise<GithubAuthConfigResult>
  githubAuthStart: () => Promise<GithubAuthStartResult>
  githubAuthStatus: () => Promise<GithubAuthStatusResult>
  githubAuthLogout: () => Promise<{ success: boolean; error?: string }>
  onGithubAuthComplete: (
    callback: (payload: GithubAuthCompletePayload) => void
  ) => () => void
  githubAuthDeviceStart: () => Promise<GithubDeviceLoginStartResult>
  githubAuthDeviceCancel: () => Promise<{ success: boolean; cancelled?: boolean }>
  githubAuthDeviceOpen: () => Promise<{ success: boolean }>
  onGithubAuthDeviceEvent: (
    callback: (payload: GithubDeviceLoginEvent) => void
  ) => () => void
  gitSetGithubToken: (token: string) => Promise<{ success: boolean; error?: string }>
  gitPrStatus: (
    workspaceDir: string,
    worktreePath?: string
  ) => Promise<{ success: boolean; status?: GithubPrStatus; error?: string }>
  onAgentSessionRootChanged: (
    callback: (payload: { workspaceDir: string; sessionId: string; root: string }) => void
  ) => () => void

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

  // 供应商预设（凭证 + 模型目录）
  providersList: () => Promise<ProvidersListResult>
  providersSetActive: (providerId: string, modelId?: string) => Promise<{ success: boolean; error?: string }>
  providersSetOverrides: (
    providerId: string,
    modelId: string,
    overrides: ProviderModelOverrides
  ) => Promise<{
    success: boolean
    error?: string
    effective?: ProviderModelLimits
    /** true：正在跑的会话会在轮次边界才用新上限（D23） */
    pending?: boolean
  }>
  providersRefresh: (force?: boolean) => Promise<{
    success: boolean
    added: number
    removed: number
    checkedAt: number
    error?: string
  }>
  providersSetApiKey: (providerId: string, apiKey: string) => Promise<{ success: boolean; error?: string }>
  providersForget: (providerId: string) => Promise<{ success: boolean }>
  providersLogin: (providerId: string, type: ProviderAuthMethod) => Promise<{ success: boolean; error?: string }>
  providersAuthAnswer: (requestId: string, value: string) => Promise<{ ok: boolean }>
  providersCancelLogin: (providerId: string) => Promise<{ ok: boolean }>
  onProvidersAuthEvent: (callback: (payload: ProviderAuthEvent) => void) => () => void

  // 云端连接（配对 / 解绑 / 状态）
  cloudLinkStatus: () => Promise<CloudLinkStatusResult>
  cloudPair: (input: CloudPairInput) => Promise<CloudPairResult>
  cloudUnlink: () => Promise<{ success: boolean; error?: string }>
  cloudReconnect: () => Promise<{ success: boolean; state?: CloudDeviceState; error?: string }>
  cloudRefreshWorkspaces: () => Promise<{
    success: boolean
    workspaces?: CloudWorkspaceEntry[]
    error?: string
  }>
  cloudListWorkspaces: () => Promise<{ success: boolean; workspaces: CloudWorkspaceEntry[] }>
  cloudClientOpen: () => Promise<{ success: boolean; state: CloudClientState; error?: string }>
  cloudClientClose: () => Promise<{ success: boolean }>
  cloudClientSend: (frame: CloudClientOutgoingFrame) => Promise<{ success: boolean; error?: string }>
  cloudClientState: () => Promise<{ success: boolean; state: CloudClientState }>
  cloudGetConfig: () => Promise<CloudConfigResult>
  cloudSaveConfig: (config: CloudConfigInput) => Promise<{
    success: boolean
    result?: { ok?: boolean; apiKeyMasked?: string; takesEffect?: string; warning?: string }
    error?: string
  }>
  cloudFetchModels: (input: {
    providerId: string
  }) => Promise<{ success: boolean; models: string[]; catalog?: CloudCatalogModel[]; error?: string }>
  cloudGetMemoryData: () => Promise<{
    success: boolean
    memories?: import('./cloud').CloudMemoryItem[]
    docs?: import('./cloud').CloudDocItem[]
    dreams?: import('./cloud').CloudDreamItem[]
    error?: string
  }>
  cloudAddMemory: (input: {
    kind?: string
    content: string
    tags?: string[]
    pinned?: boolean
  }) => Promise<{ success: boolean; memory?: import('./cloud').CloudMemoryItem; error?: string }>
  cloudUpdateMemory: (input: {
    id: string
    kind?: string
    content?: string
    tags?: string[]
    pinned?: boolean
  }) => Promise<{ success: boolean; memory?: import('./cloud').CloudMemoryItem; error?: string }>
  cloudDeleteMemory: (id: string) => Promise<{ success: boolean; error?: string }>
  cloudSaveDoc: (input: {
    name: 'AGENTS.md' | 'SOUL.md'
    content: string
  }) => Promise<{ success: boolean; doc?: import('./cloud').CloudDocItem; error?: string }>
  cloudRunDream: () => Promise<{
    success: boolean
    dream?: import('./cloud').CloudDreamItem | null
    error?: string
  }>
  onCloudClientFrame: (callback: (frame: unknown) => void) => () => void
  onCloudClientState: (callback: (state: CloudClientState) => void) => () => void
  onCloudState: (callback: (state: CloudDeviceState) => void) => () => void

  // Web search (内置联网能力)
  webSearchGet: () => Promise<WebSearchGetResult>
  webSearchSave: (config: WebSearchConfig) => Promise<WebSearchSaveResult>
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

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

