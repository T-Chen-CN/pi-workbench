/**
 * 派活 worker：把「云端推来的任务」和「本地执行的会话」接起来。
 *
 * 生命周期：
 * - 打开派活 → 连中继 + 上报工作区清单；关掉 → 断中继、清单变空（云端立刻看不到目标）。
 * - 配置变化（工作区增删、地址 / token 变、开关变）都走 `refresh()`，内部自己判断要重启
 *   中继还是只重报清单。
 *
 * 并发：**一台设备同一时刻只跑一个任务**。第二个任务留在本地队列里，
 * 前一个结束后再领 —— 与网关「每设备并发 1」一致，避免两个会话同时写一棵树。
 */

import * as fs from 'node:fs'
import type { CloudClient } from '../cloud/client.js'
import { createCloudClient } from '../cloud/client.js'
import { readCloudConfig } from '../cloud/config.js'
import type { AgentIpcContext } from '../ipc/agent.js'
import {
  publicWorkspaces,
  readDispatchConfig,
  findWorkspace,
  type DispatchConfig,
} from './config.js'
import { DispatchExecutor } from './executor.js'
import { DispatchRelay, publishWorkspaces, reportTask, type RelayFrame } from './relay.js'
import { appendLedger, readLedger, type DispatchLedgerEntry } from './ledger.js'

export interface DispatchWorkerState {
  enabled: boolean
  connected: boolean
  lastFrameAt: number | null
  lastError: string | null
  /** 当前正在执行的任务与工作区显示名 */
  runningTaskId: string | null
  runningWorkspace: string | null
  /** 排队等执行的任务数 */
  queued: number
  publishedAt: number | null
  /** 最近完成的任务（本机账本，界面用） */
  recent: DispatchLedgerEntry[]
}

export interface DispatchWorkerDeps {
  context: AgentIpcContext
  readApiConfig: () => Promise<{
    provider: string
    apiUrl: string
    apiKey: string
    selectedModel: string
    models?: Array<{ id: string; contextWindow: number; image: boolean }>
  } | null>
  logger: { info?: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
  /** 账本落盘位置（`{appDir}/data/agent/dispatch-ledger.json`） */
  ledgerPath: string
  onState: (state: DispatchWorkerState) => void
  /** 测试注入 */
  now?: () => number
  createClient?: (input: { baseUrl: string; credential: string }) => CloudClient
  /** 测试注入：默认用真实的会话执行器 */
  executor?: DispatchExecutorLike
  /** 测试注入：中继重连的等待（默认真等，避免把退避逻辑测成空转） */
  relayDelay?: (ms: number) => Promise<void>
}

/** worker 只用到执行器的这两个能力，注入替身时不必拖进整个 Agent 栈 */
export interface DispatchExecutorLike {
  run: (task: {
    taskId: string
    workspaceId: string
    workspacePath: string
    prompt: string
  }) => Promise<{
    report: Omit<Parameters<typeof reportTask>[1], 'taskId'>
    sessionId: string | null
  }>
  cancel: (taskId: string) => Promise<boolean>
}

/** 设备上报清单的节奏：与心跳同源，30s 一次足够 */
const CATALOG_REFRESH_MS = 30_000

const DEFAULT_STATE: DispatchWorkerState = {
  enabled: false,
  connected: false,
  lastFrameAt: null,
  lastError: null,
  runningTaskId: null,
  runningWorkspace: null,
  queued: 0,
  publishedAt: null,
  recent: [],
}

export class DispatchWorker {
  private relay: DispatchRelay | null = null
  private executor: DispatchExecutorLike
  private state: DispatchWorkerState = { ...DEFAULT_STATE }
  private queue: Array<{ taskId: string; workspaceId: string; prompt: string }> = []
  private draining = false
  private catalogTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: DispatchWorkerDeps) {
    this.executor =
      deps.executor ??
      new DispatchExecutor({
        context: deps.context,
        readApiConfig: deps.readApiConfig,
        logger: deps.logger,
      })
  }

  getState(): DispatchWorkerState {
    return { ...this.state, queued: this.queue.length }
  }

