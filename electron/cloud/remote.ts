/** 云端 REST 端点 → 前端模型（只做形状转换，不含业务状态） */

import type { CloudCapabilities, CloudRunStatus, CloudSession, CloudTracePart } from './types.js'
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

interface RawRunStatus {
  run_id?: string
  status?: string
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
      }
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
