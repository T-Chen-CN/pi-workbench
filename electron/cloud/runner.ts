/**
 * 一次 run 的主进程生命周期：
 *   POST /v1/runs → 读一次状态拿 session_id → 订阅 SSE 推帧 → 结束时用历史做一次校正。
 *
 * 校正帧是「工具结果」的唯一可靠来源（SSE 的 `tool.completed.preview` 可能是空串）。
 */

import type { CloudFrame, CloudRunStatus } from './types.js'
import { CloudApiError, type CloudClient } from './client.js'
import { readSseStream } from './events.js'
import { RunMapper } from './map.js'
import { createRemote, type CloudRemote } from './remote.js'
import { flushApprovalOutcome, recordApprovalOutcome } from './audit.js'

/** 停止请求发出后，等后端推终态的最长时间 */
const STOP_FALLBACK_MS = 15_000
/** 断流后最多重订阅几次（后端支持 Last-Event-ID 续传） */
const MAX_STREAM_RETRIES = 3
const RETRY_BASE_DELAY_MS = 500
/**
 * 「只要新事件」的订阅游标。
 *
 * `GET /v1/runs/{id}/events` 不带 `last_seq` 时从 **seq 0 全量回放** backlog
 * （`api_server_runs.py` 的 `_RunStream.attach(last_seq=-1)`），而重启后时间线
 * 已经由历史重建过一遍 —— 照抄回放会把整轮再渲染一次。把游标顶到 int32 上限，
 * 回放集合为空，只收订阅之后的增量；后续断流重订阅用的是真实观测到的 seq。
 */
export const LIVE_ONLY_SEQ = 2 ** 31 - 1

/**
 * 同时跟随的实时流上限。
 *
 * 网关给每台设备的 SSE 并发是 2（CLOUD_AGENT §6.4），所以本地也封 2 条：
 * 第 3 轮在客户端就拒绝，比让服务端回 429、界面卡在「运行中」要好解释。
 */
export const MAX_LIVE_STREAMS = 2

export interface CloudAttachResult {
  /** 是否真的接上了事件流（false = 这轮已经结束 / 只补了状态） */
  attached: boolean
  runId: string
  sessionId: string | null
  state: CloudRunStatus
}
/**
 * 轮询状态的间隔。
 *
 * clarify / approval 本来会从 SSE 推过来，但流可能已经断了（重连三次失败后我们只是
 * 不再跟随）。这时只有 `GET /v1/runs/{id}` 的 `pending_controls` 能告诉我们
 * "它在等人回答" —— 15 秒一次，代价可以忽略。
 */
export const CONTROL_POLL_MS = 15_000

export interface CloudRunnerDeps {
  emit: (frame: CloudFrame) => void
  log?: (message: string, error?: unknown) => void
  /**
   * 这一轮已经落到终态 —— 实时帧说出来，或收尾校正发现的都算。
   * 「跨重启接回」的记录靠它清掉（不能只看帧：接回时终态可能落在被丢弃的缓冲里）。
   */
  onRunSettled?: (runId: string, state: CloudRunStatus) => void
}

interface StreamState {
  runId: string
  sessionId: string | null
  controller: AbortController
  /** 这一轮的映射器：IPC 要用它把审批对到具体的工具调用上 */
  mapper: RunMapper
}

export class CloudRunner {
  private remote: CloudRemote
  /**
   * 在跟随的轮次，按 runId 索引。
   *
   * 多轮并存是允许的（不同会话各跑各的），上限见 `MAX_LIVE_STREAMS`。
   * 每轮的状态必须自己带 sessionId：帧的归属、收尾重拉历史、停止的兜底都靠它。
   */
  private streams = new Map<string, StreamState>()

  private readonly client: CloudClient

  constructor(
    private readonly deps: CloudRunnerDeps,
    client: CloudClient
  ) {
    this.client = client
    this.remote = createRemote(client)
  }

