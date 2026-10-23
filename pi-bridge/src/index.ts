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
  SessionMode,
  SessionOpenResult,
  SessionSummary,
} from './agent-manager.js'
export {
  DEFAULT_PERMISSION_POLICY,
  TOOL_CATEGORIES,
  buildApprovalDetails,
  categorizeTool,
  isAllowDecision,
  normalizePermissionPolicy,
} from './approval-policy.js'
export type {
  ApprovalDecision,
  ApprovalDetails,
  ApprovalRequestPayload,
  PermissionAction,
  PermissionPolicy,
  ToolCategory,
} from './approval-policy.js'


