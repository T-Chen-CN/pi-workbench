/** 云端 REST 端点 → 前端模型（只做形状转换，不含业务状态） */

import type {
  CloudCapabilities,
  CloudJob,
  CloudJobExecution,
  CloudRunStatus,
  CloudSession,
  CloudTracePart,
} from './types.js'
import type { CloudClient } from './client.js'
import { mapMessages, type RawMessage } from './map.js'

interface RawSession {
  id?: string
  title?: string
  preview?: string
  message_count?: number
  tool_call_count?: number
  input_tokens?: number
  output_tokens?: number
  last_active?: number
  started_at?: number
  model?: string
  parent_session_id?: string | null
  pinned?: boolean
  archived?: boolean
  estimated_cost_usd?: number | null
  actual_cost_usd?: number | null
}

interface RawSessionList {
  data?: RawSession[]
  has_more?: boolean
}

interface RawMessagePage {
  data?: RawMessage[]
  session_id?: string
  pagination?: { returned?: number; limit?: number; offset?: number }
}

interface RawCapabilities {
  platform?: string
  model?: string
  /** 实际响应把它们放在 features 下；扁平写法作为兼容回退 */
  features?: Record<string, unknown>
  run_stop?: boolean
  run_steer?: boolean
  approval_events?: boolean
  run_approval_response?: boolean
}

/** features 里的值可能是布尔，也可能是 `{ supported: true, ... }` */
function featureFlag(raw: RawCapabilities, key: string): boolean {
  const value = raw.features?.[key] ?? (raw as Record<string, unknown>)[key]
  if (typeof value === 'boolean') return value
  if (value && typeof value === 'object') {
    return Boolean((value as { supported?: unknown }).supported)
  }
  return false
}

interface RawJobExecution {
  id?: string
  status?: string
  claimed_at?: string
  started_at?: string | null
  finished_at?: string | null
  error?: string | null
}

interface RawJob {
  id?: string
  name?: string
  prompt?: string | null
  schedule?: string
  schedule_display?: string
  state?: string
  enabled?: boolean
  next_run_at?: string | null
  last_run_at?: string | null
  repeat?: number | null
  paused_reason?: string | null
  latest_execution?: RawJobExecution | null
  live_execution?: RawJobExecution | null
}

function toJobExecution(raw: RawJobExecution | null | undefined): CloudJobExecution | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  return {
    id: raw.id ? String(raw.id) : undefined,
    status: raw.status ? String(raw.status) : undefined,
    claimedAt: raw.claimed_at ? String(raw.claimed_at) : undefined,
    startedAt: raw.started_at ? String(raw.started_at) : undefined,
    finishedAt: raw.finished_at ? String(raw.finished_at) : undefined,
    error: raw.error ? String(raw.error) : undefined,
  }
}

/** 服务端记录 → 渲染层的驼峰形状；缺字段一律当空，不编造 */
function toJob(raw: RawJob): CloudJob {
  const id = String(raw?.id ?? '')
  return {
    id,
    name: String(raw?.name ?? id),
    prompt: String(raw?.prompt ?? ''),
    schedule: String(raw?.schedule ?? ''),
    scheduleDisplay: String(raw?.schedule_display ?? raw?.schedule ?? ''),
    state: String(raw?.state ?? 'scheduled'),
    enabled: raw?.enabled !== false,
    nextRunAt: raw?.next_run_at ? String(raw.next_run_at) : undefined,
    lastRunAt: raw?.last_run_at ? String(raw.last_run_at) : undefined,
    repeat: raw?.repeat ?? null,
    pausedReason: raw?.paused_reason ? String(raw.paused_reason) : undefined,
    latestExecution: toJobExecution(raw?.latest_execution),
    liveExecution: toJobExecution(raw?.live_execution),
  }
}

interface RawRunStatus {
  run_id?: string
  status?: string
  /** 丢失 owner epoch 时用来确认收尾的凭据 */
  admission_id?: string
  execution_generation?: number
  session_id?: string
  error?: string
  output?: string
  pending_controls?: unknown
}

interface RawAcceptedRun {
  run_id?: string
  status?: string
  replayed?: boolean
}

