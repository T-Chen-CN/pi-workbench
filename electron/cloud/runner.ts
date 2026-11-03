/**
 * 一次 run 的主进程生命周期：
 *   POST /v1/runs → 读一次状态拿 session_id → 订阅 SSE 推帧 → 结束时用历史做一次校正。
 *
 * 校正帧是「工具结果」的唯一可靠来源（SSE 的 `tool.completed.preview` 可能是空串）。
 */

import type { CloudFrame, CloudRunStatus } from './types.js'
import { CloudApiError, cloudErrorMessage, type CloudClient } from './client.js'
import { readSseStream } from './events.js'
import { RunMapper } from './map.js'
import { createRemote, type CloudRemote } from './remote.js'

/** 停止请求发出后，等后端推终态的最长时间 */
const STOP_FALLBACK_MS = 15_000

export interface CloudRunnerDeps {
  emit: (frame: CloudFrame) => void
  log?: (message: string, error?: unknown) => void
}

export class CloudRunner {
  private remote: CloudRemote
  private stream: { runId: string; controller: AbortController } | null = null
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

  dispose(): void {
    this.stream?.controller.abort()
    this.stream = null
  }

  private async streamRun(runId: string, sessionId: string | null): Promise<void> {
    const mapper = new RunMapper(runId)
    const controller = new AbortController()
    if (this.stream) this.stream.controller.abort()
    this.stream = { runId, controller }

    if (sessionId) this.lastSessionId = sessionId
    let terminal = false
    try {
      const response = await this.client.openStream(`/v1/runs/${encodeURIComponent(runId)}/events`, controller.signal)
      if (!response.body) throw new Error('事件流没有响应正文')
      await readSseStream(response.body, {
        signal: controller.signal,
        onFrame: (frame) => {
          for (const emitted of mapper.handle(frame)) {
            if (emitted.kind === 'run') terminal = true
            this.deps.emit(emitted)
          }
        },
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        this.deps.log?.('[Cloud] run stream failed', error)
        this.deps.emit({ kind: 'error', runId, error: cloudErrorMessage(error) })
      }
    } finally {
      if (this.stream?.runId === runId) this.stream = null
    }

    await this.reconcile(runId, sessionId, terminal)
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