  /** 首次进入界面时把账本读进来（不动运行态） */
  loadLedger(): void {
    try {
      this.patch({ recent: readLedger(this.deps.ledgerPath) })
    } catch (error) {
      this.deps.logger.warn('[Dispatch] reading ledger failed', error)
    }
  }

  /** 按当前配置启动 / 停止 / 重报清单。可以反复调用。 */
  async refresh(): Promise<void> {
    const config = readDispatchConfig()
    const client = this.clientFor(config)
    if (!config.enabled || config.workspaces.length === 0 || !client) {
      await this.stop()
      this.patch({ enabled: config.enabled })
      return
    }
    this.patch({ enabled: true })
    if (!this.relay) {
      this.relay = this.buildRelay()
      this.relay.start()
      this.catalogTimer = setInterval(() => {
        void this.publishCatalog()
      }, CATALOG_REFRESH_MS)
      this.catalogTimer.unref?.()
    }
    await this.publishCatalog()
  }

  async stop(): Promise<void> {
    if (this.catalogTimer) clearInterval(this.catalogTimer)
    this.catalogTimer = null
    const relay = this.relay
    this.relay = null
    if (relay) await relay.stop()
    this.queue = []
    this.patch({ enabled: false, connected: false, runningTaskId: null, runningWorkspace: null })
  }

  /** 界面「急停」：断中继 + 取消正在跑的任务 */
  async stopNow(): Promise<void> {
    const taskId = this.state.runningTaskId
    if (taskId) {
      await this.executor.cancel(taskId)
      await this.report(taskId, {
        kind: 'canceled',
        error: '本机用户急停',
      }).catch(() => undefined)
    }
    await this.stop()
  }

  private clientFor(config: DispatchConfig): CloudClient | null {
    const cloud = readCloudConfig()
    if (!cloud.hasDeviceToken || !cloud.deviceToken || !cloud.gatewayUrl) return null
    if (config.workspaces.length === 0) return null
    const factory = this.deps.createClient ?? createCloudClient
    try {
      return factory({ baseUrl: cloud.gatewayUrl, credential: cloud.deviceToken })
    } catch (error) {
      this.deps.logger.warn('[Dispatch] cannot build cloud client', error)
      return null
    }
  }

  private buildRelay(): DispatchRelay {
    return new DispatchRelay({
      getClient: () => this.clientFor(readDispatchConfig()),
      onFrame: (frame) => void this.handleFrame(frame),
      onState: (relayState) => {
        this.patch({
          connected: relayState.connected,
          lastFrameAt: relayState.lastFrameAt,
          lastError: relayState.lastError,
        })
        if (relayState.connected) {
          // 重连成功先补一次清单：断线期间用户可能改了白名单
          void this.publishCatalog()
        }
      },
      log: (message, error) => this.deps.logger.warn(message, error),
      now: this.deps.now,
      delay: this.deps.relayDelay,
    })
  }

  private async publishCatalog(): Promise<void> {
    const config = readDispatchConfig()
    const client = this.clientFor(config)
    if (!client) return
    const workspaces = publicWorkspaces(config).filter((item) => {
      const entry = findWorkspace(config, item.id)
      return entry ? fs.existsSync(entry.path) : false
    })
    try {
      await publishWorkspaces(client, { enabled: config.enabled, workspaces })
      this.patch({ publishedAt: this.deps.now?.() ?? Date.now() })
    } catch (error) {
      this.deps.logger.warn('[Dispatch] publishing workspaces failed', error)
    }
  }

  // -- 帧处理 -------------------------------------------------------------

  /** 中继入口：一条云端帧。测试也走这里，保证测的是真实分发路径。 */
  async handleFrame(frame: RelayFrame): Promise<void> {
    const taskId = typeof frame.taskId === 'string' ? frame.taskId : ''
    if (!taskId) return
    if (frame.type === 'task.assigned') {
      this.enqueue({
        taskId,
        workspaceId: String(frame.workspaceId ?? ''),
        prompt: String(frame.prompt ?? ''),
      })
      return
    }
    if (frame.type === 'task.cancel') {
      await this.cancelTask(taskId)
      return
    }
    // task.answered 属于 P2；P1 只记下来，别让任务悬挂
    if (frame.type === 'task.answered') {
      this.deps.logger.warn('[Dispatch] ignoring task.answered (P1 has no input-required)')
    }
  }

