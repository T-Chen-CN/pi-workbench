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
  /** 首次 hydrate 是否完成（云端外壳据此决定落「连接」还是「会话」页） */
  hydrated: boolean
  config: CloudConnectionInfo
  connection: CloudConnectionState
  error: string | null
  capabilities: CloudCapabilities | null

  sessions: CloudSession[]
  sessionsLoading: boolean
  sessionsLoadingMore: boolean
  sessionsHasMore: boolean
  sessionsError: string | null
  /** 列表搜索词（纯本地过滤：服务端只支持精确标题查找） */
  sessionQuery: string
  /** 最近一次自动同步成功的时间（多端同步的唯一信号） */
  sessionsSyncedAt: number | null
  syncing: boolean
  /** 正在执行条目操作（重命名 / 置顶 / 删除）的会话 id */
  sessionActionPending: string | null

  activeSessionId: string | null
  sessionMeta: CloudSession | null
  parts: CloudTracePart[]
  partsLoading: boolean
  partsError: string | null

  runId: string | null
  runState: CloudRunStatus | null
  runError: string | null
  /** 插话请求本身的失败（与轮次失败分开，避免误报「这一轮挂了」） */
  steerError: string | null
  /** 断流后待补的分隔线（校正帧会整体替换 parts，标记留到替换时插入） */
  pendingDisconnect: string | null
  /** 上一个未成功的发送：重试时复用同一个幂等键，避免后端重复执行 */
  pending: { text: string; key: string } | null
  /** 历史拉取的世代号：只接受最后一次请求的结果（连点会话时防串台） */
  historyToken: number

  draft: string
  dashboard: CloudDashboardState

  hydrate: () => Promise<void>
  saveConfig: (input: { baseUrl: string; apiKey?: string; dashboardToken?: string }) => Promise<boolean>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  refreshSessions: () => Promise<void>
  loadMoreSessions: () => Promise<void>
  setSessionQuery: (query: string) => void
  syncSessions: () => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<boolean>
  togglePinned: (sessionId: string) => Promise<boolean>
  deleteSession: (sessionId: string) => Promise<boolean>
  openSession: (sessionId: string) => Promise<void>
  newSession: () => void
  setDraft: (text: string) => void
  send: () => Promise<void>
  steer: () => Promise<void>
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
  /** 主进程报「这次加载收尾」：清加载态；成功时连错误一起清（重试成功要自愈） */
  settleDashboard: () => void
  /** 主进程那边关掉了视图（例如页面里按了 Esc） */
  hideDashboard: () => void
}

