/** 云端 REST 端点 → 前端模型（只做形状转换，不含业务状态） */

import type {
  CloudCapabilities,
  CloudDiagnosticCheck,
  CloudDiagnostics,
  CloudJob,
  CloudJobExecution,
  CloudRunStatus,
  CloudSession,
  CloudTracePart,
} from './types.js'
import type { CloudClient } from './client.js'
import { deviceAuthor } from './device.js'
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

interface RawHealthDetailed {
  status?: string
  platform?: string
  version?: string
  gateway_state?: string
  readiness?: {
    status?: string
    checks?: Record<string, Record<string, unknown> | undefined>
  }
}

interface RawToolsetList {
  data?: Array<{
    name?: string
    label?: string
    enabled?: boolean
    configured?: boolean
    tools?: unknown[]
  }>
}

interface RawSkillList {
  data?: unknown[]
}

interface RawModelList {
  data?: Array<{ id?: string }>
}

/** `/v1/skills` 的形状在版本间变过：数组 / `{data}` / `{skills}` 都认 */
function collectSkillNames(raw: RawSkillList | undefined): string[] {
  const list = Array.isArray(raw?.data)
    ? raw.data
    : Array.isArray((raw as { skills?: unknown[] })?.skills)
      ? ((raw as { skills?: unknown[] }).skills as unknown[])
      : []
  return list
    .map((row) =>
      typeof row === 'string' ? row : String((row as { name?: string })?.name ?? '')
    )
    .filter(Boolean)
}