/** epoch 秒（后端）→ epoch 毫秒（前端） */
function toMillis(value: unknown): number {
  const seconds = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.round(seconds * 1000)
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function toCloudSession(raw: RawSession): CloudSession {
  const actual = positive(raw.actual_cost_usd)
  return {
    id: String(raw.id ?? ''),
    title: String(raw.title ?? ''),
    preview: String(raw.preview ?? ''),
    lastActive: toMillis(raw.last_active),
    startedAt: toMillis(raw.started_at),
    messageCount: positive(raw.message_count),
    toolCallCount: positive(raw.tool_call_count),
    inputTokens: positive(raw.input_tokens),
    outputTokens: positive(raw.output_tokens),
    costUsd: actual || positive(raw.estimated_cost_usd),
    model: String(raw.model ?? ''),
    parentSessionId: raw.parent_session_id ? String(raw.parent_session_id) : null,
    pinned: Boolean(raw.pinned),
    archived: Boolean(raw.archived),
  }
}

const RUN_STATUSES: CloudRunStatus[] = [
  'started',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'unknown',
]

export function toRunStatus(value: unknown): CloudRunStatus {
  const text = String(value ?? '')
  if (text === 'queued') return 'started'
  if (text === 'waiting_for_approval') return 'waiting_approval'
  if (text === 'interrupted') return 'failed'
  return (RUN_STATUSES as string[]).includes(text) ? (text as CloudRunStatus) : 'running'
}

export interface RunStatusSnapshot {
  status: CloudRunStatus
  sessionId: string | null
  error: string | null
  /** 只有 `unknown` 才有；确认收尾时原样回传 */
  admissionId?: string
  executionGeneration?: number
}

export function createRemote(client: CloudClient) {
  return {
    async capabilities(): Promise<CloudCapabilities> {
      const raw = await client.request<RawCapabilities>('/v1/capabilities', { timeoutMs: 15_000 })
      return {
        platform: raw.platform,
        model: raw.model,
        runStop: featureFlag(raw, 'run_stop'),
        runSteer: featureFlag(raw, 'run_steer'),
        approvalEvents: featureFlag(raw, 'approval_events'),
        runApprovalResponse: featureFlag(raw, 'run_approval_response'),
      }
    },

    async listSessions(input: { limit?: number; offset?: number }): Promise<{
      sessions: CloudSession[]
      hasMore: boolean
    }> {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
      const offset = Math.max(input.offset ?? 0, 0)
      const raw = await client.request<RawSessionList>(
        `/api/sessions?limit=${limit}&offset=${offset}`
      )
      const sessions = (raw.data ?? []).map(toCloudSession)
      const hasMore = typeof raw.has_more === 'boolean' ? raw.has_more : sessions.length >= limit
      return { sessions, hasMore }
    },

    async updateSession(input: {
      sessionId: string
      title?: string
      pinned?: boolean
    }): Promise<CloudSession> {
      const body: Record<string, unknown> = {}
      if (typeof input.title === 'string') body.title = input.title
      if (typeof input.pinned === 'boolean') body.pinned = input.pinned
      const raw = await client.request<{ session?: RawSession }>(
        `/api/sessions/${encodeURIComponent(input.sessionId)}`,
        { method: 'PATCH', body, timeoutMs: 20_000 }
      )
      if (!raw?.session) throw new Error('云端没有返回更新后的会话')
      return toCloudSession(raw.session)
    },

    async deleteSession(sessionId: string): Promise<boolean> {
      const raw = await client.request<{ deleted?: boolean }>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE', timeoutMs: 30_000 }
      )
      return raw?.deleted === true
    },

    async listMessages(input: {
      sessionId: string
      limit?: number
      offset?: number
    }): Promise<{ parts: CloudTracePart[]; hasMore: boolean }> {
      const limit = Math.min(Math.max(input.limit ?? 500, 1), 500)
      const offset = Math.max(input.offset ?? 0, 0)
      const raw = await client.request<RawMessagePage>(
        `/api/sessions/${encodeURIComponent(input.sessionId)}/messages` +
          `?inline_images=false&limit=${limit}&offset=${offset}`
      )
      const rows = raw.data ?? []
      const returned = raw.pagination?.returned ?? rows.length
      return {
        parts: mapMessages(rows, { settled: true }),
        hasMore: returned >= limit,
      }
    },

    async startRun(input: {
      input: string
      sessionId?: string
      idempotencyKey: string
    }): Promise<{ runId: string; status: CloudRunStatus }> {
      const body: Record<string, unknown> = { input: input.input }
      if (input.sessionId) body.session_id = input.sessionId
      const raw = await client.request<RawAcceptedRun>('/v1/runs', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': input.idempotencyKey },
        timeoutMs: 60_000,
      })
      if (!raw.run_id) throw new Error('云端没有返回 run_id')
      return { runId: raw.run_id, status: toRunStatus(raw.status) }
    },

    async runStatus(runId: string): Promise<RunStatusSnapshot> {
      const raw = await client.request<RawRunStatus>(
        `/v1/runs/${encodeURIComponent(runId)}`,
        { timeoutMs: 15_000 }
      )
      return {
        status: toRunStatus(raw.status),
        sessionId: raw.session_id ? String(raw.session_id) : null,
        error: raw.error ? String(raw.error) : null,
        admissionId: raw.admission_id ? String(raw.admission_id) : undefined,
        executionGeneration:
          typeof raw.execution_generation === 'number' ? raw.execution_generation : undefined,
      }
    },

    /**
     * 丢失 owner epoch 的收尾确认：只对 `unknown` 有意义，body 必须**严格等于**
     * `{admission_id, execution_generation}`（多一个字段后端就 invalid_params）。
     */
    async resolveUnknownRun(input: {
      runId: string
      admissionId: string
      executionGeneration: number
    }): Promise<{ status: RunStatusSnapshot['status']; sessionId: string | null }> {
      const raw = await client.request<RawRunStatus>(
        `/v1/runs/${encodeURIComponent(input.runId)}/resolve-unknown`,
        {
          method: 'POST',
          body: {
            admission_id: input.admissionId,
            execution_generation: input.executionGeneration,
          },
          timeoutMs: 30_000,
        }
      )
      return {
        status: toRunStatus(raw.status ?? 'cancelled'),
        sessionId: raw.session_id ? String(raw.session_id) : null,
      }
    },

    /**
     * 定时任务：只有「列 / 立刻跑 / 暂停 / 恢复」四个动作。
     *
     * 不做删除（用户明确：任务只能暂停，不能在这里删），也不做新建——
     * 新建等于写一段 prompt 交给调度器，那属于对话里让 Agent 建。
     */
    async listJobs(): Promise<CloudJob[]> {
      const raw = await client.request<{ jobs?: RawJob[] }>('/api/jobs', { timeoutMs: 20_000 })
      const rows = Array.isArray(raw?.jobs) ? raw.jobs : []
      return rows.map(toJob)
    },

    async runJob(jobId: string): Promise<void> {
      await client.request<Record<string, unknown>>(
        `/api/jobs/${encodeURIComponent(jobId)}/run`,
        { method: 'POST', body: {}, timeoutMs: 20_000 }
      )
    },

    async pauseJob(jobId: string): Promise<void> {
      await client.request<Record<string, unknown>>(
        `/api/jobs/${encodeURIComponent(jobId)}/pause`,
        { method: 'POST', body: {}, timeoutMs: 20_000 }
      )
    },

    async resumeJob(jobId: string): Promise<void> {
      await client.request<Record<string, unknown>>(
        `/api/jobs/${encodeURIComponent(jobId)}/resume`,
        { method: 'POST', body: {}, timeoutMs: 20_000 }
      )
    },

    async steerRun(runId: string, text: string): Promise<void> {
      await client.request<Record<string, unknown>>(
        `/v1/runs/${encodeURIComponent(runId)}/steer`,
        { method: 'POST', body: { input: text }, timeoutMs: 20_000 }
      )
    },

    async stopRun(runId: string): Promise<RunStatusSnapshot> {
      const raw = await client.request<RawRunStatus>(
        `/v1/runs/${encodeURIComponent(runId)}/stop`,
        { method: 'POST', body: {}, timeoutMs: 20_000 }
      )
      return {
        status: toRunStatus(raw.status ?? 'cancelled'),
        sessionId: raw.session_id ? String(raw.session_id) : null,
        error: raw.error ? String(raw.error) : null,
      }
    },
  }
}

export type CloudRemote = ReturnType<typeof createRemote>
