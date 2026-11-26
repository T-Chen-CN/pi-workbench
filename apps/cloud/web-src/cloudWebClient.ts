/**
 * 云端 Web 客户端纯状态、协议帧归并、主题偏好与 HTTP 请求封装。
 * 零 Electron / 桌面 store 依赖，与桌面端 CloudView 保持完全一致的协议语义与思考流投影。
 */

import type {
  CloudAuthorizationRow,
  CloudAwaySummaryRow,
  CloudChatRow,
  CloudDeviceRow,
  CloudDocItem,
  CloudDreamItem,
  CloudMemoryItem,
  CloudMemoryKind,
  CloudNotice,
  CloudTraceRow,
  CloudUnitRow,
} from '../../../src/types/cloud'

export type WebTab = 'chat' | 'tasks' | 'devices' | 'memory' | 'settings'
export type WebTheme = 'light' | 'dark'
export type WebWsStatus = 'connecting' | 'open' | 'closed'

export interface WebMe {
  hasAccount: boolean
  authenticated: boolean
  version?: string
}

export interface WebCloudConfig {
  configured: boolean
  providerId?: string
  model?: string
  apiKeyMasked?: string
}

export interface WebCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  vision?: boolean
}

export interface WebConfigDraft {
  providerId: string
  model: string
  apiKey: string
}

export interface WebPairCode {
  code: string
  expiresAt: number
}

export interface WebTaskItem {
  id: string
  status: string
  createdAt?: number
  updatedAt?: number
  error?: string
  question?: { id?: string; text: string; at?: number }
  spec?: {
    title?: string
    deviceId?: string
    workUnitId?: string
    repo?: { workspacePath?: string }
  }
  progress?: {
    summary?: string
    changedFiles?: Array<{ path: string; kind?: string; attention?: string }>
    secretHits?: Array<{ path: string; line: number; kind: string }>
  }
  result?: {
    summary?: string
    changedFiles?: Array<{ path: string; kind?: string; attention?: string }>
    secretHits?: Array<{ path: string; line: number; kind: string }>
  }
}

export interface RequestResult<T = any> {
  ok: boolean
  status: number
  payload: T | null
  networkError?: boolean
}

export const THEME_STORAGE_KEY = 'pi-cloud-theme'

export const ACTIVE_TASK_STATUSES = ['queued', 'assigned', 'running', 'waiting_human'] as const

export const TASK_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  assigned: '已派发',
  running: '执行中',
  waiting_human: '等你回答',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  expired: '已过期',
  rejected: '被拒绝',
}

export const AGENT_STATUS_LABELS: Record<string, string> = {
  idle: '空闲',
  thinking: '思考中…',
  replying: '回复中…',
  error: '异常',
}

/** 固定供应商白名单（与桌面端同一份；模型能力全部来自 Pi catalog） */
export const PROVIDER_PRESETS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'google', label: 'Google' },
  { id: 'xai', label: 'xAI' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'xiaomi', label: '小米 MiMo' },
  { id: 'xiaomi-token-plan-cn', label: '小米（Token 套餐）' },
  { id: 'openai-codex', label: 'OpenAI Codex' },
]

export const MEMORY_KIND_LABELS: Record<CloudMemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  project: '项目',
  decision: '决策',
  todo: '待办',
}

export function formatTime(ts?: number): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

