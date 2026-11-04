/** 云端 Agent 的 IPC：配置、会话、run 生命周期、程序内控制台 */

import type { BrowserWindow } from 'electron'
import { handleIpc } from './register.js'
import {
  normalizeBaseUrl,
  clearCloudToken,
  publicCloudConfig,
  readCloudConfig,
  writeCloudConfig
} from '../cloud/config.js'
import { CloudApiError, cloudErrorMessage, createCloudClient, type CloudClient } from '../cloud/client.js'
import { CloudRunner } from '../cloud/runner.js'
import { CloudDashboard } from '../cloud/dashboard.js'
import { createDashboardClient, parseImageDataUrl } from '../cloud/dash.js'
import { createRemote, toRunStatus } from '../cloud/remote.js'
import type { CloudCapabilities, CloudConnectionState } from '../cloud/types.js'

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

  const send = (channel: string, payload: unknown): void => {
    const win = deps.getMainWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(channel, payload)
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
        emit: (frame) => send('cloud:event', frame),
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
      return { success: true, state: snapshot.status, error: snapshot.error ?? undefined }
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
      runner?.dispose()
      dashboard.destroy()
    }
  }
}