/** 检查项里除了 status 以外的可读信息（磁盘占用 / 队列深度…） */
function describeCheck(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined
  const parts: string[] = []
  if (typeof value.used_percent === 'number') parts.push(`${value.used_percent}%`)
  if (typeof value.state === 'string' && value.state) parts.push(String(value.state))
  if (typeof value.active_api_runs === 'number') parts.push(`runs ${value.active_api_runs}`)
  if (typeof value.active_delegations === 'number') {
    parts.push(`delegations ${value.active_delegations}`)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
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
  pending_controls?: Array<Record<string, unknown>>
  run_id?: string
  status?: string
  /** 丢失 owner epoch 时用来确认收尾的凭据 */
  admission_id?: string
  execution_generation?: number
  session_id?: string
  error?: string
  output?: string
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
  // 排队是真实状态：别折叠成 started，否则界面会把「排在别人后面」显示成已在执行
  if (text === 'queued') return 'queued'
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
  /** 卡在这一轮上的提问（approval / clarify）；流断了也能靠它补出卡片 */
  pendingControls?: Array<Record<string, unknown>>
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

    /**
     * 自检：四块只读事实一次拉全。
     *
     * 每块独立失败——`/v1/skills` 目前在服务器上就是 500，如果整块挂了就把
     * 其它三块一起拖黑，自检就失去意义了。
     */
    async diagnostics(): Promise<CloudDiagnostics> {
      const [health, toolsets, skills, models] = await Promise.all([
        client
          .request<RawHealthDetailed>('/health/detailed', { timeoutMs: 15_000 })
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error })),
        client
          .request<RawToolsetList>('/v1/toolsets', { timeoutMs: 15_000 })
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error })),
        client
          .request<RawSkillList>('/v1/skills', { timeoutMs: 15_000 })
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error })),
        client
          .request<RawModelList>('/v1/models', { timeoutMs: 15_000 })
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error })),
      ])

      const reason = (error: unknown): string =>
        error instanceof Error ? error.message : String(error ?? '未知错误')

      const checks: CloudDiagnosticCheck[] = []
      if (health.ok) {
        const rawChecks = health.value?.readiness?.checks ?? {}
        for (const [name, value] of Object.entries(rawChecks)) {
          checks.push({
            name,
            status: String(value?.status ?? 'unknown'),
            detail: describeCheck(value),
          })
        }
      }

      return {
        fetchedAt: Date.now(),
        version: health.ok ? health.value?.version : undefined,
        platform: health.ok ? health.value?.platform : undefined,
        gatewayState: health.ok ? health.value?.gateway_state : undefined,
        readiness: health.ok
          ? { ok: true, checks }
          : { ok: false, error: reason(health.error), checks: [] },
        toolsets: toolsets.ok
          ? {
              ok: true,
              items: (toolsets.value?.data ?? []).map((row) => ({
                name: String(row?.name ?? ''),
                label: String(row?.label ?? row?.name ?? ''),
                enabled: row?.enabled !== false,
                configured: row?.configured !== false,
                tools: Array.isArray(row?.tools) ? row.tools.map(String) : [],
              })),
            }
          : { ok: false, error: reason(toolsets.error), items: [] },
        skills: skills.ok
          ? { ok: true, names: collectSkillNames(skills.value) }
          : { ok: false, error: reason(skills.error), names: [] },
        models: models.ok
          ? {
              ok: true,
              items: (models.value?.data ?? [])
                .map((row) => String(row?.id ?? ''))
                .filter(Boolean),
            }
          : { ok: false, error: reason(models.error), items: [] },
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
      // `author` 只做记忆归属：上游 `prompt_builder.py` 不读 turn_author，
      // 真正能影响模型判断的是 `instructions`（我们不注入，见 CLOUD_AGENT_DEVICES §3.2）。
      // 逐轮字面量稳定，所以同 Idempotency-Key + 同 body 仍然命中幂等。
      const body: Record<string, unknown> = { input: input.input, author: deviceAuthor() }
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
        pendingControls: Array.isArray(raw.pending_controls) ? raw.pending_controls : undefined,
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
      // `include_disabled=true` 不能省：服务端默认只回 enabled 的任务，
      // 暂停过的那条会从列表里消失 —— 那样就永远没法恢复了。
      const raw = await client.request<{ jobs?: RawJob[] }>('/api/jobs?include_disabled=true', {
        timeoutMs: 20_000,
      })
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

    /**
     * 回答 clarify 提问。body **严格等于** `{request_id, execution_generation, answer}`
     * （多一个字段后端就 invalid_params；generation 不对就 stale_generation）。
     */
    async clarifyRun(input: {
      runId: string
      requestId: string
      generation: number
      answer: string
    }): Promise<void> {
      await client.request<Record<string, unknown>>(
        `/v1/runs/${encodeURIComponent(input.runId)}/clarify`,
        {
          method: 'POST',
          body: {
            request_id: input.requestId,
            execution_generation: input.generation,
            answer: input.answer,
          },
          timeoutMs: 30_000,
        }
      )
    },

    async steerRun(runId: string, text: string): Promise<void> {
      await client.request<Record<string, unknown>>(
        `/v1/runs/${encodeURIComponent(runId)}/steer`,
        { method: 'POST', body: { input: text }, timeoutMs: 20_000 }
      )
    },

    /**
     * 提交审批决定。
     *
     * 2026-11-06 实测（Hermes 0.22.6）：三个字段**都必填** —— 只发 `{choice}` 或
     * `{request_id, choice}` 一律 `400 invalid_params`；凑齐
     * `{request_id, execution_generation, choice}` 才回 `200 {status:"resolved"}`。
     * 所以这里不做「能带就带」的降级（缺字段的请求只会白挨一次 400），
     * 由调用方从轮次状态里补 `execution_generation`。
     */
    async respondApproval(input: {
      runId: string
      requestId: string
      generation: number
      choice: 'once' | 'session' | 'deny'
    }): Promise<{ resolved?: number }> {
      const raw = await client.request<Record<string, unknown>>(
        `/v1/runs/${encodeURIComponent(input.runId)}/approval`,
        {
          method: 'POST',
          body: {
            request_id: input.requestId,
            execution_generation: input.generation,
            choice: input.choice,
          },
          timeoutMs: 30_000,
        }
      )
      return { resolved: typeof raw?.resolved === 'number' ? raw.resolved : undefined }
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
