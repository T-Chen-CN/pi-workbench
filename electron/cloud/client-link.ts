/**
 * 桌面端云端页的客户端通道（F-34 / D-22）。
 *
 * 渲染层不开 WS：token 在主进程，连接也留在主进程，渲染层只通过 IPC 收帧 / 发帧。
 * 与 Web 客户端走同一套帧格式（`ServerToClientFrame` / `ClientToServerFrame`），
 * 不新增协议。
 */

import { WebSocket } from 'ws'
import {
  CLOUD_PROTOCOL_VERSION,
  CLOUD_WS_PATHS,
  buildSnapshotRequest,
  clientCursorQuery,
  type ClientToServerFrame,
  type ServerToClientFrame,
} from 'pi-bridge'
import { readCloudLink, readCloudToken, wsUrl } from './link-store.js'

const HEARTBEAT_MS = 25_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export type CloudClientState =
  | { status: 'closed' }
  | { status: 'connecting' }
  | { status: 'open'; lastSeq: number }
  /**
   * `revoked`：设备已被云端解绑（F-08 / A-15），已停止重连，UI 应引导重新配对。
   * `fatal`：服务端以 `fatal` 错误帧拒绝（协议版本不匹配等，F-47 / A-27），重连也不会成功。
   */
  | { status: 'error'; error: string; revoked?: boolean; fatal?: boolean }

type OutgoingClientFrame = ClientToServerFrame extends infer Frame
  ? Frame extends unknown
    ? Omit<Frame, 'v'>
    : never
  : never

export interface CloudClientBridgeDeps {
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
  onFrame: (frame: ServerToClientFrame) => void
  onState: (state: CloudClientState) => void
}

export class CloudClientBridge {
  private deps: CloudClientBridgeDeps
  private socket: WebSocket | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelay = RECONNECT_MIN_MS
  private lastAckSeq = 0
  private closed = true
  /** 解绑后永久停手（直到用户重新打开 / 重新配对） */
  private durableStop = false
  private state: CloudClientState = { status: 'closed' }

  constructor(deps: CloudClientBridgeDeps) {
    this.deps = deps
  }

  getState(): CloudClientState {
    return this.state
  }

  getLastAckSeq(): number {
    return this.lastAckSeq
  }

  /**
   * 打开（或复用）连接；未配对时直接报错，不静默失败。
   *
   * 连接已活着时也要**主动要一份快照**：渲染层重载后 store 是空的，而主进程的
   * socket 与游标都还在。复用它却不补快照，页面就一直白着（历史「消失」）。
   */
  open(): CloudClientState {
    const link = readCloudLink()
    if (!link) {
      this.updateState({ status: 'error', error: 'This device is not paired' })
      return this.state
    }
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.requestSnapshot()
      return this.state
    }
    if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      return this.state
    }
    this.closed = false
    this.durableStop = false
    void this.connect(link.baseUrl, readCloudToken(link))
    return this.state
  }

  /** 让服务端重发整份快照：`resume(0)` 就是「游标为空」；连接没起来时什么也不做 */
  requestSnapshot(): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify({ v: CLOUD_PROTOCOL_VERSION, ...buildSnapshotRequest() }))
      return true
    } catch (error) {
      this.deps.logger.warn('[Cloud Client] snapshot request failed:', error)
      return false
    }
  }

  send(frame: OutgoingClientFrame): { success: boolean; error?: string } {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return { success: false, error: 'Cloud connection is not ready' }
    }
    try {
      socket.send(JSON.stringify({ v: CLOUD_PROTOCOL_VERSION, ...frame }))
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  close(): void {
    this.closed = true
    this.clearTimers()
    this.socket?.close()
    this.socket = null
    this.updateState({ status: 'closed' })
  }

  private async connect(baseUrl: string, token: string): Promise<void> {
    if (this.closed) return
    if (!token) {
      this.updateState({ status: 'error', error: 'Saved token cannot be decrypted; pair again.' })
      return
    }
    this.updateState({ status: 'connecting' })
    // 游标为空时不要拼 `?lastAckSeq=0`：那会让服务端按续传处理、只重放旧事件而不发快照。
    // 归一化规则统一在 cloud-protocol 里（三端共用）。
    const url = `${wsUrl(baseUrl, CLOUD_WS_PATHS.client)}${clientCursorQuery(this.lastAckSeq)}`
    let socket: WebSocket
    try {
      socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
    } catch (error) {
      this.scheduleReconnect(error)
      return
    }
    this.socket = socket

    socket.on('open', () => {
      this.reconnectDelay = RECONNECT_MIN_MS
      this.updateState({ status: 'open', lastSeq: this.lastAckSeq })
      this.startHeartbeat()
    })
    socket.on('message', (raw) => {
      let frame: ServerToClientFrame
      try {
        frame = JSON.parse(String(raw)) as ServerToClientFrame
      } catch {
        return
      }
      if (!frame || typeof frame !== 'object') return
      if ((frame as { v?: number }).v !== CLOUD_PROTOCOL_VERSION) return
      if (typeof (frame as { seq?: number }).seq === 'number') {
        this.lastAckSeq = Math.max(this.lastAckSeq, (frame as { seq: number }).seq)
      }
      try {
        this.deps.onFrame(frame)
      } catch (error) {
        this.deps.logger.warn('[Cloud Client] frame handler failed:', error)
      }
      const errorFrame = frame as { type?: string; fatal?: boolean; message?: string }
      if (errorFrame.type === 'error' && errorFrame.fatal) {
        this.markRejected(String(errorFrame.message ?? 'The cloud rejected this client'))
      }
    })
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
      this.stopHeartbeat()
      if (this.closed || this.durableStop) return
      this.updateState({ status: 'connecting' })
      this.scheduleReconnect(new Error('connection closed'))
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
      if (this.closed || this.durableStop) return
      if (status === 401 || status === 403) {
        this.markRevoked()
        return
      }
      this.updateState({ status: 'connecting' })
      this.scheduleReconnect(new Error(`handshake rejected with ${status}`))
    })
    socket.on('error', (error) => {
      this.deps.logger.warn('[Cloud Client] socket error:', error)
    })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      this.send({ type: 'ping', at: Date.now() })
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
    this.closed = true
    this.clearTimers()
    this.updateState({
      status: 'error',
      revoked: true,
      error: 'This device was removed from the cloud; pair it again.',
    })
  }

  /**
   * 服务端以 `fatal` 错误帧拒绝（更新版本不匹配等）：重连永远不会成功，停手并让 UI 明说。
   * 必须停掉退避定时器，否则就是「无限重连 + 提示看不见」的死循环。
   */
  private markRejected(message: string): void {
    this.durableStop = true
    this.closed = true
    this.clearTimers()
    this.updateState({ status: 'error', fatal: true, error: message })
    const socket = this.socket
    this.socket = null
    socket?.close()
  }

  private scheduleReconnect(_error: unknown): void {
    if (this.closed || this.durableStop || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(this.reconnectDelay * 1.8))
    const link = readCloudLink()
    if (!link) {
      this.updateState({ status: 'error', error: 'This device is not paired' })
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      const current = readCloudLink()
      if (!current) return
      void this.connect(current.baseUrl, readCloudToken(current))
    }, delay)
    this.reconnectTimer.unref?.()
    this.updateState({ status: 'connecting' })
  }

  private clearTimers(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private updateState(state: CloudClientState): void {
    this.state = state
    try {
      this.deps.onState(state)
    } catch {
      // ignore
    }
  }
}
