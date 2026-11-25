/**
 * 服务入口：装配存储、云端会话、派活器与两条 WS 通道。
 *
 * 进程模型（D-13 / §3.5）：只监听 127.0.0.1，TLS 与 WS 升级交给 Caddy；
 * 数据目录 `/var/lib/pi-cloud`，会话 JSONL 在 `agent/sessions`（F-42 的唯一真相源）。
 */

import { createServer, type IncomingMessage, type Server } from 'http'
import { promises as fs } from 'fs'
import * as path from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  CLOUD_PROTOCOL_VERSION,
  CLOUD_WS_PATHS,
  isTerminalTaskStatus,
  normalizeResumeCursor,
  type ClientToServerFrame,
  type CloudSnapshot,
  type CloudWorkspaceInfo,
  type DeviceToServerFrame,
} from 'pi-bridge'
import { AgentManager, createFileCredentialStore, legacyProviderFromUrl } from 'pi-bridge'
import { loadConfig, type CloudConfig } from './config.js'
import { CloudStore } from './store/store.js'
import { AttemptLimiter } from './auth/rate-limit.js'
import { readCookie, SESSION_COOKIE, verifySessionCookie } from './auth/session-cookie.js'
import { decryptSecret, encryptSecret } from './secure/config-crypto.js'
import { Hub, type ClientPeer, type DevicePeer } from './ws/hub.js'
import { TaskDispatcher } from './tasks/dispatcher.js'
import {
  CLOUD_TOOL_NAMES,
  CloudSession,
  authorizationView,
} from './agent/cloud-session.js'
import { createCloudToolsExtension } from './agent/tools.js'
import { probeProviderConfig } from './agent/provider-models.js'
import { buildRouter } from './http/routes.js'
import { defaultWebDir, serveStatic } from './http/static.js'
import { HttpError, readJsonBody, sendJson, sourceOf } from './http/router.js'
import type { AuthorizationRecord } from './tasks/authorization.js'
import { DEFAULT_AUTHORIZATION_TTL_MS, DEFAULT_QUOTA } from './tasks/authorization.js'
import { randomBytes } from 'crypto'

const logger = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
}

export interface CloudServer {
  config: CloudConfig
  store: CloudStore
  hub: Hub
  dispatcher: TaskDispatcher
  session: CloudSession
  server: Server
  snapshot: () => Promise<CloudSnapshot>
  listen: () => Promise<number>
  close: () => Promise<void>
}

export interface CloudServerHooks {
  /** 轮换前的配置探测（默认走供应商 `/models`；测试里注入替身，避免打外网） */
  probeConfig?: (
    config: { provider: string; apiUrl: string; apiKey: string; model: string }
  ) => Promise<{ ok: true; warning?: string } | { ok: false; reason: string }>
}