  private enqueue(task: { taskId: string; workspaceId: string; prompt: string }): void {
    if (this.queue.some((item) => item.taskId === task.taskId)) return
    if (this.state.runningTaskId === task.taskId) return
    this.queue.push(task)
    this.patch({})
    void this.drain()
  }

  private async cancelTask(taskId: string): Promise<void> {
    const index = this.queue.findIndex((item) => item.taskId === taskId)
    if (index >= 0) {
      this.queue.splice(index, 1)
      await this.report(taskId, { kind: 'canceled', error: '云端取消' }).catch(() => undefined)
      this.patch({})
      return
    }
    if (this.state.runningTaskId === taskId) {
      await this.executor.cancel(taskId)
    }
  }

  /** 串行执行：一个任务跑到终态再领下一个 */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift() as {
          taskId: string
          workspaceId: string
          prompt: string
        }
        this.patch({})
        const config = readDispatchConfig()
        const workspace = findWorkspace(config, next.workspaceId)
        if (!workspace) {
          const error = '本机已不再允许这个工作区派活（白名单里没有它）。'
          await this.report(next.taskId, { kind: 'failed', error }).catch(() => undefined)
          this.record({
            taskId: next.taskId,
            workspaceId: next.workspaceId,
            workspaceLabel: next.workspaceId,
            state: 'failed',
            summary: error,
            sessionId: null,
          })
          continue
        }
        if (!fs.existsSync(workspace.path)) {
          const error = '工作区目录不存在（可能被移动或删除）。'
          await this.report(next.taskId, { kind: 'failed', error }).catch(() => undefined)
          this.record({
            taskId: next.taskId,
            workspaceId: next.workspaceId,
            workspaceLabel: workspace.label,
            state: 'failed',
            summary: error,
            sessionId: null,
          })
          continue
        }

        this.patch({
          runningTaskId: next.taskId,
          runningWorkspace: workspace.label,
        })
        await this.report(next.taskId, { kind: 'claimed' }).catch((error: unknown) => {
          this.deps.logger.warn('[Dispatch] claim report failed', error)
        })

        const outcome = await this.executor.run({
          taskId: next.taskId,
          workspaceId: next.workspaceId,
          workspacePath: workspace.path,
          prompt: next.prompt,
        })
        // 本地会话 id 一定要带上（云端拿它做「派活 → 本机会话」的锚点）
        const report = { ...outcome.report }
        if (!report.localSessionId && outcome.sessionId) report.localSessionId = outcome.sessionId
        await this.report(next.taskId, report).catch((error: unknown) => {
          this.deps.logger.warn('[Dispatch] outcome report failed', error)
        })
        this.record({
          taskId: next.taskId,
          workspaceId: next.workspaceId,
          workspaceLabel: workspace.label,
          state: outcome.report.kind === 'done' ? 'completed' : 'failed',
          summary: outcome.report.summary ?? outcome.report.error ?? '',
          sessionId: outcome.sessionId,
        })
        this.patch({ runningTaskId: null, runningWorkspace: null })
      }
    } finally {
      this.draining = false
      this.patch({})
    }
  }

  /** 写本机账本；写失败只记日志，不影响任务结果 */
  private record(input: {
    taskId: string
    workspaceId: string
    workspaceLabel: string
    state: 'completed' | 'failed' | 'canceled'
    summary: string
    sessionId: string | null
  }): void {
    try {
      const entries = appendLedger(this.deps.ledgerPath, {
        ...input,
        summary: input.summary.slice(0, 500),
        at: this.deps.now?.() ?? Date.now(),
      })
      this.patch({ recent: entries })
    } catch (error) {
      this.deps.logger.warn('[Dispatch] writing ledger failed', error)
    }
  }

  private async report(
    taskId: string,
    report: Omit<Parameters<typeof reportTask>[1], 'taskId'>
  ): Promise<void> {
    const client = this.clientFor(readDispatchConfig())
    if (!client) return
    await reportTask(client, { taskId, ...report })
  }

  private patch(patch: Partial<DispatchWorkerState>): void {
    this.state = { ...this.state, ...patch }
    this.deps.onState(this.getState())
  }
}
