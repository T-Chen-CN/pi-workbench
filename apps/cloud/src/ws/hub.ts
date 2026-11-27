/**
 * 数据面：客户端通道 + 设备通道的连接管理、背压保护、帧限流与事件投递（F-43 ~ F-50）。
 *
 * 设计取舍：
 * - **客户端事件日志是全局单条**（单会话模型），每个连接按自己的 `lastAckSeq` 续读；
 *   多条浏览器标签不会各存一份。超上限 / 超时效就丢旧增量并要求对方重拉 snapshot。
 * - **设备日志按设备一条**，工单进终态时立刻清掉它的待投递项（F-21），重连不会再收到
 *   已被取消的工单。`ack(seq)` 只用于裁剪设备日志。
 * - 心跳 25 s、静默 60 s 判离线；发送前检查 `readyState === OPEN` 与 `bufferedAmount <= MAX_WS_BUFFERED_BYTES`
 *   （慢消费者超 4 MiB 立即断开防 OOM）；单客户端高开销帧（`resume` / `say` / `confirm_plan`）走令牌桶限流。
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

/** `/client/ws` 默认并发连接上限，超出后拒绝升级或 1013 关闭 */
export const MAX_CLIENT_CONNECTIONS = 32
/** 单 socket 发送缓冲背压上限（4 MiB）；超出视为慢消费者立即断开，防止 OOM */
export const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024

const WS_OPEN = 1
const EXPENSIVE_CLIENT_FRAMES: ReadonlySet<string> = new Set(['resume', 'say', 'confirm_plan'])
const DEFAULT_EXPENSIVE_BUCKET = { capacity: 10, refillPerSec: 2 }

interface TokenBucketState {
  tokens: number
  lastRefillAt: number
}

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
  /** 已因容量/过期被淘汰的最大 seq；用于判断空日志下旧游标是否已发生溢出 */
  private evictedUpTo = 0

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

  /** 续读：返回 lastAckSeq 之后的帧；overflow 表示中间有容量/过期淘汰或服务端重启游标归零（dropTask 造成的空洞不是溢出） */
  since(lastAckSeq: number): { frames: StoredFrame[]; overflow: boolean } {
    this.trim()
    const overflow =
      lastAckSeq > this.lastSeq || (lastAckSeq > 0 && lastAckSeq < this.evictedUpTo)
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
      const cut = this.entries.length - this.maxEntries
      const dropped = this.entries[cut - 1]
      if (dropped) this.evictedUpTo = Math.max(this.evictedUpTo, dropped.seq)
      this.entries = this.entries.slice(cut)
    }
    if (this.entries.length > 0 && now - this.entries[0].at > this.maxAgeMs) {
      const kept: StoredFrame[] = []
      for (const entry of this.entries) {
        if (now - entry.at <= this.maxAgeMs) kept.push(entry)
        else this.evictedUpTo = Math.max(this.evictedUpTo, entry.seq)
      }
      this.entries = kept
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
  /** 若由设备 Bearer Token 鉴权，记录其 deviceId 以便撤销设备时立即踢线 */
  deviceId?: string
  /** 连接时声明的游标，用于决定先回 snapshot 还是补增量 */
  resumeFrom: number | null
  /**
   * 首包（快照 / 增量）是否发完。发完之前 `publish()` 不往这个对端推事件：
   * 否则“快照还没建好”的窗口里推下来的事件会跑到快照前面，客户端拿到的第一帧就不是快照。
   */
  initialized: boolean
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
  /** 客户端连接数从 0 变为 1 或从 1 变为 0 时通知，用于离线期汇总（F-51 / A-23） */
  onClientConnected?: (wasEmpty: boolean) => void
  onClientsEmpty?: () => void
  /** 每次发布客户端事件后的通知（用于服务端维护未读计数，F-52 / C-03c） */
  onPublished?: (seq: number, event: CloudEvent) => void
  /** 需要一个新鲜快照（首次连接 / 增量溢出） */
  buildSnapshot: () => Promise<CloudSnapshot>
  logger: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void }
}

export interface HubOptions {
  /** 并发 `/client/ws` 连接上限（默认 32） */
  maxClientConnections?: number
  /** 单 socket 发送缓冲背压上限（默认 4 MiB） */
  maxBufferedBytes?: number
  /** 单 socket 高开销帧（`resume` / `say` / `confirm_plan`）令牌桶参数 */
  expensiveFrameBucket?: { capacity: number; refillPerSec: number }
}

