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
  | { status: 'error'; error: string }

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

  /** 打开（或复用）连接；未配对时直接报错，不静默失败 */
  open(): CloudClientState {
    const link = readCloudLink()
    if (!link) {
      this.updateState({ status: 'error', error: 'This device is not paired' })
      return this.state
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return this.state
    }
    this.closed = false
    void this.connect(link.baseUrl, readCloudToken(link))
    return this.state
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
    const url = `${wsUrl(baseUrl, CLOUD_WS_PATHS.client)}?lastAckSeq=${this.lastAckSeq}`
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
    })
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null
      this.stopHeartbeat()
      if (this.closed) return
      this.updateState({ status: 'connecting' })
      this.scheduleReconnect(new Error('connection closed'))
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

  private scheduleReconnect(_error: unknown): void {
    if (this.closed || this.reconnectTimer) return
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