  /** 最近一轮（IPC 没拿到显式 runId 时的兜底） */
  get activeRunId(): string | null {
    const ids = [...this.streams.keys()]
    return ids.length > 0 ? (ids[ids.length - 1] ?? null) : null
  }

  /** 这个会话正在跟的 run（没有就 null） */
  activeRunIdFor(sessionId: string | null | undefined): string | null {
    if (!sessionId) return null
    for (const stream of this.streams.values()) {
      if (stream.sessionId === sessionId) return stream.runId
    }
    return null
  }

  get liveStreamCount(): number {
    return this.streams.size
  }

  /**
   * 所有帧都要带会话归属。
   *
   * 渲染层只认当前会话的帧：A 在跑的时候切到 B，A 的增量不能写进 B 的时间线。
   */
  private emit(frame: CloudFrame, sessionId: string | null): void {
    // `session` 帧自己就带着新会话 id，不能再被外层覆盖
    this.deps.emit(frame.kind === 'session' ? frame : { ...frame, sessionId })
  }

  get remoteApi(): CloudRemote {
    return this.remote
  }

  async start(input: {
    input: string
    sessionId?: string
    idempotencyKey: string
  }): Promise<{ runId: string; sessionId: string | null }> {
    if (this.streams.size >= MAX_LIVE_STREAMS) {
      throw new CloudApiError(
        'conflict',
        `同时最多跟随 ${MAX_LIVE_STREAMS} 轮；先等其中一轮结束`
      )
    }
    const accepted = await this.remote.startRun(input)
    let sessionId = input.sessionId ?? null
    // 同一会话已有轮次在跑时后端会排队（202 里 status=queued）：别把它报成 started
    let initialState: CloudRunStatus = 'started'

    // 202 里没有 session_id：读一次状态拿（同时能发现「一秒内就失败」的轮次）
    try {
      const snapshot = await this.remote.runStatus(accepted.runId)
      if (snapshot.sessionId) sessionId = snapshot.sessionId
      if (snapshot.status === 'queued') initialState = 'queued'
    } catch (error) {
      this.deps.log?.('[Cloud] initial run status failed', error)
    }

    if (sessionId) this.emit({ kind: 'session', sessionId }, sessionId)
    this.emit({ kind: 'run', runId: accepted.runId, state: initialState }, sessionId)

    void this.streamRun(accepted.runId, sessionId)
    return { runId: accepted.runId, sessionId }
  }

  /**
   * 接回一轮已经在服务端跑着的 run（应用重启 / 断线之后）。
   *
   * 顺序是「先问状态 → 铺历史 → 只订阅新事件」：
   * - 终态：不订阅，直接按历史校正一次（`parts` 全量替换 + 终态帧）；
   * - `unknown`（主人进程丢了）：没有事件流可订，只把状态补出来，等用户点「收尾」；
   * - 还在跑：先把历史铺好，再把订阅期间的增量补上（顺序见 `streamRun`）。
   */
  async attach(input: { runId: string; sessionId?: string | null }): Promise<CloudAttachResult> {
    const runId = input.runId
    const live = this.streams.get(runId)
    if (live) {
      const sessionId = live.sessionId ?? input.sessionId ?? null
      return { attached: true, runId, sessionId, state: 'running' }
    }

    const snapshot = await this.remote.runStatus(runId)
    const sessionId = snapshot.sessionId ?? input.sessionId ?? null
    if (sessionId) this.emit({ kind: 'session', sessionId }, sessionId)

    if (isTerminalStatus(snapshot.status) || snapshot.status === 'unknown') {
      // 收尾 / 丢失的轮次没有实时流可跟：账本与工具结果全靠历史这条路回来
      await this.reconcile(runId, sessionId, false)
      return { attached: false, runId, sessionId, state: snapshot.status }
    }

    this.emit({ kind: 'run', runId, state: snapshot.status }, sessionId)
    void this.streamRun(runId, sessionId, { liveOnly: true, historyFirst: true })
    return { attached: true, runId, sessionId, state: snapshot.status }
  }