export async function createCloudServer(
  overrides: Partial<CloudConfig> = {},
  hooks: CloudServerHooks = {}
): Promise<CloudServer> {
  const probeConfig = hooks.probeConfig ?? probeProviderConfig
  const config = loadConfig(overrides)
  await fs.mkdir(config.dataDir, { recursive: true })
  await fs.mkdir(config.workspaceDir, { recursive: true })
  await fs.mkdir(config.agentDir, { recursive: true })

  const store = await CloudStore.open(config.dataDir)
  const loginLimiter = new AttemptLimiter()
  const pairLimiter = new AttemptLimiter()

  const agent = new AgentManager()
  const session = new CloudSession({
    agent,
    store,
    hub: null as unknown as Hub,
    dispatcher: null as unknown as TaskDispatcher,
    logger,
    // 入口屏障：重建窗口里运行时与 sessionId 都不可用（F-13）
    ready: () => ensureAgent(),
  })

  const hub = new Hub(
    {
      logger,
      buildSnapshot: () => buildSnapshot(),
      onClientFrame: (peer, frame) => void onClientFrame(peer, frame),
      onDeviceFrame: (peer, frame) => void onDeviceFrame(peer, frame),
      onDeviceOffline: (deviceId) => void onDeviceOffline(deviceId),
      onDeviceOnline: (deviceId) => void onDeviceOnline(deviceId),
      onClientHello: () => undefined,
    },
    () => Date.now()
  )

  const dispatcher = new TaskDispatcher({
    store,
    hub,
    logger,
    wake: (payload) => session.wake(payload),
  })

  // 两个对象在构造时互相引用：先建后注入，避免循环依赖
  ;(session as unknown as { deps: { hub: Hub; dispatcher: TaskDispatcher } }).deps.hub = hub
  ;(session as unknown as { deps: { hub: Hub; dispatcher: TaskDispatcher } }).deps.dispatcher =
    dispatcher

  async function buildSnapshot(): Promise<CloudSnapshot> {
    // 历史在落盘的会话里，但要经 AgentManager 投影就得先初始化。
    // 不在这里拉一下：重启后没人说过话，`sessionId` 还是 null → 快照里历史空白，
    // 表现就是「重启后对话全没了」。模拟配置未推时不报错，只是历史为空。
    await ensureAgent().catch(() => false)
    return {
      serverVersion: config.version,
      protocol: CLOUD_PROTOCOL_VERSION,
      lastSeq: hub.lastClientSeq(),
      cloud: session.runtimeState(),
      messages: await session.history(),
      tasks: store.listTasks(),
      devices: dispatcher.deviceSnapshots(),
      units: dispatcher.unitViews(),
      authorizations: store.activeAuthorizations().map(authorizationView),
    }
  }

  const router = buildRouter({
    config,
    store,
    dispatcher,
    session,
    loginLimiter,
    pairLimiter,
    snapshot: buildSnapshot,
    logger,
  })

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
        if ((req.method ?? 'GET') === 'GET') {
          const served = await serveStatic(config.webDir || defaultWebDir(), url.pathname, res)
          if (served) return
        }
        const matched = router.match(req.method ?? 'GET', url.pathname)
        if (!matched) {
          sendJson(res, 404, { error: 'not-found' })
          return
        }
        const result = await matched.handler({
          req,
          res,
          url,
          source: sourceOf(req),
          cookie: (name) => readCookie(req.headers.cookie, name),
          json: <T,>(limit?: number) => readJsonBody<T>(req, limit),
          params: matched.params,
        })
        if (res.headersSent) return
        sendJson(res, 200, result)
      } catch (error) {
        if (error instanceof HttpError) {
          if (!res.headersSent) sendJson(res, error.status, { error: error.message, code: error.code })
          return
        }
        logger.error('[cloud] request failed:', error instanceof Error ? error.stack : error)
        if (!res.headersSent) sendJson(res, 500, { error: 'server-error' })
      }
    })()
  })

  const wsServer = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      // 游标 0 / 非数字都等于「没有游标」→ 首连必须发整份快照（见 normalizeResumeCursor）
      const resumeFrom = normalizeResumeCursor(url.searchParams.get('lastAckSeq'))

      if (url.pathname === CLOUD_WS_PATHS.device) {
        const device = authenticateDevice(req)
        if (!device) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          hub.addDevice(ws, device.id, Number.isFinite(resumeFrom) ? resumeFrom : null)
        })
        return
      }

      if (url.pathname === CLOUD_WS_PATHS.client) {
        if (!authenticateClient(req)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
        wsServer.handleUpgrade(req, socket, head, (ws) => {
          hub.addClient(ws, Number.isFinite(resumeFrom) ? resumeFrom : null)
        })
        return
      }

      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
    })()
  })

  function authenticateDevice(req: IncomingMessage) {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token) return undefined
    const device = store.findDeviceByToken(token)
    if (!device) return undefined
    void store.updateDevice(device.id, { lastSeenAt: Date.now() })
    return device
  }

  /** 一机一 token（D-22）：设备 token 也能开客户端通道；Web 用 cookie */
  function authenticateClient(req: IncomingMessage): boolean {
    const cookie = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (verifySessionCookie(config.cookieSecret, cookie)) return true
    return Boolean(authenticateDevice(req))
  }

  let closing = false

  async function onClientFrame(peer: ClientPeer, frame: ClientToServerFrame): Promise<void> {
    if (closing) return
    switch (frame.type) {
      case 'resume':
        await hub.resumeClient(peer, frame.lastAckSeq)
        return
      case 'ack':
        return
      case 'ping':
        peer.socket.send(JSON.stringify({ v: CLOUD_PROTOCOL_VERSION, type: 'pong', at: frame.at }))
        return
      case 'say':
        await ensureAgent()
        await session.say(frame.text, frame.clientMessageId)
        return
      case 'confirm_plan':
        await ensureAgent()
        await confirmPlan(frame.planText, frame.items, frame.quota)
        return
      case 'stop_reply':
        await session.stopReply()
        return
      case 'stop_task': {
        const cancelled = await dispatcher.cancelTask(frame.taskId, 'user-cancel')
        if (!cancelled) {
          hub.publish({
            type: 'notice',
            level: 'warn',
            text: '工单已结束或不存在，停止指令未下发',
            at: Date.now(),
            key: `stop-${frame.taskId}`,
          })
        }
        return
      }
      case 'close_unit': {
        const result = await dispatcher.requestUnitClose(frame.unitId, 'user-close')
        if (!result.ok) {
          hub.publish({
            type: 'notice',
            level: 'warn',
            text:
              result.code === 'task-running'
                ? '这个工作单元还有工单在跑，先停止工单再结束单元'
                : result.code === 'already-closed'
                  ? '这个工作单元已经结束了'
                  : '工作单元不存在',
            at: Date.now(),
            key: `close-unit-${frame.unitId}`,
          })
        }
        return
      }
      default:
        return
    }
  }

  async function confirmPlan(
    planText: string,
    items: Array<{ deviceId: string; workspacePath: string }>,
    quota: number
  ): Promise<void> {
    const now = Date.now()
    const record: AuthorizationRecord = {
      id: `auth-${randomBytes(4).toString('hex')}`,
      items: items.filter((item) => item.deviceId && item.workspacePath),
      quota: Math.max(1, Math.min(50, Number(quota) || DEFAULT_QUOTA)),
      used: 0,
      confirmedAt: now,
      confirmedSummary: planText.slice(0, 400),
      expiresAt: now + DEFAULT_AUTHORIZATION_TTL_MS,
      revokedAt: null,
    }
    if (record.items.length === 0) {
      hub.publish({
        type: 'notice',
        level: 'warn',
        text: '确认方案时必须至少选择一个设备与仓库',
        at: now,
        key: 'confirm-no-target',
      })
      return
    }
    await store.saveAuthorization(record)
    hub.publish({
      type: 'notice',
      level: 'info',
      text: `已授权 ${record.items.length} 个目标、${record.quota} 张工单（${record.id}）`,
      at: now,
      key: `confirm-${record.id}`,
    })
    // 确认动作落进会话记录（F-18）：以用户消息的形式，模型才能看到授权与额度
    const targets = record.items
      .map((item) => `${item.deviceId} → ${item.workspacePath}`)
      .join('\n')
    await session.say(
      [
        '【已确认方案 / 授权派活】',
        planText.trim(),
        `授权范围（设备 → 仓库）：\n${targets}`,
        `工单额度：${record.quota} 张；authorizationId: ${record.id}`,
        '在同一范围内可以连续派活，不需要再征求确认；换设备、换仓库或明显加码必须先问我。',
      ].join('\n\n'),
      `confirm-${record.id}`
    )
  }

  async function onDeviceFrame(peer: DevicePeer, frame: DeviceToServerFrame): Promise<void> {
    if (closing) return
    await store.updateDevice(peer.deviceId, { lastSeenAt: Date.now() })
    if (frame.type === 'hello') {
      await store.updateDevice(peer.deviceId, { workspaces: sanitize(frame.workspaces) })
      publishDevice(peer.deviceId)
      await reconcileTasksOnHello(peer.deviceId, frame.runningTasks)
      return
    }
    if (frame.type === 'workspaces') {
      await store.updateDevice(peer.deviceId, { workspaces: sanitize(frame.workspaces) })
      publishDevice(peer.deviceId)
      return
    }
    if (frame.type === 'heartbeat' || frame.type === 'ack' || frame.type === 'ping') {
      if (frame.type === 'ping') {
        peer.socket.send(
          JSON.stringify({ v: CLOUD_PROTOCOL_VERSION, type: 'pong', at: frame.at })
        )
      }
      return
    }
    await dispatcher.handleDeviceFrame(peer.deviceId, frame)
    publishDevice(peer.deviceId)
  }

  function publishDevice(deviceId: string): void {
    const device = store.findDevice(deviceId)
    if (!device) return
    hub.publish({ type: 'device', device: dispatcher.deviceSnapshot(device) })
  }

  /**
   * 重连对账（F-21 / A-13 / A-41）：终端把自己认为还在跑的工单报上来，
   * 服务端只纠正**不该继续跑**的那些——掉线期间已落终态（离线判定 / 用户停止 /
   * 超时），以及服务端根本没有记录的孤儿（它已经无法汇报，留着只会堵住 FIFO）。
   *
   * 必须由服务端判定：终端本地台账在掉线那段时间拿不到任何新事实。
   */
  async function reconcileTasksOnHello(deviceId: string, running: unknown): Promise<void> {
    if (!Array.isArray(running)) return
    for (const raw of running) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      const taskId = raw.trim()
      const task = store.findTask(taskId)
      // 别的设备的工单：不认，避免用一台设备停掉另一台的活
      if (task && task.spec.deviceId !== deviceId) continue
      if (task && !isTerminalTaskStatus(task.status)) continue
      hub.sendToDevice(
        deviceId,
        {
          v: CLOUD_PROTOCOL_VERSION,
          type: 'task_cancel',
          seq: 0,
          taskId,
          reason: task ? (task.terminalReason ?? 'server-terminal') : 'unknown-task',
        },
        taskId
      )
      logger.info(
        `[cloud] reconcile: asked ${deviceId} to stop ${taskId} (${task ? task.status : 'unknown'})`
      )
    }
  }

  async function onDeviceOffline(deviceId: string): Promise<void> {
    publishDevice(deviceId)
    await dispatcher.onDeviceOffline(deviceId)
  }

  async function onDeviceOnline(deviceId: string): Promise<void> {
    publishDevice(deviceId)
    await dispatcher.onDeviceOnline(deviceId)
  }

  // ------------------------------ 云端 Agent ------------------------------

  let agentReady = false
  let agentInitializing: Promise<boolean> | null = null
  /** 正在运行的那份配置的 `updatedAt`；null 表示没有可用运行时 */
  let runningConfigStamp: number | null = null
  /** 上次初始化成功的配置（含解密后的 Key，只在内存）：新配置失败时用它回滚 */
  let lastGoodConfig: ResolvedCloudConfig | null = null
  /** 正在进行的重建；所有入口（含 `ensureAgent()`）都要先等它结束 */
  let applyingConfig: Promise<void> | null = null
  /** 已经失败过的那份配置：同一份坏配置不反复重试（否则每次入口都会再拆一次运行时） */
  let failedConfigStamp: number | null = null

  interface ResolvedCloudConfig {
    stamp: number
    provider: string
    apiUrl: string
    apiKey: string
    model: string
  }

  /**
   * 云端凭证落盘位置。P5 之前云端仍用自己的配置页写 key，这里把它翻译成
   * 预设供应商 + CredentialStore，Agent 运行时不再读明文 Key。
   */
  const credentials = createFileCredentialStore({
    path: path.join(config.dataDir, 'credentials.json'),
    cipher: {
      encrypt: (plain) => encryptSecret(plain, config.encryptionKey),
      decrypt: (stored) => decryptSecret(stored, config.encryptionKey),
    },
    logger,
  })

  /** 读磁盘配置并解密 Key；解密失败返回 null（换过 `PI_CLOUD_ENC_KEY` 的典型表现） */
  function resolveConfig(): ResolvedCloudConfig | null {
    const record = store.getCloudConfig()
    if (!record) return null
    try {
      return {
        stamp: record.updatedAt,
        provider: record.provider,
        apiUrl: record.apiUrl,
        apiKey: decryptSecret(record.apiKeyCipher, config.encryptionKey),
        model: record.model,
      }
    } catch {
      logger.error('[cloud] cannot decrypt the stored model config; re-push it from the client')
      return null
    }
  }

  /** 磁盘上的配置比运行中的新，且不是已失败的那份 → 返回它的 stamp */
  function pendingConfigStamp(): number | null {
    const record = store.getCloudConfig()
    if (!record) return null
    if (runningConfigStamp === record.updatedAt) return null
    if (failedConfigStamp === record.updatedAt) return null
    return record.updatedAt
  }

  /** 用给定配置建运行时并续上唯一会话 */
  async function startAgent(resolved: ResolvedCloudConfig): Promise<boolean> {
    const providerId = legacyProviderFromUrl(resolved.apiUrl) ?? resolved.provider
    // 旧配置里的明文 Key 转成预设供应商凭证；P5 会换成配置页 + OAuth 登录
    await credentials.modify(providerId, async () => ({
      type: 'api_key',
      key: resolved.apiKey,
    }))
    const result = await agent.initialize({
      workspaceDir: config.workspaceDir,
      agentDir: config.agentDir,
      apiConfig: { providerId, modelId: resolved.model },
      credentials,
      allowModelNetwork: true,
      logger,
      // 云端会话：无审批（mode=auto）、不挂计划与工作树扩展、工具白名单只有六个
      builtinExtensions: { approval: false, plan: false, worktree: false },
      toolAllowlist: [...CLOUD_TOOL_NAMES],
      extensionFactories: [createCloudToolsExtension({ store, hub, dispatcher })],
      getDefaultPermissionLevel: () => 'auto',
      onAgentSettled: () => {
        hub.publish({ type: 'cloud_status', status: 'idle' })
      },
    })
    if (!result.success) {
      logger.error('[cloud] agent initialize failed:', result.error)
      hub.publish({
        type: 'notice',
        level: 'error',
        text: `云端 Agent 初始化失败：${result.error ?? 'unknown error'}`,
        at: Date.now(),
        key: 'agent-init-failed',
      })
      return false
    }
    const opened = await session.open()
    if (!opened.ok) {
      logger.error('[cloud] session open failed:', opened.error)
      return false
    }
    agentReady = true
    runningConfigStamp = resolved.stamp
    lastGoodConfig = resolved
    hub.publish({ type: 'cloud_status', status: 'idle' })
    logger.info(`[cloud] cloud agent ready (${resolved.provider} / ${resolved.model})`)
    return true
  }

  /**
   * F-13：配置轮换只在**轮次边界**生效——而且落在“下一轮开始之前”，不在 `agent_settled` 里重建。
   *
   * 为什么不在 settle 里重建：`agent_settled` 在事件分发过程中触发，此时 `dispose()` 会销毁正在分发
   * 事件的会话；改在入口处重建还能顺带避开“settle 与新消息同 tick”的竞态（入口本来就要 await）。
   *
   * 为什么只有探测通过才“先拆后建”：`initialize()` 会写进程级的 Provider Key，失败时释放会把环境还原成
   * **进程原值**而不是旧 Key，反而毒掉正在跑的旧实例（§3.1）。而 `initialize()` 本身不看 Key 与模型是否
   * 真实存在（它查的 models.json 就是按这份配置生成的），所以“推错 Key 也报已生效”的坑只能靠探测堵。
   */
  async function applyConfig(): Promise<void> {
    if (applyingConfig) {
      await applyingConfig
      return
    }
    if (pendingConfigStamp() === null) return
    // 本轮在跑就不动它：下一次入口（下一轮开始前）再生效
    if (session.isBusy()) return

    applyingConfig = (async () => {
      const resolved = resolveConfig()
      if (!resolved) {
        const record = store.getCloudConfig()
        if (record) failedConfigStamp = record.updatedAt
        return
      }
      const previous = lastGoodConfig

      // 先探测再拆：探测是纯 HTTP，不碰运行时，失败时旧实例毫发无伤
      const probe = await probeConfig({
        provider: resolved.provider,
        apiUrl: resolved.apiUrl,
        apiKey: resolved.apiKey,
        model: resolved.model,
      })
      if (!probe.ok) {
        failedConfigStamp = resolved.stamp
        logger.warn(`[cloud] new cloud config rejected: ${probe.reason}`)
        hub.publish({
          type: 'notice',
          level: 'warn',
          text: `新配置不可用（${probe.reason}），已保留原配置继续运行；修正后重新推送即可`,
          at: Date.now(),
          key: `config-rejected-${resolved.stamp}`,
        })
        return
      }
      if (probe.warning) logger.warn(`[cloud] config probe: ${probe.warning}`)

      logger.info(`[cloud] applying new cloud config: ${resolved.provider} / ${resolved.model}`)
      agentReady = false
      runningConfigStamp = null
      await agent.dispose().catch((error) => {
        logger.warn('[cloud] agent dispose failed:', error)
      })

      if (await startAgent(resolved)) {
        failedConfigStamp = null
        hub.publish({
          type: 'notice',
          level: 'info',
          text: `云端模型配置已生效：${resolved.provider} / ${resolved.model}`,
          at: Date.now(),
          key: `config-applied-${resolved.stamp}`,
        })
        return
      }

      // 回滚：坏配置不能把云端打死，用上一份可用配置重建
      failedConfigStamp = resolved.stamp
      if (previous && (await startAgent(previous))) {
        hub.publish({
          type: 'notice',
          level: 'warn',
          text: '新配置不可用，已回退到上一份可用配置；检查后重新推送即可',
          at: Date.now(),
          key: `config-rollback-${resolved.stamp}`,
        })
      }
    })()
    try {
      await applyingConfig
    } finally {
      applyingConfig = null
    }
  }

  /**
   * 懒初始化 + 轮次边界换配（F-10 / F-13）。
   * 没有配置时控制面照常工作（能看到设备、配对、健康检查），只是不能对话。
   */
  async function ensureAgent(): Promise<boolean> {
    if (applyingConfig) await applyingConfig
    if (agentReady) {
      // 配置换过就在本轮开始前生效；这一句是 F-13 的唯一触发点
      if (pendingConfigStamp() !== null) await applyConfig()
      return agentReady
    }
    if (agentInitializing) return agentInitializing
    agentInitializing = (async () => {
      const resolved = resolveConfig()
      if (!resolved) {
        hub.publish({
          type: 'notice',
          level: 'warn',
          text: '云端模型配置尚未推送，请在「云端配置」里填写后重试',
          at: Date.now(),
          key: 'missing-cloud-config',
        })
        return false
      }
      // 刚失败过的那份配置不再重试；有上一份可用配置就用它起来
      if (failedConfigStamp === resolved.stamp) {
        if (lastGoodConfig) return startAgent(lastGoodConfig)
        return false
      }
      // 首次建运行时**不探测**：拉历史（buildSnapshot → 这里）不能依赖供应商可达，
      // 否则网络抖一下连历史都看不见了。坏 Key 会在轮换时（有旧运行时可比）被拦下。
      const ok = await startAgent(resolved)
      if (!ok) failedConfigStamp = resolved.stamp
      return ok
    })()
    try {
      return await agentInitializing
    } finally {
      agentInitializing = null
    }
  }

  const sweeper = setInterval(() => {
    void dispatcher.sweepTimeouts().catch((error) => logger.warn('[cloud] sweeper failed:', error))
    loginLimiter.prune()
    pairLimiter.prune()
  }, 5_000)
  sweeper.unref?.()

  const cloudServer: CloudServer = {
    config,
    store,
    hub,
    dispatcher,
    session,
    server,
    snapshot: buildSnapshot,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.host, () => {
          hub.startHeartbeat()
          void ensureAgent()
          const address = server.address()
          const port = typeof address === 'object' && address ? address.port : config.port
          logger.info(`[cloud] listening on ${config.host}:${port}`)
          resolve(port)
        })
      }),
    close: async () => {
      closing = true
      clearInterval(sweeper)
      hub.stop()
      await session.stopReply().catch(() => undefined)
      await agent.dispose().catch(() => undefined)
      await store.flush().catch(() => undefined)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }

  return cloudServer
}

function sanitize(input: unknown): CloudWorkspaceInfo[] {
  if (!Array.isArray(input)) return []
  const result: CloudWorkspaceInfo[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const workspacePath = String(record.path ?? '').trim()
    if (!workspacePath) continue
    result.push({
      path: workspacePath.slice(0, 1024),
      name: String(record.name ?? workspacePath.split(/[\\/]/).pop() ?? 'workspace').slice(0, 80),
      remote: record.remote ? String(record.remote).slice(0, 300) : undefined,
      defaultBranch: record.defaultBranch ? String(record.defaultBranch).slice(0, 120) : undefined,
      isGit: record.isGit !== false,
    })
  }
  return result
}

/** 直接运行（systemd ExecStart）：失败一律非零退出，交给 Restart=always 重试 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).endsWith(path.join('dist', 'main.js'))

if (invokedDirectly) {
  const server = await createCloudServer()
  await server.listen()
  const shutdown = async (signal: string) => {
    console.log(`[cloud] ${signal} received, shutting down`)
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

export type { WebSocket }
