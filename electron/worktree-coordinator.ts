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
import {
  NO_DEPS,
  WorktreeDepsManager,
  type WorktreeDepsInstaller,
  type WorktreeDepsStatus,
} from './worktree-deps.js'

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
  /** 依赖安装状态；主工作树与失效工作树恒为 none */
  deps: WorktreeDepsStatus
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
  deps: WorktreeDepsManager
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

const SILENT_LOGGER: WorktreeLogger = { info: () => {}, warn: () => {} }

/** 依赖状态变化事件：由 IPC 层转成 `git:worktree-deps` 推给渲染层 */
export interface WorktreeDepsEventPayload {
  workspaceDir: string
  key: string
  status: WorktreeDepsStatus
}

export interface WorktreeDepsConfig {
  /** 设置项 autoInstallWorktreeDeps；默认开 */
  isAutoInstallEnabled: () => boolean
  onStatusChange?: (payload: WorktreeDepsEventPayload) => void
  /** 测试注入点：默认用真实 spawn 的安装器 */
  createInstaller?: (repoRoot: string) => WorktreeDepsInstaller
}

let depsConfig: WorktreeDepsConfig | null = null

/** 由 IPC 层注入一次；依赖安装属于「会跑仓库里的脚本」，所以开关由设置驱动 */
export function configureWorktreeDeps(config: WorktreeDepsConfig | null): void {
  depsConfig = config
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
  // 安装回调需要 state 本身（按路径映射回工作树 key 才能落盘与推送）
  const ref: { state: WorkspaceState | null } = { state: null }
  const deps = new WorktreeDepsManager({
    repoRoot: repo.root,
    logger: logging ?? SILENT_LOGGER,
    isAutoInstallEnabled: () => depsConfig?.isAutoInstallEnabled() ?? true,
    ...(depsConfig?.createInstaller
      ? { installer: depsConfig.createInstaller(repo.root) }
      : {}),
    // 安装完成后的落盘必须走 serialize()，不能绕过协调器的写锁
    onInstalled: (worktreePath, hash) => {
      if (ref.state) persistInstalledHash(ref.state, worktreePath, hash)
    },
    onStatusChange: (worktreePath, status) => {
      if (ref.state) publishDepsStatus(ref.state, worktreePath, status)
    },
  })
  const state: WorkspaceState = {
    workspaceDir: key,
    repo,
    data: loadSessionGit(key),
    lock: Promise.resolve(),
    deps,
  }
  ref.state = state
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
 * 安装成功后把 lockfile 哈希写回工作树记录。
 * 这里必须走 serialize()：协调器的所有写操作共用一把锁，直接 writeJsonAtomic 会与
 * bind / release 落盘互相覆盖。注意**不要**在持锁路径里 await 本函数（会死锁），
 * 所以它是 fire-and-forget 的。
 */
function persistInstalledHash(
  state: WorkspaceState,
  worktreePath: string,
  hash: string
): void {
  const found = recordForPath(state, worktreePath)
  if (!found.id || !found.record || found.id === MAIN_WORKTREE_KEY) return
  const id = found.id
  void serialize(state, async () => {
    const record = state.data.worktrees[id]
    if (!record || record.installedLockfileHash === hash) return
    state.data.worktrees[id] = { ...record, installedLockfileHash: hash }
    await persist(state)
  }).catch((error) =>
    logging?.warn('[WorktreeDeps] Failed to persist lockfile hash:', error)
  )
}

function publishDepsStatus(
  state: WorkspaceState,
  worktreePath: string,
  status: WorktreeDepsStatus
): void {
  const found = recordForPath(state, worktreePath)
  if (!found.id || found.id === MAIN_WORKTREE_KEY) return
  depsConfig?.onStatusChange?.({ workspaceDir: state.workspaceDir, key: found.id, status })
}

/** 主工作树与目录已丢失的工作树不参与依赖安装 */
async function depsStatusFor(
  state: WorkspaceState,
  id: string,
  target: string | null,
  record: GitWorktreeRecord | null
): Promise<WorktreeDepsStatus> {
  if (id === MAIN_WORKTREE_KEY || !target) return NO_DEPS
  if (!existsSync(target)) return NO_DEPS
  return state.deps.statusFor(target, record?.installedLockfileHash ?? null)
}

/** 供 Agent 上下文用的一行描述 */
function describeDeps(status: WorktreeDepsStatus): string {
  switch (status.state) {
    case 'ready':
      return `已就绪（${status.manager ?? '未知包管理器'}，lockfile 未变化）`
    case 'installing':
      return '安装中，测试/构建可能暂时不可用'
    case 'failed':
      return `安装失败（${(status.error ?? '未知原因').split('\n')[0]}）—— 可以请用户手动重试，或先自己在该工作树目录安装依赖`
    case 'idle':
      return '未安装（该工作树没有依赖目录）—— 跑测试前先在当前目录安装，不要依赖向上解析到主工作树的依赖'
    case 'none':
    default:
      return '未检出 lockfile，跳过依赖安装'
  }
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
  const target = worktreePathFromKey(state, id)
  if (target) state.deps.forget(target)
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
  const [status, deps] = await Promise.all([
    target ? getStatus(target) : Promise.resolve<GitStatusInfo | null>(null),
    depsStatusFor(state, id, target, record),
  ])
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
    deps,
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

  /**
   * 手动触发 / 重试某个工作树的依赖安装。
   * 不阻塞调用方：立刻返回 `installing` 或 `ready`，结果由 `git:worktree-deps` 推送。
   */
  /**
   * 会话重新打开 / 恢复绑定后补一次依赖检查：应用关着的时候 lockfile 可能已经变了。
   * 与 `ensureInstalled` 一样受自动安装开关约束，且只在绑定链接工作树时生效。
   */
  async ensureSessionDeps(sessionId: string): Promise<void> {
    const state = this.state
    const key = this.getSessionKey(sessionId)
    if (key === MAIN_WORKTREE_KEY) return
    const target = worktreePathFromKey(state, key)
    if (!target || !existsSync(target)) return
    await state.deps.ensureInstalled(
      target,
      state.data.worktrees[key]?.installedLockfileHash ?? null
    )
  }

  async installDeps(
    key: string
  ): Promise<{ success: boolean; deps?: WorktreeDepsStatus; error?: string }> {
    const state = this.state
    if (key === MAIN_WORKTREE_KEY) {
      return { success: false, error: 'The main worktree shares the repository dependencies' }
    }
    const target = worktreePathFromKey(state, key)
    if (!target) return { success: false, error: 'Unknown worktree' }
    if (!existsSync(target)) return { success: false, error: 'Worktree directory is missing' }
    const record = state.data.worktrees[key]
    const deps = await state.deps.install(target, record?.installedLockfileHash ?? null)
    return { success: true, deps }
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
      // 新建 / 首次复用绑定工作树：这里才是「该装依赖」的时刻。
      // 枚举（toView → statusFor）只读，不会触发安装。
      const boundPath = key === MAIN_WORKTREE_KEY ? null : worktreePathFromKey(state, key)
      if (boundPath && existsSync(boundPath)) {
        await state.deps.ensureInstalled(
          boundPath,
          state.data.worktrees[key]?.installedLockfileHash ?? null
        )
      }
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
        // 工作树即将消失：先终止还在跑的依赖安装，避免往已经删掉的目录里写文件
        state.deps.forget(target)
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
          state.deps.forget(target)
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
      if (target) state.deps.forget(target)
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
    if (current && !current.isMain) {
      lines.push(`依赖：${describeDeps(current.deps)}`)
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
  states.get(key)?.deps.dispose()
  states.delete(key)
}

/**
 * 退出时回收全部工作区的 coordinator。
 *
 * 依赖安装（npm / pnpm install）可能在退出时还在跑：`deps.dispose()` 会
 * cancelAll()，把安装进程树一并终止，否则它们会变成孤儿进程继续写
 * node_modules。
 */
export function disposeAllCoordinators(): void {
  coordinatorCache.clear()
  for (const [key, state] of [...states.entries()]) {
    try {
      state.deps.dispose()
    } catch (error) {
      console.warn('[Worktree] Failed to dispose workspace state:', error)
    }
    states.delete(key)
  }
}
