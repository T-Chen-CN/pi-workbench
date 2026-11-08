/**
 * 派活中继客户端：一条出站 SSE 常连 + 三个上行接口。
 *
 * 为什么不监听端口：设备在 NAT / 防火墙后面，云端不可能主动连进来。设备主动连
 * 网关，网关把任务推下来 —— 与 `heartbeat` 同一个方向。
 *
 * 断线处理：网关自己会在 3600s 时发 `relay.reconnect` 让我们换连接；网络断了就
 * 指数退避重连。**重连不需要补状态**：网关在连接建立时会补发所有 `queued` 任务。
 */

import type { CloudClient } from '../cloud/client.js'
import { readSseStream } from '../cloud/events.js'

export type RelayFrame = Record<string, unknown> & { type?: string; taskId?: string }

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** 网关每 25s 一条 `: ping`；留到 90s 才判死，避免慢网络误杀 */
const RELAY_IDLE_TIMEOUT_MS = 90_000

export interface RelayDeps {
  /** 每次连接现取凭据；null 表示未配对 / 已注销，直接歇着 */
  getClient: () => CloudClient | null
  onFrame: (frame: RelayFrame) => void
  onState: (state: RelayState) => void
  log?: (message: string, error?: unknown) => void
  now?: () => number
  delay?: (ms: number) => Promise<void>
}

export interface RelayState {
  connected: boolean
  lastFrameAt: number | null
  lastError: string | null
}

const defaultDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class DispatchRelay {
  private controller: AbortController | null = null
  private loop: Promise<void> | null = null
  private stopped = true
  private state: RelayState = { connected: false, lastFrameAt: null, lastError: null }

  constructor(private readonly deps: RelayDeps) {}

  getState(): RelayState {
    return { ...this.state }
  }

  isConnected(): boolean {
    return this.state.connected
  }

  /** 幂等启动：已在跑就不重复建连接 */
  start(): void {
    if (this.loop) return
    this.stopped = false
    this.loop = this.run().finally(() => {
      this.loop = null
    })
  }

  /**
   * 停止并等待连接收尾。配置变更（换地址 / 换 token / 关派活）后重新调用 `start()`
   * 就会用新凭据重连。
   */
  async stop(): Promise<void> {
    this.stopped = true
    this.controller?.abort()
    this.controller = null
    await this.loop?.catch(() => undefined)
  }

  private emit(patch: Partial<RelayState>): void {
    this.state = { ...this.state, ...patch }
    this.deps.onState({ ...this.state })
  }

  private async run(): Promise<void> {
    let attempt = 0
    while (!this.stopped) {
      const client = this.deps.getClient()
      if (!client) {
        this.emit({ connected: false, lastError: null })
        await this.pause(RECONNECT_MAX_MS)
        continue
      }
      const controller = new AbortController()
      this.controller = controller
      try {
        const response = await client.openStream('/v1/hub/relay/stream', controller.signal)
        if (!response.body) throw new Error('中继流没有响应正文')
        this.emit({ connected: true, lastError: null })
        attempt = 0
        await readSseStream(response.body, {
          signal: controller.signal,
          idleTimeoutMs: RELAY_IDLE_TIMEOUT_MS,
          onFrame: (frame) => {
            let parsed: RelayFrame
            try {
              parsed = JSON.parse(frame.data) as RelayFrame
            } catch {
              return
            }
            this.state = { ...this.state, lastFrameAt: this.deps.now?.() ?? Date.now() }
            if (parsed.type === 'relay.reconnect') return
            this.deps.onFrame(parsed)
          },
        })
      } catch (error) {
        if (controller.signal.aborted) break
        const message = error instanceof Error ? error.message : String(error)
        this.deps.log?.('[Dispatch] relay stream failed', error)
        this.emit({ connected: false, lastError: message })
      }
      this.controller = null
      this.emit({ connected: false })
      if (this.stopped) break
      attempt += 1
      await this.pause(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1)))
    }
    this.emit({ connected: false })
  }

  private async pause(ms: number): Promise<void> {
    if (this.stopped) return
    await (this.deps.delay ?? defaultDelay)(ms)
  }
}

/** 上报工作区清单（全量替换）。失败只记日志：下一拍心跳会再报一次。 */
export async function publishWorkspaces(
  client: CloudClient,
  input: { enabled: boolean; workspaces: Array<{ id: string; label: string; description: string }> }
): Promise<void> {
  await client.request('/v1/hub/workspaces', {
    method: 'POST',
    body: { dispatchable: input.enabled, workspaces: input.workspaces },
    timeoutMs: 15_000,
  })
}

export interface ReportInput {
  taskId: string
  kind: 'claimed' | 'progress' | 'question' | 'done' | 'failed' | 'canceled'
  summary?: string
  files?: string[]
  usage?: unknown
  error?: string
  question?: string
  localSessionId?: string
}

export async function reportTask(client: CloudClient, input: ReportInput): Promise<void> {
  await client.request('/v1/hub/relay/report', {
    method: 'POST',
    body: input,
    timeoutMs: 20_000,
  })
}