export class Hub {
  private clients = new Set<ClientPeer>()
  private devices = new Map<string, DevicePeer>()
  private clientLog = new BoundedLog()
  private deviceLogs = new Map<string, BoundedLog>()
  private clientBuckets = new WeakMap<ClientPeer, TokenBucketState>()
  private heartbeat: NodeJS.Timeout | null = null
  private readonly maxClientConnections: number
  private readonly maxBufferedBytes: number
  private readonly bucketConfig: { capacity: number; refillPerSec: number }
  private static counter = 0

  constructor(
    private readonly handlers: HubHandlers,
    private readonly now: () => number = Date.now,
    options: HubOptions = {}
  ) {
    this.maxClientConnections = Math.max(1, options.maxClientConnections ?? MAX_CLIENT_CONNECTIONS)
    this.maxBufferedBytes = Math.max(1024, options.maxBufferedBytes ?? MAX_WS_BUFFERED_BYTES)
    this.bucketConfig = {
      capacity: Math.max(1, options.expensiveFrameBucket?.capacity ?? DEFAULT_EXPENSIVE_BUCKET.capacity),
      refillPerSec: Math.max(
        0.01,
        options.expensiveFrameBucket?.refillPerSec ?? DEFAULT_EXPENSIVE_BUCKET.refillPerSec
      ),
    }
  }

  // ------------------------------ 连接 ------------------------------

  canAcceptClient(): boolean {
    return this.clients.size < this.maxClientConnections
  }

  addClient(socket: WebSocket, resumeFrom: number | null, deviceId?: string): ClientPeer | null {
    if (!this.canAcceptClient()) {
      this.handlers.logger.warn(
        `[cloud] rejecting client ws: connection cap (${this.maxClientConnections}) reached`
      )
      try {
        socket.close(1013, 'Too many client connections')
      } catch {
        try {
          socket.terminate()
        } catch {
          // ignore
        }
      }
      return null
    }
    const wasEmpty = this.clients.size === 0
    Hub.counter += 1
    const peer: ClientPeer = {
      id: `client-${Hub.counter}`,
      role: 'client',
      deviceId,
      socket,
      alive: true,
      lastSeenAt: this.now(),
      resumeFrom,
      initialized: false,
    }
    this.clients.add(peer)
    this.handlers.onClientConnected?.(wasEmpty)
    socket.on('message', (raw: unknown) => this.handleClientMessage(peer, raw))
    socket.on('pong', () => {
      peer.alive = true
      peer.lastSeenAt = this.now()
    })
    socket.on('close', () => this.removeClient(peer))
    socket.on('error', (error: Error) => {
      this.handlers.logger.warn('[cloud] client socket error:', error.message)
      this.removeClient(peer)
    })
    void this.sendInitial(peer, resumeFrom).catch((error) => {
      this.handlers.logger.warn('[cloud] failed to send initial client snapshot:', error)
    })
    return peer
  }

  private removeClient(peer: ClientPeer): void {
    if (!this.clients.delete(peer)) return
    if (this.clients.size === 0) {
      this.handlers.onClientsEmpty?.()
    }
  }

  private terminatePeer(peer: HubPeer, reason: string): void {
    this.handlers.logger.warn(`[cloud] terminating ${peer.role} ${peer.id}: ${reason}`)
    peer.alive = false
    if (peer.role === 'client') {
      this.removeClient(peer)
    } else if (this.devices.get(peer.deviceId) === peer) {
      this.devices.delete(peer.deviceId)
      this.handlers.onDeviceOffline(peer.deviceId)
    }
    try {
      peer.socket.terminate()
    } catch {
      try {
        peer.socket.close()
      } catch {
        // ignore
      }
    }
  }

  /**
   * 背压与就绪状态保护发送：
   * - 连接非 OPEN 直接跳过；
   * - `bufferedAmount > maxBufferedBytes`（4 MiB）判定为慢消费者，立即终止连接防止 OOM。
   */
  private safeSend(peer: HubPeer, payload: string): boolean {
    if (peer.socket.readyState !== WS_OPEN) return false
    const buffered = typeof peer.socket.bufferedAmount === 'number' ? peer.socket.bufferedAmount : 0
    if (buffered > this.maxBufferedBytes) {
      this.terminatePeer(
        peer,
        `slow consumer backpressure (${buffered} > ${this.maxBufferedBytes} bytes)`
      )
      return false
    }
    try {
      peer.socket.send(payload)
      return true
    } catch (error) {
      this.handlers.logger.warn(`[cloud] failed to send to ${peer.role} ${peer.id}:`, error)
      return false
    }
  }

