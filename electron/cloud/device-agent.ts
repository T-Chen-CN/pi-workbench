/**
 * 终端侧 device agent（G6 / G7 / F-19）。
 *
 * 职责边界：**只做通道与派活**，不承载云端逻辑。连上云端后上报工作区清单，
 * 收工单就交给 `CloudTaskRunner`，结果 / 进度按帧回传。断线时帧进有界队列，
 * 重连后带 `lastAckSeq` 续传。
 */

import { WebSocket } from 'ws'
import {
  CLOUD_PROTOCOL_VERSION,
  CLOUD_WS_PATHS,
  type CloudChangedFile,
  type CloudTaskSpec,
  type DeviceToServerFrame,
  type ServerToDeviceFrame,
} from 'pi-bridge'
import {
  readCloudLink,
  readCloudToken,
  touchCloudLink,
  wsUrl,
  type CloudLinkRecord,
} from './link-store.js'
import { CloudTaskRunner } from './task-runner.js'

/** 出站帧不带 v（序列化时统一补），否则联合类型要求每条调用都手写版本号 */
type OutgoingDeviceFrame = DeviceToServerFrame extends infer Frame
  ? Frame extends unknown
    ? Omit<Frame, 'v'>
    : never
  : never

const HEARTBEAT_MS = 25_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const OUTBOX_LIMIT = 1_000

export type DeviceLinkStatus = 'unlinked' | 'connecting' | 'online' | 'offline' | 'error'

export interface DeviceLinkState {
  status: DeviceLinkStatus
  deviceId?: string
  baseUrl?: string
  lastError?: string
  lastConnectedAt?: number
  /**
   * 已被云端解绑（F-08 / A-15）：服务端在 WS 升级阶段直接回 401，
   * 拿不到关闭码，只能看 HTTP 状态。这类失败重连没有意义，必须停手让用户重新配对。
   */
  revoked?: boolean
  /** 队列里还没送出去的帧数（离线时 > 0） */
  pending: number
}

export interface DeviceAgentDeps {
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
  dataDir: string
  getWorkspaces: () => Promise<
    Array<{ path: string; name: string; remote?: string; defaultBranch?: string; isGit: boolean }>
  >
  /** 校验云端下发的 repo 路径是否属于受信任工作区（可选；省略时按 getWorkspaces() 列表校验） */
  isAllowedWorkspace?: (workspacePath: string) => boolean | Promise<boolean>
  getApiConfig: CloudTaskRunnerDeps_Pick
  getCoordinator: CloudTaskRunnerDeps_Coordinator
  onStateChange?: (state: DeviceLinkState) => void
}

// 只取 task-runner 需要的两个依赖，避免把整个类型面暴露给上层
type CloudTaskRunnerDeps_Pick = ConstructorParameters<typeof CloudTaskRunner>[0]['getApiConfig']
type CloudTaskRunnerDeps_Coordinator = ConstructorParameters<
  typeof CloudTaskRunner
>[0]['getCoordinator']

export class DeviceAgent {
  private deps: DeviceAgentDeps
  private runner: CloudTaskRunner
  private socket: WebSocket | null = null
  private link: CloudLinkRecord | null = null
  private token = ''
  private heartbeat: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelay = RECONNECT_MIN_MS
  private outbox: OutgoingDeviceFrame[] = []
  private lastAckSeq = 0
  private stopped = false
  private durableStop = false
  private state: DeviceLinkState = { status: 'unlinked', pending: 0 }
  /** 未完成的工单：断线重连后要重新对齐状态 */
  private running = new Set<string>()

