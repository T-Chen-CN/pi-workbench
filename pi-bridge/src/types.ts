/** AgentManager 的公开类型 */

import type {
  ApprovalDecision,
  ApprovalRequestPayload,
} from './approval-policy.js'
import type { StructuredPlan } from './plan.js'

export interface AgentLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

/** 可展示的工具步骤 */
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
    }

/** 主进程归一化后的流式事件；文本、思考和工具共用同一条有序通道 */
export type AgentTraceEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_redacted' }
  | {
      type: 'tool_start'
      toolCallId: string
      toolName: string
      argsSummary: string
      startedAt: number
      /** 嵌套调用（子 Agent）的父级工具调用（R-16） */
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


export interface AgentConfig {
  workspaceDir: string
  /** Agent 数据目录（默认为 {workspace}/.pi-workbench/agent） */
  agentDir?: string
  apiConfig: {
    provider: string
    apiUrl: string
    apiKey: string
    selectedModel: string
    /** 供应商返回的可选模型列表；用于写入 models.json 与能力提示 */
    availableModels?: string[]
    /** 用户勾选为“支持图片”的模型；未提供时按内置已知信息兜底 */
    imageModels?: string[]
  }
  /** 日志出口；主进程注入 agent.log，未注入时退回 console */
  logger?: AgentLogger
  /** 模型生成会话标题后回调（主进程转发给渲染层） */
  onSessionTitle?: (sessionId: string, title: string) => void
  /** 新会话的默认权限档位；只在创建会话运行时读取一次，之后会话自行持有权限 */
  getDefaultPermissionLevel?: () => unknown
  /** 请求用户审批；未提供时按拒绝处理（fail-closed） */
  requestApproval?: (request: ApprovalRequestPayload) => Promise<ApprovalDecision>
}

export interface SessionSummary {
  id: string
  title: string
  messageCount: number
  createdAt: number
  updatedAt: number
}

/** 模型能力提示（R-06）；null 表示供应商未声明，界面显示“未知” */
export interface ModelCapabilityInfo {
  id: string
  available: boolean
  /** catalog：应用内置已知元数据；default：供应商未声明，使用 SDK 默认值 */
  source: 'catalog' | 'default'
  contextWindow: number | null
  maxTokens: number | null
  reasoning: boolean | null
  vision: boolean | null
  thinkingLevels: string[]
}

/** Pi 提示模板（R-13），通过 `/name` 在对话中展开 */
export interface PromptTemplateInfo {
  name: string
  description: string
  argumentHint?: string
  scope: 'user' | 'project' | 'temporary'
}

/** Pi 技能（R-13），通过 `/skill:name` 调用 */
export interface SkillInfo {
  name: string
  description: string
  scope: 'user' | 'project' | 'temporary'
  disableModelInvocation: boolean
}

export interface SessionOpenResult {
  success: boolean
  session?: SessionSummary
  history?: AgentMessage[]
  error?: string
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

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
  parts?: AgentTracePart[]
  /** 用户消息附带的图片（R-08），用于历史恢复时展示 */
  images?: Array<{ data: string; mimeType: string }>
  timestamp: number
}

export interface FileEdit {
  path: string
  oldContent: string
  newContent: string
  /** 触发该修改的工具调用；用于在工具步骤里打开对应 Diff */
  toolCallId?: string
}

/** 工具结果元数据（R-20）；完整内容按需从会话消息中读取 */
export interface ToolResultMeta {
  toolName: string
  /** text：可分段读取；image：仅含图片结果 */
  kind: 'text' | 'image'
  chars: number
  bytes: number
  lines: number
  imageCount: number
}

export interface AgentUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  /** 供应商回报的累计费用（可能为 0） */
  cost: number
}

export interface AgentChatResult {
  success: boolean
  response?: string
  error?: string
  /** Agent 在本轮对话中修改过的文件（用于 Diff 展示） */
  edits?: FileEdit[]
  /** 本轮模型调用的 token 用量 */
  usage?: AgentUsage
  /** 本轮 Plan 模式新提交的结构化计划（R-04） */
  plan?: StructuredPlan
}

export interface AgentChatOptions {
  /** 接收流式文本增量（兼容只关心文本的调用方） */
  onTextDelta?: (delta: string) => void
  /** 接收归一化的文本 / 思考 / 工具事件；与 onTextDelta 可同时使用 */
  onTrace?: (event: AgentTraceEvent) => void
  /** 单轮请求超时（毫秒），0 表示不超时；默认 10 分钟 */
  timeoutMs?: number
  /** 图像附件（base64，不含 data: 前缀） */
  images?: Array<{ data: string; mimeType: string }>
}

