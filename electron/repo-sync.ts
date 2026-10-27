/**
 * 仓库同步：每个仓库一套文件监听 + 定时 fetch，把变化推给渲染层。
 *
 * - 监听与定时器按仓库（repo root）去重，同一仓库的多个工作区 / 工作树共享一套；
 * - watcher 只报告“有变化”，引用快照比对后才真正推送；
 * - 所有 fetch 串行到单仓库，全局最多两个并发，避免网络风暴。
 */

import { existsSync } from 'fs'
import * as path from 'path'
import type { BrowserWindow } from 'electron'
import {
  fetchRemote,
  getRepoInfo,
  readRefsSnapshot,
  type GitRepoInfo,
} from './git-worktrees.js'
import { RepoWatcher, type RepoChangeScope } from './repo-watcher.js'
import { AutoFetcher } from './repo-autofetch.js'
import { canonicalizePath } from './workspace-trust.js'

export interface GitChangedPayload {
  workspaceDir: string
  repoRoot: string
  scopes: RepoChangeScope[]
  reason: 'watch' | 'fetch'
}

export interface RepoSyncLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

export interface RepoSyncContext {
  getMainWindow: () => BrowserWindow | null
  logger: RepoSyncLogger
}

interface RepoEntry {
  repoRoot: string
  gitDir: string
  commonDir: string
  /** 归一化工作区路径 → 渲染层传入的原始路径（事件里必须原样带回） */
  workspaces: Map<string, string>
  watcher?: RepoWatcher
  fetcher?: AutoFetcher
  lastSnapshot: string | null
  chain: Promise<void>
  disposed: boolean
}

const MAX_CONCURRENT_FETCHES = 2

/** fetch 期间可能出现这些标记文件：说明仓库正在写操作中 */
const OPERATION_MARKERS = [
  'index.lock',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'rebase-merge',
  'rebase-apply',
]

export class RepoSyncManager {
  private entries = new Map<string, RepoEntry>()
  private workspaceRepos = new Map<string, string>()
  private attaching = new Map<string, Promise<void>>()
  private context: RepoSyncContext | null = null
  private activeFetches = 0
  private fetchWaiters: Array<() => void> = []

  configure(context: RepoSyncContext): void {
    this.context = context
  }

  /** 确保该工作区的仓库已纳入监听；非 git 仓库直接跳过 */
  async ensure(workspaceDir: string): Promise<void> {
    const key = this.key(workspaceDir)
    if (this.workspaceRepos.has(key)) return
    const inflight = this.attaching.get(key)
    if (inflight) return inflight

    const task = this.attach(key, workspaceDir).finally(() => {
      this.attaching.delete(key)
    })
    this.attaching.set(key, task)
    return task
  }

  /** 关闭工作区时释放监听与定时器（同一仓库还有其他工作区时保留） */
  detachWorkspace(workspaceDir: string): void {
    const key = this.key(workspaceDir)
    const repoRoot = this.workspaceRepos.get(key)
    if (!repoRoot) return
    this.workspaceRepos.delete(key)
    const entry = this.entries.get(repoRoot)
    if (!entry) return
    entry.workspaces.delete(key)
    if (entry.workspaces.size === 0) this.disposeEntry(entry)
  }

  /** 聚焦、打开面板等触发一次静默 fetch（受最小间隔限制） */
  async touch(workspaceDir: string): Promise<void> {
    await this.ensure(workspaceDir)
    this.entryFor(workspaceDir)?.fetcher?.touch()
  }

  touchAll(): void {
    for (const entry of this.entries.values()) entry.fetcher?.touch()
  }