  constructor(deps: DeviceAgentDeps) {
    this.deps = deps
    this.runner = new CloudTaskRunner({
      logger: deps.logger,
      dataDir: deps.dataDir,
      isAllowedWorkspace: async (workspacePath: string) => {
        if (deps.isAllowedWorkspace) {
          return await deps.isAllowedWorkspace(workspacePath)
        }
        const workspaces = await deps.getWorkspaces()
        const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        const target = norm(workspacePath)
        return workspaces.some((ws) => norm(ws.path) === target)
      },
      getApiConfig: deps.getApiConfig,
      getCoordinator: deps.getCoordinator,
      onStatus: (taskId, status) => this.send({ type: 'task_status', taskId, status, at: Date.now() }),
      onWorktree: (taskId, unitId, worktreePath, branch) =>
        this.send({
          type: 'task_worktree',
          taskId,
          unitId,
          path: worktreePath,
          branch,
          at: Date.now(),
        }),
      onMilestone: (taskId, milestone) => this.send({ type: 'task_milestone', taskId, milestone }),
      onQuestion: (taskId, questionId, text) =>
        this.send({ type: 'task_question', taskId, questionId, text, at: Date.now() }),
      onResult: (taskId, result) => {
        this.running.delete(taskId)
        this.send({ type: 'task_result', taskId, result, at: Date.now() })
      },
      onFailed: (taskId: string, error: string, changedFiles?: CloudChangedFile[], worktreeClean?: boolean) => {
        this.running.delete(taskId)
        this.send({
          type: 'task_failed',
          taskId,
          error,
          changedFiles,
          worktreeClean,
          at: Date.now(),
        })
      },
      onInterrupted: (taskId: string, reason: string, worktreeClean?: boolean) => {
        this.running.delete(taskId)
        this.send({ type: 'task_interrupted', taskId, reason, worktreeClean, at: Date.now() })
      },
      // 工作单元回收回执与兜底状态（F-19a / A-43）
      onUnitClosed: (unitId, result) =>
        this.send({ type: 'unit_closed', unitId, ...result, at: Date.now() }),
      onUnitState: (unitId, state) =>
        this.send({ type: 'unit_state', unitId, ...state, at: Date.now() }),
    })
  }

  getState(): DeviceLinkState {
    return { ...this.state, pending: this.outbox.length }
  }

  /** 启动：读回凭据 → 恢复上次未完成工单 → 连接 */
  async start(): Promise<void> {
    this.stopped = false
    this.durableStop = false
    await this.runner.load()
    await this.runner.recoverInterrupted()
    // A-43 兜底：上报本地台账里每个单元的工作树状态（干净且已收敛的会被云端自动回收）
    await this.runner.sweepUnits().catch((error) =>
      this.deps.logger.warn('[Cloud Device] unit sweep failed:', error)
    )
    this.link = readCloudLink()
    if (!this.link) {
      this.updateState({ status: 'unlinked' })
      return
    }
    this.token = readCloudToken(this.link)
    if (!this.token) {
      this.updateState({ status: 'error', lastError: 'Saved token cannot be decrypted; pair again.' })
      return
    }
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimers()
    this.socket?.close()
    this.socket = null
    await this.runner.dispose()
  }

  /** 换了云端 / 重新配对：丢掉旧连接与凭据 */
  async unlink(): Promise<void> {
    this.durableStop = true
    this.clearTimers()
    this.socket?.close()
    this.socket = null
    this.link = null
    this.token = ''
    this.outbox = []
    this.lastAckSeq = 0
    this.updateState({ status: 'unlinked' })
    await this.runner.dispose()
  }

  /** 手动重连（换网络 / 云端重启）；不重置凭据，也不销毁执行器 */
  async reconnect(): Promise<void> {
    this.stopped = false
    this.durableStop = false
    this.clearTimers()
    this.socket?.close()
    this.socket = null
    this.link = readCloudLink()
    if (!this.link) {
      this.updateState({ status: 'unlinked' })
      return
    }
    this.token = readCloudToken(this.link)
    if (!this.token) {
      this.updateState({ status: 'error', lastError: 'Saved token cannot be decrypted; pair again.' })
      return
    }
    this.reconnectDelay = RECONNECT_MIN_MS
    await this.connect()
  }

  /** 工作区清单变化：在线时立刻重发，离线时等重连的 hello */
  async refreshWorkspaces(): Promise<void> {
    if (!this.link) return
    const workspaces = await this.deps.getWorkspaces()
    this.send({ type: 'workspaces', workspaces })
  }

