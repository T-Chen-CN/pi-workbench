/**
 * 工作树协调器：把会话与工作树绑定、生成 Agent 上下文、回收无主工作树。
 *
 * 每个打开的工作区一个实例，由 IPC 层按工作区取用。所有写操作串行执行，
 * 避免两个会话同时绑定同一个空闲工作树。
 */

import * as path from 'path'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import {
  MAIN_WORKTREE_KEY,
  branchHasNewCommits,
  createWorktree as gitCreateWorktree,
  deleteBranch,
  ensureWorktreeIgnored,
  getRepoInfo,
  getStatus,
  isPathInWorkspace,
  listWorktrees as gitListWorktrees,
  loadSessionGit,
  pruneWorktrees,
  removeWorktree as gitRemoveWorktree,
  resolveWorktreePath,
  saveSessionGit,
  type GitRepoInfo,
  type GitStatusInfo,
  type GitWorktreeInfo,
  type GitWorktreeRecord,
  type SessionGitFile,
} from './git-worktrees.js'
import { canonicalizePath } from './workspace-trust.js'

export interface WorktreeView {
  id: string
  path: string
  relativePath: string
  branch: string | null
  base: string
  managed: boolean
  isMain: boolean
  /** git 已不再把它当作本仓库工作树（目录可能还在）；不可切换，只能手动忘记 */
  missing: boolean
  boundSessionCount: number
  boundToActiveSession: boolean
  dirtyCount: number
  ahead: number
  behind: number
}

export interface ForgetResult {
  success: boolean
  error?: string
  worktrees?: WorktreeView[]
}

export interface BindResult {
  success: boolean
  worktree?: WorktreeView
  sharedWith?: number
  error?: string
}

export interface ReleaseResult {
  success: boolean
  removed: boolean
  dirty: boolean
  worktreePath?: string
  error?: string
}

interface WorkspaceState {
  workspaceDir: string
  repo: GitRepoInfo
  data: SessionGitFile
  lock: Promise<unknown>
}

const states = new Map<string, WorkspaceState>()

export interface WorktreeLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

/** 由 IPC 层注入一次，记录自动回收动作；未注入时保持静默 */
let logging: WorktreeLogger | null = null

export function configureWorktreeLogging(logger: WorktreeLogger | null): void {
  logging = logger
}

function keyFor(workspaceDir: string): string {
  return canonicalizePath(workspaceDir) ?? path.resolve(workspaceDir)
}

function normalizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)
}

function relativePath(workspaceDir: string, target: string): string {
  return path.relative(workspaceDir, target).split(path.sep).join('/')
}

function worktreePathFromKey(state: WorkspaceState, key: string): string | null {
  if (key === MAIN_WORKTREE_KEY) return state.repo.root
  const record = state.data.worktrees[key]
  if (!record) return null
  const target = path.join(state.workspaceDir, record.path)
  return canonicalizePath(target) ?? target
}

function boundSessionCount(state: WorkspaceState, key: string): number {
  return Object.values(state.data.sessions).filter((binding) => binding.worktree === key).length
}

function recordForPath(
  state: WorkspaceState,
  worktreePath: string
): { id: string; record: GitWorktreeRecord | null } {
  const canonical = canonicalizePath(worktreePath) ?? worktreePath
  if (state.repo.root === canonical) return { id: MAIN_WORKTREE_KEY, record: null }
  for (const [id, record] of Object.entries(state.data.worktrees)) {
    const target = canonicalizePath(path.join(state.workspaceDir, record.path))
    if (target === canonical) return { id, record }
  }
  return { id: '', record: null }
}

function makeWorktreeId(state: WorkspaceState, sessionId: string): string {
  const short = normalizeId(sessionId.slice(0, 8)) || randomBytes(3).toString('hex')
  let counter = 1
  let id = `${short}`
  while (state.data.worktrees[id]) {
    counter += 1
    id = `${short}-${counter}`
  }
  return id
}

async function refreshState(workspaceDir: string): Promise<WorkspaceState | null> {
  const key = keyFor(workspaceDir)
  const existing = states.get(key)
  if (existing) return existing
  const repo = await getRepoInfo(workspaceDir)
  if (!repo || repo.bare) return null
  const state: WorkspaceState = {
    workspaceDir: key,
    repo,
    data: loadSessionGit(key),
    lock: Promise.resolve(),
  }
  states.set(key, state)
  await ensureWorktreeIgnored(repo.root)
  await pruneWorktrees(repo.root)
  return state
}

