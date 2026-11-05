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
}

export class CloudRunner {
  private remote: CloudRemote
  private stream: { runId: string; controller: AbortController } | null = null
  /** 当前轮的映射器：IPC 要用它把审批对到具体的工具调用上 */
  private mapper: RunMapper | null = null
  /** 当前轮所属会话：stop / 断流收尾时用来重拉历史 */
  private lastSessionId: string | null = null

  private readonly client: CloudClient

  constructor(
    private readonly deps: CloudRunnerDeps,
    client: CloudClient
  ) {
    this.client = client
    this.remote = createRemote(client)
  }

  get activeRunId(): string | null {
    return this.stream?.runId ?? null
  }

  get remoteApi(): CloudRemote {
    return this.remote
  }

  async start(input: {
    input: string
    sessionId?: string
    idempotencyKey: string
  }): Promise<{ runId: string; sessionId: string | null }> {
    const accepted = await this.remote.startRun(input)
    let sessionId = input.sessionId ?? null

    // 202 里没有 session_id：读一次状态拿（同时能发现「一秒内就失败」的轮次）
    try {
      const snapshot = await this.remote.runStatus(accepted.runId)
      if (snapshot.sessionId) sessionId = snapshot.sessionId
    } catch (error) {
      this.deps.log?.('[Cloud] initial run status failed', error)
    }

    if (sessionId) this.deps.emit({ kind: 'session', sessionId })
    this.deps.emit({ kind: 'run', runId: accepted.runId, state: 'started' })

    void this.streamRun(accepted.runId, sessionId)
    return { runId: accepted.runId, sessionId }
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
      if (this.stream?.runId !== runId) return
      this.stream.controller.abort()
      this.stream = null
      void this.reconcile(runId, this.lastSessionId, false)
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
  async steer(text: string): Promise<void> {
    const runId = this.stream?.runId ?? null
    if (!runId) throw new Error('当前没有正在执行的一轮')
    await this.remote.steerRun(runId, text)
  }

  dispose(): void {
    this.stream?.controller.abort()
    this.stream = null
  }

  private async streamRun(runId: string, sessionId: string | null): Promise<void> {
    const mapper = new RunMapper(runId)
    const controller = new AbortController()
    if (this.stream) this.stream.controller.abort()
    this.stream = { runId, controller }
    this.mapper = mapper

    if (sessionId) this.lastSessionId = sessionId
    let terminal = false
    const controlPoll = setInterval(() => {
      if (terminal || controller.signal.aborted) return
      void this.pollControls(runId, mapper)
    }, CONTROL_POLL_MS)
    controlPoll.unref?.()
    // 已经收到的最后一个事件序号：断流重订阅时带回去，避免重复或漏事件
    let lastSeq = -1

    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const suffix = lastSeq >= 0 ? `?last_seq=${lastSeq}` : ''
          const response = await this.client.openStream(
            `/v1/runs/${encodeURIComponent(runId)}/events${suffix}`,
            controller.signal
          )
          if (!response.body) throw new Error('事件流没有响应正文')
          await readSseStream(response.body, {
            signal: controller.signal,
            onFrame: (frame) => {
              if (typeof frame.id === 'number') lastSeq = frame.id
              for (const emitted of mapper.handle(frame)) {
                if (emitted.kind === 'run') terminal = true
                this.deps.emit(emitted)
                this.auditToolOutcome(emitted, runId)
              }
            },
          })
        } catch (error) {
          if (controller.signal.aborted) break
          this.deps.log?.('[Cloud] run stream failed', error)
        }

        if (terminal || controller.signal.aborted) break

        // 流断了但没收到终态：先确认后端还在跑，再决定续订还是收尾
        const stillRunning = await this.isRunning(runId)
        if (!stillRunning) break
        if (attempt >= MAX_STREAM_RETRIES) {
          this.deps.emit({
            kind: 'error',
            runId,
            error: '事件流多次中断，已停止跟随；重新打开会话可看到最新进度',
          })
          break
        }
        await delay(RETRY_BASE_DELAY_MS * 2 ** attempt)
      }
    } finally {
      clearInterval(controlPoll)
      if (this.stream?.runId === runId) this.stream = null
      this.mapper = null
    }

    await this.reconcile(runId, sessionId, terminal)
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
        toolCallId: part.toolCallId || undefined,
      })
    }
  }

  /** 这条审批拦的是哪个工具调用（IPC 写审计时用；拿不到就当未知） */
  approvalToolCallId(requestId: string): string | undefined {
    return this.mapper?.approvalToolCallId(requestId)
  }

  /** 只补「还没见过的提问」：已有的 prompt_id 会被 mapper 去重掉 */
  private async pollControls(runId: string, mapper: RunMapper): Promise<void> {
    try {
      const snapshot = await this.remote.runStatus(runId)
      for (const control of snapshot.pendingControls ?? []) {
        const kind = controlKindOf(control)
        if (kind === 'clarify') {
          for (const emitted of mapper.ensureClarify(control)) this.deps.emit(emitted)
        } else if (kind === 'approval') {
          for (const emitted of mapper.ensureApproval(control)) this.deps.emit(emitted)
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

  /** 流结束 / 断流后的收敛：拿最终状态 + 重拉历史（工具结果、token、花费都以历史为准） */
  private async reconcile(
    runId: string,
    sessionId: string | null,
    terminal: boolean
  ): Promise<void> {
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

    if (session && session !== sessionId) {
      this.deps.emit({ kind: 'session', sessionId: session })
    }

    if (session) {
      try {
        const page = await this.remote.listMessages({ sessionId: session, limit: 500 })
        // 历史里也可能带着「那次审批的结果」：断流期间结果只走这条路回来
        this.auditToolOutcome({ kind: 'parts', parts: page.parts }, runId)
        this.deps.emit({ kind: 'parts', parts: page.parts })
      } catch (historyError) {
        this.deps.log?.('[Cloud] history reconcile failed', historyError)
      }
    }

    if (!terminal && state) {
      this.deps.emit({ kind: 'run', runId, state, error: error ?? undefined })
    }
  }
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
