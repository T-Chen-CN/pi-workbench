/**
 * 只读 Git 查询的进程内缓存。
 *
 * - 仓库根：`git rev-parse` 一次要起 9 个进程，而同一个工作区目录的根不会变，
 *   所以按工作区缓存，只缓存成功结果（当前不是仓库的目录下次仍会重新探测）。
 * - 提交详情：提交对象内容按 sha 内容寻址、永不改变，可以一直留到被 LRU 淘汰；
 *   同一个 sha 的并发请求只启动一次 git。
 */

import type { GitCommitDetail } from './git-worktrees.js'

export class LruCache<K, V> {
  private readonly entries = new Map<K, V>()
  private bytes = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
    private readonly sizeOf: (value: V) => number = () => 0
  ) {}

  get(key: K): V | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    // 重新插入以刷新 LRU 顺序
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    const previous = this.entries.get(key)
    if (previous !== undefined) {
      this.entries.delete(key)
      this.bytes -= this.sizeOf(previous)
    }
    this.entries.set(key, value)
    this.bytes += this.sizeOf(value)
    this.trim()
  }

  delete(key: K): void {
    const previous = this.entries.get(key)
    if (previous === undefined) return
    this.entries.delete(key)
    this.bytes -= this.sizeOf(previous)
  }

  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }

  get size(): number {
    return this.entries.size
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next()
      if (oldest.done) return
      const value = this.entries.get(oldest.value)
      this.entries.delete(oldest.value)
      if (value !== undefined) this.bytes -= this.sizeOf(value)
    }
  }
}

/** 详情缓存上限：约 20MB / 60 条，够覆盖来回滚动的一屏历史 */
const detailCache = new LruCache<string, GitCommitDetail>(
  60,
  20 * 1024 * 1024,
  (detail) =>
    detail.patch.length +
    detail.body.length +
    detail.commit.subject.length +
    64 * detail.files.length +
    1024
)

/** 仓库根按工作区缓存；数量上限按常见的同时打开数放宽到 32 */
const repoRootCache = new LruCache<string, string>(32)

const pendingDetails = new Map<string, Promise<GitCommitDetail | null>>()
const pendingRoots = new Map<string, Promise<string | null>>()

function keyFor(root: string, sha: string): string {
  return `${root}\u0000${sha}`
}

/** 同一个工作区的仓库根只探测一次；并发调用共享同一个 promise */
export function cachedRepoRoot(
  workspaceDir: string,
  load: () => Promise<string | null>
): Promise<string | null> {
  const cached = repoRootCache.get(workspaceDir)
  if (cached !== undefined) return Promise.resolve(cached)

  const pending = pendingRoots.get(workspaceDir)
  if (pending) return pending

  const promise = load()
    .then((root) => {
      if (root) repoRootCache.set(workspaceDir, root)
      return root
    })
    .finally(() => pendingRoots.delete(workspaceDir))
  pendingRoots.set(workspaceDir, promise)
  return promise
}

/** 提交详情只取一次：命中直接返回，未命中时合并同 sha 的并发请求 */
export function cachedCommitDetail(
  root: string,
  sha: string,
  load: () => Promise<GitCommitDetail | null>
): Promise<GitCommitDetail | null> {
  const key = keyFor(root, sha)
  const cached = detailCache.get(key)
  if (cached) return Promise.resolve(cached)

  const pending = pendingDetails.get(key)
  if (pending) return pending

  const promise = load()
    .then((detail) => {
      if (detail) detailCache.set(key, detail)
      return detail
    })
    .finally(() => pendingDetails.delete(key))
  pendingDetails.set(key, promise)
  return promise
}

export function clearGitCaches(): void {
  repoRootCache.clear()
  detailCache.clear()
  pendingRoots.clear()
  pendingDetails.clear()
}
