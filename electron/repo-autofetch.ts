/**
 * 仓库自动 fetch：定时 + 事件触发地静默拉取远端引用。
 *
 * - 周期从上次 fetch 结束开始计时，互不重叠；
 * - 触发（聚焦 / 打开面板）有最小间隔，避免连续触发；
 * - 认证失败后退避一段时间，不在后台反复重试；
 * - 手动 fetch 可以等待在途请求，并可触发系统凭据界面。
 */

export interface AutoFetchOutcome {
  success: boolean
  skipped?: boolean
  authFailed?: boolean
  error?: string
  durationMs: number
}

export interface AutoFetchResult {
  ok: boolean
  stderr: string
}

export interface AutoFetcherOptions {
  repoRoot: string
  intervalMs?: number
  initialDelayMs?: number
  minGapMs?: number
  authBackoffMs?: number
  /** 由调用方检查仓库是否正处于 merge / rebase / 写操作中 */
  canFetch?: () => boolean
  fetch: (
    repoRoot: string,
    options: { interactive: boolean }
  ) => Promise<AutoFetchResult>
  onFetched?: (outcome: AutoFetchOutcome) => void
  logger?: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
  }
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_INITIAL_DELAY_MS = 10_000
const DEFAULT_MIN_GAP_MS = 15_000
const DEFAULT_AUTH_BACKOFF_MS = 30 * 60_000

const AUTH_FAILURE = new RegExp(
  [
    'Authentication failed',
    'could not read Username',
    'could not read Password',
    'terminal prompts disabled',
    'Permission denied (publickey)',
    'Host key verification failed',
    'Invalid username or password',
  ].join('|'),
  'i'
)

export class AutoFetcher {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<AutoFetchOutcome> | null = null
  private lastStartedAt = 0
  private authBackoffUntil = 0
  private disposed = false

  constructor(private readonly options: AutoFetcherOptions) {}

  start(): void {
    if (this.disposed) return
    this.schedule(this.options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
  }

  /** 聚焦、打开面板等轻量触发：受最小间隔与退避限制 */
  touch(): void {
    if (this.disposed || this.running) return
    const now = Date.now()
    if (now < this.authBackoffUntil) return
    if (now - this.lastStartedAt < (this.options.minGapMs ?? DEFAULT_MIN_GAP_MS)) return
    if (!this.canFetch()) return
    void this.run(false)
  }

  /**
   * 手动 / 面板打开触发的 fetch。
   * force 跳过节流与退避（手动刷新必须真的去拉一次），但仍不与在途请求并发。
   */
  async fetchNow(options: { force?: boolean; interactive?: boolean } = {}): Promise<AutoFetchOutcome> {
    if (this.disposed) {
      return { success: false, error: 'Repository sync is not running.', durationMs: 0 }
    }
    if (this.running) return this.running

    if (!options.force) {
      const now = Date.now()
      if (now < this.authBackoffUntil || now - this.lastStartedAt < (this.options.minGapMs ?? DEFAULT_MIN_GAP_MS)) {
        return { success: true, skipped: true, durationMs: 0 }
      }
    }
    if (!this.canFetch()) {
      return { success: true, skipped: true, error: 'A git operation is in progress.', durationMs: 0 }
    }
    return this.run(Boolean(options.interactive))
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private canFetch(): boolean {
    return this.options.canFetch?.() !== false
  }

  private run(interactive: boolean): Promise<AutoFetchOutcome> {
    this.lastStartedAt = Date.now()
    const started = this.lastStartedAt
    const task = (async (): Promise<AutoFetchOutcome> => {
      const result = await this.options.fetch(this.options.repoRoot, { interactive })
      const durationMs = Date.now() - started
      if (result.ok) {
        const outcome: AutoFetchOutcome = { success: true, durationMs }
        this.options.logger?.info(`[AutoFetch] Fetched ${this.options.repoRoot} in ${durationMs}ms`)
        this.options.onFetched?.(outcome)
        return outcome
      }

      const error = result.stderr.trim() || 'git fetch failed'
      const authFailed = AUTH_FAILURE.test(result.stderr)
      if (authFailed) {
        this.authBackoffUntil =
          Date.now() + (this.options.authBackoffMs ?? DEFAULT_AUTH_BACKOFF_MS)
      }
      this.options.logger?.warn(
        `[AutoFetch] Fetch failed for ${this.options.repoRoot}: ${error}${authFailed ? ' (backing off)' : ''}`
      )
      return { success: false, authFailed, error, durationMs }
    })()

    this.running = task.finally(() => {
      this.running = null
      if (!this.disposed) {
        this.schedule(this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
      }
    })
    return this.running
  }

  private schedule(delay: number): void {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed) return
      if (this.running) {
        this.schedule(this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
        return
      }
      if (Date.now() < this.authBackoffUntil) {
        this.schedule(this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
        return
      }
      void this.run(false)
    }, delay)
  }
}
