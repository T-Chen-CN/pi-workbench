/**
 * 渲染层 Electron Preload 桥接类型声明。
 *
 * 所有领域接口与 IPC 通道契约均单一来源于 `electron/ipc/contract.ts`，
 * 在此统一重导出以保持全仓 `src/` 既有导入路径零变更。
 */

import type {
  ElectronAPIContract,
  IpcEventBridge,
  IpcInvokeBridge,
  IpcSendBridge,
} from '../../electron/ipc/contract'

export type {
  AuxDetachResult,
  WindowMaximizedState,
  WindowCommand,
  AuxWindowCommandResult,
  DetachablePanelId,
  PanelDetachRect,
  PanelDetachRequest,
  PanelDetachResult,
  PanelDockResult,
  WindowSyncMessage,
  GitRepoInfo,
  GitWorktreeView,
  GitBranchInfo,
  GitStatusInfo,
  GitCommitInfo,
  GitCommitStats,
  GitCommitDetail,
  GithubPrStatus,
  GithubAuthUser,
  GithubAuthConfigResult,
  GithubAuthStartResult,
  GithubAuthCompletePayload,
  GithubAuthStatusResult,
  GithubDeviceLoginStartResult,
  GithubDeviceLoginEvent,
  GitSessionBinding,
  GitChangeScope,
  GitChangedPayload,
  GitFetchResult,
  GitWorktreeDepsState,
  GitWorktreeDepsStatus,
  GitWorktreeDepsPayload,
  CloudLinkView,
  CloudDeviceState,
  CloudWorkspaceEntry,
  CloudCatalogModel,
  CloudConfigResult,
  CloudConfigInput,
  CloudClientState,
  CloudClientOutgoingFrame,
  CloudLinkStatusResult,
  CloudPairInput,
  CloudPairResult,
  OpenDirectoryResult,
  PickedAttachment,
  AttachmentPickResult,
  DocumentRenderRequestPayload,
  DocumentRenderResultPayload,
  DocumentPreviewBlock,
  DocumentPreviewSheet,
  DocumentPreviewSlide,
  DocumentPreviewChapter,
  DocumentPreview,
  DocumentPreviewResult,
  ListDirectoryResult,
  ReadFileResult,
  WriteFileResult,
  CreateFileResult,
  ExistsResult,
  StatResult,
  GetAppDirResult,
  AppSettingsRecord,
  GetSettingsResult,
  SaveSettingsResult,
  WorkspaceResult,
  ProviderId,
  ProviderAuthMethod,
  ProviderModelOverrides,
  ProviderModelLimits,
  ProviderModelEnrichmentCost,
  ProviderModelEnrichment,
  ProviderModelView,
  ProviderDirectoryView,
  ProviderView,
  ProvidersListResult,
  ProviderAuthPrompt,
  ProviderAuthEvent,
  WebSearchProviderId,
  WebSearchEndpoint,
  WebSearchConfig,
  WebSearchGetResult,
  WebSearchSaveResult,
  McpTransportType,
  McpServerSource,
  McpServerState,
  McpToolInfo,
  McpServerStatus,
  McpTestResult,
  McpServerInput,
  McpServerSaveInput,
  McpTestRequest,
  McpListResult,
  McpSaveGlobalResult,
  McpDeleteGlobalResult,
  McpSetEnabledResult,
  McpTestCallResult,
  AgentInitConfig,
  AgentInitResult,
  AgentHostInfoResult,
  AgentHostCrashedPayload,
  AgentImagePayload,
  ToolCategory,
  PermissionAction,
  PermissionPolicy,
  PermissionLevel,
  SessionMode,
  SessionPermission,
  ApprovalRequestPayload,
  ApprovalDecision,
  ContextUsageInfo,
  SessionMeta,
  ConversationBranchOption,
  ConversationBranchGroup,
  ExportSessionFormat,
  ToolResultMeta,
  ModelCapabilityInfo,
  PromptTemplateInfo,
  SkillInfo,
  PlanStepStatus,
  PlanStatus,
  PlanStep,
  StructuredPlan,
  SessionStatsInfo,
  FileEdit,
  AgentTracePart,
  AgentStreamEvent,
  AgentStreamPayload,
  AgentChatResult,
  SessionSummary,
  SessionListResult,
  SessionOpenResult,
  SessionTabs,
  SessionTabsResult,
  EditorTabs,
  EditorTabsResult,
  RepoMapRole,
  RepoMapFile,
  RepoMapResult,
  RepoMapScanOptions,
  RepoMapPoint,
  RepoMapFolderState,
  RepoMapCanvasState,
  RepoMapCanvasGetResult,
  RepoMapCanvasSetResult,
  AgentHistoryResult,
  MessageContextQuote,
  MessageContextFile,
  MessageContext,
  AgentDisposeResult,
  TerminalCreateResult,
  TerminalResult,
  TerminalSnapshotInfo,
  TerminalListResult,
  PluginCommandInfo,
  PluginInfo,
  PluginsListResult,
  PluginCommandResult,
  RecentWorkspacesResult,
  DraftRecord,
  DraftResult,
  DraftListResult,
  UpdateStatusKind,
  UpdateState,
  UpdateCheckResult,
  UpdateActionResult,
  UpdateStateResult,
  UpdateNoticeResult,
  AppInfo,
  AppInfoResult,
  AppActiveWorkResult,
  NotifyClickPayload,
  IpcInvokeChannel,
  IpcInvokeMethod,
  IpcEventChannel,
  IpcEventMethod,
  IpcInvokeContract,
  IpcEventContract,
  IpcInvokeBridge,
  IpcEventBridge,
  IpcSendBridge,
  ElectronAPIContract,
} from '../../electron/ipc/contract'

