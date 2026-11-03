/**
 * 云端 Agent 的渲染层状态。
 *
 * 关键约定：历史与流式片段都落到同一个 `parts` 数组，主进程用同一套 id
 * （历史 `h:<index>` / 流式 `s:<seq>`）推送，所以「轮次结束后的校正帧」可以
 * 直接整体替换而不丢已渲染的内容。
 */

import { create } from 'zustand'
import { cloudApi, hasCloudBridge, UNCONFIGURED_CONNECTION } from '../api/cloud'
import type {
  CloudCapabilities,
  CloudConnectionInfo,
  CloudConnectionState,
  CloudDashboardBounds,
  CloudDashboardState,
  CloudFrame,
  CloudRunStatus,
  CloudSession,
  CloudTracePart,
} from '../types/cloud'

const TERMINAL_STATES: CloudRunStatus[] = ['completed', 'failed', 'cancelled']
const SESSIONS_PAGE_SIZE = 50
const MESSAGES_PAGE_SIZE = 200

const EMPTY_DASHBOARD: CloudDashboardState = {
  visible: false,
  loading: false,
  url: '',
  error: null,
}

export function isTerminalRun(state: CloudRunStatus | null): boolean {
  return state != null && TERMINAL_STATES.includes(state)
}

/** 按 id 覆盖或追加：同 id 的位置不动，保证时间线不跳动 */
export function upsertPart(parts: CloudTracePart[], part: CloudTracePart): CloudTracePart[] {
  const index = parts.findIndex((item) => item.id === part.id)
  if (index < 0) return [...parts, part]
  const next = parts.slice()
  next[index] = part
  return next
}

interface CloudState {
  bridgeAvailable: boolean
  config: CloudConnectionInfo
  connection: CloudConnectionState
  error: string | null
  capabilities: CloudCapabilities | null

  sessions: CloudSession[]
  sessionsLoading: boolean
  sessionsError: string | null

  activeSessionId: string | null
  sessionMeta: CloudSession | null
  parts: CloudTracePart[]
  partsLoading: boolean
  partsError: string | null

  runId: string | null
  runState: CloudRunStatus | null
  runError: string | null
  /** 断流后待补的分隔线（校正帧会整体替换 parts，标记留到替换时插入） */
  pendingDisconnect: string | null
  /** 上一个未成功的发送：重试时复用同一个幂等键，避免后端重复执行 */
  pending: { text: string; key: string } | null

  draft: string
  dashboard: CloudDashboardState

  hydrate: () => Promise<void>
  saveConfig: (input: { baseUrl: string; apiKey?: string }) => Promise<boolean>
  connect: () => Promise<void>
  refreshSessions: () => Promise<void>
  openSession: (sessionId: string) => Promise<void>
  newSession: () => void
  setDraft: (text: string) => void
  send: () => Promise<void>
  stop: () => Promise<void>
  applyFrame: (frame: CloudFrame) => void
  applyStatus: (payload: {
    state: CloudConnectionState
    error: string | null
    capabilities?: CloudCapabilities | null
  }) => void
  openDashboard: () => Promise<void>
  closeDashboard: () => Promise<void>
  setDashboardBounds: (bounds: CloudDashboardBounds) => Promise<void>
  reloadDashboard: () => Promise<void>
  setDashboardError: (error: string | null) => void
  /** 主进程那边关掉了视图（例如页面里按了 Esc） */
  hideDashboard: () => void
}

