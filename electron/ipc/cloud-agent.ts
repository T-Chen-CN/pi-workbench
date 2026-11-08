/** 云端 Agent 的 IPC：配置、会话、run 生命周期、程序内控制台 */

import { app, dialog, type BrowserWindow } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { handleIpc } from './register.js'
import {
  normalizeBaseUrl,
  deriveDashboardUrl,
  publicCloudConfig,
  readCloudConfig,
  writeCloudConfig,
  cloudTransport,
  clearDeviceCredentials,
  pruneUnknownCloudConfig
} from '../cloud/config.js'
import { CloudApiError, cloudErrorMessage, createCloudClient, type CloudClient } from '../cloud/client.js'
import { CloudRunner } from '../cloud/runner.js'
import { CloudDashboard } from '../cloud/dashboard.js'
import { createMediaClient, parseImageDataUrl } from '../cloud/media.js'
import {
  gatewayHealth,
  gatewayStatus,
  gatewayWhoAmI,
  heartbeatDevice,
  pairDevice,
  revokeDevice,
} from '../cloud/gateway.js'
import {
  applyVerdict,
  classifyToolWrite,
  makeWriteEntry,
  mutateLedger,
  readLedger,
  reconcileWithHistory,
  recordCompleted,
  recordStarted,
  settleRun
} from '../cloud/ledger.js'
import { createRemote, toRunStatus } from '../cloud/remote.js'
import { clearActiveRun, readActiveRun, writeActiveRun } from '../cloud/active-run.js'
import { startHeartbeat } from '../cloud/heartbeat.js'
import {
  deviceSummary,
  ensureDeviceNameProbe,
  readCloudDevice,
  recordSessionDevice,
  reprobeDeviceName,
  updateCloudDeviceName
} from '../cloud/device.js'
import { recordApprovalDecision, recordModeChange } from '../cloud/audit.js'
import {
  notificationCopy,
  notificationSummary,
  type SessionNotification
} from '../notifications.js'
import {
  isApprovalMode,
  readApprovalPolicy,
  writeApprovalMode
} from '../cloud/policy.js'
import { cloudExportFileName, renderCloudExport } from '../cloud/export.js'
import type {
  CloudApprovalChoice,
  CloudApprovalMode,
  CloudCapabilities,
  CloudConnectionState,
  CloudPairErrorCode,
  CloudPendingWrite
} from '../cloud/types.js'

