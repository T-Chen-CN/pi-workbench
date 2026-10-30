/**
 * Pi Agent Bridge
 *
 * Bridges Electron main process to real Pi Agent runtime.
 * Uses @earendil-works/pi-coding-agent for AI-powered development assistance.
 */

export { AgentManager } from './agent-manager.js'
export type {
  AgentChatOptions,
  AgentChatResult,
  AgentConfig,
  AgentLogger,
  AgentMessage,
  AgentTraceEvent,
  AgentTracePart,
  FileEdit,
  MessageContext,
  MessageContextFile,
  MessageContextQuote,
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
  PermissionAction,
  PermissionLevel,
  PermissionPolicy,
  SessionMode,
  SessionPermission,
  ToolCategory,
} from './approval-policy.js'
export type { SessionExtras } from './session-extras.js'


