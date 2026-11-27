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
  CLOUD_PROTOCOL_CAPABILITIES,
  CLOUD_PROTOCOL_VERSION,
  CLOUD_WS_PATHS,
  isTerminalTaskStatus,
  normalizeResumeCursor,
  type ClientToServerFrame,
  type CloudAwaySummary,
  type CloudAwaySummaryItem,
  type CloudEvent,
  type CloudSnapshot,
  type CloudTaskSnapshot,
  type CloudWorkspaceInfo,
  type DeviceToServerFrame,
} from 'pi-bridge'
import { AgentManager, createFileModelsStore } from 'pi-bridge'
import { loadConfig, type CloudConfig } from './config.js'
import { CloudStore } from './store/store.js'
import { AttemptLimiter } from './auth/rate-limit.js'
import { readCookie, SESSION_COOKIE, verifySessionCookie } from './auth/session-cookie.js'
import { decryptSecret } from './secure/config-crypto.js'
import { Hub, type ClientPeer, type DevicePeer } from './ws/hub.js'
import { TaskDispatcher } from './tasks/dispatcher.js'
import {
  CLOUD_TOOL_NAMES,
  CloudSession,
  authorizationView,
} from './agent/cloud-session.js'
import { createCloudToolsExtension } from './agent/tools.js'
import { probeProviderKey } from './agent/provider-models.js'
import { createCloudCredentialStore } from './secure/cloud-credentials.js'
import { CloudMemoryStore } from './memory/memory-store.js'
import {
  CLOUD_DREAM_IDLE_MS,
  createCloudMemoryExtension,
  runDreamConsolidation,
  type AuxiliaryCompleter,
} from './memory/memory-engine.js'
import { buildRouter } from './http/routes.js'
import { defaultWebDir, serveStatic } from './http/static.js'
import { HttpError, isAllowedOrigin, readJsonBody, sendJson, sourceOf } from './http/router.js'
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
  memoryStore: CloudMemoryStore
  hub: Hub
  dispatcher: TaskDispatcher
  session: CloudSession
  server: Server
  snapshot: () => Promise<CloudSnapshot>
  listen: () => Promise<number>
  close: () => Promise<void>
}

export interface CloudServerHooks {
  /** 保存配置前的 Key 探测（默认打 catalog 的 baseUrl；测试里注入替身，避免外网） */
  probeConfig?: (
    input: { providerId: string; apiKey: string }
  ) => Promise<{ ok: true; warning?: string } | { ok: false; reason: string }>
  /** 覆盖记忆抽取 / 梦境整理的辅助模型调用（测试不走公网） */
  completeAuxiliary?: AuxiliaryCompleter
}

