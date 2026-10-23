/** 自动重试倒计时（R-19）：按收到 retry_start 的本地时间计算剩余秒数 */
export interface RetryTiming {
  delayMs: number
  /** 渲染层收到 retry_start 的时刻；缺失时视为刚刚收到 */
  receivedAt?: number
}

export function retrySecondsRemaining(timing: RetryTiming, now = Date.now()): number {
  const receivedAt = timing.receivedAt ?? now
  const remainingMs = timing.delayMs - (now - receivedAt)
  return Math.max(0, Math.ceil(remainingMs / 1000))
}