interface LoggerLike {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface CloudAgentIpcDeps {
  getMainWindow: () => BrowserWindow | null
  logger?: LoggerLike
  /** 通知文案跟随应用语言（缺省中文），与本地 Agent 同一份 copy */
  getLanguage?: () => string | undefined
  /** 桌面通知出口：路由自己会判前台 / 开关 / 退出，这里只负责构造事件 */
  notify?: (event: SessionNotification) => boolean
}

const DASHBOARD_CLOSED_EVENT = 'cloud:dashboard:closed'

/**
 * 最近一次从服务端读到的档位：**只用于审计留痕**。
 *
 * 审批回执之后不能再去读配置（`tool.completed` 会在那次往返期间到达，结果行就配
 * 不上了），所以决定行用这个缓存值；档位本身的显示永远走 `cloud:policy:get`。
 */
let cachedPolicyMode: CloudApprovalMode | null = null

export function registerCloudAgentIpc(deps: CloudAgentIpcDeps): {
  dispose: () => void
} {
  const logger = deps.logger
  let client: CloudClient | null = null
  let clientKey = ''
  let runner: CloudRunner | null = null
  /** 心跳：配对后每 30s 一拍，让云端知道这台机器还开着（H2-1） */
  const heartbeat = startHeartbeat({
    credential: () => {
      // 这个模块在 app ready 之前就被装配了；此时 safeStorage 还不能解密，
      // 读配置会报错并刷日志 —— 没 ready 就当「没有凭据」，ready 后再 poke。
      if (!app.isReady()) return null
      const config = readCloudConfig()
      if (!config.hasDeviceToken) return null
      return { gatewayUrl: config.gatewayUrl, deviceToken: config.deviceToken }
    },
    beat: ({ gatewayUrl, deviceToken }) => heartbeatDevice({ gatewayUrl, deviceToken }),
    onState: (state) => send('cloud:gateway:heartbeat', state),
    onRevoked: (reason) => {
      logger?.warn('[Cloud] heartbeat stopped: credentials revoked', reason)
      send('cloud:gateway:revoked', { reason })
    }
  })
  // ready 之后补一拍：启动那一刻还没有 safeStorage，凭据读不出来
  void app.whenReady().then(() => heartbeat.poke())
  let capabilities: CloudCapabilities | null = null
  let hookedWindow: BrowserWindow | null = null

  const send = (channel: string, payload: unknown): void => {
    const win = deps.getMainWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  /**
   * 当前轮：账本需要 runId / sessionId，而工具帧本身不带。
   * `unknown` 这类"没能收尾"的轮次也要能对应上，所以用最近一次的 start 结果兜底。
   */
  let activeRun: { runId: string; sessionId: string | null } | null = null

  /**
   * 只观测**实时**帧：`kind:'parts'` 是历史校正，里面的工具早已结束，
   * 从那里记账只会把陈年旧账翻出来。
   */
  function observeForLedger(frame: unknown): void {
    const value = frame as {
      kind?: string
      runId?: string
      state?: string
      sessionId?: string
      part?: {
        type?: string
        toolCallId?: string
        toolName?: string
        argsSummary?: string
        status?: string
      }
    }
    try {
      if (value.kind === 'session' && typeof value.sessionId === 'string') {
        if (activeRun) activeRun.sessionId = value.sessionId
        return
      }
      if (value.kind === 'run') {
        const state = value.state
        if (state === 'completed' || state === 'failed' || state === 'cancelled') {
          const runId = value.runId ?? activeRun?.runId
          if (runId) mutateLedger((entries) => settleRun(entries, runId))
          if (activeRun && (!value.runId || value.runId === activeRun.runId)) activeRun = null
        }
        return
      }
      if (value.kind !== 'part') return
      const part = value.part
      if (!part || part.type !== 'tool' || !part.toolCallId) return
      const runId = activeRun?.runId
      if (!runId) return
      if (part.status === 'running') {
        const writeClass = classifyToolWrite({
          toolName: String(part.toolName ?? ''),
          summary: String(part.argsSummary ?? '')
        })
        if (!writeClass) return
        const entry = makeWriteEntry({
          runId,
          sessionId: activeRun?.sessionId ?? null,
          toolCallId: part.toolCallId,
          toolName: String(part.toolName ?? ''),
          summary: String(part.argsSummary ?? ''),
          writeClass
        })
        mutateLedger((entries) => recordStarted(entries, entry))
        return
      }
      // success / error：结账
      mutateLedger((entries) =>
        recordCompleted(entries, runId, String(part.toolCallId), part.status !== 'error')
      )
    } catch (error) {
      logger?.warn('[Cloud] ledger observe failed', error)
    }
  }

  /**
   * 通知去重：同一张审批卡 / 同一轮的终态只发一条。
   * SSE 会重订阅、历史会重放，而系统通知重复弹出来比不弹更扰民。
   */
  const notifiedApprovals = new Set<string>()
  const notifiedRuns = new Set<string>()
  /** 帧里不总是带 sessionId：先记最近一次看到的，点击通知才有地方落 */
  let notifySessionId = ''
  /** 最近一段助手正文：终态通知的正文用它，空正文时就不写 */
  let lastReply = ''

  function rememberNoticeKey(bucket: Set<string>, key: string): boolean {
    if (bucket.has(key)) return false
    // 无界增长在长跑的机器上没意义：只挡重复，不需要历史
    if (bucket.size > 500) bucket.clear()
    bucket.add(key)
    return true
  }

  function postNotification(event: {
    kind: 'approval' | 'complete' | 'error'
    title: string
    body: string
    requestId?: string
  }): void {
    if (!deps.notify) return
    deps.notify({
      kind: event.kind,
      title: event.title,
      body: event.body,
      // 云端会话没有工作区：点击后只能切到云端页，不能去开同名目录
      workspaceDir: null,
      sessionId: notifySessionId || activeRun?.sessionId || '',
      cloud: true,
      requestId: event.requestId
    })
  }

  /**
   * 通知只跟**实时**帧：`kind:'parts'` 是历史校正，里面的审批早就结算了，
   * 拿它通知就是把陈年卡当新请求推给用户。
   */
  function observeForNotify(frame: unknown): void {
    if (!deps.notify) return
    const value = frame as {
      kind?: string
      runId?: string
      state?: string
      sessionId?: string
      /** 终态帧里的失败原因：上通知正文，不解锁屏也知道为什么挂的 */
      error?: string
      part?: {
        type?: string
        role?: string
        text?: string
        requestId?: string
        promptId?: string
        question?: string
        command?: string
        decision?: string
        answer?: string
        settled?: boolean
        expiredAt?: number
      }
    }
    try {
      if (value.kind === 'session' && typeof value.sessionId === 'string') {
        notifySessionId = value.sessionId
        return
      }
      if (value.kind === 'run') {
        const state = value.state
        const runId = value.runId || activeRun?.runId || ''
        if (!runId) return
        // 自己点的停止不通知：那是用户已经知道的结果
        if (state === 'failed' || state === 'interrupted' || state === 'completed') {
          if (!rememberNoticeKey(notifiedRuns, runId)) return
          const text = notificationCopy(deps.getLanguage?.())
          postNotification({
            kind: state === 'completed' ? 'complete' : 'error',
            title: state === 'completed' ? text.cloudComplete : text.cloudError,
            body:
              state === 'completed'
                ? notificationSummary(lastReply)
                : notificationSummary(String(value.error ?? ''))
          })
        }
        return
      }
      if (value.kind !== 'part') return
      const part = value.part
      if (!part) return
      if (part.type === 'text' && part.role === 'assistant' && typeof part.text === 'string') {
        lastReply = part.text
        return
      }
      // 审批 / 澄清才是“这轮卡住了”：没填 decision、没 settled、没超时才值得弹
      const pending =
        part.decision === undefined && part.settled !== true && part.expiredAt === undefined
      if (!pending) return
      const text = notificationCopy(deps.getLanguage?.())
      if (part.type === 'approval' && typeof part.requestId === 'string' && part.requestId) {
        if (!rememberNoticeKey(notifiedApprovals, `ap:${part.requestId}`)) return
        postNotification({
          kind: 'approval',
          title: text.cloudApproval,
          body: notificationSummary(String(part.command ?? '')),
          requestId: part.requestId
        })
        return
      }
      if (part.type === 'clarify' && typeof part.promptId === 'string' && part.promptId) {
        if (!rememberNoticeKey(notifiedApprovals, `cl:${part.promptId}`)) return
        postNotification({
          kind: 'approval',
          title: text.cloudClarify,
          body: notificationSummary(String(part.question ?? '')),
          requestId: part.promptId
        })
      }
    } catch (error) {
      logger?.warn('[Cloud] notify observe failed', error)
    }
  }

  const dashboard = new CloudDashboard({
    getWindow: () => deps.getMainWindow(),
    onLoadFailed: (payload) => send('cloud:dashboard:load-failed', payload),
    onLoadSettled: () => send('cloud:dashboard:loaded', {}),
    onRequestClose: () => {
      dashboard.close()
      send(DASHBOARD_CLOSED_EVENT, { reason: 'escape' })
    },
    getAllowedUrl: () => readCloudConfig().dashboardUrl
  })

  function clientKeyFor(transport: { baseUrl: string; credential: string }): string {
    return `${normalizeBaseUrl(transport.baseUrl)}|${transport.credential}`
  }

  /** 配置变了就重建客户端与 runner（避免旧密钥/旧地址残留） */
  function ensureClient(): CloudClient {
    const config = readCloudConfig()
    const transport = cloudTransport(config)
    if (!transport.credential) {
      throw new CloudApiError(
        'unauthorized',
        config.hasDeviceToken
          ? '设备 token 丢失，请在「连接」页重新配对这台设备'
          : '还没有配对这台设备，请先在「连接」页用连接码配对'
      )
    }
    const key = clientKeyFor(transport)
    if (client && key === clientKey) return client
    runner?.dispose()
    client = createCloudClient({ baseUrl: transport.baseUrl, credential: transport.credential })
    runner = new CloudRunner(
      {
        emit: (frame) => {
          observeForLedger(frame)
          observeForNotify(frame)
          send('cloud:event', frame)
        },
        log: (message, error) => logger?.warn(message, error ?? ''),
        // 这一轮结束了：跨重启接回的记录用完即弃
        onRunSettled: (runId) => clearActiveRun(runId)
      },
      client
    )
    clientKey = key
    return client
  }

  function ensureRunner(): CloudRunner {
    ensureClient()
    if (!runner) throw new CloudApiError('unknown', '云端运行器没有初始化')
    return runner
  }

  function hookWindow(): void {
    const win = deps.getMainWindow()
    if (!win || win === hookedWindow) return
    hookedWindow = win
    win.on('minimize', () => dashboard.hide())
    win.on('hide', () => dashboard.hide())
    // 窗口回来只恢复「页面最后要求的状态」：控制台不在前台时它连窗口都没挂着，
    // 托盘唤回 / 通知点击 / 第二实例都不可能把它糊到当前页面上
    win.on('restore', () => dashboard.sync())
    win.on('show', () => dashboard.sync())
    win.on('closed', () => dashboard.destroy())
  }

  const fail = (error: unknown): { success: false; error: string } => ({
    success: false,
    error: cloudErrorMessage(error)
  })

  handleIpc('cloud:config:get', () => {
    // 旧版本留下的字段（baseUrl / apiKey / 管理密钥 / 控制台口令 / 旧凭证记录）顺手清掉
    pruneUnknownCloudConfig()
    const config = publicCloudConfig()
    return { success: true, config }
  })

  handleIpc('cloud:connect', async () => {
    try {
      const active = ensureClient()
      const remote = createRemote(active)
      capabilities = await remote.capabilities()
      logger?.info('[Cloud] connected', capabilities.model ?? '')
      return { success: true, state: 'connected' as CloudConnectionState, capabilities }
    } catch (error) {
      logger?.warn('[Cloud] connect failed', cloudErrorMessage(error))
      const state: CloudConnectionState =
        error instanceof CloudApiError && error.code === 'unauthorized' ? 'unconfigured' : 'error'
      return { success: false, state, error: cloudErrorMessage(error), capabilities }
    }
  })

  // 「断开连接」= 真正断开：丢掉主进程里的客户端，同时清掉盘上的密钥
  handleIpc('cloud:disconnect', () => {
    runner?.dispose()
    runner = null
    client = null
    clientKey = ''
    capabilities = null
    dashboard.close()
    clearDeviceCredentials()
    send('cloud:status', { state: 'unconfigured', error: null, capabilities: null })
    return { success: true }
  })

  handleIpc('cloud:sessions:list', async (_event, input: { limit?: number; offset?: number }) => {
    try {
      const remote = createRemote(ensureClient())
      const result = await remote.listSessions(input ?? {})
      return { success: true, ...result }
    } catch (error) {
      return fail(error)
    }
  })

  handleIpc(
    'cloud:sessions:update',
    async (_event, input: { sessionId?: string; title?: string; pinned?: boolean }) => {
      const sessionId = String(input?.sessionId ?? '')
      if (!sessionId) return { success: false, error: '缺少 sessionId' }
      try {
        const remote = createRemote(ensureClient())
        const session = await remote.updateSession({
          sessionId,
          title: typeof input?.title === 'string' ? input.title : undefined,
          pinned: typeof input?.pinned === 'boolean' ? input.pinned : undefined
        })
        return { success: true, session }
      } catch (error) {
        return fail(error)
      }
    }
  )

  handleIpc('cloud:sessions:delete', async (_event, input: { sessionId?: string }) => {
    const sessionId = String(input?.sessionId ?? '')
    if (!sessionId) return { success: false, error: '缺少 sessionId' }
    try {
      const remote = createRemote(ensureClient())
      const deleted = await remote.deleteSession(sessionId)
      return { success: true, deleted }
    } catch (error) {
      return fail(error)
    }
  })

  handleIpc(
    'cloud:clarify:respond',
    async (_event, input: { requestId?: string; generation?: number; answer?: string }) => {
      const requestId = String(input?.requestId ?? '')
      const answer = String(input?.answer ?? '')
      if (!requestId) return { success: false as const, error: '缺少提问 id' }
      if (!answer.trim()) return { success: false as const, error: '回答不能为空' }
      const generation = Number(input?.generation)
      if (!Number.isInteger(generation)) return { success: false as const, error: '缺少轮次代号' }
      const runId = runner?.activeRunId ?? null
      if (!runId) return { success: false as const, error: '当前没有正在执行的一轮' }
      try {
        await createRemote(ensureClient()).clarifyRun({ runId, requestId, generation, answer })
        return { success: true as const }
      } catch (error) {
        return fail(error)
      }
    }
  )

  /**
   * 提交审批决定。
   *
   * 只接受 once / session / deny（`always` 会写服务端永久白名单，S-08 禁止），
   * 并在同一次调用里写一条审计（决定行）；结果行由 runner 在下一个终态工具卡上补。
   */
  handleIpc(
    'cloud:approval:respond',
    async (
      _event,
      input: {
        runId?: string
        requestId?: string
        generation?: number
        choice?: string
        command?: string
        patternKeys?: string[]
        sessionId?: string
      }
    ) => {
      const choice = String(input?.choice ?? '')
      if (choice !== 'once' && choice !== 'session' && choice !== 'deny') {
        return { success: false as const, error: '审批选项只能是 once / session / deny' }
      }
      const runId = String(input?.runId ?? '') || (runner?.activeRunId ?? '')
      if (!runId) return { success: false as const, error: '当前没有正在执行的一轮' }
      const requestId = String(input?.requestId ?? '')
      const rawGeneration = Number(input?.generation)
      let generation = Number.isInteger(rawGeneration) ? rawGeneration : undefined

      try {
        const remote = createRemote(ensureClient())
        // 服务端（0.22.6）要求三个字段齐全：缺代次就从轮次状态里取一次
        if (generation === undefined) {
          generation = (await remote.runStatus(runId)).executionGeneration
        }
        if (!requestId || generation === undefined) {
          return {
            success: false as const,
            error: '这条审批缺请求标识或轮次代次，刷新会话后重试',
          }
        }
        await remote.respondApproval({
          runId,
          requestId,
          generation,
          choice: choice as CloudApprovalChoice,
        })
        // 审计必须**立刻**写：这里不能再做任何网络往返 —— 服务端紧接着就会推
        // tool.completed，结果行要能配对上；先读一遍策略（一次 HTTP GET）就会输掉这场赛跑。
        recordApprovalDecision({
          runId,
          sessionId: input?.sessionId ?? null,
          command: String(input?.command ?? ''),
          patternKeys: Array.isArray(input?.patternKeys) ? input.patternKeys : [],
          choice: choice as CloudApprovalChoice,
          mode: cachedPolicyMode,
          toolCallId: runner?.approvalToolCallId(requestId),
          device: deviceSummary(),
        })
        // 档位只用于留痕：异步刷新缓存，失败无所谓（下一次读会补）
        void readApprovalPolicy()
          .then((policy) => {
            cachedPolicyMode = policy.mode
          })
          .catch(() => {})
        return { success: true as const, choice }
      } catch (error) {
        logger?.warn('[Cloud] approval respond failed', cloudErrorMessage(error))
        return fail(error)
      }
    }
  )

  /**
   * 本机设备身份。
   *
   * `get` 顺带补一次系统友好名探测（macOS `ComputerName` / Linux `hostnamectl --pretty`）：
   * 只在打开连接页时跑，且用户改过名就一个字都不动。
   */
  handleIpc('cloud:device:get', async () => {
    try {
      const record = await ensureDeviceNameProbe()
      return { success: true as const, device: deviceSummary(record) }
    } catch (error) {
      logger?.warn('[Cloud] device read failed', error)
      return { success: false as const, error: '读取设备身份失败' }
    }
  })

  /**
   * 重新读取系统设备名。自动探测只做一次（默认名一旦取到就封存，避免系统改名让云端
   * 看到的设备名无声变化），所以「跟随系统改名」必须由用户显式点这一下。
   */
  handleIpc('cloud:device:reprobe', async () => {
    try {
      const record = await reprobeDeviceName()
      return { success: true as const, device: deviceSummary(record) }
    } catch (error) {
      logger?.warn('[Cloud] device reprobe failed', error)
      return { success: false as const, error: '读取系统设备名失败' }
    }
  })

  /** 改设备名。空字符串 = 恢复系统默认名。 */
  handleIpc('cloud:device:set', (_event, input: { name?: string }) => {
    try {
      const record = updateCloudDeviceName(input?.name ?? '')
      return { success: true as const, device: deviceSummary(record) }
    } catch (error) {
      logger?.warn('[Cloud] device rename failed', error)
      return { success: false as const, error: '保存设备名失败' }
    }
  })

  /**
   * 网关（云端单入口）三件事：看状态、配对这台设备、注销这台设备。
   *
   * 配对是**设备身份的唯一诞生点**：一次性连接码换 token，token 用 safeStorage
   * 存起来，之后所有请求（含图片上传）只带它。`deviceId` 用本地 `device.json`
   * 里那个只读 id，网关侧与 `author.id` 因此是同一个身份。
   */
  handleIpc('cloud:gateway:status', async () => {
    const config = readCloudConfig()
    const device = readCloudDevice()
    const base = {
      gatewayUrl: config.gatewayUrl,
      device: deviceSummary(device),
      // 心跳状态也放在状态里：页面重开 / 错过了推送时还能看到「已被注销」
      heartbeat: heartbeat.state()
    }
    if (!config.hasDeviceToken) {
      return { success: true as const, registered: false as const, ...base }
    }
    try {
      const [me, detailed] = await Promise.all([
        gatewayWhoAmI(config.gatewayUrl, config.deviceToken),
        // 新版插件有完整诊断；旧插件没有这条路由（404）→ 回退到瘦身版 health
        gatewayStatus(config.gatewayUrl, config.deviceToken).catch(() => null)
      ])
      const health = detailed ? null : await gatewayHealth(config.gatewayUrl).catch(() => null)
      return {
        success: true as const,
        registered: true as const,
        ...base,
        deviceId: me.deviceId,
        name: me.name,
        scopes: me.scopes,
        hub: me.hub,
        online: detailed ? (detailed.upstreamOk ?? null) : (health?.upstreamOk ?? null),
        upstream: detailed?.upstream ?? health?.upstream ?? '',
        upstreamVersion: detailed?.upstreamVersion ?? health?.upstreamVersion ?? '',
        devices: detailed?.devices ?? health?.devices ?? null
      }
    } catch (error) {
      logger?.warn('[Cloud] gateway status failed', cloudErrorMessage(error))
      return {
        success: true as const,
        registered: false as const,
        ...base,
        error: cloudErrorMessage(error)
      }
    }
  })

  const PAIR_ERROR_CODES: CloudPairErrorCode[] = [
    'pairing_not_found',
    'pairing_expired',
    'pairing_used',
    'rate_limited',
    'pairing_disabled',
    'pairing_unsupported'
  ]
  const pairErrorCode = (error: unknown): CloudPairErrorCode | undefined => {
    if (!(error instanceof CloudApiError)) return undefined
    return PAIR_ERROR_CODES.find((code) => code === error.backendCode)
  }

  /**
   * 用一次性连接码配对这台设备。
   *
   * 连接码是这一次唯一的授权：请求不带管理密钥，也不带设备 token。
   * 失败时**不写盘**，旧配置（包括原有 token）保持不动。
   */
  handleIpc(
    'cloud:gateway:pair',
    async (
      _event,
      input: { code?: string; gatewayUrl?: string; name?: string }
    ) => {
      const config = readCloudConfig()
      const code = String(input?.code ?? '').trim()
      if (!code) {
        return { success: false as const, error: '请填写连接码' }
      }
      const gatewayUrl = String(input?.gatewayUrl ?? '').trim() || config.gatewayUrl
      const record = readCloudDevice()
      const name = String(input?.name ?? '').trim() || record.name
      try {
        const result = await pairDevice({
          gatewayUrl,
          code,
          deviceId: record.id,
          name
        })
        const nextDashboardUrl =
          normalizeBaseUrl(result.dashboardUrl ?? '') ||
          (normalizeBaseUrl(gatewayUrl) === normalizeBaseUrl(config.gatewayUrl)
            ? config.dashboardUrl
            : deriveDashboardUrl(gatewayUrl))
        const saved = writeCloudConfig({
          gatewayUrl,
          dashboardUrl: nextDashboardUrl,
          deviceToken: result.token,
          deviceScopes: result.scopes,
          deviceId: result.deviceId
        })
        client = null
        clientKey = ''
        runner?.dispose()
        runner = null
        capabilities = null
        // 换了一台网关：上一台的 run 记录接不回来
        if (normalizeBaseUrl(gatewayUrl) !== normalizeBaseUrl(config.gatewayUrl)) {
          clearActiveRun()
        }
        heartbeat.poke() // 新 token 立刻跳一拍：云端马上看到「在线」
        logger?.info(
          `[Cloud] device paired name=${result.name} prefix=${result.tokenPrefix} scopes=${result.scopes.join('+')}`
        )
        return {
          success: true as const,
          config: publicCloudConfig(saved),
          tokenPrefix: result.tokenPrefix,
          name: result.name
        }
      } catch (error) {
        logger?.warn('[Cloud] device pair failed', cloudErrorMessage(error))
        return {
          success: false as const,
          code: pairErrorCode(error),
          error: cloudErrorMessage(error)
        }
      }
    }
  )

  /** 注销这台设备：token 立即失效；本地同时清掉 token（要重新配对才能用）。 */
  handleIpc('cloud:gateway:revoke', async () => {
    const config = readCloudConfig()
    if (!config.hasDeviceToken) {
      return { success: false as const, error: '这台设备还没配对' }
    }
    try {
      await revokeDevice({
        gatewayUrl: config.gatewayUrl,
        deviceId: config.deviceId || readCloudDevice().id,
        deviceToken: config.deviceToken
      })
      // 注销：只清设备凭据，网关地址留着显示（本地没有别的凭据可退）
      clearDeviceCredentials()
      heartbeat.stop() // 没凭据了，别再往云端打 401
      client = null
      runner?.dispose()
      runner = null
      capabilities = null
      return { success: true as const }
    } catch (error) {
      logger?.warn('[Cloud] device revoke failed', cloudErrorMessage(error))
      return { success: false as const, error: cloudErrorMessage(error) }
    }
  })

  handleIpc('cloud:policy:get', async () => {
    try {
      const policy = await readApprovalPolicy()
      cachedPolicyMode = policy.mode
      return { success: true as const, policy }
    } catch (error) {
      logger?.warn('[Cloud] policy read failed', cloudErrorMessage(error))
      return fail(error)
    }
  })

  handleIpc('cloud:policy:set', async (_event, input: { mode?: string }) => {
    const mode = String(input?.mode ?? '')
    if (!isApprovalMode(mode)) {
      return { success: false as const, error: `不支持的审批档位：${mode}` }
    }
    try {
      const before = await readApprovalPolicy()
      const policy = await writeApprovalMode(mode)
      cachedPolicyMode = policy.mode
      if (before.mode !== policy.mode) recordModeChange(before.mode, policy.mode)
      return { success: true as const, policy }
    } catch (error) {
      logger?.warn('[Cloud] policy write failed', cloudErrorMessage(error))
      return fail(error)
    }
  })

  handleIpc('cloud:diagnostics', async () => {
    try {
      const diagnostics = await createRemote(ensureClient()).diagnostics()
      return { success: true as const, diagnostics }
    } catch (error) {
      return fail(error)
    }
  })

  handleIpc('cloud:jobs:list', async () => {
    try {
      const remote = createRemote(ensureClient())
      const jobs = await remote.listJobs()
      return { success: true as const, jobs }
    } catch (error) {
      return fail(error)
    }
  })

  /**
   * 新建定时任务。
   *
   * 三条必填在本地先拦：服务端把空白名 / 缺调度当 400 回，但那句话是英文且不含字段名，
   * 让用户对着表单猜很不划算。上限与服务端常量一致（名 ≤ 200、提示词 ≤ 5000）。
   */
  handleIpc(
    'cloud:jobs:create',
    async (
      _event,
      input: { name?: string; schedule?: string; prompt?: string; repeat?: number }
    ) => {
      const name = String(input?.name ?? '').trim()
      const schedule = String(input?.schedule ?? '').trim()
      const prompt = String(input?.prompt ?? '').trim()
      if (!name) return { success: false as const, error: '任务名不能为空' }
      if (!schedule) return { success: false as const, error: '调度表达式不能为空' }
      if (!prompt) return { success: false as const, error: '提示词不能为空' }
      if (name.length > 200) return { success: false as const, error: '任务名最多 200 个字符' }
      if (prompt.length > 5000) return { success: false as const, error: '提示词最多 5000 个字符' }
      const repeat = Number(input?.repeat)
      if (input?.repeat !== undefined && input?.repeat !== null && !(Number.isInteger(repeat) && repeat > 0)) {
        return { success: false as const, error: '「最多跑几次」要么留空，要么填正整数' }
      }
      try {
        const job = await createRemote(ensureClient()).createJob({
          name,
          schedule,
          prompt,
          ...(Number.isInteger(repeat) && repeat > 0 ? { repeat } : {}),
        })
        return { success: true as const, job }
      } catch (error) {
        return fail(error)
      }
    }
  )

  handleIpc('cloud:jobs:run', async (_event, input: { jobId?: string }) => {
    const jobId = String(input?.jobId ?? '')
    if (!jobId) return { success: false as const, error: '缺少任务 id' }
    try {
      await createRemote(ensureClient()).runJob(jobId)
      return { success: true as const }
    } catch (error) {
      return fail(error)
    }
  })

  handleIpc('cloud:jobs:pause', async (_event, input: { jobId?: string }) => {
    const jobId = String(input?.jobId ?? '')
    if (!jobId) return { success: false as const, error: '缺少任务 id' }
    try {
      await createRemote(ensureClient()).pauseJob(jobId)
      return { success: true as const }
    } catch (error) {
      return fail(error)
    }
  })

  handleIpc('cloud:jobs:resume', async (_event, input: { jobId?: string }) => {
    const jobId = String(input?.jobId ?? '')
    if (!jobId) return { success: false as const, error: '缺少任务 id' }
    try {
      await createRemote(ensureClient()).resumeJob(jobId)
      return { success: true as const }
    } catch (error) {
      return fail(error)
    }
  })

  handleIpc('cloud:ledger:list', () => {
    try {
      return { success: true as const, entries: readLedger() }
    } catch (error) {
      logger?.warn('[Cloud] ledger read failed', error)
      return fail(error)
    }
  })

  handleIpc(
    'cloud:ledger:resolve',
    (_event, input: { id?: string; verdict?: string }) => {
      const id = String(input?.id ?? '')
      const verdict = String(input?.verdict ?? '')
      if (!id) return { success: false as const, error: '缺少条目 id' }
      if (verdict !== 'done' && verdict !== 'missing' && verdict !== 'ignored') {
        return { success: false as const, error: '未知的核对结论' }
      }
      try {
        const entries = mutateLedger((list) => applyVerdict(list, id, verdict))
        return { success: true as const, entries }
      } catch (error) {
        logger?.warn('[Cloud] ledger resolve failed', error)
        return fail(error)
      }
    }
  )

  handleIpc(
    'cloud:ledger:note',
    (_event, input: { summary?: string; writeClass?: string; sessionId?: string }) => {
      const summary = String(input?.summary ?? '').trim()
      if (!summary) return { success: false as const, error: '没有内容' }
      const writeClass =
        input?.writeClass === 'system' || input?.writeClass === 'irreversible'
          ? input.writeClass
          : 'external'
      try {
        const entry: CloudPendingWrite = {
          id: `note:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          runId: 'manual',
          sessionId: input?.sessionId ? String(input.sessionId) : null,
          toolName: 'manual',
          writeClass,
          summary: summary.slice(0, 300),
          startedAt: Date.now(),
          status: 'unknown'
        }
        const entries = mutateLedger((list) => [entry, ...list])
        return { success: true as const, entries }
      } catch (error) {
        logger?.warn('[Cloud] ledger note failed', error)
        return fail(error)
      }
    }
  )

  handleIpc('cloud:media:upload', async (_event, input: { dataUrl?: string; filename?: string }) => {
    const dataUrl = String(input?.dataUrl ?? '')
    if (!dataUrl) return { success: false as const, error: '没有图片数据' }
    const config = readCloudConfig()
    const transport = cloudTransport(config)
    if (!transport.credential) {
      // 单入口：上传凭据就是设备 token，没有第二条路
      return { success: false as const, error: '这台设备还没有配对，先在「连接」页配对' }
    }
    try {
      // 本地先校验类型与体积，省一次注定失败的往返
      parseImageDataUrl(dataUrl)
      const client = createMediaClient({
        baseUrl: transport.baseUrl,
        credential: transport.credential
      })
      const image = await client.uploadImage({ dataUrl, filename: input?.filename })
      return { success: true as const, image }
    } catch (error) {
      logger?.warn('[Cloud] image upload failed', cloudErrorMessage(error))
      return fail(error)
    }
  })

  handleIpc('cloud:media:read', async (_event, input: { path?: string }) => {
    const target = String(input?.path ?? '').trim()
    if (!target) return { success: false as const, error: '没有图片路径' }
    const config = readCloudConfig()
    const transport = cloudTransport(config)
    if (!transport.credential) {
      return { success: false as const, error: '这台设备还没有配对，先在「连接」页配对' }
    }
    try {
      const client = createMediaClient({
        baseUrl: transport.baseUrl,
        credential: transport.credential
      })
      const dataUrl = await client.readImageDataUrl(target)
      return { success: true as const, dataUrl }
    } catch (error) {
      logger?.warn('[Cloud] image read failed', cloudErrorMessage(error))
      return fail(error)
    }
  })

  /**
   * 导出云端会话（md / html / json）。
   *
   * 云端没有可复制的会话记录文件：真相是 `/api/sessions/{id}/messages`，
   * 所以这里现拉一轮片段、渲染成文档，再让用户选路径。默认落在下载目录。
   */
  handleIpc(
    'cloud:session:export',
    async (
      _event,
      input: { sessionId?: string; title?: string; format?: string; language?: string }
    ) => {
      const sessionId = String(input?.sessionId ?? '')
      if (!sessionId) return { success: false as const, error: '缺少 sessionId' }
      const format = input?.format === 'html' ? 'html' : input?.format === 'json' ? 'json' : 'md'
      const language: 'zh' | 'en' = input?.language === 'en' ? 'en' : 'zh'
      try {
        const remote = createRemote(ensureClient())
        const page = await remote.listMessages({ sessionId, limit: 500 })
        const title = String(input?.title ?? '').trim()
        const content = renderCloudExport(
          page.parts,
          { sessionId, title, model: capabilities?.model ?? null, exportedAt: Date.now() },
          format,
          language
        )

        let baseDir = ''
        try {
          baseDir = app.getPath('downloads')
        } catch {
          baseDir = ''
        }
        const defaultPath = baseDir
          ? path.join(baseDir, cloudExportFileName(title, sessionId, format))
          : cloudExportFileName(title, sessionId, format)
        const filters =
          format === 'md'
            ? [{ name: 'Markdown', extensions: ['md'] }]
            : format === 'html'
              ? [{ name: 'HTML', extensions: ['html'] }]
              : [{ name: 'JSON', extensions: ['json'] }]
        const win = deps.getMainWindow()
        const picked = win
          ? await dialog.showSaveDialog(win, { defaultPath, filters })
          : await dialog.showSaveDialog({ defaultPath, filters })
        if (picked.canceled || !picked.filePath) {
          return { success: true as const, canceled: true }
        }
        await fs.writeFile(picked.filePath, content, 'utf-8')
        return { success: true as const, path: picked.filePath }
      } catch (error) {
        logger?.warn('[Cloud] export failed', cloudErrorMessage(error))
        return { success: false as const, error: cloudErrorMessage(error) }
      }
    }
  )

  handleIpc('cloud:messages:list', async (_event, input: { sessionId?: string; limit?: number; offset?: number }) => {
    const sessionId = String(input?.sessionId ?? '')
    if (!sessionId) return { success: false, error: '缺少 sessionId' }
    try {
      const remote = createRemote(ensureClient())
      const page = await remote.listMessages({
        sessionId,
        limit: input?.limit,
        offset: input?.offset
      })
      // 顺手复核账本：历史里有 tool_call_id 就说明那个工具真的跑完了
      try {
        const callIds = new Set<string>()
        for (const part of page.parts) {
          if (part.type === 'tool' && part.toolCallId) callIds.add(part.toolCallId)
        }
        if (callIds.size > 0) {
          mutateLedger((entries) => reconcileWithHistory(entries, sessionId, callIds))
        }
      } catch (error) {
        logger?.warn('[Cloud] ledger reconcile failed', error)
      }
      return { success: true, parts: page.parts, hasMore: page.hasMore }
    } catch (error) {
      return fail(error)
    }
  })

  handleIpc(
    'cloud:run:start',
    async (_event, input: { input?: string; sessionId?: string; idempotencyKey?: string }) => {
      const text = String(input?.input ?? '').trim()
      if (!text) return { success: false, error: '消息内容为空' }
      const idempotencyKey = String(input?.idempotencyKey ?? '').trim()
      if (!idempotencyKey) return { success: false, error: '缺少幂等键' }
      try {
        const started = await ensureRunner().start({
          input: text,
          sessionId: input?.sessionId || undefined,
          idempotencyKey
        })
        activeRun = { runId: started.runId, sessionId: started.sessionId ?? null }
        // 新一轮：上一轮的正文不能再当成本轮的结果摘要
        lastReply = ''
        const device = readCloudDevice()
        logger?.info(
          `[Cloud] run start device=${device.name} (${device.id.slice(0, 8)})`
        )
        // 会话归属：本机记一条「哪个会话是哪台设备起的」（云端不记这个）
        try {
          if (started.sessionId) recordSessionDevice(started.sessionId, device)
        } catch (error) {
          logger?.warn('[Cloud] session device record failed', error)
        }
        // 落一条「上次开跑的是哪一轮」：重启之后靠它把还在跑的 run 接回来
        writeActiveRun({
          runId: started.runId,
          sessionId: started.sessionId ?? null,
          startedAt: Date.now(),
        })
        return { success: true, runId: started.runId, sessionId: started.sessionId ?? undefined }
      } catch (error) {
        logger?.warn('[Cloud] run start failed', cloudErrorMessage(error))
        return fail(error)
      }
    }
  )

  /**
   * 接回上一次开的那一轮（应用重启 / 断线之后）。
   *
   * 没有记录、记录的会话跟当前要打开的不是同一个、后端已经认不得这条 run
   * 都返回 `attached: false` —— 渲染层据此什么也不做，不报错。
   */
  handleIpc('cloud:run:attach', async (_event, input: { sessionId?: string }) => {
    const record = readActiveRun()
    if (!record) return { success: true, attached: false }
    const wanted = String(input?.sessionId ?? '')
    if (wanted && record.sessionId && wanted !== record.sessionId) {
      return { success: true, attached: false }
    }
    try {
      const result = await ensureRunner().attach({
        runId: record.runId,
        sessionId: record.sessionId,
      })
      if (result.attached) {
        activeRun = { runId: result.runId, sessionId: result.sessionId ?? record.sessionId }
      } else {
        // 终态 / unknown：记录已完成使命（unknown 仍是会话里的状态，不靠它找回）
        clearActiveRun(record.runId)
      }
      return {
        success: true,
        attached: result.attached,
        runId: result.runId,
        sessionId: result.sessionId ?? undefined,
        state: result.state,
      }
    } catch (error) {
      // 网关重启过 / run 被回收：这条记录永远接不上了，删掉别每次启动都问
      if (error instanceof CloudApiError && error.code === 'not_found') {
        clearActiveRun(record.runId)
        return { success: true, attached: false }
      }
      logger?.warn('[Cloud] run attach failed', cloudErrorMessage(error))
      return fail(error)
    }
  })

  handleIpc('cloud:run:resolve-unknown', async (_event, input: { runId?: string }) => {
    const runId = String(input?.runId ?? '')
    if (!runId) return { success: false, error: '缺少 runId' }
    try {
      const remote = createRemote(ensureClient())
      // 收尾凭据必须与后端当前记录一致：现查一次，绝不缓存旧值
      const snapshot = await remote.runStatus(runId)
      if (snapshot.status !== 'unknown') {
        return { success: false, error: '这一轮不是丢失状态，无需收尾' }
      }
      if (!snapshot.admissionId || typeof snapshot.executionGeneration !== 'number') {
        return { success: false, error: '后端没有给出收尾凭据（admission_id / execution_generation）' }
      }
      const resolved = await remote.resolveUnknownRun({
        runId,
        admissionId: snapshot.admissionId,
        executionGeneration: snapshot.executionGeneration
      })
      return { success: true, state: resolved.status }
    } catch (error) {
      logger?.warn('[Cloud] resolve-unknown failed', cloudErrorMessage(error))
      return fail(error)
    }
  })

  handleIpc('cloud:run:steer', async (_event, input: { runId?: string; text?: string }) => {
    const text = String(input?.text ?? '').trim()
    if (!text) return { success: false, error: '插话内容为空' }
    try {
      await ensureRunner().steer(text)
      return { success: true }
    } catch (error) {
      logger?.warn('[Cloud] steer failed', cloudErrorMessage(error))
      return fail(error)
    }
  })

  handleIpc('cloud:run:status', async (_event, input: { runId?: string }) => {
    const runId = String(input?.runId ?? '')
    if (!runId) return { success: false, error: '缺少 runId' }
    try {
      const snapshot = await createRemote(ensureClient()).runStatus(runId)
      return {
        success: true,
        state: snapshot.status,
        error: snapshot.error ?? undefined,
        // 断流 / 重启后补卡片的唯一来源；只透脱敏字段（命令 + 命中规则 + 定位用的 id）
        pendingControls: (snapshot.pendingControls ?? []).map((control) => ({
          kind: typeof control?.kind === 'string' ? control.kind : '',
          promptId: String(control?.prompt_id ?? control?.request_id ?? ''),
          generation:
            typeof control?.execution_generation === 'number'
              ? control.execution_generation
              : typeof control?.generation === 'number'
                ? control.generation
                : undefined,
          command: typeof control?.command === 'string' ? control.command : '',
          patternKey:
            typeof control?.pattern_key === 'string'
              ? control.pattern_key
              : Array.isArray(control?.pattern_keys)
                ? String(control.pattern_keys[0] ?? '')
                : '',
          question: typeof control?.question === 'string' ? control.question : '',
          choices: Array.isArray(control?.choices)
            ? control.choices.map((item) => String(item ?? '')).filter(Boolean)
            : undefined,
          timeoutSeconds:
            typeof control?.timeout_s === 'number'
              ? control.timeout_s
              : typeof control?.timeout_seconds === 'number'
                ? control.timeout_seconds
                : undefined,
        })),
      }
    } catch (error) {
      return fail(error)
    }
  })

  handleIpc('cloud:run:stop', async (_event, input: { runId?: string }) => {
    const runId = String(input?.runId ?? '')
    if (!runId) return { success: false, error: '缺少 runId' }
    try {
      const state = await ensureRunner().stop(runId)
      send('cloud:event', { kind: 'run', runId, state: toRunStatus(state) })
      return { success: true, state }
    } catch (error) {
      return fail(error)
    }
  })

  handleIpc('cloud:dashboard:open', () => {
    const config = readCloudConfig()
    if (!config.hasDeviceToken) {
      return { success: false, error: '这台设备还没有配对，先在「连接」页配对' }
    }
    if (!config.dashboardUrl) {
      return {
        success: false,
        error: '还没有控制台地址：重新配对一次会自动带上，或在「连接」页填好网关地址后再试'
      }
    }
    hookWindow()
    try {
      dashboard.open(config.dashboardUrl)
      return { success: true }
    } catch (error) {
      return fail(error)
    }
  })

  handleIpc('cloud:dashboard:close', () => {
    dashboard.close()
    return { success: true }
  })

  handleIpc(
    'cloud:dashboard:bounds',
    (event, rect: { x: number; y: number; width: number; height: number; visible?: boolean }) => {
      // 原生层盖在主窗口上：坐标系只有主窗口说得清。拆出去的面板窗口推上来的
      // 矩形会把控制台摆到主窗口的错误位置（或干脆把不该可见的它点亮）
      const win = deps.getMainWindow()
      if (!win || win.isDestroyed() || event.sender !== win.webContents) {
        return { success: false, error: '控制台原生层只接受主窗口上报的边界' }
      }
      dashboard.setBounds(
        {
          x: Number(rect?.x ?? 0),
          y: Number(rect?.y ?? 0),
          width: Number(rect?.width ?? 0),
          height: Number(rect?.height ?? 0)
        },
        Boolean(rect?.visible ?? true)
      )
      return { success: true }
    }
  )

  handleIpc('cloud:dashboard:reload', () => {
    dashboard.reload()
    return { success: true }
  })

  return {
    dispose: () => {
      heartbeat.stop()
      runner?.dispose()
      dashboard.destroy()
    }
  }
}