async function serialize<T>(state: WorkspaceState, task: () => Promise<T>): Promise<T> {
  const run = state.lock.then(task, task)
  state.lock = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function persist(state: WorkspaceState): Promise<void> {
  await saveSessionGit(state.workspaceDir, state.data)
}

/**
 * 丢掉一条「工作树已不在盘上」的登记。
 * 只动登记与孤儿分支：managed 工作树的分支只有在没有独有提交时才回收，
 * 有提交的分支一律保留，避免丢失工作。
 */
async function dropMissingRecord(
  state: WorkspaceState,
  id: string,
  record: GitWorktreeRecord
): Promise<void> {
  delete state.data.worktrees[id]
  const branch = record.branch
  if (!record.managed || !record.base || !branch.startsWith('pi/')) return
  // git 拒删“仍被某个（已失踪的）工作树 check out”的分支，先把无效登记从 git 侧剪掉
  await pruneWorktrees(state.repo.root)
  const hasCommits = await branchHasNewCommits(state.repo.root, branch, record.base)
  if (hasCommits) {
    logging?.info(`[Worktree] Kept branch ${branch}: it has commits not in ${record.base}`)
    return
  }
  await deleteBranch(state.repo.root, branch)
  logging?.info(`[Worktree] Deleted orphan branch ${branch}`)
}

/**
 * 自愈：删除目录已不存在、且没有会话绑定的工作树登记。
 * 目录还在但 git 已不认的登记保留——磁盘上可能有内容，只由用户手动忘记。
 * 返回被清掉的记录路径。
 */
async function pruneMissingRecords(
  state: WorkspaceState,
  infos: GitWorktreeInfo[]
): Promise<string[]> {
  // prunable 表示 git 自己也认为目录已丢，不能当作活着的工作树
  const live = new Set(
    infos.filter((info) => !info.prunable).map((info) => canonicalizePath(info.path) ?? info.path)
  )
  const pruned: string[] = []
  for (const [id, record] of Object.entries(state.data.worktrees)) {
    if (id === MAIN_WORKTREE_KEY) continue
    if (boundSessionCount(state, id) > 0) continue
    const target = worktreePathFromKey(state, id)
    if (target && live.has(target)) continue
    if (target && existsSync(target)) continue
    await dropMissingRecord(state, id, record)
    pruned.push(target ?? record.path)
  }
  if (pruned.length > 0) {
    logging?.info(`[Worktree] Dropped records for missing worktrees: ${pruned.join(', ')}`)
  }
  return pruned
}

async function toView(
  state: WorkspaceState,
  id: string,
  info: GitWorktreeInfo | null,
  record: GitWorktreeRecord | null,
  activeSessionId?: string | null
): Promise<WorktreeView> {
  const target = info?.path ?? (id === MAIN_WORKTREE_KEY ? state.repo.root : worktreePathFromKey(state, id))
  const status: GitStatusInfo | null = target ? await getStatus(target) : null
  const bindings = Object.entries(state.data.sessions).filter(([, binding]) => binding.worktree === id)
  return {
    id,
    path: target ?? '',
    relativePath: target ? relativePath(state.workspaceDir, target) : '',
    branch: info?.branch ?? record?.branch ?? status?.branch ?? null,
    base: record?.base ?? '',
    managed: record?.managed ?? false,
    isMain: id === MAIN_WORKTREE_KEY,
    missing: id !== MAIN_WORKTREE_KEY && info === null,
    boundSessionCount: bindings.length,
    boundToActiveSession: Boolean(activeSessionId && bindings.some(([session]) => session === activeSessionId)),
    dirtyCount: status?.files.length ?? 0,
    ahead: status?.ahead ?? 0,
    behind: status?.behind ?? 0,
  }
}

export class WorktreeCoordinator {
  static async forWorkspace(workspaceDir: string): Promise<WorktreeCoordinator | null> {
    const state = await refreshState(workspaceDir)
    return state ? new WorktreeCoordinator(state) : null
  }

  private constructor(private readonly state: WorkspaceState) {}

  get repo(): GitRepoInfo {
    return this.state.repo
  }

  get workspaceDir(): string {
    return this.state.workspaceDir
  }

  async listWorktrees(activeSessionId?: string | null): Promise<WorktreeView[]> {
    const state = this.state
    const infos = await gitListWorktrees(state.repo.root)
    const byPath = new Map(
      infos.map((info) => [canonicalizePath(info.path) ?? info.path, info])
    )
    const views: WorktreeView[] = []
    const rootKey = canonicalizePath(state.repo.root) ?? state.repo.root
    const mainInfo = byPath.get(rootKey) ?? infos[0] ?? null
    views.push(await toView(state, MAIN_WORKTREE_KEY, mainInfo, null, activeSessionId))

    let changed = (await pruneMissingRecords(state, infos)).length > 0

    const known = new Set<string>([rootKey])
    for (const [id, record] of Object.entries(state.data.worktrees)) {
      const target = canonicalizePath(path.join(state.workspaceDir, record.path))
      if (target) known.add(target)
      const info = target ? byPath.get(target) ?? null : null
      views.push(await toView(state, id, info, record, activeSessionId))
    }

    // 发现工作区内用户自己创建、尚未登记的工作树
    for (const info of infos) {
      if (info.prunable) continue
      const target = canonicalizePath(info.path) ?? info.path
      if (!target || known.has(target)) continue
      if (!isPathInWorkspace(state.workspaceDir, target)) continue
      const id = makeWorktreeId(state, `ext-${path.basename(target)}`)
      state.data.worktrees[id] = {
        path: relativePath(state.workspaceDir, target),
        managed: false,
        branch: info.branch ?? '',
        base: '',
        createdBySession: '',
        createdAt: new Date().toISOString(),
      }
      known.add(target)
      views.push(await toView(state, id, info, state.data.worktrees[id], activeSessionId))
      changed = true
    }
    // 只在登记变化时写盘：contextFor() 每条消息都会调 listWorktrees()
    if (changed) await persist(state)
    return views
  }

  getSessionKey(sessionId: string): string {
    return this.state.data.sessions[sessionId]?.worktree ?? MAIN_WORKTREE_KEY
  }

  hasBinding(sessionId: string): boolean {
    return Boolean(this.state.data.sessions[sessionId])
  }

  getSessionRoot(sessionId: string): string {
    const key = this.getSessionKey(sessionId)
    return worktreePathFromKey(this.state, key) ?? this.state.repo.root
  }

  getSessionBinding(sessionId: string): { key: string; path: string; branch: string | null } {
    const key = this.getSessionKey(sessionId)
    const target = worktreePathFromKey(this.state, key) ?? this.state.repo.root
    const record = this.state.data.worktrees[key]
    return { key, path: target, branch: record?.branch ?? null }
  }

  async bind(
    sessionId: string,
    target: string,
    base?: string,
    activeSessionId?: string | null
  ): Promise<BindResult> {
    const state = this.state
    return serialize(state, async () => {
      const resolved = await this.resolveTarget(state, sessionId, target, base)
      if (!resolved.success || !resolved.key) {
        return { success: false, error: resolved.error ?? 'Unable to resolve worktree' }
      }
      const key = resolved.key
      state.data.sessions[sessionId] = { worktree: key }
      await persist(state)
      const view = await this.viewForKey(key, activeSessionId ?? sessionId)
      return {
        success: true,
        worktree: view,
        sharedWith: Math.max(0, (view?.boundSessionCount ?? 1) - 1),
      }
    })
  }

  private async resolveTarget(
    state: WorkspaceState,
    sessionId: string,
    target: string,
    base?: string
  ): Promise<{ success: boolean; key?: string; error?: string }> {
    const normalized = target.trim()
    if (normalized === MAIN_WORKTREE_KEY || normalized === 'main') {
      return { success: true, key: MAIN_WORKTREE_KEY }
    }
    if (normalized === 'auto') {
      const free = await this.findFreeWorktree(state, sessionId)
      if (free) return { success: true, key: free }
      return this.createNew(state, sessionId, base)
    }
    if (normalized === 'new') {
      return this.createNew(state, sessionId, base)
    }
    const canonical = canonicalizePath(normalized)
    if (!canonical || !isPathInWorkspace(state.workspaceDir, canonical)) {
      return { success: false, error: 'Worktree must be inside the workspace' }
    }
    const infos = await gitListWorktrees(state.repo.root)
    if (!infos.some((info) => canonicalizePath(info.path) === canonical)) {
      return { success: false, error: 'Selected path is not a git worktree of this repository' }
    }
    const found = recordForPath(state, canonical)
    if (found.id) return { success: true, key: found.id }
    const id = makeWorktreeId(state, `ext-${path.basename(canonical)}`)
    state.data.worktrees[id] = {
      path: relativePath(state.workspaceDir, canonical),
      managed: false,
      branch: infos.find((info) => canonicalizePath(info.path) === canonical)?.branch ?? '',
      base: '',
      createdBySession: '',
      createdAt: new Date().toISOString(),
    }
    return { success: true, key: id }
  }

  private async findFreeWorktree(
    state: WorkspaceState,
    sessionId: string
  ): Promise<string | null> {
    const infos = await gitListWorktrees(state.repo.root)
    const candidates: { id: string; dirty: number }[] = []
    for (const [id, record] of Object.entries(state.data.worktrees)) {
      const target = canonicalizePath(path.join(state.workspaceDir, record.path))
      if (!target) continue
      const info = infos.find((item) => canonicalizePath(item.path) === target)
      if (!info || info.locked || info.prunable) continue
      const boundByOther = Object.entries(state.data.sessions).some(
        ([otherSession, binding]) => otherSession !== sessionId && binding.worktree === id
      )
      if (boundByOther) continue
      const status = await getStatus(target)
      candidates.push({ id, dirty: status.files.length })
    }
    candidates.sort((a, b) => a.dirty - b.dirty)
    return candidates[0]?.id ?? null
  }

  private async createNew(
    state: WorkspaceState,
    sessionId: string,
    base?: string
  ): Promise<{ success: boolean; key?: string; error?: string }> {
    const infos = await gitListWorktrees(state.repo.root)
    const rootKey = canonicalizePath(state.repo.root) ?? state.repo.root
    const mainInfo =
      infos.find((info) => (canonicalizePath(info.path) ?? info.path) === rootKey) ?? infos[0]
    const baseBranch =
      base?.trim() || mainInfo?.branch || mainInfo?.head || state.repo.branch || state.repo.head
    if (!baseBranch) return { success: false, error: 'Repository has no commits yet' }
    if (!mainInfo?.head && !state.repo.head) {
      return { success: false, error: 'unsupported: empty repository' }
    }
    const id = makeWorktreeId(state, sessionId)
    const target = resolveWorktreePath(state.workspaceDir, id)
    if (!target) return { success: false, error: 'Unable to allocate a worktree path' }
    const branch = `pi/${id}`
    try {
      await gitCreateWorktree(state.repo.root, target, branch, baseBranch)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    state.data.worktrees[id] = {
      path: relativePath(state.workspaceDir, target),
      managed: true,
      branch,
      base: baseBranch,
      createdBySession: sessionId,
      createdAt: new Date().toISOString(),
    }
    await persist(state)
    return { success: true, key: id }
  }

  /**
   * 只删除会话绑定，不动工作树本身。
   * 切换工作树失败回滚时用：绑定已经写入，但运行时没有真正换根。
   */
  async unbind(sessionId: string): Promise<void> {
    const state = this.state
    await serialize(state, async () => {
      if (!state.data.sessions[sessionId]) return
      delete state.data.sessions[sessionId]
      await persist(state)
    })
  }

  private async viewForKey(
    key: string,
    activeSessionId?: string | null
  ): Promise<WorktreeView | undefined> {
    const views = await this.listWorktrees(activeSessionId)
    return views.find((view) => view.id === key)
  }

  async release(sessionId: string): Promise<ReleaseResult> {
    const state = this.state
    return serialize(state, async () => {
      const key = state.data.sessions[sessionId]?.worktree
      if (!key) return { success: true, removed: false, dirty: false }
      delete state.data.sessions[sessionId]
      await persist(state)
      if (key === MAIN_WORKTREE_KEY) return { success: true, removed: false, dirty: false }
      const record = state.data.worktrees[key]
      if (!record) return { success: true, removed: false, dirty: false }
      const target = worktreePathFromKey(state, key)
      if (!target) return { success: true, removed: false, dirty: false }
      const stillBound = boundSessionCount(state, key) > 0
      if (stillBound) {
        return { success: true, removed: false, dirty: false, worktreePath: target }
      }
      if (!existsSync(target)) {
        // 工作树目录已不在：只丢登记，不跑 git worktree remove（那会一直失败并卡在 dirty）
        await dropMissingRecord(state, key, record)
        await persist(state)
        return { success: true, removed: false, dirty: false, worktreePath: target }
      }
      if (!record.managed) {
        return { success: true, removed: false, dirty: false, worktreePath: target }
      }
      const status = await getStatus(target)
      if (!status.clean) {
        return { success: true, removed: false, dirty: true, worktreePath: target }
      }
      try {
        await gitRemoveWorktree(state.repo.root, target)
        const hasCommits = await branchHasNewCommits(state.repo.root, record.branch, record.base)
        if (record.branch && !hasCommits) await deleteBranch(state.repo.root, record.branch)
        delete state.data.worktrees[key]
        await persist(state)
        return { success: true, removed: true, dirty: false, worktreePath: target }
      } catch (error) {
        return {
          success: false,
          removed: false,
          dirty: false,
          worktreePath: target,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    })
  }

  async cleanupOrphans(): Promise<{
    removed: string[]
    dirty: string[]
    external: string[]
    pruned: string[]
  }> {
    const state = this.state
    return serialize(state, async () => {
      const removed: string[] = []
      const dirty: string[] = []
      const external: string[] = []
      // 目录已不存在的登记先清掉；它们没有可回收的工作树，也不该算 dirty
      const pruned = await pruneMissingRecords(state, await gitListWorktrees(state.repo.root))
      for (const [id, record] of Object.entries(state.data.worktrees)) {
        if (boundSessionCount(state, id) > 0) continue
        const target = worktreePathFromKey(state, id)
        if (!target) continue
        if (!record.managed) {
          external.push(target)
          continue
        }
        const status = await getStatus(target)
        if (!status.clean) {
          dirty.push(target)
          continue
        }
        try {
          await gitRemoveWorktree(state.repo.root, target)
          const hasCommits = await branchHasNewCommits(state.repo.root, record.branch, record.base)
          if (record.branch && !hasCommits) await deleteBranch(state.repo.root, record.branch)
          delete state.data.worktrees[id]
          removed.push(target)
        } catch {
          dirty.push(target)
        }
      }
      await persist(state)
      return { removed, dirty, external, pruned }
    })
  }

  /**
   * 手动忘记一条失效登记：git 不再认这条路径、也没有会话绑定时才允许。
   * 只丢登记，不碰磁盘内容——目录里可能还有用户文件。
   */
  async forget(id: string, activeSessionId?: string | null): Promise<ForgetResult> {
    const state = this.state
    return serialize(state, async (): Promise<ForgetResult> => {
      if (id === MAIN_WORKTREE_KEY) return { success: false, error: 'The main worktree cannot be forgotten' }
      if (!state.data.worktrees[id]) return { success: false, error: 'Unknown worktree' }
      if (boundSessionCount(state, id) > 0) {
        return { success: false, error: 'Worktree is in use by a session' }
      }
      const target = worktreePathFromKey(state, id)
      const infos = await gitListWorktrees(state.repo.root)
      const known =
        target !== null &&
        infos.some(
          (info) => !info.prunable && (canonicalizePath(info.path) ?? info.path) === target
        )
      if (known) return { success: false, error: 'Worktree still exists' }
      delete state.data.worktrees[id]
      await persist(state)
      return { success: true, worktrees: await this.listWorktrees(activeSessionId) }
    })
  }

  async contextFor(sessionId: string): Promise<string> {
    const views = await this.listWorktrees(sessionId)
    const current = views.find((view) => view.boundToActiveSession)
    const lines: string[] = ['[工作树上下文]']
    if (current) {
      lines.push(
        `当前工作树：${current.isMain ? '主工作树' : current.relativePath}（分支 ${current.branch ?? '未知'}，${
          current.boundSessionCount > 1 ? `与 ${current.boundSessionCount - 1} 个会话共享` : '未共享'
        }，未提交改动 ${current.dirtyCount} 个）`
      )
    } else {
      lines.push('当前工作树：主工作树')
    }
    const others = views.filter((view) => view !== current)
    if (others.length > 0) {
      lines.push('其他工作树：')
      for (const view of others) {
        const state = view.boundSessionCount > 0 ? `使用中（${view.boundSessionCount} 个会话）` : '空闲'
        lines.push(
          `- ${view.isMain ? '主工作树' : view.relativePath} | 分支 ${view.branch ?? '未知'} | ${state} | 未提交 ${view.dirtyCount}`
        )
      }
    }
    lines.push('共享工作树时，提交可能包含其他会话的改动；切换分支会影响所有绑定该工作树的会话。')
    return lines.join('\n')
  }
}

const coordinatorCache = new Map<string, WorktreeCoordinator>()

export async function getCoordinator(
  workspaceDir: string
): Promise<WorktreeCoordinator | null> {
  const key = keyFor(workspaceDir)
  const cached = coordinatorCache.get(key)
  if (cached) return cached
  const coordinator = await WorktreeCoordinator.forWorkspace(workspaceDir)
  if (coordinator) coordinatorCache.set(key, coordinator)
  return coordinator
}

export function disposeCoordinator(workspaceDir: string): void {
  const key = keyFor(workspaceDir)
  coordinatorCache.delete(key)
  states.delete(key)
}
