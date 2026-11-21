/**
 * 数据面：客户端通道 + 设备通道的连接管理与事件投递（F-43 ~ F-50）。
 *
 * 设计取舍：
 * - **客户端事件日志是全局单条**（单会话模型），每个连接按自己的 `lastAckSeq` 续读；
 *   多条浏览器标签不会各存一份。超上限 / 超时效就丢旧增量并要求对方重拉 snapshot。
 * - **设备日志按设备一条**，工单进终态时立刻清掉它的待投递项（F-21），重连不会再收到
 *   已被取消的工单。`ack(seq)` 只用于裁剪设备日志。
 * - 心跳 25 s、静默 60 s 判离线；离线判定只负责通知上层（工单转 `cancelled` 的决策在
 *   dispatcher 里，避免连接层持有业务状态）。
 */

import type { WebSocket } from 'ws'
import {
  CLOUD_HEARTBEAT_INTERVAL_MS,
  CLOUD_OFFLINE_TIMEOUT_MS,
  CLOUD_OUTBOX_MAX_AGE_MS,
  CLOUD_OUTBOX_MAX_ENTRIES,
  CLOUD_PROTOCOL_VERSION,
  decodeFrame,
  normalizeResumeCursor,
  CLIENT_TO_SERVER_TYPES,
  DEVICE_TO_SERVER_TYPES,
  encodeFrame,
  type CloudErrorCode,
  type ClientToServerFrame,
  type CloudEvent,
  type CloudSnapshot,
  type DeviceToServerFrame,
  type ServerToClientFrame,
  type ServerToDeviceFrame,
} from 'pi-bridge'

interface StoredFrame {
  seq: number
  at: number
  frame: unknown
  /** 设备日志按工单标记，便于进终态时整单清理 */
  taskId?: string
}

export class BoundedLog {
  private entries: StoredFrame[] = []
  private lastSeq = 0

  constructor(
    private readonly maxEntries = CLOUD_OUTBOX_MAX_ENTRIES,
    private readonly maxAgeMs = CLOUD_OUTBOX_MAX_AGE_MS,
    private readonly now: () => number = Date.now
  ) {}

  get lastSeqValue(): number {
    return this.lastSeq
  }

  append(frame: unknown, taskId?: string): number {
    this.lastSeq += 1
    this.push({ seq: this.lastSeq, at: this.now(), frame, taskId })
    return this.lastSeq
  }

  /** 存带 seq 的完整帧（设备通道用：帧本身含 seq，重放时不能再包一层） */
  appendWith(build: (seq: number) => unknown, taskId?: string): { seq: number; frame: unknown } {
    this.lastSeq += 1
    const frame = build(this.lastSeq)
    this.push({ seq: this.lastSeq, at: this.now(), frame, taskId })
    return { seq: this.lastSeq, frame }
  }

  private push(entry: StoredFrame): void {
    this.entries.push(entry)
    this.trim()
  }

  /** 续读：返回 lastAckSeq 之后的帧；overflow 表示中间有丢失，调用方应回 snapshot */
  since(lastAckSeq: number): { frames: StoredFrame[]; overflow: boolean } {
    this.trim()
    const first = this.entries[0]
    const overflow = Boolean(first && lastAckSeq > 0 && first.seq > lastAckSeq + 1)
    return {
      frames: this.entries.filter((entry) => entry.seq > lastAckSeq),
      overflow,
    }
  }

  ackUpTo(seq: number): void {
    this.entries = this.entries.filter((entry) => entry.seq > seq)
  }

  /** 工单进终态：清掉该工单的待投递项（已取消的活儿不该在重连后被重放） */
  dropTask(taskId: string): void {
    this.entries = this.entries.filter((entry) => entry.taskId !== taskId)
  }

  clear(): void {
    this.entries = []
  }

  size(): number {
    return this.entries.length
  }