  /** 发送 pong（走背压保护通道） */
  sendPong(peer: HubPeer, at: number): boolean {
    return this.safeSend(peer, encodeFrame({ v: CLOUD_PROTOCOL_VERSION, type: 'pong', at }))
  }

  /** 撤销设备时立即断开其 `/device/ws` 及由该设备 token 鉴权的全部 `/client/ws` 连接 */
  disconnectDevice(deviceId: string): void {
    const dev = this.devices.get(deviceId)
    if (dev) {
      this.devices.delete(deviceId)
      try {
        dev.socket.close(4401, 'Device revoked')
      } catch {
        // ignore
      }
      this.handlers.onDeviceOffline(deviceId)
    }
    for (const client of [...this.clients]) {
      if (client.deviceId !== deviceId) continue
      this.removeClient(client)
      try {
        client.socket.close(4401, 'Device revoked')
      } catch {
        // ignore
      }
    }
    this.deviceLogs.delete(deviceId)
  }

  /** 管理员登出时立即断开全部 Web Cookie 鉴权的 `/client/ws` 连接（不影响设备 token 连接） */
  disconnectWebClients(): void {
    for (const client of [...this.clients]) {
      if (client.deviceId) continue
      this.removeClient(client)
      try {
        client.socket.close(4401, 'Session logged out')
      } catch {
        // ignore
      }
    }
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
    // 补包期间先停了实时推送，结束时统一按日志补上（否则快照会跑到事件后面）
    peer.initialized = false
    // 游标 0 / 负数 / 非数字都归一成 null：直接回快照（见 normalizeResumeCursor）。
    // 客户端重载后本地状态已清空，也会主动发 resume(0) 要一份新的。
    const cursor = normalizeResumeCursor(lastAckSeq)
    const { frames, overflow } = cursor === null ? { frames: [], overflow: false } : this.clientLog.since(cursor)
    const needsSnapshot = cursor === null || overflow
    if (needsSnapshot) {
      const snapshot = await this.handlers.buildSnapshot()
      const sent = this.safeSend(
        peer,
        encodeFrame({
          v: CLOUD_PROTOCOL_VERSION,
          type: 'snapshot',
          seq: snapshot.lastSeq,
          snapshot,
        })
      )
      if (!sent) {
        peer.initialized = true
        return
      }
      this.finishInitial(peer, snapshot.lastSeq)
      return
    }
    for (const entry of frames) {
      const sent = this.safeSend(
        peer,
        encodeFrame({
          v: CLOUD_PROTOCOL_VERSION,
          type: 'event',
          seq: entry.seq,
          event: entry.frame,
        })
      )
      if (!sent) {
        peer.initialized = true
        return
      }
    }
    this.finishInitial(peer, frames.length > 0 ? frames[frames.length - 1].seq : (cursor ?? 0))
  }

  // ------------------------------ 投递 ------------------------------

  /** 广播一条客户端事件（分配全局 seq 并写进客户端日志） */
  publish(event: CloudEvent): number {
    const seq = this.clientLog.append(event)
    this.handlers.onPublished?.(seq, event)
    const frame: ServerToClientFrame = {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'event',
      seq,
      event,
    }
    const text = encodeFrame(frame)
    for (const peer of [...this.clients]) {
      // 首包未发完的对端先不推：它在 sendInitial/resumeClient 结束时按日志补上，顺序就对了
      if (!peer.initialized) continue
      this.safeSend(peer, text)
    }
    return seq
  }

