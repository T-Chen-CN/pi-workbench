/**
 * 仓库文件监听（基于 `chokidar` v4）：把 gitdir 的变化合并成 refs / status 两类事件。
 *
 * - 监听 common-dir（HEAD、index、packed-refs）与 refs / logs / worktrees 子目录，
 *   并在 chokidar `ignored` 阶段直接剪枝 `objects/`、`lfs/`、`*.lock` 与无关目录；
 * - index 变化归为 status，HEAD / refs / packed-refs 归为 refs；
 * - 事件按防抖窗口合并，status 另有最小间隔，避免编辑文件时刷爆；
 * - watcher 不可用（inotify 上限、网络盘、目录缺失）时重试并降级为定时轮询。
 */

import * as fs from 'fs'
import * as path from 'path'
import chokidar, { type FSWatcher } from 'chokidar'

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
const MAX_SNAPSHOT_ENTRIES = 2000

/** objects / lfs 与锁文件不参与刷新 */
const IGNORED_PATH = /(?:\.lock$|(?:^|[\\/])(?:objects|lfs)(?:[\\/]|$))/
const REF_PATH = /(^|[\\/])(refs|logs|worktrees)([\\/]|$)/
const REF_SUBDIRS = new Set(['refs', 'logs', 'worktrees'])
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

function normalizePosixPath(targetPath: string): string {
  return path.resolve(targetPath).replace(/\\/g, '/').replace(/\/+$/, '')
}

function compareKey(posixPath: string): string {
  return process.platform === 'win32' ? posixPath.toLowerCase() : posixPath
}

function relativeInside(rootPosix: string, rootCmp: string, candidatePosix: string): string | null {
  const candidateCmp = compareKey(candidatePosix)
  if (candidateCmp === rootCmp) return ''
  if (!candidateCmp.startsWith(`${rootCmp}/`)) return null
  return candidatePosix.slice(rootPosix.length + 1)
}

/** chokidar v4 忽略谓词：仅放行 gitdir/commonDir 根、顶层关键文件与 refs/logs/worktrees 子树 */
function createRepoWatchIgnored(commonDir: string, gitDir: string): (candidatePath: string) => boolean {
  const commonPosix = normalizePosixPath(commonDir)
  const commonCmp = compareKey(commonPosix)
  const gitPosix = normalizePosixPath(gitDir)
  const gitCmp = compareKey(gitPosix)
  const hasDistinctGitDir = gitCmp !== commonCmp

  const shouldIgnoreRelative = (rel: string, allowWorktrees: boolean): boolean => {
    if (!rel) return false
    if (IGNORED_PATH.test(rel)) return true
    const slash = rel.indexOf('/')
    if (slash < 0) {
      return rel !== 'index' && !REF_FILES.has(rel) && !(REF_SUBDIRS.has(rel) && (allowWorktrees || rel !== 'worktrees'))
    }
    const first = rel.slice(0, slash)
    if (!REF_SUBDIRS.has(first)) return true
    if (first === 'worktrees' && !allowWorktrees) return true
    return false
  }

  return (candidatePath: string): boolean => {
    const candidatePosix = candidatePath.replace(/\\/g, '/').replace(/\/+$/, '')
    if (hasDistinctGitDir) {
      const gitRel = relativeInside(gitPosix, gitCmp, candidatePosix)
      if (gitRel !== null) {
        return shouldIgnoreRelative(gitRel, false)
      }
    }
    const commonRel = relativeInside(commonPosix, commonCmp, candidatePosix)
    if (commonRel !== null) {
      return shouldIgnoreRelative(commonRel, true)
    }
    return false
  }
}

interface RepoSnapshot {
  statusSig: string
  refsSig: string
}