  private trim(): void {
    const now = this.now()
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries)
    }
    if (this.entries.length > 0 && now - this.entries[0].at > this.maxAgeMs) {
      this.entries = this.entries.filter((entry) => now - entry.at <= this.maxAgeMs)
    }
  }
}

interface PeerBase {
  id: string
  socket: WebSocket
  alive: boolean
  lastSeenAt: number
}

export interface ClientPeer extends PeerBase {
  role: 'client'
  /** 连接时声明的游标，用于决定先回 snapshot 还是补增量 */
  resumeFrom: number | null
}

export interface DevicePeer extends PeerBase {
  role: 'device'
  deviceId: string
}

export type HubPeer = ClientPeer | DevicePeer

export interface HubHandlers {
  onClientFrame: (peer: ClientPeer, frame: ClientToServerFrame) => void
  onDeviceFrame: (peer: DevicePeer, frame: DeviceToServerFrame) => void
  onDeviceOnline: (deviceId: string) => void
  onDeviceOffline: (deviceId: string) => void
  onClientHello: (peer: ClientPeer) => void
  /** 需要一个新鲜快照（首次连接 / 增量溢出） */
  buildSnapshot: () => Promise<CloudSnapshot>
  logger: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void }
}

export class Hub {
  private clients = new Set<ClientPeer>()
  private devices = new Map<string, DevicePeer>()
  private clientLog = new BoundedLog()
  private deviceLogs = new Map<string, BoundedLog>()
  private heartbeat: NodeJS.Timeout | null = null
  private static counter = 0

  constructor(
    private readonly handlers: HubHandlers,
    private readonly now: () => number = Date.now
  ) {}

  // ------------------------------ 连接 ------------------------------

  addClient(socket: WebSocket, resumeFrom: number | null): ClientPeer {
    Hub.counter += 1
    const peer: ClientPeer = {
      id: `client-${Hub.counter}`,
      role: 'client',
      socket,
      alive: true,
      lastSeenAt: this.now(),
      resumeFrom,
    }
    this.clients.add(peer)
    socket.on('message', (raw: unknown) => this.handleClientMessage(peer, raw))
    socket.on('pong', () => {
      peer.alive = true
      peer.lastSeenAt = this.now()
    })
    socket.on('close', () => this.clients.delete(peer))
    socket.on('error', (error: Error) => {
      this.handlers.logger.warn('[cloud] client socket error:', error.message)
      this.clients.delete(peer)
    })
    void this.sendInitial(peer, resumeFrom)
    return peer
  }

  addDevice(socket: WebSocket, deviceId: string, resumeFrom: number | null): DevicePeer {
    Hub.counter += 1
    const previous = this.devices.get(deviceId)
    if (previous) {
      // 同一设备重连：旧连接直接关掉，避免两条通道同时抢工单
      try {
        previous.socket.close()
      } catch {
        // ignore
      }
      this.devices.delete(deviceId)
    }
    const peer: DevicePeer = {
      id: `device-${Hub.counter}`,
      role: 'device',
      socket,
      alive: true,
      lastSeenAt: this.now(),
      deviceId,
    }
    this.devices.set(deviceId, peer)
    socket.on('message', (raw: unknown) => this.handleDeviceMessage(peer, raw))
    socket.on('pong', () => {
      peer.alive = true
      peer.lastSeenAt = this.now()
    })
    socket.on('close', () => {
      if (this.devices.get(deviceId) === peer) {
        this.devices.delete(deviceId)
        this.handlers.onDeviceOffline(deviceId)
      }
    })
    socket.on('error', () => {
      if (this.devices.get(deviceId) === peer) {
        this.devices.delete(deviceId)
        this.handlers.onDeviceOffline(deviceId)
      }
    })
    this.replayDeviceLog(peer, resumeFrom)
    this.handlers.onDeviceOnline(deviceId)
    return peer
  }

  isDeviceOnline(deviceId: string): boolean {
    return this.devices.has(deviceId)
  }

  onlineDeviceIds(): string[] {
    return [...this.devices.keys()]
  }

  clientCount(): number {
    return this.clients.size
  }