  /**
   * 请求停止。
   *
   * 不立刻断开事件流：后端会推 `run.cancelled` 并关闭流，那时收尾最准确。
   * 但模型可能卡在一次很长的请求里，所以 15s 还没结束就主动断开并自行收敛。
   */
  async stop(runId: string): Promise<CloudRunStatus> {
    const snapshot = await this.remote.stopRun(runId)
    const timer = setTimeout(() => {
      if (!this.streams.has(runId)) return
      this.streams.get(runId)?.controller.abort()
      this.streams.delete(runId)
      void this.reconcile(runId, null, false)
    }, STOP_FALLBACK_MS)
    timer.unref?.()
    return snapshot.status
  }

  /**
   * 插话：运行中把新指令插进去。
   *
   * 后端只接受 `running` 状态（queued 会被拒），并且不保证立刻投递 ——
   * 终态事件里可能带回 `pending_steer`，那才是"没送进去"的真相。
   */
  async steer(runId: string | null, text: string): Promise<void> {
    const target = runId ?? this.activeRunId
    if (!target) throw new Error('当前没有正在执行的一轮')
    await this.remote.steerRun(target, text)
  }

  dispose(): void {
    for (const stream of this.streams.values()) stream.controller.abort()
    this.streams.clear()
  }

  private async streamRun(
    runId: string,
    sessionId: string | null,
    options: { liveOnly?: boolean; historyFirst?: boolean } = {}
  ): Promise<void> {
    const mapper = new RunMapper(runId)
    const controller = new AbortController()
    // 同一轮重复订阅（attach 之后又收到重推）：旧的先让位，避免两条流写同一条时间线
    this.streams.get(runId)?.controller.abort()
    this.streams.set(runId, { runId, sessionId, controller, mapper })
    let terminal = false
    /** 服务端明确说过「这一轮已经结束 / 没这一轮」：不再续订，收尾时要说清楚 */
    let fatalStreamEnd = false
    /** 事件流断过 / 重订过 / 本身是接回：这一轮的时间线不完整，收尾要靠历史补齐 */
    let degraded = Boolean(options.historyFirst)
    const controlPoll = setInterval(() => {
      if (terminal || controller.signal.aborted) return
      void this.pollControls(runId, mapper, sessionId)
    }, CONTROL_POLL_MS)
    controlPoll.unref?.()
    // 接回来的轮次：审批卡不会自动重推，先问一次，别等 15 秒
    if (options.historyFirst) void this.pollControls(runId, mapper, sessionId)
    // 已经收到的最后一个事件序号：断流重订阅时带回去，避免重复或漏事件
    let lastSeq = options.liveOnly ? LIVE_ONLY_SEQ : -1

    /**
     * 接回流：历史必须先落到界面上，订阅期间的增量再往后放。
     *
     * 否则历史帧（全量替换）会把刚推过来的工具卡 / 审批卡冲掉。
     * 反过来，如果这一轮在历史落地前就结束了，缓冲直接丢弃 —— 终态 reconcile
     * 会拿历史重建整条时间线，那时候再补增量只会重复。
     */
    let buffering = Boolean(options.historyFirst)
    let finished = false
    /** 渲染层是否真的收到过终态帧：没收到就得由 reconcile 补发 */
    let deliveredTerminal = false
    const buffered: CloudFrame[] = []
    const dispatch = (frame: CloudFrame): void => {
      if (buffering) {
        buffered.push(frame)
        return
      }
      if (frame.kind === 'run' && isTerminalStatus(frame.state)) deliveredTerminal = true
      this.emit(frame, sessionId)
      this.auditToolOutcome(frame, runId)
    }
    const release = (): void => {
      if (!buffering) return
      buffering = false
      // 这一轮在历史落地前就结束了：增量不要了（终态 reconcile 会用历史重建）
      if (finished) {
        buffered.length = 0
        return
      }
      for (const frame of buffered.splice(0)) dispatch(frame)
    }
    if (options.historyFirst) {
      void this.loadHistoryFrames(runId, sessionId).then(release, release)
    }

    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const suffix = lastSeq >= 0 ? `?last_seq=${lastSeq}` : ''
          const response = await this.client.openStream(
            `/v1/runs/${encodeURIComponent(runId)}/events${suffix}`,
            controller.signal
          )
          if (!response.body) throw new Error('事件流没有响应正文')
          const endReason = await readSseStream(response.body, {
            signal: controller.signal,
            onFrame: (frame) => {
              if (typeof frame.id === 'number') lastSeq = frame.id
              for (const emitted of mapper.handle(frame)) {
                if (emitted.kind === 'run') {
                  terminal = true
                  if (isTerminalStatus(emitted.state)) this.deps.onRunSettled?.(runId, emitted.state)
                }
                dispatch(emitted)
              }
            },
          })
          // 流是「正常读完」的（服务端关流 / keepalive 静默超时），没抛错也就没有
          // 失败日志 —— 不在这里记一条，这次断流在日志里根本不存在，只剩后面重订阅的后果。
          if (!terminal && endReason !== 'aborted') {
            this.deps.log?.('[Cloud] run stream ended without terminal frame', {
              runId,
              endReason,
              lastSeq,
            })
          }
        } catch (error) {
          if (controller.signal.aborted) break
          degraded = true
          this.deps.log?.('[Cloud] run stream failed', error)
          // 服务端已经明确说「没有这一轮 / 这一轮已经结束了」：重订阅只会把退避
          // 全花在一个不会变的答案上，最后还推一条「多次中断」的假故障。
          // 实测 2026-11-09 10:34 就是这么连打四次 `这一轮已经结束了`。
          if (isFatalStreamError(error)) {
            this.deps.log?.('[Cloud] run stream stop following', { runId, code: error.code })
            fatalStreamEnd = true
            break
          }
        }

