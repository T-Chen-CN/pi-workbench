/** 云端 Agent 的 IPC：配置、会话、run 生命周期、程序内控制台 */

import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { app, clipboard, dialog, type BrowserWindow } from 'electron'
import { handleIpc } from './register.js'
import {
  normalizeBaseUrl,
  clearCloudToken,
  publicCloudConfig,
  readCloudConfig,
  writeCloudConfig,
  cloudTransport,
  clearDeviceCredentials,
  pruneLegacyCloudConfig
} from '../cloud/config.js'
import {
  HANDOFF_MAX_BYTES,
  parseHandoff,
  pendingPatch,
  toPreview
} from '../cloud/handoff.js'
import { CloudApiError, cloudErrorMessage, createCloudClient, type CloudClient } from '../cloud/client.js'
import { CloudRunner } from '../cloud/runner.js'
import { CloudDashboard } from '../cloud/dashboard.js'
import { createMediaClient, parseImageDataUrl } from '../cloud/media.js'
import {
  gatewayHealth,
  gatewayWhoAmI,
  heartbeatDevice,
  registerDevice,
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
  isApprovalMode,
  readApprovalPolicy,
  writeApprovalMode
} from '../cloud/policy.js'
import type {
  CloudApprovalChoice,
  CloudApprovalMode,
  CloudCapabilities,
  CloudConfigPatch,
  CloudConnectionState,
  CloudHandoffParseCode,
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
  /** 心跳：登记后每 30s 一拍，让云端知道这台机器还开着（H2-1） */
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

  /**
   * 待应用的交接文件：明文补丁只在内存里活 60 秒，或被一次 apply 消费。
   * 渲染层只拿 nonce，不拿明文。
   */
  let pendingHandoff: { nonce: string; patch: CloudConfigPatch; timer: NodeJS.Timeout } | null =
    null
  const HANDOFF_TTL_MS = 60_000
  const HANDOFF_EXTENSIONS = ['txt', 'handoff', 'env', 'conf']

  function clearPendingHandoff(): void {
    if (!pendingHandoff) return
    clearTimeout(pendingHandoff.timer)
    pendingHandoff = null
  }

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
          ? '设备 token 丢失，请在「连接」页重新登记这台设备'
          : '还没有登记这台设备，请先在「连接」页用管理密钥登记'
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
    win.on('restore', () => dashboard.show())
    win.on('show', () => dashboard.show())
    win.on('closed', () => dashboard.destroy())
  }

  const fail = (error: unknown): { success: false; error: string } => ({
    success: false,
    error: cloudErrorMessage(error)
  })

  handleIpc('cloud:config:get', () => {
    // 老版本留下的字段（baseUrl / dashboardToken / apiKey）顺手清掉：读取本来就不用它们
    pruneLegacyCloudConfig()
    const config = publicCloudConfig()
    return { success: true, config }
  })

  /**
   * 选一个交接文件 → 只读解析 → 回脱敏预览。
   * 明文密钥留在主进程的 pendingHandoff 里，`apply` 只回传 nonce。
   */
  handleIpc('cloud:handoff:pick', async () => {
    const win = deps.getMainWindow()
    const options = {
      title: '选择 Hermes 交接文件',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'hermes-handoff', extensions: HANDOFF_EXTENSIONS }]
    }
    let filePath = ''
    try {
      const picked = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (picked.canceled || picked.filePaths.length === 0) {
        return { success: true, canceled: true }
      }
      filePath = picked.filePaths[0]
    } catch {
      return { success: false, canceled: true, error: '无法打开文件选择框' }
    }

    let text = ''
    try {
      const stats = await fs.promises.stat(filePath)
      if (stats.size > HANDOFF_MAX_BYTES) {
        return { success: false, canceled: false, code: 'too_large' as CloudHandoffParseCode }
      }
      text = await fs.promises.readFile(filePath, 'utf8')
    } catch {
      return { success: false, canceled: false, code: 'read_failed' as CloudHandoffParseCode }
    }

    const parsed = parseHandoff(text)
    if (!parsed.ok) {
      // 只回原因码：文件内容（含明文密钥）绝不出主进程
      return { success: false, canceled: false, code: parsed.code }
    }

    clearPendingHandoff()
    const nonce = randomUUID()
    const timer = setTimeout(() => {
      pendingHandoff = null
    }, HANDOFF_TTL_MS)
    // 不因一个待应用的预览把进程留住
    ;(timer as unknown as { unref?: () => void }).unref?.()
    pendingHandoff = { nonce, patch: pendingPatch(parsed.data), timer }

    logger?.info('[Cloud] handoff picked', parsed.data.version)
    return {
      success: true,
      canceled: false,
      preview: {
        ...toPreview(parsed.data, path.basename(filePath)),
        willOverwrite: readCloudConfig().hasDeviceToken,
        applyNonce: nonce
      }
    }
  })

  handleIpc('cloud:handoff:apply', (_event, input: { applyNonce?: string }) => {
    const nonce = String(input?.applyNonce ?? '')
    if (!pendingHandoff || !nonce || pendingHandoff.nonce !== nonce) {
      return { success: false, error: '预览已过期，请重新选择交接文件' }
    }
    const patch = pendingHandoff.patch
    // 一次性：无论写盘成败都作废，避免拿着同一份预览反复覆盖
    clearPendingHandoff()
    try {
      const previousGatewayUrl = readCloudConfig().gatewayUrl
      const saved = writeCloudConfig({ ...patch, handoffImportedAt: Date.now() })
      // 地址或密钥变了，旧连接作废
      client = null
      clientKey = ''
      runner?.dispose()
      runner = null
      capabilities = null
      // 换了网关，上一台的 run 记录就再也接不上了
      if (normalizeBaseUrl(saved.gatewayUrl) !== normalizeBaseUrl(previousGatewayUrl)) {
        clearActiveRun()
      }
      logger?.info('[Cloud] handoff imported', saved.handoffProfile || 'unknown')
      return { success: true, config: publicCloudConfig(saved) }
    } catch (error) {
      return fail(error)
    }
  })

  handleIpc('cloud:handoff:copy', (_event, input: { field?: string }) => {
    const field = String(input?.field ?? '')
    if (field !== 'password') return { success: false, error: '不支持复制这个字段' }
    const password = readCloudConfig().dashboardPassword
    if (!password) return { success: false, error: '没有保存控制台口令' }
    clipboard.writeText(password)
    return { success: true }
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
    clearCloudToken()
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
   * 网关（云端单入口）三件事：看状态、登记这台设备、注销这台设备。
   *
   * 登记是**设备身份的唯一诞生点**：管理密钥换一次性 token，token 用 safeStorage
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
      const [me, health] = await Promise.all([
        gatewayWhoAmI(config.gatewayUrl, config.deviceToken),
        gatewayHealth(config.gatewayUrl).catch(() => null)
      ])
      return {
        success: true as const,
        registered: true as const,
        ...base,
        deviceId: me.deviceId,
        name: me.name,
        scopes: me.scopes,
        hub: me.hub,
        online: health?.upstreamOk ?? null,
        upstream: health?.upstream ?? '',
        upstreamVersion: health?.upstreamVersion ?? '',
        devices: health?.devices ?? null
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

  /** 用管理密钥登记这台设备；成功后立刻落盘（token 只出现这一次）。 */
  handleIpc(
    'cloud:gateway:register',
    async (
      _event,
      input: {
        adminKey?: string
        name?: string
        gatewayUrl?: string
        scopes?: string[]
        /** 勾上就记住这把管理密钥（`enc:`，只留在主进程） */
        rememberAdminKey?: boolean
      }
    ) => {
      const config = readCloudConfig()
      // 界面上不填 = 用本机记住的那把（勾过「记住」之后就不必反复粘）
      const typed = String(input?.adminKey ?? '').trim()
      const adminKey = typed || config.adminKey
      if (!adminKey) return { success: false as const, error: '请填写管理密钥' }
      const gatewayUrl = String(input?.gatewayUrl ?? '').trim() || config.gatewayUrl
      const record = readCloudDevice()
      const name = String(input?.name ?? '').trim() || record.name
      try {
        const result = await registerDevice({
          gatewayUrl,
          adminKey,
          deviceId: record.id,
          name,
          scopes: input?.scopes
        })
        writeCloudConfig({
          gatewayUrl,
          // 自建部署可能单独指定过控制台地址：别因为登记设备把它覆盖掉
          dashboardUrl: config.dashboardUrl,
          deviceToken: result.token,
          deviceScopes: result.scopes,
          deviceId: result.deviceId,
          // 勾选才记；不勾且之前记过 = 尊重这次选择（清掉）
          adminKey: input?.rememberAdminKey ? adminKey : ''
        })
        client = null // 凭据变了，重建客户端与 runner
        runner?.dispose()
        runner = null
        // 换了一台网关：上一台的 run 记录接不回来
        if (normalizeBaseUrl(gatewayUrl) !== normalizeBaseUrl(config.gatewayUrl)) {
          clearActiveRun()
        }
        heartbeat.poke() // 新 token 立刻跳一拍：云端马上看到「在线」
        logger?.info(
          `[Cloud] device registered name=${result.name} prefix=${result.tokenPrefix} scopes=${result.scopes.join('+')}`
        )
        return {
          success: true as const,
          deviceId: result.deviceId,
          tokenPrefix: result.tokenPrefix,
          scopes: result.scopes,
          name: result.name
        }
      } catch (error) {
        logger?.warn('[Cloud] device register failed', cloudErrorMessage(error))
        return { success: false as const, error: cloudErrorMessage(error) }
      }
    }
  )

  /** 注销这台设备：token 立即失效；本地同时清掉 token（要重新登记才能用）。 */
  handleIpc('cloud:gateway:revoke', async (_event, input: { adminKey?: string }) => {
    const config = readCloudConfig()
    if (!config.hasDeviceToken) {
      return { success: false as const, error: '这台设备还没登记' }
    }
    try {
      await revokeDevice({
        gatewayUrl: config.gatewayUrl,
        deviceId: config.deviceId || readCloudDevice().id,
        adminKey: String(input?.adminKey ?? '').trim() || undefined,
        deviceToken: config.deviceToken
      })
      // 注销：只清设备凭据，网关地址留着显示（本地没有别的凭据可退）
      clearDeviceCredentials()
      heartbeat.stop() // 没凭据了，别再往云端打 401
      client = null
      runner?.dispose()
      runner = null
      return { success: true as const }
    } catch (error) {
      logger?.warn('[Cloud] device revoke failed', cloudErrorMessage(error))
      return { success: false as const, error: cloudErrorMessage(error) }
    }
  })

  /** 忘掉本机记住的管理密钥（下次登记要重新粘） */
  handleIpc('cloud:gateway:forget-admin-key', () => {
    const config = readCloudConfig()
    if (!config.hasAdminKey) return { success: true as const }
    // 只动管理密钥：自建部署的 gateway / dashboard 地址不能被重置
    writeCloudConfig({
      gatewayUrl: config.gatewayUrl,
      dashboardUrl: config.dashboardUrl,
      adminKey: ''
    })
    return { success: true as const }
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
      return { success: false as const, error: '这台设备还没有登记，先在「连接」页登记' }
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
      return { success: false as const, error: '这台设备还没有登记，先在「连接」页登记' }
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
      return { success: false, error: '这台设备还没有登记，先在「连接」页登记' }
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
    (_event, rect: { x: number; y: number; width: number; height: number; visible?: boolean }) => {
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
      clearPendingHandoff()
      heartbeat.stop()
      runner?.dispose()
      dashboard.destroy()
    }
  }
}
