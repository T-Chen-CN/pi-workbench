/**
 * 限速与熔断（F-02 / F-05 / A-45）。
 *
 * 6 位配对码的搜索空间只有 10^6，因此配套限制是这条设计的**必选部分**：
 * - 每来源 5 次失败 / 5 分钟
 * - 全局失败熔断：窗口内失败过多则所有人暂时不可配对（熔断期内连正确码也拒绝）
 * - 所有失败对外同一个错误码，不透露「码是否存在 / 是否过期」
 *
 * 时间注入（`now`）让测试不必真的等 5 分钟。
 */

export interface RateLimitOptions {
  limit: number
  windowMs: number
  /** 全局失败上限；达到后进入熔断 */
  globalLimit: number
  /** 熔断持续时间 */
  cooldownMs: number
}

export const DEFAULT_CREDENTIAL_LIMITS: RateLimitOptions = {
  limit: 5,
  windowMs: 5 * 60 * 1000,
  globalLimit: 20,
  cooldownMs: 5 * 60 * 1000,
}

interface AttemptWindow {
  stamps: number[]
}

const MAX_TRACKED_SOURCES = 4096

export class AttemptLimiter {
  private perSource = new Map<string, AttemptWindow>()
  private inFlight = new Map<string, number>()
  private globalFailures: number[] = []
  private blockedUntil = 0

  private readonly options: RateLimitOptions

  constructor(
    options: Partial<RateLimitOptions> = {},
    private readonly now: () => number = Date.now
  ) {
    this.options = { ...DEFAULT_CREDENTIAL_LIMITS, ...options }
  }

  /** 是否允许该来源再试一次；熔断期内一律拒绝 */
  canAttempt(source: string): { allowed: boolean; reason?: 'source' | 'global' } {
    const now = this.now()
    if (now < this.blockedUntil) return { allowed: false, reason: 'global' }
    const active = this.inFlight.get(source) ?? 0
    const window = this.perSource.get(source)
    if (!window) {
      return active >= this.options.limit ? { allowed: false, reason: 'source' } : { allowed: true }
    }
    const fresh = window.stamps.filter((stamp) => now - stamp < this.options.windowMs)
    window.stamps = fresh
    if (fresh.length + active >= this.options.limit) return { allowed: false, reason: 'source' }
    return { allowed: true }
  }

  /**
   * 原子占位一次在途尝试：防止并发请求在 async verifyPassword 完成前同时越过 canAttempt。
   * 必须配对调用返回的 release()。
   */
  tryAcquire(source: string): { allowed: true; release: () => void } | { allowed: false; reason?: 'source' | 'global' } {
    const gate = this.canAttempt(source)
    if (!gate.allowed) return { allowed: false, reason: gate.reason }
    this.inFlight.set(source, (this.inFlight.get(source) ?? 0) + 1)
    let released = false
    return {
      allowed: true,
      release: () => {
        if (released) return
        released = true
        const next = (this.inFlight.get(source) ?? 1) - 1
        if (next <= 0) this.inFlight.delete(source)
        else this.inFlight.set(source, next)
      },
    }
  }

  /** 记录一次失败；返回是否因此触发全局熔断 */
  recordFailure(source: string): { tripped: boolean } {
    const now = this.now()
    if (!this.perSource.has(source) && this.perSource.size >= MAX_TRACKED_SOURCES) {
      this.prune()
      if (this.perSource.size >= MAX_TRACKED_SOURCES) {
        const oldestKey = this.perSource.keys().next().value
        if (oldestKey !== undefined) this.perSource.delete(oldestKey)
      }
    }
    const window = this.perSource.get(source) ?? { stamps: [] }
    window.stamps.push(now)
    this.perSource.set(source, window)

    if (!Number.isFinite(this.options.globalLimit)) {
      return { tripped: false }
    }
    this.globalFailures = this.globalFailures.filter(
      (stamp) => now - stamp < this.options.windowMs
    )
    this.globalFailures.push(now)
    if (this.globalFailures.length >= this.options.globalLimit) {
      this.blockedUntil = now + this.options.cooldownMs
      this.globalFailures = []
      return { tripped: true }
    }
    return { tripped: false }
  }

  /** 成功一次就清空该来源的失败记录（不重置全局熔断） */
  recordSuccess(source: string): void {
    this.perSource.delete(source)
  }

  /** 熔断剩余时间（毫秒），0 表示未熔断；供健康检查与测试观察 */
  blockedForMs(): number {
    return Math.max(0, this.blockedUntil - this.now())
  }

  /** 垃圾回收：来源窗口过期后丢弃，避免 Map 无限增长 */
  prune(): void {
    const now = this.now()
    for (const [source, window] of this.perSource) {
      const fresh = window.stamps.filter((stamp) => now - stamp < this.options.windowMs)
      if (fresh.length === 0) this.perSource.delete(source)
      else window.stamps = fresh
    }
  }
}
