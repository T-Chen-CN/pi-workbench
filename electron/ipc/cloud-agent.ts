/** 云端 Agent 的 IPC：配置、会话、run 生命周期、程序内控制台 */

import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { clipboard, dialog, type BrowserWindow } from 'electron'
import { handleIpc } from './register.js'
import {
  normalizeBaseUrl,
  clearCloudToken,
  publicCloudConfig,
  readCloudConfig,
  writeCloudConfig
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
import { createDashboardClient, parseImageDataUrl } from '../cloud/dash.js'
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

export function registerCloudAgentIpc(deps: CloudAgentIpcDeps): {
  dispose: () => void
} {
  const logger = deps.logger
  let client: CloudClient | null = null
  let clientKey = ''
  let runner: CloudRunner | null = null
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

  function clientKeyFor(config: { baseUrl: string; apiKey: string }): string {
    return `${normalizeBaseUrl(config.baseUrl)}|${config.apiKey}`
  }

  /** 配置变了就重建客户端与 runner（避免旧密钥/旧地址残留） */
  function ensureClient(): CloudClient {
    const config = readCloudConfig()
    if (!config.hasToken) {
      throw new CloudApiError('unauthorized', '还没有配置 API 密钥，请先在「连接」页保存')
    }
    const key = clientKeyFor(config)
    if (client && key === clientKey) return client
    runner?.dispose()
    client = createCloudClient({ baseUrl: config.baseUrl, apiKey: config.apiKey })
    runner = new CloudRunner(
      {
        emit: (frame) => {
          observeForLedger(frame)
          send('cloud:event', frame)
        },
        log: (message, error) => logger?.warn(message, error ?? '')
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
    const config = publicCloudConfig()
    return { success: true, config }
  })

  handleIpc('cloud:config:set', (_event, input: { baseUrl?: string; apiKey?: string; dashboardToken?: string }) => {
    const saved = writeCloudConfig({
      baseUrl: String(input?.baseUrl ?? ''),
      apiKey: typeof input?.apiKey === 'string' ? input.apiKey : undefined,
      dashboardToken: typeof input?.dashboardToken === 'string' ? input.dashboardToken : undefined
    })
    // 地址或密钥变化后旧连接作废
    client = null
    clientKey = ''
    runner?.dispose()
    runner = null
    capabilities = null
    return {
      success: true,
      config: publicCloudConfig(saved)
    }
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
        willOverwrite: readCloudConfig().hasToken,
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
      const saved = writeCloudConfig({ ...patch, handoffImportedAt: Date.now() })
      // 地址或密钥变了，旧连接作废（与 cloud:config:set 同一套语义）
      client = null
      clientKey = ''
      runner?.dispose()
      runner = null
      capabilities = null
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
      const requestId = String(input?.requestId ?? '') || undefined
      const rawGeneration = Number(input?.generation)
      const generation = Number.isInteger(rawGeneration) ? rawGeneration : undefined

      try {
        const remote = createRemote(ensureClient())
        await remote.respondApproval({ runId, requestId, generation, choice: choice as CloudApprovalChoice })
        // 审计：决定行（结果行由 runner 后补）
        let mode: CloudApprovalMode | null = null
        try {
          mode = (await readApprovalPolicy()).mode
        } catch {
          // 读不到档位不影响审批本身：审计里就记 null
        }
        recordApprovalDecision({
          runId,
          sessionId: input?.sessionId ?? null,
          command: String(input?.command ?? ''),
          patternKeys: Array.isArray(input?.patternKeys) ? input.patternKeys : [],
          choice: choice as CloudApprovalChoice,
          mode,
        })
        return { success: true as const, choice }
      } catch (error) {
        logger?.warn('[Cloud] approval respond failed', cloudErrorMessage(error))
        return fail(error)
      }
    }
  )

  handleIpc('cloud:policy:get', async () => {
    try {
      const policy = await readApprovalPolicy()
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
    if (!config.hasDashboardToken) {
      return {
        success: false as const,
        error: '图片上传需要控制台会话令牌：在「连接」页填入服务端 .env 的 HERMES_DASHBOARD_SESSION_TOKEN'
      }
    }
    try {
      // 本地先校验类型与体积，省一次注定失败的往返
      parseImageDataUrl(dataUrl)
      const client = createDashboardClient({
        dashboardUrl: config.dashboardUrl,
        token: config.dashboardToken
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
    if (!config.hasDashboardToken) {
      return { success: false as const, error: '读取云端图片需要控制台会话令牌' }
    }
    try {
      const client = createDashboardClient({
        dashboardUrl: config.dashboardUrl,
        token: config.dashboardToken
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
        return { success: true, runId: started.runId, sessionId: started.sessionId ?? undefined }
      } catch (error) {
        logger?.warn('[Cloud] run start failed', cloudErrorMessage(error))
        return fail(error)
      }
    }
  )

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
    if (!config.hasToken) {
      return { success: false, error: '还没有配置 API 密钥' }
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
      runner?.dispose()
      dashboard.destroy()
    }
  }
}