  /** 工单帧投给设备；设备离线或触发背压断开时返回 false（调用方按 F-21 处理） */
  sendToDevice(deviceId: string, frame: ServerToDeviceFrame, taskId?: string): boolean {
    const log = this.deviceLog(deviceId)
    // 帧本身要带 seq：重连补投时不能再包一层
    const sequenced = log.appendWith(
      (seq) => ({ ...frame, seq }) as unknown,
      taskId
    )
    const peer = this.devices.get(deviceId)
    if (!peer) return false
    return this.safeSend(peer, encodeFrame(sequenced.frame))
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
    this.safeSend(peer, encodeFrame(frame))
    if (fatal) {
      try {
        peer.socket.close()
      } catch {
        // ignore
      }
    }
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
    // 严格按 CLOUD_OFFLINE_TIMEOUT_MS（60s）静默判离线，每 25s 发 ping 触发 pong 刷新 lastSeenAt，
    // 避免单次延迟 pong 在 25s 就被误杀
    for (const peer of [...this.clients]) {
      if (now - peer.lastSeenAt > CLOUD_OFFLINE_TIMEOUT_MS) {
        peer.alive = false
        peer.socket.terminate()
        this.removeClient(peer)
        continue
      }
      try {
        peer.socket.ping()
      } catch {
        this.removeClient(peer)
      }
    }
    for (const [deviceId, peer] of [...this.devices]) {
      if (now - peer.lastSeenAt > CLOUD_OFFLINE_TIMEOUT_MS) {
        peer.alive = false
        peer.socket.terminate()
        this.devices.delete(deviceId)
        this.handlers.onDeviceOffline(deviceId)
        continue
      }
      try {
        peer.socket.ping()
      } catch {
        this.devices.delete(deviceId)
        this.handlers.onDeviceOffline(deviceId)
      }
    }
  }

  // ------------------------------ 内部 ------------------------------

  private consumeExpensiveFrameToken(peer: ClientPeer): boolean {
    const now = this.now()
    let state = this.clientBuckets.get(peer)
    if (!state) {
      state = { tokens: this.bucketConfig.capacity, lastRefillAt: now }
      this.clientBuckets.set(peer, state)
    } else {
      const elapsedSec = Math.max(0, (now - state.lastRefillAt) / 1000)
      state.tokens = Math.min(
        this.bucketConfig.capacity,
        state.tokens + elapsedSec * this.bucketConfig.refillPerSec
      )
      state.lastRefillAt = now
    }
    if (state.tokens < 1) return false
    state.tokens -= 1
    return true
  }

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
    const { frames, overflow } = log.since(resumeFrom ?? 0)
    // 服务端重启游标归零或设备日志溢出：发送 ack(seq: 0) 重置终端游标并重放当前全部待投递帧，防止静默丢帧
    const toReplay = overflow ? log.since(0).frames : frames
    if (overflow) {
      if (
        !this.safeSend(
          peer,
          encodeFrame({
            v: CLOUD_PROTOCOL_VERSION,
            type: 'ack',
            seq: 0,
          })
        )
      ) {
        return
      }
    }
    for (const entry of toReplay) {
      if (!this.safeSend(peer, encodeFrame(entry.frame))) return
    }
  }

  private async sendInitial(peer: ClientPeer, resumeFrom: number | null): Promise<void> {
    // 与 resumeClient 同一条规则：只有真正的游标才走续传，其余一律发快照
    const cursor = normalizeResumeCursor(resumeFrom)
    if (cursor !== null) {
      const { frames, overflow } = this.clientLog.since(cursor)
      if (!overflow) {
        for (const entry of frames) {
          const sent = this.safeSend(
            peer,
            encodeFrame({
              v: CLOUD_PROTOCOL_VERSION,
              type: 'event',
              seq: entry.seq,
              event: entry.frame,
            })
          )
          if (!sent) return
        }
        this.finishInitial(peer, frames.length > 0 ? frames[frames.length - 1].seq : cursor)
        return
      }
    }
    const snapshot = await this.handlers.buildSnapshot()
    const sent = this.safeSend(
      peer,
      encodeFrame({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'snapshot',
        seq: snapshot.lastSeq,
        snapshot,
      })
    )
    if (!sent) return
    this.finishInitial(peer, snapshot.lastSeq)
  }

  /**
   * 首包发完：补上期间错过的事件（`publish()` 在初始化窗口里跳过了这个对端），再开始实时推送。
   * 补发与置位之间不能有 await，否则会漏掉恰好夹在中间的帧。
   */
  private finishInitial(peer: ClientPeer, fromSeq: number): void {
    const { frames } = this.clientLog.since(fromSeq)
    for (const entry of frames) {
      const sent = this.safeSend(
        peer,
        encodeFrame({
          v: CLOUD_PROTOCOL_VERSION,
          type: 'event',
          seq: entry.seq,
          event: entry.frame,
        })
      )
      if (!sent) return
    }
    peer.initialized = true
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
    if (EXPENSIVE_CLIENT_FRAMES.has(decoded.frame.type) && !this.consumeExpensiveFrameToken(peer)) {
      this.sendError(peer, 'rate-limited', 'Too many requests; slow down.', false)
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
