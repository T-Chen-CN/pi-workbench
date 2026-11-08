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
  writeDispatchConfig,
  type DispatchConfig,
} from './config.js'
import { DispatchExecutor } from './executor.js'
import {
  DispatchRelay,
  publishWorkspaces,
  reportTask,
  type RelayFrame,
  type ReportInput,
} from './relay.js'
import { appendLedger, readLedger, type DispatchLedgerEntry } from './ledger.js'
import { TraceCollector, compactTrace, readTrace } from './trace.js'

export interface DispatchWorkerState {
  enabled: boolean
  connected: boolean
  lastFrameAt: number | null
  lastError: string | null
  /** 当前正在执行的任务与工作区显示名 */
  runningTaskId: string | null
  runningWorkspace: string | null
  /** 本地 Agent 正在等云端回答的问题（`input_required`） */
  question: string | null
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
  /** 轨迹缓存目录（`{appDir}/cache/dispatch-traces`）；测试注入 */
  traceDir?: string
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
    ask?: (question: string) => Promise<string>
    onTrace?: (event: {
      type: string
      toolCallId?: string
      toolName?: string
      argsSummary?: string
      status?: 'success' | 'error'
      durationMs?: number
      resultPreview?: string
      filePath?: string
    }) => void
  }) => Promise<{
    report: Omit<Parameters<typeof reportTask>[1], 'taskId'>
    sessionId: string | null
  }>
  cancel: (taskId: string) => Promise<boolean>
}

/** 设备上报清单的节奏：与心跳同源，30s 一次足够 */
const CATALOG_REFRESH_MS = 30_000
/**
 * 任务执行期间的心跳：网关租约 120s 靠它续命。
 * 只在本地 Agent 真的在跑时发 —— 等云端回答（`input_required`）同样算活着。
 */
const PROGRESS_HEARTBEAT_MS = 30_000
/** 反问最多等这么久；再久说明云端那轮已经放弃，本地不能一直挂住 */
const QUESTION_TIMEOUT_MS = 9 * 60_000

const DEFAULT_STATE: DispatchWorkerState = {
  enabled: false,
  connected: false,
  lastFrameAt: null,
  lastError: null,
  runningTaskId: null,
  runningWorkspace: null,
  question: null,
  queued: 0,
  publishedAt: null,
  recent: [],
}

