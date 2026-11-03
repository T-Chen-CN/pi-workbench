/**
 * 云端 Agent 的数据模型（主进程侧副本）。
 *
 * 与 `src/types/cloud.ts` 结构完全一致：主进程 tsconfig 的 rootDir 是 electron/，
 * 不能直接引用 src/ 下的文件。两边一致性由 tests/cloud-types.test.ts 的类型断言守住。
 */

/**
 * 云端 Hermes Agent 的前端数据模型。
 *
 * 与本地 Agent（AgentTracePart）刻意独立：云端后端只提供 messages + SSE 事件，
 * 没有计划 / 压缩 / 审批队列之外的本地概念。字段命名保持与本地一致，
 * 方便两套时间线组件观感统一。
 */

/** 连接状态：未配置（没有 token）→ connecting → connected / error */
export type CloudConnectionState = 'unconfigured' | 'connecting' | 'connected' | 'error'

export interface CloudConnectionInfo {
  baseUrl: string
  dashboardUrl: string
  /** 渲染层永远拿不到密钥，只能知道有没有 */
  hasToken: boolean
}

/** 后端 /v1/capabilities 的子集（只取前端实际用到的） */
export interface CloudCapabilities {
  platform?: string
  model?: string
  runStop?: boolean
  runSteer?: boolean
  approvalEvents?: boolean
  runApprovalResponse?: boolean
}

export type CloudRunStatus =
  | 'started'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 会话列表行（GET /api/sessions 的条目，只保留前端展示用到的字段） */
export interface CloudSession {
  id: string
  title: string
  preview: string
  /** epoch 毫秒 */
  lastActive: number
  startedAt: number
  messageCount: number
  toolCallCount: number
  inputTokens: number
  outputTokens: number
  /** 实际花费优先，缺失时用估算值（美元） */
  costUsd: number
  model: string
  /** 子会话（delegation / cron 产生的） */
  parentSessionId: string | null
  pinned: boolean
  archived: boolean
}

export type CloudToolStatus = 'running' | 'success' | 'error'

/** 时间线单元。历史与流式事件映射到同一套形状。 */
export type CloudTracePart =
  | { type: 'text'; id: string; role: 'user' | 'assistant'; text: string }
  | { type: 'thinking'; id: string; text: string; redacted?: boolean }
  | {
      type: 'tool'
      id: string
      toolCallId: string
      toolName: string
      argsSummary: string
      status: CloudToolStatus
      resultPreview?: string
      exitCode?: number
      durationMs?: number
    }
  | {
      type: 'approval'
      id: string
      requestId: string
      generation: number
      summary: string
      decision?: 'allow' | 'deny'
    }
  | { type: 'divider'; id: string; kind: 'session_meta' | 'disconnect' | 'run_error'; detail?: string }

/** 主进程 → 渲染层的事件帧 */
export type CloudFrame =
  /** 全量替换（打开会话的历史 / 轮次结束后的校正） */
  | { kind: 'parts'; parts: CloudTracePart[] }
  /** 增量：按 id 覆盖或追加 */
  | { kind: 'part'; part: CloudTracePart }
  | { kind: 'run'; runId: string; state: CloudRunStatus; error?: string }
  /** 新会话的 id：第一条消息发出后由主进程回填 */
  | { kind: 'session'; sessionId: string }
  | { kind: 'error'; runId: string; error: string }

export interface CloudDashboardState {
  visible: boolean
  loading: boolean
  url: string
  error: string | null
}

export interface CloudStatusPayload {
  state: CloudConnectionState
  error: string | null
  capabilities: CloudCapabilities | null
}

export interface CloudConfigGetResult {
  success: boolean
  config: CloudConnectionInfo
  error?: string
}

export interface CloudConfigSetResult {
  success: boolean
  config?: CloudConnectionInfo
  error?: string
}

export interface CloudConnectResult {
  success: boolean
  state: CloudConnectionState
  capabilities?: CloudCapabilities | null
  error?: string
}

export interface CloudSessionsResult {
  success: boolean
  sessions: CloudSession[]
  hasMore?: boolean
  error?: string
}

export interface CloudMessagesResult {
  success: boolean
  parts: CloudTracePart[]
  session?: CloudSession | null
  hasMore?: boolean
  error?: string
}

export interface CloudRunStartResult {
  success: boolean
  runId?: string
  sessionId?: string
  error?: string
}

export interface CloudRunResult {
  success: boolean
  state?: CloudRunStatus
  error?: string
}

export interface CloudDashboardBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}
