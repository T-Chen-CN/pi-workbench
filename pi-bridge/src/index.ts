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
  SessionOpenResult,
  SessionSummary,
} from './agent-manager.js'


