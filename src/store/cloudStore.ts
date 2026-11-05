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
  CloudApprovalChoice,
  CloudApprovalMode,
  CloudApprovalPolicy,
  CloudCapabilities,
  CloudConnectionInfo,
  CloudConnectionState,
  CloudDashboardBounds,
  CloudDashboardState,
  CloudDeviceSummary,
  CloudFrame,
  CloudHandoffPreview,
  CloudRunStatus,
  CloudDiagnostics,
  CloudJob,
  CloudPendingWrite,
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
  /** 收尾确认的失败原因 */
  resolveError: string | null
  resolvingUnknown: boolean
  /** 未结算账本（全部条目，UI 自己过滤待处理项） */
  pendingWrites: CloudPendingWrite[]
  ledgerError: string | null
  /** 定时任务（只读列表 + 三个动作，不给新建 / 删除） */
  jobs: CloudJob[]
  jobsLoading: boolean
  jobsError: string | null
  /** 正在操作的 job id（按钮级 loading） */
  jobActionPending: string | null
  /** 正在提交回答的提问 id */
  clarifyPending: string | null
  clarifyError: string | null
  /** 正在提交的审批请求 id */
  approvalPending: string | null
  approvalError: string | null
  /** 服务端当前生效的审批策略（原生档位；不本地记忆） */
  policy: CloudApprovalPolicy | null
  policyLoading: boolean
  policyError: string | null
  /** 正在切换的档位（分段控件 loading） */
  policyPending: CloudApprovalMode | null
  /** 本机设备身份（连接页设备卡；与云端连接状态无关，没配 token 也有） */
  device: CloudDeviceSummary | null
  deviceBusy: boolean
  deviceError: string | null
  /** 自检结果（连接页折叠区块，按需拉） */
  diagnostics: CloudDiagnostics | null
  diagnosticsLoading: boolean
  diagnosticsError: string | null
  /** 断流后待补的分隔线（校正帧会整体替换 parts，标记留到替换时插入） */
  pendingDisconnect: string | null
  /** 上一个未成功的发送：重试时复用同一个幂等键，避免后端重复执行 */
  pending: { text: string; key: string } | null
  /** 历史拉取的世代号：只接受最后一次请求的结果（连点会话时防串台） */
  historyToken: number

  draft: string
  dashboard: CloudDashboardState
  /** 导入预览（脱敏）：非空时连接页弹预览框 */
  handoffPreview: CloudHandoffPreview | null
  handoffBusy: 'pick' | 'apply' | null
  handoffError: string | null

  hydrate: () => Promise<void>
  saveConfig: (input: { baseUrl: string; apiKey?: string; dashboardToken?: string }) => Promise<boolean>
  pickHandoff: () => Promise<boolean>
  applyHandoff: () => Promise<boolean>
  copyHandoffSecret: () => Promise<boolean>
  clearHandoffPreview: () => void
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
  /** 接回上一轮还在跑的 run（重启 / 断线后）；接上了返回 true */
  attachRun: (sessionId?: string) => Promise<boolean>
  newSession: () => void
  setDraft: (text: string) => void
  send: () => Promise<void>
  steer: () => Promise<void>
  resolveUnknown: () => Promise<boolean>
  loadLedger: () => Promise<void>
  resolveLedger: (id: string, verdict: 'done' | 'missing' | 'ignored') => Promise<boolean>
  noteLedger: (summary: string) => Promise<boolean>
  respondClarify: (promptId: string, answer: string) => Promise<boolean>
  respondApproval: (requestId: string, choice: CloudApprovalChoice) => Promise<boolean>
  /** 本地倒计时归零：卡片置灰（服务端随后按自己的超时拒绝） */
  expireApproval: (requestId: string) => void
  loadPolicy: () => Promise<void>
  setMode: (mode: CloudApprovalMode) => Promise<boolean>
  loadDiagnostics: () => Promise<void>
  loadJobs: () => Promise<void>
  runJob: (jobId: string) => Promise<boolean>
  pauseJob: (jobId: string) => Promise<boolean>
  resumeJob: (jobId: string) => Promise<boolean>
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

  /** 读本机设备身份（顺带补一次系统友好名探测） */
  loadDevice: () => Promise<void>
  /** 改设备名；空串 = 恢复默认名。返回是否成功 */
  setDeviceName: (name: string) => Promise<boolean>
  /** 重新读取系统设备名。返回是否成功 */
  reprobeDeviceName: () => Promise<boolean>
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
  resolveError: null,
  resolvingUnknown: false,
  pendingWrites: [],
  ledgerError: null,
  jobs: [],
  jobsLoading: false,
  jobsError: null,
  jobActionPending: null,
  clarifyPending: null,
  clarifyError: null,
  approvalPending: null,
  approvalError: null,
  policy: null,
  policyLoading: false,
  policyError: null,
  policyPending: null,
  device: null,
  deviceBusy: false,
  deviceError: null,
  diagnostics: null,
  diagnosticsLoading: false,
  diagnosticsError: null,
  pendingDisconnect: null,
  pending: null,
  historyToken: 0,

  draft: '',
  dashboard: EMPTY_DASHBOARD,
  handoffPreview: null,
  handoffBusy: null,
  handoffError: null,

  async hydrate() {
    const bridgeAvailable = hasCloudBridge()
    set({ bridgeAvailable })
    // 设备身份跟连接无关：没配 token 也要能看到「这台设备」
    void get().loadDevice()
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
        void get().loadLedger()
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

  /**
   * 选文件 → 主进程解析 → 只把脱敏预览带回来。
   *
   * 取消选择不算失败（返回 false 但不写 error）。
   */
  async pickHandoff() {
    set({ handoffBusy: 'pick', handoffError: null })
    const result = await cloudApi.pickHandoff()
    if (!result.success) {
      set({ handoffBusy: null, handoffError: result.code ?? result.error ?? 'unknown' })
      return false
    }
    if (result.canceled || !result.preview) {
      set({ handoffBusy: null })
      return false
    }
    set({ handoffBusy: null, handoffPreview: result.preview })
    return true
  },

  /** 应用预览：只传 nonce，写盘与「作废旧连接」都在主进程完成 */
  async applyHandoff() {
    const preview = get().handoffPreview
    if (!preview) return false
    set({ handoffBusy: 'apply', handoffError: null })
    const result = await cloudApi.applyHandoff(preview.applyNonce)
    if (!result.success) {
      set({ handoffBusy: null, handoffError: result.error ?? 'unknown' })
      return false
    }
    if (result.config) set({ config: result.config })
    set({ handoffBusy: null, handoffPreview: null })
    await get().connect()
    return true
  },

  async copyHandoffSecret() {
    const result = await cloudApi.copyHandoffSecret('password')
    return result.success
  },

  clearHandoffPreview() {
    set({ handoffPreview: null, handoffError: null, handoffBusy: null })
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
    if (result.state === 'connected') {
      await get().refreshSessions()
      // 上一轮可能还在服务端跑着：接回来，否则用户得自己重发
      void get().attachRun()
    }
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
      approvalPending: null,
      approvalError: null,
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
    // 打开会话时主进程顺手做了历史复核，这里刷新一次让账本状态跟上
    void get().loadLedger()
    // 这个会话是不是还有一轮在跑（应用重启过 / 断线过）
    void get().attachRun(sessionId)
  },

  async attachRun(sessionId) {
    if (!hasCloudBridge()) return false
    const result = await cloudApi.attachRun(sessionId ? { sessionId } : {})
    if (!result.success || !result.attached) return false
    // 帧会同时从推送频道过来；这里先把状态收窄，避免首帧到达前的空窗被当成空闲
    set({
      runId: result.runId ?? get().runId,
      runState: result.state ?? 'running',
      runError: null,
    })
    return true
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
      approvalPending: null,
      approvalError: null,
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

  /**
   * 收尾一轮「主人进程丢了」的 run。两个凭据由主进程现查，渲染层只递 runId。
   */
  async respondClarify(promptId, answer) {
    const text = answer.trim()
    if (!text) return false
    const part = get().parts.find(
      (item): item is Extract<CloudTracePart, { type: 'clarify' }> =>
        item.type === 'clarify' && item.promptId === promptId
    )
    if (!part || part.settled) return false

    // 乐观写入：卡片立刻显示答案，失败再撤回
    const patch = (next: Partial<typeof part>) =>
      set((state) => ({
        parts: state.parts.map((item) =>
          item.type === 'clarify' && item.promptId === promptId ? { ...item, ...next } : item
        ),
      }))
    set({ clarifyPending: promptId, clarifyError: null })
    patch({ answer: text })

    const result = await cloudApi.respondClarify({
      requestId: promptId,
      generation: part.generation,
      answer: text,
    })
    set({ clarifyPending: null })
    if (!result.success) {
      patch({ answer: undefined })
      set({ clarifyError: result.error ?? 'unknown' })
      return false
    }
    patch({ settled: true })
    return true
  },

  /**
   * 提交审批决定。
   *
   * 乐观写入：卡片立即收折，失败就回退并显示错误。服务端把「已结算 / 代次过期」
   * 回成 409 时，卡片不回退成可点（否则会被重复提交），而是标成已结算。
   */
  async respondApproval(requestId, choice) {
    const { parts, runId, activeSessionId, approvalPending } = get()
    if (approvalPending) return false
    const part = parts.find(
      (item): item is Extract<CloudTracePart, { type: 'approval' }> =>
        item.type === 'approval' && item.requestId === requestId
    )
    if (!part || part.decision || part.settled) return false
    if (part.expiredAt !== undefined && choice !== 'deny') return false

    const effectiveRunId = runId ?? ''
    if (!effectiveRunId) {
      set({ approvalError: '当前没有正在执行的一轮' })
      return false
    }

    const patch = (next: Partial<typeof part>) =>
      set((state) => ({
        parts: state.parts.map((item) =>
          item.type === 'approval' && item.requestId === requestId ? { ...item, ...next } : item
        ),
      }))

    set({ approvalPending: requestId, approvalError: null })
    patch({ decision: choice, decidedAt: Date.now() })

    let result: { success: boolean; error?: string }
    try {
      result = await cloudApi.respondApproval({
        runId: effectiveRunId,
        requestId: part.requestId,
        generation: part.generation,
        choice,
        command: part.command,
        patternKeys: part.patternKeys,
        sessionId: activeSessionId ?? undefined,
      })
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      set({ approvalPending: null })
    }
    if (result.success) return true

    const settledElsewhere = /结算|过期|not_pending|not_active|stale/.test(result.error ?? '')
    if (settledElsewhere) {
      patch({ decision: undefined, decidedAt: undefined, settled: true })
    } else {
      patch({ decision: undefined, decidedAt: undefined })
    }
    set({ approvalError: result.error ?? 'unknown' })
    return false
  },

  /** 本地倒计时归零：卡片置灰（不靠服务端回执，避免重开后又能点） */
  expireApproval(requestId) {
    set((state) => ({
      parts: state.parts.map((item) =>
        item.type === 'approval' && item.requestId === requestId && item.expiredAt === undefined
          ? { ...item, expiredAt: Date.now() }
          : item
      ),
    }))
  },

  /** 读服务端当前策略：只读白名单子集，从不本地缓存旧的档位 */
  async loadPolicy() {
    set({ policyLoading: true, policyError: null })
    try {
      const result = await cloudApi.getPolicy()
      if (!result.success || !result.policy) {
        set({ policyError: result.error ?? 'unknown' })
        return
      }
      set({ policy: result.policy })
    } catch (error) {
      // 兜底：加载态必须收掉，否则控件会永远转圈且点不动
      set({ policyError: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ policyLoading: false })
    }
  },

  /**
   * 切原生档位。写后读回的校验在主进程做，这里只更新显示。
   * 失败时保留旧值（绝不把没生效的档位显示成已生效）。
   */
  async setMode(mode) {
    const previous = get().policy
    if (previous?.mode === mode) return true
    set({ policyPending: mode, policyError: null })
    try {
      const result = await cloudApi.setPolicy(mode)
      if (!result.success || !result.policy) {
        set({ policyError: result.error ?? 'unknown' })
        return false
      }
      set({ policy: result.policy })
      return true
    } catch (error) {
      set({ policyError: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      set({ policyPending: null })
    }
  },

  async loadDiagnostics() {
    set({ diagnosticsLoading: true, diagnosticsError: null })
    const result = await cloudApi.diagnostics()
    if (!result.success || !result.diagnostics) {
      set({ diagnosticsLoading: false, diagnosticsError: result.error ?? 'unknown' })
      return
    }
    set({ diagnostics: result.diagnostics, diagnosticsLoading: false })
  },

  async loadJobs() {
    set({ jobsLoading: true, jobsError: null })
    const result = await cloudApi.listJobs()
    if (!result.success) {
      set({ jobsLoading: false, jobsError: result.error ?? 'unknown' })
      return
    }
    set({ jobs: result.jobs, jobsLoading: false })
  },

  async runJob(jobId) {
    set({ jobActionPending: jobId, jobsError: null })
    const result = await cloudApi.runJob(jobId)
    set({ jobActionPending: null })
    if (!result.success) {
      set({ jobsError: result.error ?? 'unknown' })
      return false
    }
    await get().loadJobs()
    return true
  },

  async pauseJob(jobId) {
    set({ jobActionPending: jobId, jobsError: null })
    const result = await cloudApi.pauseJob(jobId)
    set({ jobActionPending: null })
    if (!result.success) {
      set({ jobsError: result.error ?? 'unknown' })
      return false
    }
    await get().loadJobs()
    return true
  },

  async resumeJob(jobId) {
    set({ jobActionPending: jobId, jobsError: null })
    const result = await cloudApi.resumeJob(jobId)
    set({ jobActionPending: null })
    if (!result.success) {
      set({ jobsError: result.error ?? 'unknown' })
      return false
    }
    await get().loadJobs()
    return true
  },

  async loadLedger() {
    const result = await cloudApi.listLedger()
    if (!result.success) {
      set({ ledgerError: result.error ?? 'unknown' })
      return
    }
    set({ pendingWrites: result.entries, ledgerError: null })
  },

  async resolveLedger(id, verdict) {
    const result = await cloudApi.resolveLedger({ id, verdict })
    if (!result.success) {
      set({ ledgerError: result.error ?? 'unknown' })
      return false
    }
    set({ pendingWrites: result.entries, ledgerError: null })
    return true
  },

  async noteLedger(summary) {
    const text = summary.trim()
    if (!text) return false
    const result = await cloudApi.noteLedger({
      summary: text,
      sessionId: get().activeSessionId ?? undefined,
    })
    if (!result.success) {
      set({ ledgerError: result.error ?? 'unknown' })
      return false
    }
    set({ pendingWrites: result.entries, ledgerError: null })
    return true
  },

  async resolveUnknown() {
    const { runId, runState, resolvingUnknown } = get()
    if (!runId || runState !== 'unknown' || resolvingUnknown) return false
    set({ resolvingUnknown: true, resolveError: null })
    const result = await cloudApi.resolveUnknownRun(runId)
    if (!result.success) {
      set({ resolvingUnknown: false, resolveError: result.error ?? 'unknown' })
      return false
    }
    set({ resolvingUnknown: false, runState: result.state ?? 'cancelled' })
    return true
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
      const settling = isTerminalRun(frame.state)
      set({ runId: frame.runId, runState: frame.state, runError: frame.error ?? null })
      // 终态时账本刚从 pending 变 unknown，拉一次让提示条准确
      if (settling) void get().loadLedger()
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

  async loadDevice() {
    const result = await cloudApi.getDevice()
    if (result.success && result.device) {
      set({ device: result.device, deviceError: null })
      return
    }
    set({ deviceError: result.error ?? 'unknown' })
  },

  async setDeviceName(name) {
    set({ deviceBusy: true, deviceError: null })
    const result = await cloudApi.setDeviceName(name)
    set({ deviceBusy: false })
    if (!result.success || !result.device) {
      set({ deviceError: result.error ?? 'unknown' })
      return false
    }
    set({ device: result.device })
    return true
  },

  async reprobeDeviceName() {
    set({ deviceBusy: true, deviceError: null })
    const result = await cloudApi.reprobeDeviceName()
    set({ deviceBusy: false })
    if (!result.success || !result.device) {
      set({ deviceError: result.error ?? 'unknown' })
      return false
    }
    set({ device: result.device })
    return true
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