function statSignature(filePath: string): string {
  try {
    const st = fs.statSync(filePath)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

/**
 * 同步采集 git 元数据轻量快照：弥补 chokidar 异步初始化（stat/readdirp）窗口期，
 * 避免 `start()` 后紧接着发生的同步 git 写入在 `ready` 前被 `ignoreInitial` 吞掉。
 */
function captureRepoSnapshot(commonDir: string, gitDir: string): RepoSnapshot {
  const statusParts: string[] = [`c:index=${statSignature(path.join(commonDir, 'index'))}`]
  const refsParts: string[] = []
  const resolvedCommon = path.resolve(commonDir)
  const resolvedGit = path.resolve(gitDir)

  for (const name of REF_FILES) {
    const sig = statSignature(path.join(commonDir, name))
    if (sig) refsParts.push(`c:${name}=${sig}`)
  }

  if (resolvedGit !== resolvedCommon) {
    statusParts.push(`g:index=${statSignature(path.join(gitDir, 'index'))}`)
    for (const name of REF_FILES) {
      const sig = statSignature(path.join(gitDir, name))
      if (sig) refsParts.push(`g:${name}=${sig}`)
    }
  }

  let visited = 0
  const walk = (dir: string, relPrefix: string): void => {
    if (visited >= MAX_SNAPSHOT_ENTRIES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (visited >= MAX_SNAPSHOT_ENTRIES) break
      const rel = `${relPrefix}/${entry.name}`
      if (IGNORED_PATH.test(rel)) continue
      const full = path.join(dir, entry.name)
      visited += 1
      if (entry.isDirectory()) {
        walk(full, rel)
      } else if (entry.isFile()) {
        const sig = statSignature(full)
        if (entry.name === 'index') {
          statusParts.push(`${rel}=${sig}`)
        } else {
          refsParts.push(`${rel}=${sig}`)
        }
      }
    }
  }

  for (const sub of REF_SUBDIRS) {
    walk(path.join(commonDir, sub), sub)
  }

  return {
    statusSig: statusParts.join('|'),
    refsSig: refsParts.join('|'),
  }
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
    const commonPosix = normalizePosixPath(commonDir)
    const commonCmp = compareKey(commonPosix)
    const gitPosix = normalizePosixPath(gitDir)
    const gitCmp = compareKey(gitPosix)

    const targets: string[] = []
    if (fs.existsSync(commonDir)) {
      targets.push(commonDir)
    }
    // 独立 gitDir（且不在 commonDir 子树下，如外部 worktree）单独加入监听目标
    const gitInsideCommon = gitCmp === commonCmp || gitCmp.startsWith(`${commonCmp}/`)
    if (!gitInsideCommon && fs.existsSync(gitDir)) {
      targets.push(gitDir)
    }

    if (targets.length === 0) {
      this.startPolling()
      return
    }

    const initialSnapshot = captureRepoSnapshot(commonDir, gitDir)
    try {
      const watcher = chokidar.watch(targets, {
        ignoreInitial: true,
        ignored: createRepoWatchIgnored(commonDir, gitDir),
        persistent: true,
        ignorePermissionErrors: true,
      })

      watcher.on('all', (_eventName, changedPath) => {
        const changedPosix = path.resolve(changedPath).replace(/\\/g, '/').replace(/\/+$/, '')
        const gitRel = !gitInsideCommon ? relativeInside(gitPosix, gitCmp, changedPosix) : null
        const rel = gitRel ?? relativeInside(commonPosix, commonCmp, changedPosix) ?? ''
        this.onEvent('', rel)
      })

      watcher.on('ready', () => {
        if (this.disposed || !this.watchers.includes(watcher)) return
        const readySnapshot = captureRepoSnapshot(commonDir, gitDir)
        if (readySnapshot.statusSig !== initialSnapshot.statusSig) {
          this.onEvent('', 'index')
        }
        if (readySnapshot.refsSig !== initialSnapshot.refsSig) {
          this.onEvent('refs', 'HEAD')
        }
      })

      watcher.on('error', (error) => this.onError(error))
      this.watchers.push(watcher)
    } catch (error) {
      this.onError(error)
      return
    }

    // 不在 start() 同步清零 failures：异步 watcher error 往往在创建后立刻触发，
    // 只有真正收到有效事件时才认定恢复，否则会陷入无限 1s 重试而不降级轮询
    this.stopPolling()
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

  private onEvent(prefix: string, filename: string): void {
    if (this.disposed) return
    this.failures = 0
    const relPath = filename && prefix ? path.join(prefix, filename) : filename
    if (relPath && IGNORED_PATH.test(relPath)) return

    if (!relPath) {
      // 个别平台不提供文件名：refs/logs 子目录只刷 refs，其余两类都刷新，交给快照比对去重
      this.pending.add('refs')
      if (prefix !== 'refs' && prefix !== 'logs') {
        this.pending.add('status')
      }
    } else {
      const base = path.basename(relPath)
      if (base === 'index') {
        this.pending.add('status')
      } else if (REF_FILES.has(base) || REF_PATH.test(relPath)) {
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
        void watcher.close().catch(() => {})
      } catch {
        // ignore
      }
    }
    this.watchers = []
  }
}
