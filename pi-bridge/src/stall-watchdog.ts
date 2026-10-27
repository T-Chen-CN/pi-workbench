/**
 * 模型响应空闲超时（stall）看门狗。
 *
 * 只负责一件事：在“等待模型产出”的窗口内，如果连续 `timeoutMs` 没有心跳，回调 onStall。
 * 它不设整轮上限，也不关心工具跑了多久——工具执行和工具审批期间计时自动挂起，
 * 这两段静默是合法的（命令可能很久没有输出，审批要等用户点）。
 *
 * 心跳来源由调用方决定：模型文本 / 思考 / 工具参数增量、工具输出增量。
 * 计时器按 `lastActivityAt + timeoutMs` 到期后自检，心跳只更新时间戳，不反复重建定时器。
 */

export interface StallWatchdogOptions {
  /** 静默上限（毫秒）；<= 0 表示不启用 */
  timeoutMs: number
  /** 判定卡死时回调，参数为实际静默时长（毫秒） */
  onStall: (idleMs: number) => void
  logger?: {
    debug: (...args: unknown[]) => void
  }
}

export class StallWatchdog {
  private readonly timeoutMs: number
  private readonly onStall: (idleMs: number) => void
  private readonly logger?: StallWatchdogOptions['logger']
  private started = false
  private timer: NodeJS.Timeout | null = null
  private lastActivityAt = 0
  private readonly tools = new Set<string>()
  private approvals = 0

  constructor(options: StallWatchdogOptions) {
    this.timeoutMs = options.timeoutMs
    this.onStall = options.onStall
    this.logger = options.logger
  }

  /** 本轮开始等待模型；从这一刻起计时 */
  start(): void {
    this.started = true
    this.lastActivityAt = Date.now()
    this.rearm()
  }

  /** 结束本轮：清空计时，之后不会再回调 onStall */
  stop(): void {
    this.started = false
    this.tools.clear()
    this.approvals = 0
    this.clear()
  }

  /** 任何模型侧 / 工具侧增量都算心跳 */
  touch(): void {
    this.lastActivityAt = Date.now()
    if (!this.started) return
    if (!this.isArmed) return
    // 定时器到期会自检剩余静默时长，这里不重建，避免每个 token 都 clearTimeout + setTimeout
    if (!this.timer) this.schedule(this.timeoutMs)
  }

  /** 工具开始执行：静默合法，挂起计时 */
  beginTool(toolCallId: string): void {
    this.tools.add(toolCallId)
    this.lastActivityAt = Date.now()
    this.rearm()
  }

  /** 工具结束：重新开始计等待模型的时间 */
  endTool(toolCallId: string): void {
    this.tools.delete(toolCallId)
    this.lastActivityAt = Date.now()
    this.rearm()
  }

  /** 审批请求发出：挂起计时（审批有自己的 120s 上限，且 fail-closed） */
  beginApproval(): void {
    this.approvals += 1
    this.lastActivityAt = Date.now()
    this.rearm()
  }

  /** 审批返回（放行 / 拒绝 / 超时）：恢复计时 */
  endApproval(): void {
    this.approvals = Math.max(0, this.approvals - 1)
    this.lastActivityAt = Date.now()
    this.rearm()
  }

  /** 当前是否处于“等待模型”的计时状态 */
  get isArmed(): boolean {
    return this.started && this.tools.size === 0 && this.approvals === 0
  }

  /** 距离上次心跳的时长（毫秒） */
  get idleMs(): number {
    return this.lastActivityAt ? Date.now() - this.lastActivityAt : 0
  }

  private rearm(): void {
    this.clear()
    if (!this.isArmed || this.timeoutMs <= 0) return
    this.schedule(this.timeoutMs)
  }

  private schedule(delayMs: number): void {
    this.clear()
    const timer = setTimeout(() => this.check(), Math.max(0, delayMs))
    timer.unref?.()
    this.timer = timer
  }

  private check(): void {
    this.timer = null
    if (!this.started) return
    if (!this.isArmed) return
    const idle = Date.now() - this.lastActivityAt
    if (idle < this.timeoutMs) {
      this.schedule(this.timeoutMs - idle)
      return
    }
    this.started = false
    this.logger?.debug('[Agent Watchdog] Model response stalled', { idleMs: idle })
    this.onStall(idle)
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