        if (terminal || controller.signal.aborted) break

        // 流断了但没收到终态：先确认后端还在跑，再决定续订还是收尾
        const stillRunning = await this.isRunning(runId)
        if (!stillRunning) break
        if (attempt >= MAX_STREAM_RETRIES) {
          degraded = true
          this.deps.log?.('[Cloud] run stream give up', { runId, attempts: attempt + 1 })
          this.emit(
            {
              kind: 'error',
              runId,
              error: '事件流多次中断，已停止跟随；重新打开会话可看到最新进度',
            },
            sessionId
          )
          break
        }
        // 还有下一次订阅：中间这一段事件已经断了，收尾得靠历史补
        degraded = true
        await delay(RETRY_BASE_DELAY_MS * 2 ** attempt)
      }
    } finally {
      clearInterval(controlPoll)
      finished = true
      buffered.length = 0
      if (this.streams.get(runId)?.controller === controller) this.streams.delete(runId)
    }

    // 第三个参数 = 「渲染层已经收到过终态」，而不是「后端已经结束」：
    // 接回时终态帧可能落在被丢弃的缓冲里，那就得由 reconcile 补一次。
    // 第四个参数 = 「这一轮流得很干净」：干净就只用历史核对审计，不拿它替掉时间线
    // （整段替换会把请求期间刚到的最新消息顶掉）。
    const settledState = await this.reconcile(
      runId,
      sessionId,
      deliveredTerminal,
      terminal && !degraded
    )
    // 服务端说这一轮结束了、状态接口却说还在跑：把这条不一致说出来，
    // 别留一个永远转圈的界面（也不像以前那样误报成「事件流多次中断」）。
    if (fatalStreamEnd && (settledState === null || !isTerminalStatus(settledState))) {
      this.emit(
        {
          kind: 'error',
          runId,
          error: '事件流已被服务端关闭（这一轮已收尾），但状态仍未终态；重新打开会话可看到最新进度',
        },
        sessionId
      )
    }
    // 实时帧只有 `error`、预览是空的：收尾时历史已经重拉过，该补的补上
    flushApprovalOutcome(runId)
  }

  /**
   * 审批的真实结果：**审批拦下的那个工具卡**一旦终态就结掉审计。
   *
   * 被拒绝时服务端返回 `BLOCKED: ...` 且 `error=true`，与真实执行失败区得开 ——
   * 这正是「审计三问」里第三问的证据。实时流和历史纠正帧都走这里：断流之后
   * 结果只会出现在历史里，不能因此把这一问丢掉。
   */
  private auditToolOutcome(frame: CloudFrame, runId: string): void {
    const parts =
      frame.kind === 'part'
        ? [frame.part]
        : frame.kind === 'parts'
          ? frame.parts
          : []
    for (const part of parts) {
      if (part.type !== 'tool') continue
      if (part.status === 'running') continue
      recordApprovalOutcome(runId, {
        error: part.status === 'error',
        preview: part.resultPreview ?? '',
        exitCode: part.exitCode,
        toolCallId: part.toolCallId || undefined,
      })
    }
  }

  /** 这条审批拦的是哪个工具调用（IPC 写审计时用；拿不到就当未知） */
  approvalToolCallId(requestId: string): string | undefined {
    for (const stream of this.streams.values()) {
      const found = stream.mapper.approvalToolCallId(requestId)
      if (found) return found
    }
    return undefined
  }

  /** 只补「还没见过的提问」：已有的 prompt_id 会被 mapper 去重掉 */
  private async pollControls(runId: string, mapper: RunMapper, sessionId: string | null): Promise<void> {
    try {
      const snapshot = await this.remote.runStatus(runId)
      for (const control of snapshot.pendingControls ?? []) {
        const kind = controlKindOf(control)
        if (kind === 'clarify') {
          for (const emitted of mapper.ensureClarify(control)) this.emit(emitted, sessionId)
        } else if (kind === 'approval') {
          for (const emitted of mapper.ensureApproval(control)) this.emit(emitted, sessionId)
        }
      }
    } catch (error) {
      this.deps.log?.('[Cloud] control poll failed', error)
    }
  }

  /**
   * 后端是否仍在执行这一轮（查不到状态时按「已结束」处理，交给 reconcile 兜底）。
   * `unknown` 表示主人进程丢了：流不可能再推任何东西，不再重订阅。
   */
  private async isRunning(runId: string): Promise<boolean> {
    try {
      const snapshot = await this.remote.runStatus(runId)
      if (snapshot.status === 'unknown') return false
      return snapshot.status !== 'completed' && snapshot.status !== 'failed' && snapshot.status !== 'cancelled'
    } catch (error) {
      this.deps.log?.('[Cloud] run status probe failed', error)
      return false
    }
  }

  /**
   * 用历史重建时间线（接回流的第一步），后面紧跟一条「已接回」分隔线。
   *
   * 与服务端 `GET /api/sessions/{id}/messages` 之间有几毫秒竞态：正好在那个窗口
   * 落盘的消息可能既在历史里又在增量里出现一次，终态 reconcile 会抹平。
   */
  private async loadHistoryFrames(runId: string, sessionId: string | null): Promise<void> {
    if (!sessionId) return
    // 取**尾部**：接回时用户要看的是刚才那一段，不是会话最早的一页
    const page = await this.remote.listMessageTail({ sessionId, limit: 500 })
    this.auditToolOutcome({ kind: 'parts', parts: page.parts }, runId)
    this.emit({ kind: 'parts', parts: page.parts }, sessionId)
    this.emit(
      { kind: 'part', part: { type: 'divider', id: `reattach:${runId}`, kind: 'reattach' } },
      sessionId
    )
  }

  /**
   * 流结束 / 断流后的收敛：拿最终状态 + （必要时）重拉历史。
   *
   * `clean` = 这一轮的事件流从头到尾没断过、也收到过终态。这时**只拿历史核对审计，
   * 不用它替掉时间线**：历史是不可变的，实时帧已经把这一轮的内容全给到了；
   * 而历史帧是 `parts` 整段替换，会把请求期间刚推上界面的几条消息顶掉
   * （实测症状：最新消息出现后又消失）。
   * 时间线本来就残缺（断流 / 接回 / 漏帧）时历史才是权威，那时候替换才是对的。
   *
   * 返回服务端最终报的状态（查不到时为 `null`）：调用方靠它判断「收尾后到底落没落终态」。
   */
  private async reconcile(
    runId: string,
    sessionId: string | null,
    terminal: boolean,
    clean = false
  ): Promise<CloudRunStatus | null> {
    let session = sessionId
    let state: CloudRunStatus | null = null
    let error: string | null = null

    try {
      const snapshot = await this.remote.runStatus(runId)
      session = session ?? snapshot.sessionId
      state = snapshot.status
      error = snapshot.error
    } catch (statusError) {
      // 轮次已被回收：没有终态事件时按完成处理，避免把正常结束显示成错误
      if (statusError instanceof CloudApiError && statusError.code === 'not_found') {
        state = terminal ? null : 'completed'
      } else {
        this.deps.log?.('[Cloud] reconcile status failed', statusError)
      }
    }

    if (state && isTerminalStatus(state)) this.deps.onRunSettled?.(runId, state)

    if (session && session !== sessionId) {
      this.emit({ kind: 'session', sessionId: session }, session)
    }

    // 终态先告诉渲染层：重拉历史可能很慢（接回时的历史请求甚至可能卡住），
    // 不能让界面一直停在「运行中」。
    if (!terminal && state) {
      this.emit({ kind: 'run', runId, state, error: error ?? undefined }, session)
    }

    if (session) {
      try {
        const page = await this.remote.listMessageTail({ sessionId: session, limit: 500 })
        // 历史里也可能带着「那次审批的结果」：断流期间结果只走这条路回来；
        // 实时帧的预览也可能是空的，所以**审计总要核对一次**（不推给界面就不会顶掉谁）
        this.auditToolOutcome({ kind: 'parts', parts: page.parts }, runId)
        if (!clean) this.emit({ kind: 'parts', parts: page.parts }, session)
      } catch (historyError) {
        this.deps.log?.('[Cloud] history reconcile failed', historyError)
      }
    }
    return state
  }
}