  /** 用户点了「停止工单」之外的中断：app 退出前把在跑的工单标 interrupted */
  async interruptRunning(): Promise<void> {
    for (const taskId of [...this.running]) {
      this.send({ type: 'task_interrupted', taskId, reason: 'app-quit', at: Date.now() })
    }
    this.running.clear()
    // 尽量把队列冲出去；shutdown 有超时，最多等 1.5s
    await this.flush(1_500)
  }

  // ------------------------------------------------------------------ 通道

  private async connect(): Promise<void> {
    if (this.stopped || this.durableStop || !this.link || !this.token) return
    this.updateState({ status: 'connecting', revoked: false })
    const url = `${wsUrl(this.link.baseUrl, CLOUD_WS_PATHS.device)}?lastAckSeq=${this.lastAckSeq}`
    let socket: WebSocket
    try {
      socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } })
    } catch (error) {
      this.scheduleReconnect(error)
      return
    }
    this.socket = socket

    socket.on('open', () => {
      void this.onOpen(socket)
    })
    socket.on('message', (raw) => {
      this.onMessage(raw)
    })
    socket.on('close', (code) => {
      if (this.socket === socket) this.socket = null
      this.stopHeartbeat()
      if (this.stopped || this.durableStop) return
      if (code === 1008 || code === 4401) {
        this.markRevoked()
        return
      }
      this.updateState({ status: 'offline' })
      this.scheduleReconnect(new Error(`socket closed (${code})`))
    })
    // 升级阶段被拒（解绑后重连）：`ws` 不会发关闭码，只有 HTTP 状态码
    socket.on('unexpected-response', (request, response) => {
      const status = response.statusCode ?? 0
      try {
        response.resume()
        request.destroy()
      } catch {
        // 清理失败不影响结论
      }
      if (this.socket === socket) this.socket = null
      this.stopHeartbeat()
      if (this.stopped || this.durableStop) return
      if (status === 401 || status === 403) {
        this.markRevoked()
        return
      }
      this.updateState({ status: 'offline' })
      this.scheduleReconnect(new Error(`handshake rejected with ${status}`))
    })
    socket.on('error', (error) => {
      this.deps.logger.warn('[Cloud Device] socket error:', error)
    })
  }

  private async onOpen(socket: WebSocket): Promise<void> {
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
    this.reconnectDelay = RECONNECT_MIN_MS
    this.updateState({
      status: 'online',
      lastError: undefined,
      revoked: false,
      lastConnectedAt: Date.now(),
    })
    if (this.link) void touchCloudLink(this.link)
    const workspaces = await this.deps.getWorkspaces().catch(() => [])
    // await 期间连接可能已断开或被替换，必须复检当前 socket
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN || this.stopped || this.durableStop) {
      return
    }
    this.send({
      type: 'hello',
      deviceId: this.link?.deviceId ?? '',
      workspaces,
      // 重连对账（F-21 / A-13）：服务端据此把掉线期间已判终态的工单重新下发 cancel
      runningTasks: [...this.running],
    })
    this.startHeartbeat()
    await this.flush(0)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      this.send({ type: 'heartbeat', at: Date.now() })
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  /** 已被云端解绑：停手，等用户重新配对（F-08 / A-15） */
  private markRevoked(): void {
    this.durableStop = true
    this.clearTimers()
    this.outbox = []
    this.updateState({
      status: 'error',
      revoked: true,
      lastError: 'This device was removed from the cloud; pair it again.',
    })
  }

  private scheduleReconnect(error: unknown): void {
    if (this.stopped || this.durableStop) return
    if (this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(this.reconnectDelay * 1.8))
    this.updateState({
      status: 'offline',
      lastError: error instanceof Error ? error.message : undefined,
    })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private clearTimers(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private send(frame: OutgoingDeviceFrame): void {
    const socket = this.socket
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ v: CLOUD_PROTOCOL_VERSION, ...frame }))
        return
      } catch (error) {
        this.deps.logger.warn('[Cloud Device] send failed, queueing:', error)
      }
    }
    // 离线：有界队列，丢最旧的（进度帧本来就可丢，终态帧重连后还能再发）
    this.outbox.push(frame)
    if (this.outbox.length > OUTBOX_LIMIT) this.outbox.splice(0, this.outbox.length - OUTBOX_LIMIT)
    this.updateState({})
  }

  private async flush(timeoutMs: number): Promise<void> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const pending = this.outbox
    this.outbox = []
    const sendPromises: Promise<void>[] = []
    for (let i = 0; i < pending.length; i += 1) {
      const frame = pending[i]
      try {
        const payload = JSON.stringify({ v: CLOUD_PROTOCOL_VERSION, ...frame })
        if (timeoutMs > 0) {
          sendPromises.push(
            new Promise<void>((resolve) => {
              socket.send(payload, () => resolve())
            })
          )
        } else {
          socket.send(payload)
        }
      } catch {
        // 第 i 帧发送失败时必须把剩余未发帧全部放回队列，不能丢弃 i+1..n
        this.outbox.unshift(...pending.slice(i))
        break
      }
    }
    if (timeoutMs > 0 && sendPromises.length > 0) {
      await Promise.race([
        Promise.all(sendPromises),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs)
          timer.unref?.()
        }),
      ])
    }
    this.updateState({})
  }

  private onMessage(raw: unknown): void {
    let frame: ServerToDeviceFrame
    try {
      const text = typeof raw === 'string' ? raw : String(raw)
      frame = JSON.parse(text) as ServerToDeviceFrame
    } catch {
      this.deps.logger.warn('[Cloud Device] dropped a malformed frame')
      return
    }
    if (!frame || typeof frame !== 'object') return
    if ((frame as { v?: number }).v !== CLOUD_PROTOCOL_VERSION) {
      this.deps.logger.warn('[Cloud Device] protocol version mismatch; ignoring frame')
      return
    }

    const ackIfSequenced = () => {
      const seq = (frame as { seq?: unknown }).seq
      if (typeof seq === 'number' && seq > 0) {
        if (seq > this.lastAckSeq) this.lastAckSeq = seq
        this.send({ type: 'ack', seq })
      }
    }

    switch (frame.type) {
      case 'ack':
        if (typeof frame.seq === 'number' && frame.seq > this.lastAckSeq) this.lastAckSeq = frame.seq
        return
      case 'task':
        ackIfSequenced()
        this.running.add(frame.task.id)
        void this.runner.start(frame.task.id, frame.task.spec as CloudTaskSpec)
        return
      case 'task_cancel':
        ackIfSequenced()
        this.running.delete(frame.taskId)
        void this.runner.cancel(frame.taskId, frame.reason)
        return
      case 'task_answer':
        ackIfSequenced()
        void this.runner.answer(frame.taskId, frame.text, frame.questionId)
        return
      case 'task_message':
        ackIfSequenced()
        void this.runner.message(frame.taskId, frame.text)
        return
      case 'close_unit':
        ackIfSequenced()
        // F-19a：回收工作单元（先判干净再删，脏树保留）
        void this.runner.closeUnit(frame.unitId).catch((error) =>
          this.deps.logger.error('[Cloud Device] close unit failed:', error)
        )
        return
      case 'pong':
        return
      case 'error':
        this.deps.logger.warn(`[Cloud Device] server error ${frame.code}: ${frame.message}`)
        if (frame.fatal) {
          this.updateState({ status: 'error', lastError: frame.message })
          this.durableStop = true
          this.socket?.close()
        }
        return
      default:
        return
    }
  }

  private updateState(patch: Partial<DeviceLinkState>): void {
    const next: DeviceLinkState = {
      ...this.state,
      ...patch,
      pending: this.outbox.length,
      deviceId: this.link?.deviceId ?? this.state.deviceId,
      baseUrl: this.link?.baseUrl ?? this.state.baseUrl,
    }
    this.state = next
    try {
      this.deps.onStateChange?.(this.getState())
    } catch (error) {
      this.deps.logger.warn('[Cloud Device] state listener failed:', error)
    }
  }
}