export interface ElectronAPI extends IpcInvokeBridge, IpcEventBridge, IpcSendBridge {
  platform: string
  /** Windows / Linux 原生 titleBarOverlay 已启用时为 true，渲染层仅预留右侧安全区不重复渲染按钮 */
  nativeTitleBarOverlay?: boolean
  getPathForFile: (file: File) => string

  // 云端 IPC 契约成员显式锚定（类型完全派生自单源契约，同时供静态预加载连线校验）
  cloudLinkStatus: IpcInvokeBridge['cloudLinkStatus']
  cloudPair: IpcInvokeBridge['cloudPair']
  cloudUnlink: IpcInvokeBridge['cloudUnlink']
  cloudReconnect: IpcInvokeBridge['cloudReconnect']
  cloudRefreshWorkspaces: IpcInvokeBridge['cloudRefreshWorkspaces']
  cloudListWorkspaces: IpcInvokeBridge['cloudListWorkspaces']
  cloudClientOpen: IpcInvokeBridge['cloudClientOpen']
  cloudClientClose: IpcInvokeBridge['cloudClientClose']
  cloudClientSend: IpcInvokeBridge['cloudClientSend']
  cloudClientState: IpcInvokeBridge['cloudClientState']
  cloudGetConfig: IpcInvokeBridge['cloudGetConfig']
  cloudSaveConfig: IpcInvokeBridge['cloudSaveConfig']
  cloudFetchModels: IpcInvokeBridge['cloudFetchModels']
  cloudGetMemoryData: IpcInvokeBridge['cloudGetMemoryData']
  cloudAddMemory: IpcInvokeBridge['cloudAddMemory']
  cloudUpdateMemory: IpcInvokeBridge['cloudUpdateMemory']
  cloudDeleteMemory: IpcInvokeBridge['cloudDeleteMemory']
  cloudSaveDoc: IpcInvokeBridge['cloudSaveDoc']
  cloudRunDream: IpcInvokeBridge['cloudRunDream']
  onCloudClientFrame: IpcEventBridge['onCloudClientFrame']
  onCloudClientState: IpcEventBridge['onCloudClientState']
  onCloudState: IpcEventBridge['onCloudState']
}

// 编译期互赋校验：保证 ElectronAPI 与 ElectronAPIContract 完全同构
type _VerifyElectronApiShape = ElectronAPI extends ElectronAPIContract
  ? ElectronAPIContract extends ElectronAPI
    ? true
    : never
  : never
export type { _VerifyElectronApiShape as ElectronAPIContractVerified }

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