  /** 客户端日志的最新 seq；快照里用它做游标基准 */
  lastClientSeq(): number {
    return this.clientLog.lastSeqValue
  }

  /** 连接内再次 `resume`：按增量补投，溢出时回快照 */
  async resumeClient(peer: ClientPeer, lastAckSeq: number): Promise<void> {
    // 游标 0 / 负数 / 非数字都归一成 null：直接回快照（见 normalizeResumeCursor）。
    // 客户端重载后本地状态已清空，也会主动发 resume(0) 要一份新的。
    const cursor = normalizeResumeCursor(lastAckSeq)
    const { frames, overflow } = cursor === null ? { frames: [], overflow: false } : this.clientLog.since(cursor)
    const needsSnapshot = cursor === null || overflow
    if (needsSnapshot) {
      const snapshot = await this.handlers.buildSnapshot()
      try {
        peer.socket.send(
          encodeFrame({
            v: CLOUD_PROTOCOL_VERSION,
            type: 'snapshot',
            seq: snapshot.lastSeq,
            snapshot,
          })
        )
      } catch {
        // ignore
      }
      return
    }
    for (const entry of frames) {
      try {
        peer.socket.send(
          encodeFrame({
            v: CLOUD_PROTOCOL_VERSION,
            type: 'event',
            seq: entry.seq,
            event: entry.frame,
          })
        )
      } catch {
        return
      }
    }
  }

  // ------------------------------ 投递 ------------------------------

  /** 广播一条客户端事件（分配全局 seq 并写进客户端日志） */
  publish(event: CloudEvent): number {
    const seq = this.clientLog.append(event)
    const frame: ServerToClientFrame = {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'event',
      seq,
      event,
    }
    const text = encodeFrame(frame)
    for (const peer of this.clients) {
      try {
        peer.socket.send(text)
      } catch (error) {
        this.handlers.logger.warn('[cloud] failed to push event:', error)
      }
    }
    return seq
  }

  /** 工单帧投给设备；设备离线时返回 false（调用方按 F-21 处理） */
  sendToDevice(deviceId: string, frame: ServerToDeviceFrame, taskId?: string): boolean {
    const log = this.deviceLog(deviceId)
    // 帧本身要带 seq：重连补投时不能再包一层
    const sequenced = log.appendWith(
      (seq) => ({ ...frame, seq }) as unknown,
      taskId
    )
    const peer = this.devices.get(deviceId)
    if (!peer) return false
    try {
      peer.socket.send(encodeFrame(sequenced.frame))
      return true
    } catch (error) {
      this.handlers.logger.warn('[cloud] failed to push to device:', error)
      return false
    }
  }

  /** 工单进终态：不再补投 */
  dropDeviceTask(deviceId: string, taskId: string): void {
    this.deviceLogs.get(deviceId)?.dropTask(taskId)
  }

  sendError(
    peer: HubPeer,
    code: CloudErrorCode,
    message: string,
    fatal = false
  ): void {
    const frame = { v: CLOUD_PROTOCOL_VERSION, type: 'error', code, message, fatal }
    try {
      peer.socket.send(encodeFrame(frame))
    } catch {
      // ignore
    }
    if (fatal) peer.socket.close()
  }

  // ------------------------------ 心跳 ------------------------------