export const useCloudStore = create<CloudState>()((set, get) => ({
  bridgeAvailable: false,
  hydrated: false,
  config: UNCONFIGURED_CONNECTION,
  connection: 'unconfigured',
  error: null,
  capabilities: null,

  sessions: [],
  sessionsLoading: false,
  sessionsLoadingMore: false,
  sessionsHasMore: false,
  sessionsError: null,
  sessionQuery: '',
  sessionsSyncedAt: null,
  syncing: false,
  sessionActionPending: null,

  activeSessionId: null,
  sessionMeta: null,
  parts: [],
  partsLoading: false,
  partsError: null,

  runId: null,
  runState: null,
  runError: null,
  steerError: null,
  pendingDisconnect: null,
  pending: null,
  historyToken: 0,

  draft: '',
  dashboard: EMPTY_DASHBOARD,

  async hydrate() {
    const bridgeAvailable = hasCloudBridge()
    set({ bridgeAvailable })
    if (!bridgeAvailable) {
      set({ connection: 'unconfigured', error: null, hydrated: true })
      return
    }
    const result = await cloudApi.getConfig()
    if (result.success) {
      set({ config: result.config })
      if (result.config.hasToken) {
        await get().connect()
        set({ hydrated: true })
        return
      }
    }
    set({ connection: 'unconfigured', hydrated: true })
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

  async disconnect() {
    await cloudApi.disconnect()
    await cloudApi.closeDashboard()
    const config = await cloudApi.getConfig()
    set({
      connection: 'unconfigured',
      error: null,
      capabilities: null,
      sessions: [],
      sessionsError: null,
      activeSessionId: null,
      sessionMeta: null,
      parts: [],
      partsError: null,
      runId: null,
      runState: null,
      runError: null,
      pending: null,
      pendingDisconnect: null,
      dashboard: EMPTY_DASHBOARD,
      ...(config.success ? { config: config.config } : {}),
    })
  },

  async refreshSessions() {
    set({ sessionsLoading: true, sessionsError: null })
    const result = await cloudApi.listSessions({ limit: SESSIONS_PAGE_SIZE, offset: 0 })
    if (!result.success) {
      set({ sessionsLoading: false, sessionsError: result.error ?? 'unknown' })
      return
    }
    set({
      sessions: result.sessions,
      sessionsLoading: false,
      sessionsHasMore: result.hasMore === true,
    })
    const active = get().activeSessionId
    if (active) {
      const meta = result.sessions.find((session) => session.id === active)
      if (meta) set({ sessionMeta: meta })
    }
  },

  async loadMoreSessions() {
    const { sessions, sessionsHasMore, sessionsLoading, sessionsLoadingMore } = get()
    if (!sessionsHasMore || sessionsLoading || sessionsLoadingMore) return
    set({ sessionsLoadingMore: true })
    const result = await cloudApi.listSessions({
      limit: SESSIONS_PAGE_SIZE,
      offset: sessions.length,
    })
    if (!result.success) {
      set({ sessionsLoadingMore: false, sessionsError: result.error ?? 'unknown' })
      return
    }
    // 翻页期间可能有新会话插进来：按 id 去重，避免同一行渲染两次
    const seen = new Set(get().sessions.map((session) => session.id))
    const appended = result.sessions.filter((session) => !seen.has(session.id))
    set({
      sessions: [...get().sessions, ...appended],
      sessionsLoadingMore: false,
      sessionsHasMore: result.hasMore === true,
    })
  },

  /**
   * 多端同步：没有全局事件端点，也没有 ETag，只能低频轮询。
   * 只合并列表行，不动当前会话的 parts —— 正在看的时间线不该被后台刷新截断。
   */
  async syncSessions() {
    const { connection, runState, sessionActionPending, syncing } = get()
    if (connection !== 'connected' || syncing) return
    // 本轮还在跑：SSE 正在推时间线，这时候拉列表只会让行乱跳
    if (runState !== null && !isTerminalRun(runState)) return
    set({ syncing: true })
    const result = await cloudApi.listSessions({ limit: SESSIONS_PAGE_SIZE, offset: 0 })
    if (!result.success) {
      // 后台刷新失败不打扰用户：保留旧列表，等下一个周期
      set({ syncing: false })
      return
    }
    const current = get().sessions
    const fresh = new Map(result.sessions.map((session) => [session.id, session]))
    const known = new Set(current.map((session) => session.id))
    const merged = current.map((row) => {
      // 本地正在做条目操作用户看不到自己被覆盖
      if (sessionActionPending === row.id) return row
      return fresh.get(row.id) ?? row
    })
    const added = result.sessions.filter((session) => !known.has(session.id))
    const active = get().activeSessionId
    const activeMeta = active ? fresh.get(active) : null
    set({
      sessions: [...added, ...merged],
      syncing: false,
      sessionsSyncedAt: Date.now(),
      ...(activeMeta ? { sessionMeta: activeMeta } : {}),
    })
  },

  setSessionQuery(query) {
    set({ sessionQuery: query })
  },

  async renameSession(sessionId, title) {
    const next = title.trim()
    const current = get().sessions.find((session) => session.id === sessionId)
    if (!current || !next || next === current.title) return false
    // 乐观更新：先改本地，失败回滚（等一个 RTT 的话手感很差）
    set({
      sessionActionPending: sessionId,
      sessions: get().sessions.map((session) =>
        session.id === sessionId ? { ...session, title: next } : session
      ),
    })
    const result = await cloudApi.updateSession({ sessionId, title: next })
    set({ sessionActionPending: null })
    if (!result.success) {
      set({
        sessions: get().sessions.map((session) =>
          session.id === sessionId ? { ...session, title: current.title } : session
        ),
        sessionsError: result.error ?? 'unknown',
      })
      return false
    }
    if (result.session) applySessionPatch(set, get, result.session)
    return true
  },

  async togglePinned(sessionId) {
    const current = get().sessions.find((session) => session.id === sessionId)
    if (!current) return false
    const pinned = !current.pinned
    set({
      sessionActionPending: sessionId,
      sessions: get().sessions.map((session) =>
        session.id === sessionId ? { ...session, pinned } : session
      ),
    })
    const result = await cloudApi.updateSession({ sessionId, pinned })
    set({ sessionActionPending: null })
    if (!result.success) {
      set({
        sessions: get().sessions.map((session) =>
          session.id === sessionId ? { ...session, pinned: current.pinned } : session
        ),
        sessionsError: result.error ?? 'unknown',
      })
      return false
    }
    if (result.session) applySessionPatch(set, get, result.session)
    return true
  },

  async deleteSession(sessionId) {
    const snapshot = get().sessions
    set({
      sessionActionPending: sessionId,
      sessions: snapshot.filter((session) => session.id !== sessionId),
    })
    const result = await cloudApi.deleteSession(sessionId)
    set({ sessionActionPending: null })
    if (!result.success || result.deleted === false) {
      set({ sessions: snapshot, sessionsError: result.error ?? 'unknown' })
      return false
    }
    if (get().activeSessionId === sessionId) {
      set({
        activeSessionId: null,
        sessionMeta: null,
        parts: [],
        partsError: null,
        runId: null,
        runState: null,
        runError: null,
        pending: null,
      })
    }
    return true
  },

  async openSession(sessionId) {
    // 连点两个会话时，先发的那次可能后回来：用令牌保证只认最后一次
    const token = get().historyToken + 1
    set({
      historyToken: token,
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
    if (get().historyToken !== token) return
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

  async steer() {
    const { draft, runState } = get()
    const text = draft.trim()
    if (!text) return
    // 只有正在执行的一轮能被插话（queued 会被后端拒绝）
    if (runState === null || isTerminalRun(runState)) return
    const id = `local:steer:${crypto.randomUUID()}`
    set({
      draft: '',
      steerError: null,
      parts: upsertPart(get().parts, { type: 'interjection', id, text, delivered: false }),
    })
    const result = await cloudApi.steerRun(text)
    if (!result.success) {
      // 请求都没发出去：撤回这条插话，把文字还回输入框
      set({
        draft: text,
        steerError: result.error ?? 'unknown',
        parts: get().parts.filter((part) => part.id !== id),
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
      const part = frame.part
      // 未送达的插话放回输入框：服务端把没消费掉的 steer 挂在终态上，
      // 用户下一次回车就能发出去，不用重打一遍
      const replay =
        part.type === 'interjection' && part.undelivered && !get().draft.trim() ? part.text : ''
      set({
        parts: upsertPart(get().parts, part),
        ...(replay ? { draft: replay } : {}),
      })
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
    set({ dashboard: { ...get().dashboard, error, loading: error ? false : get().dashboard.loading } })
  },

  settleDashboard() {
    set({ dashboard: { ...get().dashboard, loading: false, error: null } })
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

/** 把主进程返回的最新会话行合回列表，并把当前会话的 meta 一起刷新 */
function applySessionPatch(
  set: (partial: Partial<CloudState>) => void,
  get: () => CloudState,
  session: CloudSession
): void {
  set({
    sessions: get().sessions.map((row) => (row.id === session.id ? session : row)),
  })
  if (get().activeSessionId === session.id) set({ sessionMeta: session })
}

/**
 * 本地搜索：服务端 `title` 参数是「先子串查再精确等值过滤」，
 * 拿不到模糊结果，所以搜索只在已加载的会话里做。
 */
export function filterSessions(sessions: CloudSession[], query: string): CloudSession[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return sessions
  return sessions.filter(
    (session) =>
      session.title.toLowerCase().includes(needle) ||
      session.preview.toLowerCase().includes(needle)
  )
}
