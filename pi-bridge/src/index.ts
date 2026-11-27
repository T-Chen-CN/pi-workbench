/**
 * Pi Agent Bridge
 *
 * Bridges Electron main process to real Pi Agent runtime.
 * Uses @earendil-works/pi-coding-agent for AI-powered development assistance.
 */

export { AgentManager, AgentRuntimeHost } from './agent-manager.js'
export {
  SessionController,
  buildSessionExtensionFactories,
  createSessionController,
  type PendingRootSwitch,
  type SessionControllerDeps,
  type SessionTurnState,
} from './session-controller.js'
export {
  SessionRepository,
  readSessionHeaderInfo,
  type OpenTabsState,
  type SessionRepositoryDeps,
} from './session-repository.js'
export { isPiOffline, normalizePiOfflineEnv } from './agent-catalog.js'
export {
  deriveMessage,
  deriveMessages,
  mergeAgentUsage,
  readMessageUsage,
  type DeriveMessagesOptions,
} from './session-view.js'
export type {
  AgentChatOptions,
  AgentChatResult,
  AgentConfig,
  AgentExtensionToggles,
  AgentLogger,
  AgentMessage,
  AgentTraceEvent,
  AgentTracePart,
  FileEdit,
  MessageContext,
  MessageContextFile,
  MessageContextQuote,
  SessionBeforeCompactInfo,
  SessionOpenResult,
  SessionSummary,
} from './agent-manager.js'
export {
  DEFAULT_PERMISSION_LEVEL,
  DEFAULT_PERMISSION_POLICY,
  PERMISSION_LEVELS,
  PERMISSION_LEVEL_POLICIES,
  SESSION_MODES,
  SESSION_MODE_POLICIES,
  TOOL_CATEGORIES,
  buildApprovalDetails,
  categorizeTool,
  derivePermissionLevelFromPolicy,
  isAllowDecision,
  isPermissionLevel,
  isSessionMode,
  normalizePermissionPolicy,
  normalizeSessionPermission,
  resolvePermissionPolicy,
} from './approval-policy.js'
export type {
  ApprovalDecision,
  ApprovalDetails,
  ApprovalRequestPayload,
  CategorizeToolOptions,
  PermissionAction,
  PermissionLevel,
  PermissionPolicy,
  SessionMode,
  SessionPermission,
  ToolCategory,
} from './approval-policy.js'

export type { SessionExtras } from './session-extras.js'

/** 云端 Agent 的传输契约（帧格式 / 状态模型 / 默认值）；桌面端与 apps/cloud 共用一份 */
export * from './cloud-protocol.js'

/** 有序流式事件合帧器（pi-bridge / apps/cloud 共用） */
export { createStreamCoalescer } from './stream-coalescer.js'
export type {
  CoalescableStreamEvent,
  StreamCoalescer,
  StreamCoalescerOptions,
} from './stream-coalescer.js'

/** 凭证文件存储内核；桌面端注入 safeStorage，云端注入自己的 encryptionKey */
export { createFileCredentialStore } from './credentials-store.js'
export type {
  CredentialCipher,
  CredentialStoreLogger,
  FileCredentialStoreOptions,
} from './credentials-store.js'

/** 固定供应商白名单与模型容量口径；桌面端与云端必须用同一份 */
export {
  PRESET_PROVIDER_IDS,
  PROVIDER_PRESETS,
  builtinCatalogGeneratedAt,
  builtinCatalogModel,
  builtinCatalogModels,
  catalogLimits,
  diffCatalogSnapshots,
  filterEffectiveCatalogModels,
  isBuiltinCatalogProvider,
  isInvalidKeyProbeResponse,
  isPresetProviderId,
  isRemoteCatalogEffective,
  normalizeOverrides,
  presetDisplayName,
  providerModelsHeaders,
  providerModelsProbeRequest,
  resolveLimits,
} from './provider-presets.js'
export type { ModelLimits, ModelOverrides, ProviderPreset } from './provider-presets.js'

/** 供应商配置与旧配置迁移 */
export {
  LEGACY_API_CONFIG_FILE,
  LEGACY_AUTH_FILE,
  PROVIDERS_CONFIG_FILE,
  PROVIDERS_CONFIG_VERSION,
  createProvidersConfigStore,
  credentialFingerprint,
  emptyProvidersConfig,
  legacyProviderFromUrl,
} from './providers-config.js'
export type {
  LegacyMigrationReason,
  LegacyMigrationResult,
  ProviderConfigEntry,
  ProvidersConfig,
  ProvidersConfigLogger,
  ProvidersConfigStore,
  ProvidersConfigStoreOptions,
  SetActiveResult,
} from './providers-config.js'

/** 统一原子 JSON 持久化（electron / apps/cloud / pi-bridge 共用） */
export {
  readJsonAsyncWithBackup,
  readJsonWithBackup,
  writeJsonAtomic,
  writeJsonAtomicAsync,
  writeJsonAtomicSync,
} from './atomic-json.js'
export type { JsonReadResult, JsonWriteOptions } from './atomic-json.js'

/** 聊天图片附件校验常量与函数 */
export {
  CHAT_IMAGE_MIME,
  MAX_CHAT_IMAGES,
  MAX_IMAGE_BASE64_CHARS,
  MAX_TOTAL_IMAGE_BASE64_CHARS,
  validateChatImages,
  type ChatImageInput,
} from './images.js'

/** 文件型目录缓存（SDK 格式）+ 只读快照 */
export { createFileModelsStore } from './models-store.js'
export type {
  CatalogSnapshot,
  FileModelsStoreOptions,
  ModelsStoreLogger,
  TrackedModelsStore,
} from './models-store.js'

/** models.dev 富数据解析与映射（P-07，独立于 Pi catalog） */
export {
  MODELS_DEV_API_URL,
  MODELS_DEV_CACHE_VERSION,
  MODELS_DEV_UPSTREAM_PROVIDERS,
  extractModelsDevSnapshot,
  lookupModelsDevEnrichment,
  parseModelsDevCacheSnapshot,
} from './models-dev.js'
export type {
  ModelsDevCacheSnapshot,
  ModelsDevCost,
  ModelsDevEnrichment,
  ModelsDevModalities,
} from './models-dev.js'

/** MCP（Model Context Protocol）共享类型、客户端宿主与 Pi 扩展（Phase F） */
export * from './mcp-types.js'
export {
  MCP_MAX_TOOL_TEXT_BYTES,
  McpClientHost,
  computeMcpServerFingerprint,
  type McpCallToolResult,
  type McpClientHostOptions,
  type McpToolContentPart,
} from './mcp-host.js'
export { createMcpExtension, type McpExtensionOptions } from './mcp-extension.js'