  /** 手动刷新：真的拉一次远端，返回结果供界面提示 */
  async fetchNow(
    workspaceDir: string,
    options: { force?: boolean; interactive?: boolean } = {}
  ): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
    await this.ensure(workspaceDir)
    const entry = this.entryFor(workspaceDir)
    if (!entry?.fetcher) {
      return { success: false, error: 'Not a git repository' }
    }
    const release = await this.acquireFetchSlot()
    try {
      const outcome = await entry.fetcher.fetchNow({
        force: options.force ?? true,
        interactive: options.interactive ?? true,
      })
      return { success: outcome.success, skipped: outcome.skipped, error: outcome.error }
    } finally {
      release()
    }
  }

  disposeAll(): void {
    for (const entry of [...this.entries.values()]) this.disposeEntry(entry)
    this.workspaceRepos.clear()
    this.attaching.clear()
  }

  private key(workspaceDir: string): string {
    return canonicalizePath(workspaceDir) ?? path.resolve(workspaceDir)
  }

  private entryFor(workspaceDir: string): RepoEntry | undefined {
    const repoRoot = this.workspaceRepos.get(this.key(workspaceDir))
    return repoRoot ? this.entries.get(repoRoot) : undefined
  }

  private async attach(key: string, workspaceDir: string): Promise<void> {
    const repo = await getRepoInfo(workspaceDir)
    if (!repo || repo.bare || !repo.root) return

    let entry = this.entries.get(repo.root)
    if (!entry) {
      entry = this.createEntry(repo)
      this.entries.set(repo.root, entry)
    }
    entry.workspaces.set(key, workspaceDir)
    this.workspaceRepos.set(key, repo.root)
  }

  private createEntry(repo: GitRepoInfo): RepoEntry {
    const entry: RepoEntry = {
      repoRoot: repo.root,
      gitDir: repo.gitDir || path.join(repo.root, '.git'),
      commonDir: repo.commonDir || path.join(repo.root, '.git'),
      workspaces: new Map(),
      lastSnapshot: null,
      chain: Promise.resolve(),
      disposed: false,
    }

    entry.watcher = new RepoWatcher({
      gitDir: entry.gitDir,
      commonDir: entry.commonDir,
      onScopes: (scopes) => this.enqueue(entry, scopes, 'watch'),
      logger: this.context?.logger,
    })
    entry.fetcher = new AutoFetcher({
      repoRoot: entry.repoRoot,
      canFetch: () => this.canFetch(entry),
      fetch: (root, options) => fetchRemote(root, { interactive: options.interactive }),
      onFetched: () => this.enqueue(entry, ['refs'], 'fetch'),
      logger: this.context?.logger,
    })

    void this.refreshSnapshot(entry)
    entry.watcher.start()
    entry.fetcher.start()
    this.context?.logger.info(`[RepoSync] Watching repository: ${entry.repoRoot}`)
    return entry
  }

  private disposeEntry(entry: RepoEntry): void {
    entry.disposed = true
    entry.watcher?.dispose()
    entry.fetcher?.dispose()
    this.entries.delete(entry.repoRoot)
  }

  private canFetch(entry: RepoEntry): boolean {
    return !OPERATION_MARKERS.some((name) => existsSync(path.join(entry.gitDir, name)))
  }

  /** 同一仓库的引用变化按顺序处理，避免快照被并发请求抢先覆盖 */
  private enqueue(
    entry: RepoEntry,
    scopes: RepoChangeScope[],
    reason: GitChangedPayload['reason']
  ): void {
    entry.chain = entry.chain
      .then(() => this.processScopes(entry, scopes, reason))
      .catch((error) => this.context?.logger.warn('[RepoSync] Failed to process change:', error))
  }

  private async processScopes(
    entry: RepoEntry,
    scopes: RepoChangeScope[],
    reason: GitChangedPayload['reason']
  ): Promise<void> {
    if (entry.disposed) return
    let effective = scopes
    if (scopes.includes('refs')) {
      const snapshot = await readRefsSnapshot(entry.repoRoot)
      if (snapshot === entry.lastSnapshot) {
        effective = scopes.filter((scope) => scope !== 'refs')
      } else {
        entry.lastSnapshot = snapshot
      }
    }
    if (effective.length === 0) return
    this.broadcast(entry, effective, reason)
  }

  private async refreshSnapshot(entry: RepoEntry): Promise<void> {
    entry.lastSnapshot = await readRefsSnapshot(entry.repoRoot).catch(() => null)
  }

  private broadcast(
    entry: RepoEntry,
    scopes: RepoChangeScope[],
    reason: GitChangedPayload['reason']
  ): void {
    if (entry.disposed) return
    const win = this.context?.getMainWindow()
    if (!win || win.isDestroyed()) return
    for (const workspaceDir of entry.workspaces.values()) {
      const payload: GitChangedPayload = {
        workspaceDir,
        repoRoot: entry.repoRoot,
        scopes,
        reason,
      }
      win.webContents.send('git:changed', payload)
    }
  }

  private acquireFetchSlot(): Promise<() => void> {
    const release = (): void => {
      this.activeFetches = Math.max(0, this.activeFetches - 1)
      const next = this.fetchWaiters.shift()
      if (next) next()
    }
    if (this.activeFetches < MAX_CONCURRENT_FETCHES) {
      this.activeFetches += 1
      return Promise.resolve(release)
    }
    return new Promise((resolve) => {
      this.fetchWaiters.push(() => {
        this.activeFetches += 1
        resolve(release)
      })
    })
  }
}

export const repoSync = new RepoSyncManager()
