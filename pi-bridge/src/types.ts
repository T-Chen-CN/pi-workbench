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

/**
 * 上下文容量档位（十进制整数）。
 * 下限 64K：Pi 默认 reserveTokens=16384 + keepRecentTokens=20000，
 * 32K 窗口的触发点会低于保留量，导致反复压缩。
 */
export const CONTEXT_WINDOW_OPTIONS = [64_000, 128_000, 256_000, 1_000_000] as const

export type ModelContextWindow = (typeof CONTEXT_WINDOW_OPTIONS)[number]

/** 设置页维护的单个模型能力；contextWindow 与 image 均由用户显式指定 */
export interface ApiModelEntry {
  id: string
  contextWindow: ModelContextWindow
  image: boolean
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
  | {
      /** 上下文压缩点：作为 part 参与时间线排序，位置跟随压缩发生的先后 */
      type: 'compaction'
      id: string
      /** 对应 JSONL compaction entry id；实时与重载后共用同一锚点 */
      entryId?: string
      timestamp: number
      tokensBefore?: number
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
      /** 压缩被取消或失败重试被放弃时置位：前端不画分隔线 */
      aborted?: boolean
      willRetry?: boolean
      /** 已落盘的 compaction entry id 与时间戳；重载后据此对齐分隔线 */
      entryId?: string
      timestamp?: number
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
    /** 模型列表：容量档位与图片能力由用户设定，是 models.json 的唯一来源 */
    models?: ApiModelEntry[]
  }
  /** 日志出口；主进程注入 agent.log，未注入时退回 console */
  logger?: AgentLogger
  /** 模型生成会话标题后回调（主进程转发给渲染层） */
  onSessionTitle?: (sessionId: string, title: string) => void
  /** 新会话的默认权限档位；只在创建会话运行时读取一次，之后会话自行持有权限 */
  getDefaultPermissionLevel?: () => unknown
  /** 应用语言；用于固定文案（如纯图片会话的标题），缺省按中文 */
  getLanguage?: () => 'zh' | 'en'
  /** 请求用户审批；未提供时按拒绝处理（fail-closed） */
  requestApproval?: (request: ApprovalRequestPayload) => Promise<ApprovalDecision>
  /** 会话当前绑定的工作树根；未提供时使用 workspaceDir */
  resolveSessionRoot?: (sessionId: string) => string | undefined
  /** 会话是否属于当前工作区（用于 listAll 结果过滤） */
  isSessionOfWorkspace?: (sessionId: string, headerCwd: string) => boolean
  /** 内置联网扩展（pi-web-access）的加载路径；缺省表示不加载 */
  webAccessExtensionPaths?: string[]
  /** 当前联网配置版本；变化时新会话会重新加载扩展以读取新配置 */
  getWebAccessConfigVersion?: () => string
  /** 注入给 Agent 的工作树上下文（每轮追加为隐藏的 custom message） */
  getWorktreeContext?: (sessionId: string) => string | Promise<string>
  /** Agent 通过 switch_worktree 请求切换；主进程负责创建/绑定并返回新根 */
  onWorktreeSwitch?: (
    sessionId: string,
    target: string,
    base?: string
  ) => Promise<{
    success: boolean
    root?: string
    branch?: string
    sharedWith?: number
    error?: string
  }>
  /** 切换在轮次边界生效后回调 */
  onSessionRootChanged?: (sessionId: string, root: string) => void
}

export interface SessionSummary {
  id: string
  title: string
  messageCount: number
  createdAt: number
  updatedAt: number
}

/** 模型能力提示（R-06）：容量来自用户设置，maxTokens 由档位与 catalog 收敛 */
export interface ModelCapabilityInfo {
  id: string
  available: boolean
  contextWindow: number
  maxTokens: number | null
  reasoning: boolean | null
  vision: boolean
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
  /** 图像附件（base64，不含 data: 前缀） */
  images?: Array<{ data: string; mimeType: string }>
}