function isTerminalStatus(status: CloudRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/**
 * 这个流错误值不值得重订阅。
 *
 * 只有「网络断了 / 服务端 5xx / 429」这类**可能变好**的错误才退避重试；
 * 4xx 里的「没这条 run」「这一轮已经结束了」「凭据不对」重试一万次也是同一个答案，
 * 只是把 `MAX_STREAM_RETRIES` 的退避时间白白烧掉，还会误报成「事件流多次中断」。
 */
function isFatalStreamError(error: unknown): error is CloudApiError {
  if (!(error instanceof CloudApiError)) return false
  return (
    error.code === 'not_found' ||
    error.code === 'conflict' ||
    error.code === 'bad_request' ||
    error.code === 'unauthorized' ||
    error.code === 'forbidden'
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `pending_controls` 里这一条是审批还是提问。
 *
 * 不硬编码单一 `kind`：服务端版本间 `kind` 的取值与字段都在变，所以先看 `kind`，
 * 再看字段形状（审批带命令/命中规则，提问带问题文本）。
 */
export function controlKindOf(control: Record<string, unknown>): 'clarify' | 'approval' | null {
  const kind = String(control?.kind ?? '').toLowerCase()
  if (kind.includes('clarify')) return 'clarify'
  if (kind.includes('approv')) return 'approval'
  const hasCommand = typeof control?.command === 'string'
  const hasPattern = control?.pattern_key !== undefined || Array.isArray(control?.pattern_keys)
  if (hasCommand || hasPattern) return 'approval'
  if (typeof control?.question === 'string') return 'clarify'
  return null
}