export const useCloudStore = create<CloudState>()((set, get) => ({
  bridgeAvailable: false,
  config: UNCONFIGURED_CONNECTION,
  connection: 'unconfigured',
  error: null,
  capabilities: null,

  sessions: [],
  sessionsLoading: false,
  sessionsError: null,

  activeSessionId: null,
  sessionMeta: null,
  parts: [],
  partsLoading: false,
  partsError: null,

  runId: null,
  runState: null,
  runError: null,
  pendingDisconnect: null,
  pending: null,

  draft: '',
  dashboard: EMPTY_DASHBOARD,

  async hydrate() {
    const bridgeAvailable = hasCloudBridge()
    set({ bridgeAvailable })
    if (!bridgeAvailable) {
      set({ connection: 'unconfigured', error: null })
      return
    }
    const result = await cloudApi.getConfig()
    if (result.success) {
      set({ config: result.config })
      if (result.config.hasToken) {
        await get().connect()
        return
      }
    }
    set({ connection: 'unconfigured' })
  },

  async saveConfig(input) {
    set({ error: null })
    const result = await cloudApi.setConfig(input)
    if (!result.success) {
      set({ error: result.error ?? 'unknown' })
      return false
    }
    if (result.config) set({ config: result.config })
    await get().connect()
    return true
  },

  async connect() {
    set({ connection: 'connecting', error: null })
    const result = await cloudApi.connect()
    if (!result.success) {
      set({ connection: 'error', error: result.error ?? 'unknown' })
      return
    }
    set({
      connection: result.state,
      capabilities: result.capabilities ?? null,
      error: result.error ?? null,
    })
    if (result.state === 'connected') await get().refreshSessions()
  },

  async refreshSessions() {
    set({ sessionsLoading: true, sessionsError: null })
    const result = await cloudApi.listSessions({ limit: SESSIONS_PAGE_SIZE })
    if (!result.success) {
      set({ sessionsLoading: false, sessionsError: result.error ?? 'unknown' })
      return
    }
    set({ sessions: result.sessions, sessionsLoading: false })
    const active = get().activeSessionId
    if (active) {
      const meta = result.sessions.find((session) => session.id === active)
      if (meta) set({ sessionMeta: meta })
    }
  },

  async openSession(sessionId) {
    set({
      activeSessionId: sessionId,
      sessionMeta: get().sessions.find((session) => session.id === sessionId) ?? null,
      partsLoading: true,
      partsError: null,
      parts: [],
      runId: null,
      runState: null,
      runError: null,
      pending: null,
    })
    const result = await cloudApi.listMessages({ sessionId, limit: MESSAGES_PAGE_SIZE })
    if (!result.success) {
      set({ partsLoading: false, partsError: result.error ?? 'unknown' })
      return
    }
    set({
      parts: result.parts,
      partsLoading: false,
      sessionMeta: result.session ?? get().sessionMeta,
    })
  },

  newSession() {
    set({
      activeSessionId: null,
      sessionMeta: null,
      parts: [],
      partsError: null,
      partsLoading: false,
      runId: null,
      runState: null,
      runError: null,
      pending: null,
    })
  },

  setDraft(text) {
    set({ draft: text })
  },

  async send() {
    const { draft, activeSessionId, runState, pending } = get()
    const text = draft.trim()
    if (!text) return
    if (runState !== null && !isTerminalRun(runState)) return

    // 同一段文本的重试复用幂等键：后端幂等窗口内不会重复执行
    const key = pending && pending.text === text ? pending.key : crypto.randomUUID()
    const optimisticId = `local:${key}`
    set({
      draft: '',
      pending: { text, key },
      runId: null,
      runState: 'started',
      runError: null,
      parts: upsertPart(get().parts, { type: 'text', id: optimisticId, role: 'user', text }),
    })

    const result = await cloudApi.startRun({
      input: text,
      sessionId: activeSessionId ?? undefined,
      idempotencyKey: key,
    })
    if (!result.success || !result.runId) {
      set({
        draft: text,
        runState: 'failed',
        runError: result.error ?? 'unknown',
        parts: upsertPart(get().parts, {
          type: 'divider',
          id: `run-error:${key}`,
          kind: 'run_error',
          detail: result.error ?? 'unknown',
        }),
      })
      return
    }
    set({ runId: result.runId, pending: null })
    if (!activeSessionId && result.sessionId) {
      set({
        activeSessionId: result.sessionId,
        sessionMeta: { ...(get().sessionMeta ?? emptySessionMeta()), id: result.sessionId },
      })
    }
  },

  async stop() {
    const runId = get().runId
    if (!runId) return
    const result = await cloudApi.stopRun(runId)
    if (!result.success) {
      set({ runError: result.error ?? 'unknown' })
      return
    }
    if (result.state) set({ runState: result.state })
  },

  applyFrame(frame) {
    if (frame.kind === 'parts') {
      const pendingDisconnect = get().pendingDisconnect
      set({
        parts: pendingDisconnect
          ? [
              ...frame.parts,
              { type: 'divider', id: `disconnect:${pendingDisconnect}`, kind: 'disconnect' },
            ]
          : frame.parts,
        pendingDisconnect: null,
      })
      return
    }
    if (frame.kind === 'part') {
      set({ parts: upsertPart(get().parts, frame.part) })
      return
    }
    if (frame.kind === 'session') {
      set({
        activeSessionId: frame.sessionId,
        sessionMeta: { ...(get().sessionMeta ?? emptySessionMeta()), id: frame.sessionId },
      })
      return
    }
    if (frame.kind === 'run') {
      set({ runId: frame.runId, runState: frame.state, runError: frame.error ?? null })
      if (isTerminalRun(frame.state)) void get().refreshSessions()
      return
    }
    set({
      runState: 'failed',
      runError: frame.error,
      pendingDisconnect: frame.runId,
    })
  },

  applyStatus(payload) {
    set({
      connection: payload.state,
      error: payload.error,
      capabilities: payload.capabilities ?? get().capabilities,
    })
  },

  async openDashboard() {
    set({ dashboard: { ...get().dashboard, loading: true, error: null } })
    const result = await cloudApi.openDashboard()
    if (!result.success) {
      set({
        dashboard: { ...get().dashboard, loading: false, error: result.error ?? 'unknown' },
      })
      return
    }
    set({ dashboard: { ...get().dashboard, loading: false, visible: true } })
  },

  async closeDashboard() {
    await cloudApi.closeDashboard()
    set({ dashboard: { ...get().dashboard, visible: false } })
  },

  async setDashboardBounds(bounds) {
    await cloudApi.setDashboardBounds(bounds)
  },

  async reloadDashboard() {
    set({ dashboard: { ...get().dashboard, loading: true, error: null } })
    const result = await cloudApi.reloadDashboard()
    set({
      dashboard: {
        ...get().dashboard,
        loading: false,
        error: result.success ? null : (result.error ?? 'unknown'),
      },
    })
  },

  setDashboardError(error) {
    set({ dashboard: { ...get().dashboard, error } })
  },

  hideDashboard() {
    set({ dashboard: { ...get().dashboard, visible: false, loading: false } })
  },
}))

function emptySessionMeta(): CloudSession {
  return {
    id: '',
    title: '',
    preview: '',
    lastActive: Date.now(),
    startedAt: Date.now(),
    messageCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    model: '',
    parentSessionId: null,
    pinned: false,
    archived: false,
  }
}