export class DispatchWorker {
  private relay: DispatchRelay | null = null
  private executor: DispatchExecutorLike
  private state: DispatchWorkerState = { ...DEFAULT_STATE }
  private queue: Array<{ taskId: string; workspaceId: string; prompt: string }> = []
  /**
   * 本机收到的取消：taskId → 原因（「本机急停」/「云端取消」）。
   * 这些任务的结果要报 canceled 而不是 failed —— abort 会让 chat() 抛错，
   * 照原样上报会把一次刻意的取消写成失败。
   */
  private readonly cancelReasons = new Map<string, string>()
  /** 等云端回答的问句：taskId → 挂起的 resolve / reject */
  private readonly questions = new Map<
    string,
    { resolve: (answer: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  /** 上报失败的回报：重连后补发，否则设备白干一场，云端永远等不到结果 */
  private readonly pendingReports: Array<{
    taskId: string
    input: Omit<ReportInput, 'taskId'>
  }> = []
  /**
   * 已经跑出结果的任务：taskId → 该补发的那次回报。
   *
   * 重连时网关会补发 `running` 任务（接回语义），但如果本机其实已经跑完、只是回报
   * 没送到，直接重跑等于把同一条指令执行两遍。这里记着结果，收到补发就再报一次。
   */
  private readonly finished = new Map<string, Omit<ReportInput, 'taskId'>>()
  private progressTimer: ReturnType<typeof setInterval> | null = null
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

  /**
   * 停止派活：**正在跑的任务也停**。
   *
   * 只拒绝反问不 abort，会让工具错误被模型当成「云端回答」写进文件（实测写出过
   * 「派活已关闭」这种内容），所以取消必须三件齐做：标原因、abort 会话、等 drain
   * 收尾。回报要在中继断开**之前**发，否则云端只看到 `running` 一直等到租约超时。
   */
  async stop(reason = '派活已关闭'): Promise<void> {
    if (this.catalogTimer) clearInterval(this.catalogTimer)
    this.catalogTimer = null

    // 队列里还没开跑的：先摘出队列再回报终态。顺序不能反 —— 先 abort 正在跑的任务，
    // drain 会在我们清队列之前就领走下一个，那条任务既没被取消也没跑完。
    const queued = this.queue
    this.queue = []
    for (const item of queued) {
      await this.report(item.taskId, { kind: 'canceled', error: reason }).catch(
        () => undefined
      )
      this.record({
        taskId: item.taskId,
        workspaceId: item.workspaceId,
        workspaceLabel: item.workspaceId,
        state: 'canceled',
        summary: reason,
        sessionId: null,
      })
    }

    const running = this.state.runningTaskId
    if (running) {
      this.cancelReasons.set(running, reason)
      this.rejectQuestion(running, reason)
      await this.executor.cancel(running).catch((error: unknown) => {
        this.deps.logger.warn('[Dispatch] cancelling running task failed', error)
      })
      await this.settleDrain()
    }

    // 先告诉网关「这台设备不再接活」：云端必须立刻看到关着的开关，否则会在 90s 的
    // 「可能只是抖动」窗口里继续派活，任务排队到用户重新打开开关后才突然执行。
    await this.publishDisabledCatalog()
    const relay = this.relay
    this.relay = null
    if (relay) await relay.stop()
    this.queue = []
    this.stopProgress()
    for (const taskId of [...this.questions.keys()]) this.rejectQuestion(taskId, reason)
    this.patch({
      enabled: false,
      connected: false,
      runningTaskId: null,
      runningWorkspace: null,
      question: null,
    })
  }

  /** 等 drain 把当前任务收尾（abort 后通常几十毫秒，兜底 5s） */
  private async settleDrain(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.draining && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  /**
   * 界面「急停」：关掉派活 + 断中继 + 中止正在跑的任务。
   *
   * 三件事必须一起做：只断中继不 abort 会留下仍在写文件的会话；只 abort 不落盘
   * `enabled:false`，界面上的开关和磁盘会不一致（下次重启又自己连上）。
   * 被中止的任务由 drain 里按 `canceled` 回报（见 `cancelReasons`）。
   */
  async stopNow(): Promise<void> {
    const config = readDispatchConfig()
    if (config.enabled || config.workspaces.length > 0) {
      await writeDispatchConfig({ ...config, enabled: false }).catch((error: unknown) => {
        this.deps.logger.warn('[Dispatch] persisting emergency stop failed', error)
      })
    }
    // 队列与运行中任务的收尾统一在 stop() 里做，只是原因写「本机急停」
    await this.stop('本机急停')
  }

  /** 只要设备还配对着就能建客户端（关掉派活时也要用它把空清单报上去） */
  private cloudClient(): CloudClient | null {
    const cloud = readCloudConfig()
    if (!cloud.hasDeviceToken || !cloud.deviceToken || !cloud.gatewayUrl) return null
    const factory = this.deps.createClient ?? createCloudClient
    try {
      return factory({ baseUrl: cloud.gatewayUrl, credential: cloud.deviceToken })
    } catch (error) {
      this.deps.logger.warn('[Dispatch] cannot build cloud client', error)
      return null
    }
  }

  private clientFor(config: DispatchConfig): CloudClient | null {
    if (config.workspaces.length === 0) return null
    return this.cloudClient()
  }

  /**
   * 停止 / 关闭派活时把清单标成「不可派活」。
   *
   * 保留工作区本身（不报空列表）：云端模型再派时会拿到「这个工作区没打开派活开关」，
   * 而不是「这台机器上什么都没有」——前者能让它判断该请用户打开开关。
   */
  private async publishDisabledCatalog(): Promise<void> {
    const client = this.cloudClient()
    if (!client) return
    const config = readDispatchConfig()
    try {
      await publishWorkspaces(
        client,
        { enabled: false, workspaces: publicWorkspaces(config) },
        // 这条是「关开关 / 退出」路径上的，用户正等着界面响应，别等满 15s
        { timeoutMs: 3_000 }
      )
    } catch (error) {
      this.deps.logger.warn('[Dispatch] publishing disabled catalog failed', error)
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
          // 重连成功先补发没送到的回报，再补一次清单（断线期间用户可能改了白名单）
          void this.flushPendingReports().then(() => this.publishCatalog())
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
      if (await this.replayFinished(taskId)) return
      this.enqueue({
        taskId,
        workspaceId: String(frame.workspaceId ?? ''),
        prompt: String(frame.prompt ?? ''),
      })
      return
    }
    if (frame.type === 'task.cancel') {
      const reason = typeof frame.reason === 'string' && frame.reason ? frame.reason : '云端取消'
      await this.cancelTask(taskId, reason)
      return
    }
    if (frame.type === 'task.answered') {
      const pending = this.questions.get(taskId)
      if (!pending) return
      this.questions.delete(taskId)
      clearTimeout(pending.timer)
      this.patch({ question: null })
      pending.resolve(String(frame.answer ?? ''))
    }
  }

  private enqueue(task: { taskId: string; workspaceId: string; prompt: string }): void {
    if (this.queue.some((item) => item.taskId === task.taskId)) return
    if (this.state.runningTaskId === task.taskId) return
    this.queue.push(task)
    this.patch({})
    void this.drain()
  }

  private async cancelTask(taskId: string, reason = '云端取消'): Promise<void> {
    const index = this.queue.findIndex((item) => item.taskId === taskId)
    if (index >= 0) {
      this.queue.splice(index, 1)
      await this.report(taskId, { kind: 'canceled', error: reason }).catch(() => undefined)
      this.patch({})
      return
    }
    if (this.state.runningTaskId === taskId) {
      this.cancelReasons.set(taskId, reason)
      this.rejectQuestion(taskId, reason)
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

        this.startProgress(next.taskId)
        // 轨迹只攒在本地（缓存 + 终态回报里的紧凑副本），不发任何事件
        const collector = new TraceCollector(next.taskId, workspace.path, this.deps.now)
        // 执行器承诺不抛（自己把失败包成 report），但反问被 reject / 取消这类
        // 路径仍可能把异常带出来；漏掉就会让任务悬挂到 deadline
        const outcome = await this.executor
          .run({
            taskId: next.taskId,
            workspaceId: next.workspaceId,
            workspacePath: workspace.path,
            prompt: next.prompt,
            ask: (question) => this.askCloud(next.taskId, question),
            onTrace: (event) => collector.note(event),
          })
          .catch((error: unknown) => {
            this.deps.logger.warn('[Dispatch] executor threw', error)
            return {
              report: {
                kind: 'failed' as const,
                error: error instanceof Error ? error.message.slice(0, 2000) : String(error),
              },
              sessionId: null,
            }
          })
        this.stopProgress()
        // 取消过的任务：报告与账本都按 canceled 落，不要被 abort 产生的失败覆盖
        const cancelReason = this.cancelReasons.get(next.taskId)
        this.cancelReasons.delete(next.taskId)
        const base: Omit<ReportInput, 'taskId'> = cancelReason
          ? { kind: 'canceled', error: cancelReason }
          : outcome.report
        // 本地会话 id 一定要带上（云端拿它做「派活 → 本机会话」的锚点）
        const report: Omit<ReportInput, 'taskId'> = { ...base }
        if (!report.localSessionId && outcome.sessionId) report.localSessionId = outcome.sessionId
        // 轨迹：落本地缓存 + 终态回报里带一份紧凑副本（云端要能事后查）
        try {
          collector.finish()
          if (this.deps.traceDir) await collector.flush(this.deps.traceDir)
          if (report.kind !== 'canceled' || collector.snapshot().steps.length > 0) {
            report.trace = compactTrace(collector.snapshot())
          }
        } catch (error) {
          this.deps.logger.warn('[Dispatch] recording trace failed', error)
        }
        await this.report(next.taskId, report).catch((error: unknown) => {
          this.deps.logger.warn('[Dispatch] outcome report failed', error)
        })
        this.rememberFinished(next.taskId, report)
        this.record({
          taskId: next.taskId,
          workspaceId: next.workspaceId,
          workspaceLabel: workspace.label,
          state: cancelReason ? 'canceled' : report.kind === 'done' ? 'completed' : 'failed',
          summary: report.summary ?? report.error ?? '',
          sessionId: outcome.sessionId,
        })
        this.patch({ runningTaskId: null, runningWorkspace: null, question: null })
      }
    } finally {
      this.draining = false
      this.patch({})
    }
  }

  /**
   * 收到「本机已经跑完」的任务补发：只补发回报，不重跑。
   *
   * 先看内存（本轮跑完、回报失败），再退回账本（上一进程跑完、崩在回报前后）。
   * 都没有才返回 false，让调用方照常入队执行。
   */
  private async replayFinished(taskId: string): Promise<boolean> {
    const known = this.finished.get(taskId) ?? this.finishedFromLedger(taskId)
    if (!known) return false
    // 崩溃重启后内存里没有轨迹，从缓存补回来：云端至少还能查到步骤
    if (!known.trace && this.deps.traceDir) {
      const cached = await readTrace(this.deps.traceDir, taskId)
      if (cached) known.trace = compactTrace(cached)
    }
    this.deps.logger.info?.('[Dispatch] re-reporting finished task instead of re-running', taskId)
    await this.report(taskId, known).catch((error: unknown) => {
      this.deps.logger.warn('[Dispatch] re-reporting finished task failed', error)
    })
    return true
  }

  private rememberFinished(taskId: string, report: Omit<ReportInput, 'taskId'>): void {
    this.finished.set(taskId, report)
    // 只需要挡住「刚跑完就被重放」这种窗口，留最近 50 条足够
    while (this.finished.size > 50) {
      const oldest = this.finished.keys().next().value
      if (oldest === undefined) break
      this.finished.delete(oldest)
    }
  }

  private finishedFromLedger(taskId: string): Omit<ReportInput, 'taskId'> | null {
    let entries: DispatchLedgerEntry[] = []
    try {
      entries = readLedger(this.deps.ledgerPath)
    } catch {
      return null
    }
    const entry = entries.find((item) => item.taskId === taskId)
    if (!entry) return null
    if (entry.state === 'completed') {
      return {
        kind: 'done',
        summary: entry.summary,
        localSessionId: entry.sessionId ?? undefined,
      }
    }
    if (entry.state === 'canceled') {
      return { kind: 'canceled', error: entry.summary || '本机已取消该任务' }
    }
    return { kind: 'failed', error: entry.summary || '本机执行失败', localSessionId: entry.sessionId ?? undefined }
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
    try {
      await reportTask(client, { taskId, ...report })
    } catch (error) {
      // 网络断了：先留着，重连后补发。终态丢了 = 云端永远等不到结果。
      if (report.kind !== 'progress') this.pendingReports.push({ taskId, input: report })
      throw error
    }
  }

  /** 重连后补发失败的回报；同一任务只留最后一次（后到的状态覆盖先到的） */
  private async flushPendingReports(): Promise<void> {
    if (this.pendingReports.length === 0) return
    const batch = this.pendingReports.splice(0, this.pendingReports.length)
    for (const item of batch) {
      await this.report(item.taskId, item.input).catch((error: unknown) => {
        this.deps.logger.warn('[Dispatch] replaying report failed', error)
        this.pendingReports.push(item)
      })
    }
  }

  // -- 反问（input_required） ---------------------------------------------

  /**
   * 本地 Agent 需要云端决定时走这里：先回报 `question`（网关状态变 `input_required`，
   * 云端模型会看到问题），然后挂住等 `task.answered` 帧。
   */
  private async askCloud(taskId: string, question: string): Promise<string> {
    const text = question.trim().slice(0, 2000) || '（本地 Agent 没有说明问题）'
    this.patch({ question: text })
    await this.report(taskId, { kind: 'question', question: text }).catch((error: unknown) => {
      this.deps.logger.warn('[Dispatch] reporting question failed', error)
    })
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.questions.delete(taskId)
        reject(new Error('等云端回答超时'))
      }, QUESTION_TIMEOUT_MS)
      timer.unref?.()
      this.questions.set(taskId, { resolve, reject, timer })
    })
  }

  private rejectQuestion(taskId: string, reason: string): void {
    const pending = this.questions.get(taskId)
    if (!pending) return
    this.questions.delete(taskId)
    clearTimeout(pending.timer)
    this.patch({ question: null })
    pending.reject(new Error(`${reason}｜这不是云端回答，本次任务不要再写任何文件，直接结束`))
  }

  // -- 进度心跳 -----------------------------------------------------------

  private startProgress(taskId: string): void {
    this.stopProgress()
    this.progressTimer = setInterval(() => {
      void this.report(taskId, { kind: 'progress' }).catch(() => undefined)
    }, PROGRESS_HEARTBEAT_MS)
    this.progressTimer.unref?.()
  }

  private stopProgress(): void {
    if (!this.progressTimer) return
    clearInterval(this.progressTimer)
    this.progressTimer = null
  }

  private patch(patch: Partial<DispatchWorkerState>): void {
    this.state = { ...this.state, ...patch }
    this.deps.onState(this.getState())
  }
}