  startHeartbeat(intervalMs = CLOUD_HEARTBEAT_INTERVAL_MS): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => this.tick(), intervalMs)
    this.heartbeat.unref?.()
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const peer of this.clients) peer.socket.terminate()
    for (const peer of this.devices.values()) peer.socket.terminate()
    this.clients.clear()
    this.devices.clear()
  }

  private tick(): void {
    const now = this.now()
    for (const peer of [...this.clients]) {
      if (!peer.alive || now - peer.lastSeenAt > CLOUD_OFFLINE_TIMEOUT_MS) {
        peer.socket.terminate()
        this.clients.delete(peer)
        continue
      }
      peer.alive = false
      try {
        peer.socket.ping()
      } catch {
        this.clients.delete(peer)
      }
    }
    for (const [deviceId, peer] of [...this.devices]) {
      if (!peer.alive || now - peer.lastSeenAt > CLOUD_OFFLINE_TIMEOUT_MS) {
        peer.socket.terminate()
        this.devices.delete(deviceId)
        this.handlers.onDeviceOffline(deviceId)
        continue
      }
      peer.alive = false
      try {
        peer.socket.ping()
      } catch {
        this.devices.delete(deviceId)
        this.handlers.onDeviceOffline(deviceId)
      }
    }
  }

  // ------------------------------ 内部 ------------------------------

  private deviceLog(deviceId: string): BoundedLog {
    let log = this.deviceLogs.get(deviceId)
    if (!log) {
      log = new BoundedLog()
      this.deviceLogs.set(deviceId, log)
    }
    return log
  }

  private replayDeviceLog(peer: DevicePeer, resumeFrom: number | null): void {
    const log = this.deviceLog(peer.deviceId)
    const { frames } = log.since(resumeFrom ?? 0)
    for (const entry of frames) {
      try {
        peer.socket.send(encodeFrame(entry.frame))
      } catch {
        return
      }
    }
  }

  private async sendInitial(peer: ClientPeer, resumeFrom: number | null): Promise<void> {
    // 与 resumeClient 同一条规则：只有真正的游标才走续传，其余一律发快照
    const cursor = normalizeResumeCursor(resumeFrom)
    if (cursor !== null) {
      const { frames, overflow } = this.clientLog.since(cursor)
      if (!overflow) {
        for (const entry of frames) {
          try {
            peer.socket.send(
              encodeFrame({
                v: CLOUD_PROTOCOL_VERSION,
                type: 'event',
                seq: entry.seq,
                event: entry.frame,
              })
            )
          } catch {
            return
          }
        }
        this.handlers.onClientHello(peer)
        return
      }
    }
    const snapshot = await this.handlers.buildSnapshot()
    try {
      peer.socket.send(
        encodeFrame({
          v: CLOUD_PROTOCOL_VERSION,
          type: 'snapshot',
          seq: snapshot.lastSeq,
          snapshot,
        })
      )
    } catch (error) {
      this.handlers.logger.warn('[cloud] failed to send snapshot:', error)
      return
    }
    this.handlers.onClientHello(peer)
  }

  private handleClientMessage(peer: ClientPeer, raw: unknown): void {
    peer.alive = true
    peer.lastSeenAt = this.now()
    const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw)
    const decoded = decodeClientFrame(text)
    if (!decoded.ok) {
      this.sendError(peer, decoded.code, decoded.message, decoded.code === 'protocol-version')
      return
    }
    this.handlers.onClientFrame(peer, decoded.frame)
  }

  private handleDeviceMessage(peer: DevicePeer, raw: unknown): void {
    peer.alive = true
    peer.lastSeenAt = this.now()
    const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw)
    const decoded = decodeDeviceFrame(text)
    if (!decoded.ok) {
      this.sendError(peer, decoded.code, decoded.message, decoded.code === 'protocol-version')
      return
    }
    if (decoded.frame.type === 'ack') {
      this.deviceLog(peer.deviceId).ackUpTo(decoded.frame.seq)
    }
    this.handlers.onDeviceFrame(peer, decoded.frame)
  }
}

/** 帧解码单独抽出，便于在 hub 外部复用与测试 */
export function decodeClientFrame(
  raw: string
): { ok: true; frame: ClientToServerFrame } | { ok: false; code: CloudErrorCode; message: string } {
  return decodeFrame<ClientToServerFrame>(raw, CLIENT_TO_SERVER_TYPES)
}

export function decodeDeviceFrame(
  raw: string
): { ok: true; frame: DeviceToServerFrame } | { ok: false; code: CloudErrorCode; message: string } {
  return decodeFrame<DeviceToServerFrame>(raw, DEVICE_TO_SERVER_TYPES)
}