export function formatTokens(value?: number): string {
  if (!value) return '-'
  if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`
  return `${Math.round(value / 1024)}K`
}

export function parseTagsInput(raw: string): string[] {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12)
}

export function resolveInitialTheme(): WebTheme {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // 隐私模式可能禁用 localStorage
  }
  const prefersDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  return prefersDark ? 'dark' : 'light'
}

export function applyTheme(theme: WebTheme): void {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.classList.toggle('dark', theme === 'dark')
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // 忽略存储限制
  }
}

export async function apiRequest<T = any>(
  method: string,
  path: string,
  body?: unknown,
  onUnauthorized?: () => void
): Promise<RequestResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    })
  } catch {
    return { ok: false, status: 0, payload: null, networkError: true }
  }
  let payload: T | null = null
  try {
    payload = (await response.json()) as T
  } catch {
    payload = null
  }
  if (response.status === 401 && path !== '/v1/login') {
    onUnauthorized?.()
  }
  return { ok: response.ok, status: response.status, payload }
}

export interface WebSessionState {
  messages: CloudChatRow[]
  tasks: WebTaskItem[]
  devices: CloudDeviceRow[]
  units: CloudUnitRow[]
  authorizations: CloudAuthorizationRow[]
  notices: CloudNotice[]
  awaySummary: CloudAwaySummaryRow | null
  lastSeq: number
  lastReadSeq: number
  unreadCount: number
  agentStatus: string
  canStopReply: boolean
  stoppingTaskIds: Record<string, true>
}

export const INITIAL_WEB_SESSION_STATE: WebSessionState = {
  messages: [],
  tasks: [],
  devices: [],
  units: [],
  authorizations: [],
  notices: [],
  awaySummary: null,
  lastSeq: 0,
  lastReadSeq: 0,
  unreadCount: 0,
  agentStatus: 'idle',
  canStopReply: false,
  stoppingTaskIds: {},
}

function hydrateSnapshotMessage(raw: any): CloudChatRow {
  return {
    id: String(raw?.id ?? `m-${Date.now()}`),
    role: raw?.role === 'user' ? 'user' : 'assistant',
    text: String(raw?.text ?? ''),
    at: Number(raw?.at ?? Date.now()),
    streaming: Boolean(raw?.streaming),
    ...(typeof raw?.thinking === 'string' && raw.thinking ? { thinking: raw.thinking } : {}),
    ...(raw?.thinkingRedacted ? { thinkingRedacted: true } : {}),
    ...(typeof raw?.thinkingDurationMs === 'number'
      ? { thinkingDurationMs: raw.thinkingDurationMs }
      : {}),
    traces: Array.isArray(raw?.traces)
      ? raw.traces.map((trace: any) => ({
          id: String(trace?.id ?? ''),
          toolName: String(trace?.toolName ?? 'tool'),
          summary: String(trace?.summary ?? ''),
          status:
            trace?.status === 'error'
              ? 'error'
              : trace?.status === 'running'
                ? 'running'
                : 'ok',
          ...(typeof trace?.durationMs === 'number' ? { durationMs: trace.durationMs } : {}),
          ...(typeof trace?.resultPreview === 'string'
            ? { resultPreview: trace.resultPreview }
            : {}),
        }))
      : [],
    error: raw?.error,
  }
}

export interface FrameApplyResult {
  state: WebSessionState
  unreadWorthy: boolean
  snapshotUnread: boolean
}

/** 服务端 WS 帧纯状态归并：与桌面端 cloudStore 保持一致的思考/工具/正文流式语义 */
export function applyWebFrame(prev: WebSessionState, frame: any): FrameApplyResult {
  if (!frame || frame.v !== 1) return { state: prev, unreadWorthy: false, snapshotUnread: false }

  if (frame.type === 'snapshot') {
    const snap = frame.snapshot || {}
    // 服务重启后 seq 可能归零重计：snapshot 必须重置游标，不能只取 max
    const nextSeq = Number(frame.seq ?? snap.lastSeq ?? 0)
    const unreadCount = Number(snap.unreadCount ?? 0)
    const next: WebSessionState = {
      ...prev,
      lastSeq: nextSeq,
      messages: Array.isArray(snap.messages) ? snap.messages.map(hydrateSnapshotMessage) : [],
      tasks: Array.isArray(snap.tasks) ? snap.tasks : [],
      devices: Array.isArray(snap.devices) ? snap.devices : [],
      units: Array.isArray(snap.units) ? snap.units : [],
      authorizations: Array.isArray(snap.authorizations) ? snap.authorizations : [],
      awaySummary: snap.awaySummary && typeof snap.awaySummary.text === 'string' ? snap.awaySummary : null,
      lastReadSeq: Number(snap.lastReadSeq ?? 0),
      unreadCount,
      stoppingTaskIds: {},
      agentStatus: snap.cloud?.status || 'idle',
      canStopReply: Boolean(snap.cloud?.canStopReply),
    }
    return { state: next, unreadWorthy: false, snapshotUnread: unreadCount > 0 }
  }

  const nextSeq =
    typeof frame.seq === 'number' && frame.seq > prev.lastSeq ? frame.seq : prev.lastSeq

  if (frame.type === 'error') {
    const notices: CloudNotice[] = [
      { level: 'error' as const, text: String(frame.message || 'cloud error'), at: Date.now() },
      ...prev.notices,
    ].slice(0, 20)
    return {
      state: { ...prev, lastSeq: nextSeq, notices },
      unreadWorthy: false,
      snapshotUnread: false,
    }
  }

  if (frame.type !== 'event') {
    return {
      state: nextSeq === prev.lastSeq ? prev : { ...prev, lastSeq: nextSeq },
      unreadWorthy: false,
      snapshotUnread: false,
    }
  }

  const event = frame.event || {}
  const base = nextSeq === prev.lastSeq ? prev : { ...prev, lastSeq: nextSeq }

  switch (event.type) {
    case 'message': {
      const msg = event.message
      if (!msg) return { state: base, unreadWorthy: false, snapshotUnread: false }
      const hydrated = hydrateSnapshotMessage(msg)
      const index = base.messages.findIndex((row) => row.id === hydrated.id)
      const messages = base.messages.slice()
      if (index >= 0) messages[index] = { ...messages[index], ...hydrated }
      else messages.push(hydrated)
      return {
        state: { ...base, messages: messages.slice(-400) },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    }
    case 'message_start': {
      const id = String(event.messageId || `m-${Date.now()}`)
      if (base.messages.some((row) => row.id === id)) {
        return { state: base, unreadWorthy: false, snapshotUnread: false }
      }
      const isUser = event.role === 'user'
      const messages = base.messages.slice()
      if (!isUser) {
        const lastIndex = messages.length - 1
        const last = messages[lastIndex]
        if (last && last.role === 'assistant' && last.pendingTrace && !last.text) {
          messages[lastIndex] = {
            ...last,
            id,
            at: Number(event.at || last.at),
            streaming: true,
            pendingTrace: false,
          }
          return { state: { ...base, messages }, unreadWorthy: false, snapshotUnread: false }
        }
      }
      messages.push({
        id,
        role: isUser ? 'user' : 'assistant',
        text: '',
        at: Number(event.at || Date.now()),
        streaming: !isUser,
        traces: [],
      })
      return {
        state: { ...base, messages: messages.slice(-400) },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    }
    case 'text_delta': {
      const delta = String(event.delta || '')
      if (!delta) return { state: base, unreadWorthy: false, snapshotUnread: false }
      const messages = base.messages.slice()
      const targetId = String(event.messageId || '')
      let targetIndex = -1
      if (targetId) {
        for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
          if (messages[idx].id === targetId) {
            targetIndex = idx
            break
          }
        }
      }
      if (targetIndex < 0) {
        const last = messages[messages.length - 1]
        if (last && last.role === 'assistant' && last.streaming) {
          targetIndex = messages.length - 1
        }
      }
      if (targetIndex >= 0) {
        const target = messages[targetIndex]
        const now = Date.now()
        const thinkingDurationMs =
          target.thinkingStartedAt && target.thinkingDurationMs === undefined
            ? Math.max(0, now - target.thinkingStartedAt)
            : target.thinkingDurationMs
        messages[targetIndex] = {
          ...target,
          text: target.text + delta,
          streaming: true,
          pendingTrace: false,
          thinkingStartedAt: undefined,
          ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
        }
      } else {
        messages.push({
          id: targetId || `m-${Date.now()}`,
          role: 'assistant',
          text: delta,
          at: Date.now(),
          streaming: true,
          traces: [],
        })
      }
      return {
        state: { ...base, messages: messages.slice(-400) },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    }
    case 'message_end': {
      const targetId = String(event.messageId || '')
      const messages = base.messages.slice()
      const finalize = (row: CloudChatRow): CloudChatRow => {
        const now = Date.now()
        const thinkingDurationMs =
          row.thinkingStartedAt && row.thinkingDurationMs === undefined
            ? Math.max(0, now - row.thinkingStartedAt)
            : row.thinkingDurationMs
        return {
          ...row,
          text: event.text !== undefined ? String(event.text) : row.text,
          streaming: false,
          pendingTrace: false,
          thinkingStartedAt: undefined,
          ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
          error: event.error,
        }
      }
      let idx = targetId ? messages.findIndex((item) => item.id === targetId) : -1
      if (idx < 0) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i].role === 'assistant' && messages[i].streaming) {
            idx = i
            break
          }
        }
      }
      if (idx >= 0) messages[idx] = finalize(messages[idx])
      const unreadWorthy = !targetId.startsWith('u-') && Boolean(String(event.text || '').trim())
      return { state: { ...base, messages }, unreadWorthy, snapshotUnread: false }
    }
    case 'trace': {
      const trace = event.trace || {}
      const traceType = String(trace.type || '')
      if (
        traceType !== 'thinking_delta' &&
        traceType !== 'thinking_redacted' &&
        traceType !== 'tool_start' &&
        traceType !== 'tool_update' &&
        traceType !== 'tool_end'
      ) {
        return { state: base, unreadWorthy: false, snapshotUnread: false }
      }
      const messages = base.messages.slice()
      const targetId = String(event.messageId || '')
      let rowIndex = -1
      if (targetId) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i].id === targetId) {
            rowIndex = i
            break
          }
        }
      }
      if (rowIndex < 0) {
        const last = messages[messages.length - 1]
        if (last && last.role === 'assistant' && last.streaming) {
          rowIndex = messages.length - 1
        }
      }
      const now = Date.now()
      const row: CloudChatRow =
        rowIndex >= 0
          ? messages[rowIndex]
          : {
              id: targetId || `m-${now}`,
              role: 'assistant',
              text: '',
              at: now,
              streaming: true,
              pendingTrace: !targetId,
              traces: [],
            }
      let updated: CloudChatRow = row
      if (traceType === 'thinking_delta') {
        const delta = String(trace.delta || '')
        if (!delta) return { state: base, unreadWorthy: false, snapshotUnread: false }
        updated = {
          ...row,
          thinking: (row.thinking ?? '') + delta,
          thinkingStartedAt: row.thinkingStartedAt ?? now,
        }
      } else if (traceType === 'thinking_redacted') {
        updated = { ...row, thinkingRedacted: true }
      } else {
        const traces: CloudTraceRow[] = row.traces.slice()
        const id = String(trace.toolCallId || '')
        const index = traces.findIndex((item) => item.id === id)
        const closedDuration =
          row.thinkingStartedAt && row.thinkingDurationMs === undefined
            ? Math.max(0, now - row.thinkingStartedAt)
            : row.thinkingDurationMs
        if (traceType === 'tool_start') {
          const nextTrace: CloudTraceRow = {
            id,
            toolName: String(trace.toolName || 'tool'),
            summary: String(trace.argsSummary || ''),
            status: 'running',
          }
          if (index >= 0) traces[index] = nextTrace
          else traces.push(nextTrace)
        } else if (traceType === 'tool_update' && index >= 0) {
          traces[index] = {
            ...traces[index],
            resultPreview:
              typeof trace.resultPreview === 'string'
                ? trace.resultPreview
                : traces[index].resultPreview,
          }
        } else if (traceType === 'tool_end' && index >= 0) {
          traces[index] = {
            ...traces[index],
            status: trace.status === 'error' ? 'error' : 'ok',
            summary: String(trace.resultPreview ?? traces[index].summary),
            ...(typeof trace.durationMs === 'number' ? { durationMs: trace.durationMs } : {}),
            ...(typeof trace.resultPreview === 'string'
              ? { resultPreview: trace.resultPreview }
              : {}),
          }
        }
        updated = {
          ...row,
          thinkingStartedAt: undefined,
          ...(closedDuration !== undefined ? { thinkingDurationMs: closedDuration } : {}),
          traces: traces.slice(-30),
        }
      }
      if (rowIndex >= 0) messages[rowIndex] = updated
      else messages.push(updated)
      return {
        state: { ...base, messages: messages.slice(-400) },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    }
    case 'cloud_status':
      return {
        state: {
          ...base,
          agentStatus: event.status || 'idle',
          canStopReply: event.status === 'thinking' || event.status === 'replying',
        },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    case 'task': {
      const task = event.task as WebTaskItem | undefined
      if (!task) return { state: base, unreadWorthy: false, snapshotUnread: false }
      const tasks = base.tasks.slice()
      const idx = tasks.findIndex((item) => item.id === task.id)
      const prevStatus = idx >= 0 ? tasks[idx].status : null
      if (idx >= 0) tasks[idx] = task
      else tasks.unshift(task)
      let stoppingTaskIds = base.stoppingTaskIds
      if (!(ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status) && stoppingTaskIds[task.id]) {
        stoppingTaskIds = { ...stoppingTaskIds }
        delete stoppingTaskIds[task.id]
      }
      const unreadWorthy =
        prevStatus !== task.status &&
        (task.status === 'waiting_human' ||
          !(ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status))
      return { state: { ...base, tasks, stoppingTaskIds }, unreadWorthy, snapshotUnread: false }
    }
    case 'device': {
      const device = event.device as CloudDeviceRow | undefined
      if (!device) return { state: base, unreadWorthy: false, snapshotUnread: false }
      const devices = base.devices.slice()
      const idx = devices.findIndex((item) => item.id === device.id)
      if (idx >= 0) devices[idx] = device
      else devices.push(device)
      return { state: { ...base, devices }, unreadWorthy: false, snapshotUnread: false }
    }
    case 'unit': {
      const unit = event.unit as CloudUnitRow | undefined
      if (!unit) return { state: base, unreadWorthy: false, snapshotUnread: false }
      const units = base.units.slice()
      const idx = units.findIndex((item) => item.unitId === unit.unitId)
      if (idx >= 0) units[idx] = unit
      else units.unshift(unit)
      return { state: { ...base, units }, unreadWorthy: false, snapshotUnread: false }
    }
    case 'notice': {
      const notice: CloudNotice = {
        level: event.level === 'error' || event.level === 'warn' ? event.level : 'info',
        text: String(event.text || ''),
        at: Number(event.at || Date.now()),
        key: event.key,
      }
      const notices = event.key
        ? [notice, ...base.notices.filter((item) => item.key !== event.key)].slice(0, 20)
        : [notice, ...base.notices].slice(0, 20)
      return { state: { ...base, notices }, unreadWorthy: false, snapshotUnread: false }
    }
    case 'read_state': {
      const unreadCount = Number(event.unreadCount ?? 0)
      const reportedReadSeq = Number(event.lastReadSeq ?? base.lastReadSeq)
      const nextLastReadSeq =
        unreadCount === 0 && typeof frame.seq === 'number'
          ? Math.max(reportedReadSeq, frame.seq)
          : reportedReadSeq
      return {
        state: { ...base, lastReadSeq: nextLastReadSeq, unreadCount },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    }
    default:
      return { state: base, unreadWorthy: false, snapshotUnread: false }
  }
}

export type {
  CloudAuthorizationRow,
  CloudAwaySummaryRow,
  CloudChatRow,
  CloudDeviceRow,
  CloudDocItem,
  CloudDreamItem,
  CloudMemoryItem,
  CloudMemoryKind,
  CloudNotice,
  CloudUnitRow,
}
