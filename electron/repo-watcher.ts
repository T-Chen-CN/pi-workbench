/**
 * 仓库文件监听：把 gitdir 的变化合并成 refs / status 两类事件。
 *
 * - 监听 common-dir（HEAD、index、packed-refs）与 refs / logs / worktrees 子目录；
 * - index 变化归为 status，HEAD / refs / packed-refs 归为 refs；
 * - 事件按防抖窗口合并，status 另有最小间隔，避免编辑文件时刷爆。
 * - watcher 不可用（inotify 上限、网络盘、packed-refs 无事件）时降级为定时轮询。
 */

import { watch, type FSWatcher } from 'fs'
import * as path from 'path'

export type RepoChangeScope = 'refs' | 'status'

export interface RepoWatcherOptions {
  gitDir: string
  commonDir: string
  debounceMs?: number
  statusMinIntervalMs?: number
  pollIntervalMs?: number
  onScopes: (scopes: RepoChangeScope[]) => void
  logger?: { warn: (...args: unknown[]) => void }
}

const DEFAULT_DEBOUNCE_MS = 350
const DEFAULT_STATUS_MIN_INTERVAL_MS = 2000
const DEFAULT_POLL_INTERVAL_MS = 5000
const RETRY_DELAY_MS = 1000
const MAX_WATCH_FAILURES = 3

/** objects / lfs 与锁文件不参与刷新 */
const IGNORED_PATH = /(\.lock$|[\\/]objects([\\/]|$)|[\\/]lfs([\\/]|$))/
const REF_PATH = /(^|[\\/])(refs|logs|worktrees)([\\/]|$)/
const REF_FILES = new Set([
  'HEAD',
  'packed-refs',
  'config',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'commondir',
  'gitdir',
])

interface WatchTarget {
  dir: string
  recursive: boolean
}

export class RepoWatcher {
  private watchers: FSWatcher[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private statusTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private pending = new Set<RepoChangeScope>()
  private disposed = false
  private lastStatusAt = 0
  private failures = 0

  constructor(private readonly options: RepoWatcherOptions) {}

  start(): void {
    if (this.disposed) return
    this.closeWatchers()
    const { gitDir, commonDir } = this.options
    const targets: WatchTarget[] = [
      { dir: commonDir, recursive: false },
      { dir: path.join(commonDir, 'refs'), recursive: true },
      { dir: path.join(commonDir, 'logs'), recursive: true },
      { dir: path.join(commonDir, 'worktrees'), recursive: true },
    ]
    if (path.resolve(gitDir) !== path.resolve(commonDir)) {
      targets.push({ dir: gitDir, recursive: false })
    }

    for (const target of targets) {
      try {
        const watcher = watch(target.dir, { recursive: target.recursive }, (_event, filename) => {
          this.onEvent(filename ? String(filename) : '')
        })
        watcher.on('error', (error) => this.onError(error))
        this.watchers.push(watcher)
      } catch {
        // 目录不存在（没有 logs / worktrees）或超出手柄上限：其余监听继续工作
      }
    }

    if (this.watchers.length === 0) {
      this.startPolling()
    } else {
      this.failures = 0
      this.stopPolling()
    }
  }

  dispose(): void {
    this.disposed = true
    this.closeWatchers()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.statusTimer) clearTimeout(this.statusTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.stopPolling()
    this.flushTimer = null
    this.statusTimer = null
    this.retryTimer = null
    this.pending.clear()
  }

  private onEvent(filename: string): void {
    if (this.disposed) return
    if (filename && IGNORED_PATH.test(filename)) return

    if (!filename) {
      // 个别平台不提供文件名：两类都刷新，交给快照比对去重
      this.pending.add('refs')
      this.pending.add('status')
    } else {
      const base = path.basename(filename)
      if (base === 'index') {
        this.pending.add('status')
      } else if (REF_FILES.has(base) || REF_PATH.test(filename)) {
        this.pending.add('refs')
      } else {
        return
      }
    }
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    const delay = this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.flushTimer = setTimeout(() => this.flush(), delay)
  }

  private flush(): void {
    this.flushTimer = null
    if (this.disposed || this.pending.size === 0) return
    const scopes = [...this.pending]
    this.pending.clear()

    const out: RepoChangeScope[] = []
    if (scopes.includes('refs')) out.push('refs')
    if (scopes.includes('status')) {
      const now = Date.now()
      const minInterval = this.options.statusMinIntervalMs ?? DEFAULT_STATUS_MIN_INTERVAL_MS
      const wait = minInterval - (now - this.lastStatusAt)
      if (wait <= 0) {
        this.lastStatusAt = now
        out.push('status')
      } else {
        // 还没到最小间隔：单独排一次 status，不拖慢 refs 的推送
        this.scheduleStatusFlush(wait)
      }
    }
    if (out.length > 0) this.options.onScopes(out)
  }

  private scheduleStatusFlush(wait: number): void {
    if (this.statusTimer || this.disposed) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      if (this.disposed) return
      this.pending.add('status')
      this.scheduleFlush()
    }, wait)
  }

  private onError(error: unknown): void {
    this.options.logger?.warn('[RepoWatcher] File watcher failed:', error)
    this.failures += 1
    this.closeWatchers()
    if (this.failures >= MAX_WATCH_FAILURES) {
      this.startPolling()
      return
    }
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.start()
    }, RETRY_DELAY_MS)
  }

  /** watcher 不可用时的兜底：只轮询 refs，快照没变就不会真正刷新 */
  private startPolling(): void {
    if (this.pollTimer || this.disposed) return
    this.options.logger?.warn('[RepoWatcher] Falling back to polling:', this.options.commonDir)
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.pollTimer = setInterval(() => {
      if (this.disposed) return
      this.options.onScopes(['refs'])
    }, interval)
  }

  private stopPolling(): void {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        // ignore
      }
    }
    this.watchers = []
  }
}