export async function createCloudServer(
  overrides: Partial<CloudConfig> = {},
  hooks: CloudServerHooks = {}
): Promise<CloudServer> {
  const probeConfig = hooks.probeConfig ?? probeProviderKey
  const config = loadConfig(overrides)
  await fs.mkdir(config.dataDir, { recursive: true })
  await fs.mkdir(config.workspaceDir, { recursive: true })
  await fs.mkdir(config.agentDir, { recursive: true })

  const store = await CloudStore.open(config.dataDir)
  const memoryStore = await CloudMemoryStore.open(config.dataDir)
  // 登录限速保留每源 5/5m + 并发 scrypt 上限，但不启用全局熔断（防外部伪造错误请求永久锁死管理员登录）；
  // 6 位配对码仍启用全局熔断防分布式穷举（A-45）。
  const loginLimiter = new AttemptLimiter({ globalLimit: Number.POSITIVE_INFINITY })
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

  /** 按设备串行化设备帧处理，避免同一设备的 task_worktree 与 unit_closed 跨 await 乱序覆盖 */
  const deviceFrameChains = new Map<string, Promise<void>>()
  const enqueueDeviceFrame = (peer: DevicePeer, frame: DeviceToServerFrame): void => {
    const prev = deviceFrameChains.get(peer.deviceId) ?? Promise.resolve()
    const next = prev
      .catch(() => undefined)
      .then(() => onDeviceFrame(peer, frame))
      .catch((error) => {
        logger.error('[cloud] device frame handler failed:', error)
      })
    deviceFrameChains.set(peer.deviceId, next)
    void next.then(() => {
      if (deviceFrameChains.get(peer.deviceId) === next) {
        deviceFrameChains.delete(peer.deviceId)
      }
    })
  }

  let activeAwaySummary: CloudAwaySummary | undefined

  function latchAwaySummary(): void {
    const since = store.getLastClientLeftAt()
    if (since === null) return
    const now = Date.now()
    activeAwaySummary = buildAwaySummary(store.listTasks(), since, now)
    void store.setLastClientLeftAt(null).catch(() => undefined)
  }

  // ------------------------------ 已读 / 未读游标（F-52 / C-03c） ------------------------------

  const unreadEventSeqs: number[] = []
  const seenTaskUnreadKeys = new Set<string>()
  const initialReadState = store.getReadState()
  /** 重启后尚未有新事件前，基于 lastReadAt 估算历史未读数；首次 markRead 清零 */
  let persistedUnreadAtBaseline = initialReadState.lastReadAt
  let lastReadSeqRuntime = 0

  function recordPublishedEvent(seq: number, event: CloudEvent): void {
    if (event.type === 'message_end') {
      if (event.messageId.startsWith('u-') || !event.text.trim()) return
      unreadEventSeqs.push(seq)
    } else if (event.type === 'task') {
      const status = event.task.status
      if (status !== 'waiting_human' && !isTerminalTaskStatus(status)) return
      const key = `${event.task.id}:${status}:${event.task.updatedAt}`
      if (seenTaskUnreadKeys.has(key)) return
      seenTaskUnreadKeys.add(key)
      if (seenTaskUnreadKeys.size > 500) seenTaskUnreadKeys.clear()
      unreadEventSeqs.push(seq)
    } else {
      return
    }
    if (unreadEventSeqs.length > 500) unreadEventSeqs.splice(0, unreadEventSeqs.length - 500)
  }

  function computeUnreadCount(messages?: CloudSnapshot['messages']): number {
    const liveUnread = unreadEventSeqs.filter((seq) => seq > lastReadSeqRuntime).length
    if (persistedUnreadAtBaseline === null) return liveUnread
    // 进程重启后 lastSeq 归零：若用户上次已读时间早于已落盘的助手消息/终态工单，补计它们
    let persisted = 0
    if (messages) {
      for (const message of messages) {
        if (message.role === 'assistant' && message.at > persistedUnreadAtBaseline) persisted += 1
      }
    }
    for (const task of store.listTasks()) {
      const doneAt = task.finishedAt ?? task.updatedAt
      if (
        (task.status === 'waiting_human' || isTerminalTaskStatus(task.status)) &&
        doneAt > persistedUnreadAtBaseline
      ) {
        persisted += 1
      }
    }
    return Math.max(liveUnread, persisted)
  }

  async function markRead(requestedSeq?: number): Promise<{ lastReadSeq: number; unreadCount: number }> {
    const now = Date.now()
    const currentLastSeq = hub.lastClientSeq()
    const targetSeq =
      typeof requestedSeq === 'number' && Number.isFinite(requestedSeq)
        ? Math.min(Math.max(0, Math.floor(requestedSeq)), currentLastSeq)
        : currentLastSeq
    lastReadSeqRuntime = Math.max(lastReadSeqRuntime, targetSeq)
    persistedUnreadAtBaseline = null
    while (unreadEventSeqs.length > 0 && unreadEventSeqs[0] <= lastReadSeqRuntime) {
      unreadEventSeqs.shift()
    }
    const unreadCount = unreadEventSeqs.length
    await store.setReadState(lastReadSeqRuntime, now)
    hub.publish({
      type: 'read_state',
      lastReadSeq: lastReadSeqRuntime,
      unreadCount,
      at: now,
    })
    return { lastReadSeq: lastReadSeqRuntime, unreadCount }
  }

  const hub = new Hub(
    {
      logger,
      buildSnapshot: () => buildSnapshot(),
      onPublished: (seq, event) => recordPublishedEvent(seq, event),
      onClientFrame: (peer, frame) => {
        void onClientFrame(peer, frame).catch((error) => {
          logger.error('[cloud] client frame handler failed:', error)
        })
      },
      onDeviceFrame: (peer, frame) => enqueueDeviceFrame(peer, frame),
      onDeviceOffline: (deviceId) => {
        void onDeviceOffline(deviceId).catch((error) => {
          logger.error('[cloud] device offline handler failed:', error)
        })
      },
      onDeviceOnline: (deviceId) => {
        void onDeviceOnline(deviceId).catch((error) => {
          logger.error('[cloud] device online handler failed:', error)
        })
      },
      onClientHello: () => undefined,
      onClientConnected: (wasEmpty) => {
        if (wasEmpty) latchAwaySummary()
      },
      onClientsEmpty: () => {
        activeAwaySummary = undefined
        if (!closing) {
          void store.setLastClientLeftAt(Date.now()).catch(() => undefined)
        }
      },
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
    // GET /v1/snapshot 保持无破坏性：仅在尚未初始化时懒启动，绝不触发已运行实例的销毁/重建（配置轮换只在轮次边界生效）。
    await ensureAgent({ applyPendingConfig: false }).catch(() => false)
    // 覆盖 HTTP GET /v1/snapshot 直接拉取（尚未建 WS 时同样能拿到离线期汇总）
    if (store.getLastClientLeftAt() !== null) {
      latchAwaySummary()
    }
    const messages = await session.history()
    return {
      serverVersion: config.version,
      protocol: CLOUD_PROTOCOL_VERSION,
      capabilities: [...CLOUD_PROTOCOL_CAPABILITIES],
      lastSeq: hub.lastClientSeq(),
      lastReadSeq: lastReadSeqRuntime,
      unreadCount: computeUnreadCount(messages),
      cloud: session.runtimeState(),
      messages,
      tasks: store.listTasks().map((task) =>
        task.progress.diff ? { ...task, progress: { ...task.progress, diff: undefined } } : task
      ),
      devices: dispatcher.deviceSnapshots(),
      units: dispatcher.unitViews(),
      authorizations: store.activeAuthorizations().map(authorizationView),
      ...(activeAwaySummary ? { awaySummary: activeAwaySummary } : {}),
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
    probeConfig,
    onDeviceRevoked: (deviceId) => hub.disconnectDevice(deviceId),
    onWorkspacesUpdated: (deviceId) => publishDevice(deviceId),
    onLogout: () => hub.disconnectWebClients(),
    onMarkRead: (seq) => markRead(seq),
    memoryStore,
    onRunDream: () => triggerDream('manual'),
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

  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      try {
        let url: URL
        try {
          url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
        } catch {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
          socket.destroy()
          return
        }
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
          const clientAuth = authenticateClient(req)
          if (!clientAuth.ok) {
            socket.write(
              clientAuth.status === 403
                ? 'HTTP/1.1 403 Forbidden\r\n\r\n'
                : 'HTTP/1.1 401 Unauthorized\r\n\r\n'
            )
            socket.destroy()
            return
          }
          wsServer.handleUpgrade(req, socket, head, (ws) => {
            hub.addClient(
              ws,
              Number.isFinite(resumeFrom) ? resumeFrom : null,
              clientAuth.deviceId
            )
          })
          return
        }

        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
      } catch (error) {
        logger.error('[cloud] ws upgrade failed:', error)
        try {
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
          socket.destroy()
        } catch {
          // ignore
        }
      }
    })()
  })

  function authenticateDevice(req: IncomingMessage) {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token) return undefined
    const device = store.findDeviceByToken(token)
    if (!device) return undefined
    void store.updateDevice(device.id, { lastSeenAt: Date.now() }).catch(() => undefined)
    return device
  }

  /** 一机双 token：执行通道 token 仅限 /device/ws，控制面 /client/ws 只认 Cookie（强制非空精确 Origin 防 CSWSH）或桌面控制面 clientToken */
  function authenticateClient(
    req: IncomingMessage
  ): { ok: true; deviceId?: string } | { ok: false; status: 401 | 403 } {
    const cookie = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (
      store.getAccount() &&
      verifySessionCookie(config.cookieSecret, cookie, Date.now(), store.getSessionVersion())
    ) {
      if (!isAllowedOrigin(req, { requireOrigin: true })) return { ok: false, status: 403 }
      return { ok: true }
    }
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (token) {
      const device = store.findDeviceByClientToken(token)
      if (device) {
        void store.updateDevice(device.id, { lastSeenAt: Date.now() }).catch(() => undefined)
        return { ok: true, deviceId: device.id }
      }
    }
    return { ok: false, status: 401 }
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
        if (typeof frame.text !== 'string') return
        lastActivityAt = Date.now()
        // 用户回到会话发言后清空离线汇总与未读数，避免旧提醒一直挂着
        activeAwaySummary = undefined
        await markRead()
        await ensureAgent()
        await session.say(frame.text, typeof frame.clientMessageId === 'string' ? frame.clientMessageId : `say-${Date.now()}`)
        return
      case 'confirm_plan':
        if (typeof frame.planText !== 'string' || !Array.isArray(frame.items)) return
        await markRead()
        await ensureAgent()
        await confirmPlan(frame.planText, frame.items, frame.quota)
        return
      case 'mark_read':
        await markRead(typeof frame.seq === 'number' ? frame.seq : undefined)
        return
      case 'task_message': {
        if (typeof frame.taskId !== 'string' || typeof frame.text !== 'string') return
        const text = frame.text.trim()
        if (!frame.taskId || !text) return
        const task = store.findTask(frame.taskId)
        if (!task || isTerminalTaskStatus(task.status)) {
          hub.publish({
            type: 'notice',
            level: 'warn',
            text: `工单 ${frame.taskId} 已结束或不存在，补充指令未送达`,
            at: Date.now(),
            key: `task-msg-${frame.taskId}`,
          })
          return
        }
        if (!hub.isDeviceOnline(task.spec.deviceId)) {
          hub.publish({
            type: 'notice',
            level: 'warn',
            text: `设备离线，补充指令未能送达 ${task.id}`,
            at: Date.now(),
            key: `task-msg-offline-${task.id}`,
          })
          return
        }
        if (task.status === 'waiting_human') {
          await dispatcher.answerTask(task.id, text, task.question?.id)
        } else {
          hub.sendToDevice(
            task.spec.deviceId,
            { v: 1, type: 'task_message', seq: 0, taskId: task.id, text, at: Date.now() },
            task.id
          )
        }
        await markRead()
        hub.publish({
          type: 'notice',
          level: 'info',
          text:
            task.status === 'waiting_human'
              ? `已向 ${task.id} 回复提问`
              : `已向 ${task.id} 发送补充指令`,
          at: Date.now(),
          key: `task-msg-ok-${task.id}-${Date.now()}`,
        })
        return
      }
      case 'stop_reply':
        await session.stopReply()
        return
      case 'stop_task': {
        if (typeof frame.taskId !== 'string' || !frame.taskId) return
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
        if (typeof frame.unitId !== 'string' || !frame.unitId) return
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

  const deviceSeenPersistedAt = new Map<string, number>()
  const DEVICE_LAST_SEEN_PERSIST_MS = 30_000

  async function onDeviceFrame(peer: DevicePeer, frame: DeviceToServerFrame): Promise<void> {
    if (closing) return
    const now = Date.now()
    const lastPersisted = deviceSeenPersistedAt.get(peer.deviceId) ?? 0
    if (now - lastPersisted >= DEVICE_LAST_SEEN_PERSIST_MS) {
      deviceSeenPersistedAt.set(peer.deviceId, now)
      await store.updateDevice(peer.deviceId, { lastSeenAt: now })
    }
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
    providerId: string
    model: string
    credentialCipher: string
    credential: { type: 'api_key'; key?: string } | { type: 'oauth'; [key: string]: unknown }
  }

  /** 回滚到上一份可用配置时的内存凭证覆盖，避免读取磁盘上已写入的坏配置 */
  let rollbackConfigOverride: { providerId: string; credentialCipher: string } | null = null

  /**
   * 云端凭证存储：读 `CloudStore` 里那条加密记录，凭证整体（含 OAuth token）
   * 只在内存里解密。与设备端各自独立、互不同步（D19）。
   */
  const credentials = createCloudCredentialStore({
    readConfig: () => {
      if (rollbackConfigOverride) return rollbackConfigOverride
      const record = store.getCloudConfig()
      return record ? { providerId: record.providerId, credentialCipher: record.credentialCipher } : null
    },
    saveCredential: (providerId, credentialCipher) => {
      if (rollbackConfigOverride && rollbackConfigOverride.providerId === providerId) {
        rollbackConfigOverride = { providerId, credentialCipher }
      }
      return store.saveCloudCredential(providerId, credentialCipher)
    },
    clearCredential: () => {
      rollbackConfigOverride = null
      return store.clearCloudConfig()
    },
    encryptionKey: config.encryptionKey,
    logger,
  })

  /** 读磁盘配置并解密凭证；解密失败返回 null（换过 `PI_CLOUD_ENC_KEY` 的典型表现） */
  function resolveConfig(): ResolvedCloudConfig | null {
    const record = store.getCloudConfig()
    if (!record) return null
    try {
      const credential = JSON.parse(
        decryptSecret(record.credentialCipher, config.encryptionKey)
      ) as ResolvedCloudConfig['credential']
      return {
        stamp: record.updatedAt,
        providerId: record.providerId,
        model: record.model,
        credentialCipher: record.credentialCipher,
        credential,
      }
    } catch {
      logger.error('[cloud] cannot decrypt the stored credential; re-push it from the client')
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

  let lastActivityAt = Date.now()
  let dreamRunning = false

  const completeAuxiliary: AuxiliaryCompleter =
    hooks.completeAuxiliary ??
    ((systemPrompt, userPrompt, options) =>
      agent.completeAuxiliaryPrompt(systemPrompt, userPrompt, options))

  async function triggerDream(trigger: 'idle' | 'manual') {
    if (dreamRunning) return null
    dreamRunning = true
    try {
      if (trigger === 'manual') {
        await ensureAgent().catch(() => false)
      }
      const record = await runDreamConsolidation(memoryStore, trigger, completeAuxiliary)
      if (record) {
        hub.publish({
          type: 'notice',
          level: 'info',
          text: `梦境整理：${record.summary}`,
          at: record.at,
          key: `dream-${record.id}`,
        })
        logger.info(`[cloud] dream (${trigger}): ${record.summary}`)
      }
      return record
    } catch (error) {
      logger.warn('[cloud] dream consolidation failed:', error)
      return null
    } finally {
      dreamRunning = false
    }
  }

  function hasActiveTasks(): boolean {
    return store.listTasks().some((task) => !isTerminalTaskStatus(task.status))
  }

  /** 用给定配置建运行时并续上唯一会话 */
  async function startAgent(resolved: ResolvedCloudConfig): Promise<boolean> {
    const result = await agent.initialize({
      workspaceDir: config.workspaceDir,
      agentDir: config.agentDir,
      apiConfig: { providerId: resolved.providerId, modelId: resolved.model },
      credentials,
      modelsStore: createFileModelsStore({ path: path.join(config.dataDir, 'models-store.json') }),
      allowModelNetwork: true,
      logger,
      // 云端会话：无审批（mode=auto）、不挂计划与工作树扩展、工具白名单只有六个
      builtinExtensions: { approval: false, plan: false, worktree: false },
      toolAllowlist: [...CLOUD_TOOL_NAMES],
      extensionFactories: [
        createCloudToolsExtension({ store, hub, dispatcher }),
        createCloudMemoryExtension(memoryStore, {
          complete: completeAuxiliary,
          logger,
        }),
      ],
      getDefaultPermissionLevel: () => 'auto',
      onAgentSettled: () => {
        lastActivityAt = Date.now()
        session.onSettled()
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
    logger.info(`[cloud] cloud agent ready (${resolved.providerId} / ${resolved.model})`)
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

      logger.info(`[cloud] applying new cloud config: ${resolved.providerId} / ${resolved.model}`)
      agentReady = false
      runningConfigStamp = null
      await agent.dispose().catch((error) => {
        logger.warn('[cloud] agent dispose failed:', error)
      })

      if (await startAgent(resolved)) {
        rollbackConfigOverride = null
        failedConfigStamp = null
        hub.publish({
          type: 'notice',
          level: 'info',
          text: `云端模型配置已生效：${resolved.providerId} / ${resolved.model}`,
          at: Date.now(),
          key: `config-applied-${resolved.stamp}`,
        })
        return
      }

      // 回滚：坏配置不能把云端打死，切回上一份可用配置的内存凭证重建，绝不读磁盘上的坏凭证
      failedConfigStamp = resolved.stamp
      if (previous) {
        rollbackConfigOverride = {
          providerId: previous.providerId,
          credentialCipher: previous.credentialCipher,
        }
        if (await startAgent(previous)) {
          hub.publish({
            type: 'notice',
            level: 'warn',
            text: '新配置不可用，已回退到上一份可用配置；检查后重新推送即可',
            at: Date.now(),
            key: `config-rollback-${resolved.stamp}`,
          })
        } else {
          rollbackConfigOverride = null
        }
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
   * `applyPendingConfig: false` 用于只读快照路径：冷启时拉历史，但不销毁重建已有运行时。
   */
  async function ensureAgent(options: { applyPendingConfig?: boolean } = {}): Promise<boolean> {
    const applyPendingConfig = options.applyPendingConfig !== false
    if (applyingConfig) await applyingConfig
    if (agentReady) {
      // 配置换过就在本轮开始前生效；这一句是 F-13 的唯一触发点
      if (applyPendingConfig && pendingConfigStamp() !== null) await applyConfig()
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
    // F-41：无活跃工单且空闲 ≥30 分钟、且自上次整理以来有新活动或自动记忆可整理时，触发梦境整理
    const now = Date.now()
    if (
      agentReady &&
      !dreamRunning &&
      !session.isBusy() &&
      !hasActiveTasks() &&
      now - lastActivityAt >= CLOUD_DREAM_IDLE_MS &&
      lastActivityAt > memoryStore.lastDreamAt() &&
      memoryStore.listMemories().some((item) => item.source !== 'manual')
    ) {
      void triggerDream('idle')
    }
  }, 5_000)
  sweeper.unref?.()

  let closePromise: Promise<void> | null = null

  const cloudServer: CloudServer = {
    config,
    store,
    memoryStore,
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
    close: () => {
      if (closePromise) return closePromise
      closePromise = (async () => {
        closing = true
        clearInterval(sweeper)
        hub.stop()
        await session.stopReply().catch(() => undefined)
        await agent.dispose().catch(() => undefined)
        await memoryStore.flush().catch(() => undefined)
        await store.flush().catch(() => undefined)
        store.close()
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          // 主动断开空闲 HTTP keep-alive 连接，防止优雅退出无限挂起
          server.closeAllConnections?.()
        })
      })()
      return closePromise
    },
  }

  return cloudServer
}

function formatAwayItemStatus(item: CloudAwaySummaryItem): string {
  switch (item.status) {
    case 'done':
      return '已完成'
    case 'failed':
      return '失败'
    case 'waiting_human':
      return '等待决定'
    case 'interrupted':
      return '因退出应用中断'
    case 'cancelled':
      return item.terminalReason === 'device-offline' ? '因设备离线取消' : '已取消'
    case 'expired':
      return '派发超时'
    case 'rejected':
      return '被拒绝'
    default:
      return item.status
  }
}

/** 构造「你离开期间…」汇总（F-51 / A-23）；无终态或等待决定工单时返回 undefined */
export function buildAwaySummary(
  tasks: CloudTaskSnapshot[],
  since: number,
  until: number
): CloudAwaySummary | undefined {
  const items: CloudAwaySummaryItem[] = []
  for (const task of tasks) {
    if (isTerminalTaskStatus(task.status)) {
      const at = task.finishedAt ?? task.updatedAt
      if (at >= since) {
        items.push({
          taskId: task.id,
          title: task.spec.title,
          status: task.status,
          terminalReason: task.terminalReason,
          at,
        })
      }
      continue
    }
    if (task.status === 'waiting_human' && task.updatedAt >= since) {
      items.push({
        taskId: task.id,
        title: task.spec.title,
        status: task.status,
        at: task.updatedAt,
      })
    }
  }
  if (items.length === 0) return undefined
  items.sort((a, b) => a.at - b.at)
  const text = `你离开期间：${items
    .map((item) => `${item.taskId}（${item.title}）${formatAwayItemStatus(item)}`)
    .join('；')}`
  return { since, until, items, text }
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
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[cloud] ${signal} received, shutting down`)
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

export type { WebSocket }
