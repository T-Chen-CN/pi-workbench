/**
 * 链接工作树的依赖探测与后台安装（GIT-118）。
 *
 * 为什么需要独立安装：托管工作树位于 `{repo}/.pi-workbench/worktrees/<id>`，
 * 也就是**仓库内部**。Node 的模块解析与 `npm run` 的 PATH 会一路向上找到主
 * checkout 的 `node_modules`，于是工作树里的测试/构建静默跑在主分支的依赖上。
 * 只有每个工作树自己装一份依赖，隔离才成立。
 *
 * 约定：
 * - 只探测**仓库根**的 lockfile（工作树自己可能有改动，但包管理器与命令由仓库决定）。
 * - 安装完全在后台，不阻塞会话；失败只置状态，不弹模态。
 * - 子进程用 `child_process.spawn`（不用 PTY），输出只进日志与内存尾部缓冲。
 * - 不新增运行时数据目录：安装结果只写 `session-git.json` 的 `installedLockfileHash`。
 */

import { spawn as nodeSpawn } from 'child_process'
import { childRegistry, killProcessTree } from './child-registry.js'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import * as fs from 'fs/promises'
import * as path from 'path'

export type PackageManager = 'pnpm' | 'bun' | 'yarn' | 'npm' | 'uv'

/** 依赖状态。`idle` = 有 lockfile 但没装、也没在装（自动安装被关掉）。 */
export type WorktreeDepsState = 'none' | 'idle' | 'installing' | 'ready' | 'failed'

export interface WorktreeDepsStatus {
  state: WorktreeDepsState
  manager: PackageManager | null
  /** `${manager}:${sha1}`；没有 lockfile 时为 null */
  hash: string | null
  /** 失败原因，截断到 2000 字符 */
  error?: string
  /** 本轮安装开始时间（ISO），仅 installing / failed 有 */
  startedAt?: string
}

export interface LockfileInfo {
  manager: PackageManager
  /** lockfile 文件名（相对仓库根） */
  lockfile: string
  /** 安装命令与参数；`cwd` 由调用方给定 */
  command: string
  args: string[]
  /** 依赖目录名，决定「是否装过」 */
  depsDir: string
  /** `${manager}:${sha1(lockfile 内容)}` */
  hash: string
}

export const NO_DEPS: WorktreeDepsStatus = { state: 'none', manager: null, hash: null }

const MAX_ERROR_CHARS = 2000
const MAX_TAIL_CHARS = 4000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 候选 lockfile 与包管理器。顺序即优先级：一个仓库同时有多个 lockfile 时取第一个，
 * 与用户实际会用的命令保持一致（pnpm → bun → yarn → npm → uv）。
 */
const CANDIDATES: ReadonlyArray<{
  lockfile: string
  manager: PackageManager
  depsDir: string
}> = [
  { lockfile: 'pnpm-lock.yaml', manager: 'pnpm', depsDir: 'node_modules' },
  { lockfile: 'bun.lockb', manager: 'bun', depsDir: 'node_modules' },
  { lockfile: 'bun.lock', manager: 'bun', depsDir: 'node_modules' },
  { lockfile: 'yarn.lock', manager: 'yarn', depsDir: 'node_modules' },
  { lockfile: 'package-lock.json', manager: 'npm', depsDir: 'node_modules' },
  { lockfile: 'uv.lock', manager: 'uv', depsDir: '.venv' },
]

/** 安装命令固定使用「按 lockfile 精确安装」的形态，绝不改动 lockfile */
export function installCommand(
  manager: PackageManager,
  repoRoot: string
): { command: string; args: string[] } {
  switch (manager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['install', '--frozen-lockfile'] }
    case 'bun':
      return { command: 'bun', args: ['install', '--frozen-lockfile'] }
    case 'yarn':
      // yarn berry 用的是 --immutable；v1 没有这个参数
      return {
        command: 'yarn',
        args: [
          'install',
          existsSync(path.join(repoRoot, '.yarnrc.yml')) ? '--immutable' : '--frozen-lockfile',
        ],
      }
    case 'npm':
      return { command: 'npm', args: ['ci'] }
    case 'uv':
      return { command: 'uv', args: ['sync', '--frozen'] }
  }
}

/**
 * 安装脚本不能拿到 Agent 的供应商密钥，也不能看到应用自己的敏感环境变量。
 * 与终端同样的思路：按名单 + 前缀剔除，其余原样继承。
 */
const SENSITIVE_ENV_KEYS = ['PI_WORKBENCH_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']
const SENSITIVE_ENV_PREFIXES = ['PI_WORKBENCH_']

export function sanitizeInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_ENV_KEYS.includes(key)) continue
    if (SENSITIVE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    sanitized[key] = value
  }
  return sanitized
}

/** lockfile 内容哈希按 mtime + size 缓存：`listWorktrees` 每条消息都会问一次状态 */
const hashCache = new Map<string, { mtimeMs: number; size: number; sha1: string }>()

export function clearLockfileHashCache(): void {
  hashCache.clear()
}

async function readLockfileHash(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file)
    const cached = hashCache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.sha1
    }
    const content = await fs.readFile(file)
    const sha1 = createHash('sha1').update(content).digest('hex')
    hashCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, sha1 })
    return sha1
  } catch {
    return null
  }
}

/** 按仓库根的 lockfile 识别包管理器；没有 lockfile 返回 null（不安装、不报错） */
export async function detectLockfile(repoRoot: string): Promise<LockfileInfo | null> {  for (const candidate of CANDIDATES) {
    const file = path.join(repoRoot, candidate.lockfile)
    if (!existsSync(file)) continue
    const sha1 = await readLockfileHash(file)
    if (!sha1) continue
    const { command, args } = installCommand(candidate.manager, repoRoot)
    return {
      manager: candidate.manager,
      lockfile: candidate.lockfile,
      command,
      args,
      depsDir: candidate.depsDir,
      hash: `${candidate.manager}:${sha1}`,
    }
  }
  return null
}

/**
 * 认定**这次安装实际会用到**的那份 lockfile：工作树自己 checkout 出来的副本优先，
 * 没有时才回退到仓库根（lockfile 被 gitignore / 未提交时只能这样）。
 *
 * 为什么哈希必须跟安装走：哈希描述的是「装的是哪一套依赖」。用仓库根的哈希去描述
 * 工作树里的安装，会让工作树分支上的 lockfile 变化（切分支、Agent 加依赖）永远不触发重装，
 * 两个不同分支的工作树还会共用同一个哈希。
 */
export async function lockfileHashForWorktree(
  repoRoot: string,
  worktreePath: string,
  info: LockfileInfo
): Promise<string | null> {
  const own = path.join(worktreePath, info.lockfile)
  const file = existsSync(own) ? own : path.join(repoRoot, info.lockfile)
  const sha1 = await readLockfileHash(file)
  return sha1 ? `${info.manager}:${sha1}` : null
}

/** 探测包管理器（按仓库根定）并把哈希换成工作树自己的那份 */
export async function resolveLockfileForWorktree(
  repoRoot: string,
  worktreePath: string
): Promise<LockfileInfo | null> {
  const info = await detectLockfile(repoRoot)
  if (!info) return null
  const hash = await lockfileHashForWorktree(repoRoot, worktreePath, info)
  return hash ? { ...info, hash } : null
}

/** 依赖目录是否已存在（`node_modules` / `.venv`） */
export function depsPresent(worktreePath: string, depsDir: string): boolean {
  return existsSync(path.join(worktreePath, depsDir))
}

/** 依赖状态的判定规则（纯函数，便于单测） */
export function resolveDepsState(input: {
  hasLockfile: boolean
  installedHash: string | null
  currentHash: string | null
  depsPresent: boolean
  installing: boolean
  failed: boolean
  autoInstall: boolean
}): WorktreeDepsState {
  if (!input.hasLockfile) return 'none'
  if (input.currentHash && input.installedHash === input.currentHash && input.depsPresent) {
    return 'ready'
  }
  if (input.installing) return 'installing'
  if (input.failed) return 'failed'
  return input.autoInstall ? 'installing' : 'idle'
}

export function truncateError(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_ERROR_CHARS ? trimmed.slice(-MAX_ERROR_CHARS) : trimmed
}

// ---------------------------------------------------------------------------
// 安装子进程
// ---------------------------------------------------------------------------

export interface SpawnedProcess {
  pid?: number
  stdout: { on: (event: 'data', listener: (chunk: unknown) => void) => void } | null
  stderr: { on: (event: 'data', listener: (chunk: unknown) => void) => void } | null
  on: (event: 'error' | 'exit', listener: (...args: unknown[]) => void) => void
  kill: (signal?: NodeJS.Signals) => boolean
}

export interface SpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  windowsHide: boolean
  /** Windows 上包管理器是可执行 `.cmd`，必须经过 shell 才能启动 */
  shell: boolean
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess

export interface InstallResult {
  ok: boolean
  /** 被主动取消（工作树删除、工作区关闭）：不算失败，不记状态 */
  cancelled?: boolean
  error?: string
}

interface RunningInstall {
  child: SpawnedProcess | null
  cancelled: boolean
  /** 提前结算（取消 / 超时）；exit 事件之后再来一次是空操作 */
  settle: ((result: InstallResult) => void) | null
  promise: Promise<InstallResult>
}

export interface WorktreeDepsInstallerOptions {
  spawn?: SpawnFn
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: options.windowsHide,
    shell: options.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as SpawnedProcess

/**
 * 终止安装进程及其子进程。
 *
 * Windows 上 SIGTERM 只作用于直接子进程，包管理器派生出的孙进程会变成孤儿；
 * 因此先 taskkill /T 收整棵树 —— 顺序不能反：根进程先死，taskkill 就找不到子进程了。
 */
function terminateTree(child: SpawnedProcess | null): void {
  if (!child) return
  const pid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : null
  if (pid !== null && process.platform === 'win32' && killProcessTree(pid)) return
  try {
    child.kill('SIGTERM')
  } catch {
    // 进程可能已经退出；取消语义已经满足
  }
}

/**
 * 单个工作区的安装进程管理。按工作树路径单飞：并发请求 join 同一个任务。
 */
export class WorktreeDepsInstaller {
  private readonly options: WorktreeDepsInstallerOptions
  private readonly running = new Map<string, RunningInstall>()
  private readonly tails = new Map<string, string>()
  /** 串行化：同时最多一个安装；空闲时立即启动，忙时排队 */
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(options: WorktreeDepsInstallerOptions = {}) {
    this.options = options
  }

  isRunning(worktreePath: string): boolean {
    return this.running.has(worktreePath)
  }

  /** 最近一次安装的输出尾部；失败时用于给用户看原因 */
  tail(worktreePath: string): string {
    return this.tails.get(worktreePath) ?? ''
  }

  install(worktreePath: string, info: LockfileInfo): Promise<InstallResult> {
    const existing = this.running.get(worktreePath)
    if (existing) return existing.promise
    const entry: RunningInstall = {
      child: null,
      cancelled: false,
      settle: null,
      promise: Promise.resolve({ ok: false, error: 'not started' }),
    }
    // 先登记再启动：启动时同步失败（命令不存在）会立刻结算并从表里删掉自己
    this.running.set(worktreePath, entry)
    if (this.active === 0) {
      // 空闲：同步启动，和以前一样不耽误时间
      this.active = 1
      entry.promise = this.launch(worktreePath, info, entry)
      return entry.promise
    }
    // 忙：排队等上一个安装结束；排队期间被取消则不启动，直接按取消结算
    entry.promise = this.waitForSlot().then(() => {
      if (entry.cancelled) {
        this.releaseSlot()
        return { ok: false, cancelled: true }
      }
      return this.launch(worktreePath, info, entry)
    })
    return entry.promise
  }

  private waitForSlot(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  /** 交还令牌：有排队的就把令牌直接转交，否则把空闲计数归零 */
  private releaseSlot(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.active = 0
  }

  /** 终止正在跑的安装；返回是否真的取消了某个任务 */
  cancel(worktreePath: string): boolean {
    const entry = this.running.get(worktreePath)
    if (!entry) return false
    entry.cancelled = true
    this.running.delete(worktreePath)
    terminateTree(entry.child)
    entry.settle?.({ ok: false, cancelled: true })
    return true
  }

  cancelAll(): void {
    for (const worktreePath of [...this.running.keys()]) this.cancel(worktreePath)
  }

  dispose(): void {
    this.cancelAll()
    this.tails.clear()
  }

  private launch(
    worktreePath: string,
    info: LockfileInfo,
    entry: RunningInstall
  ): Promise<InstallResult> {
    const spawnFn = this.options.spawn ?? defaultSpawn
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const env = sanitizeInstallEnv(this.options.env ?? process.env)
    const log = this.options.log

    return new Promise<InstallResult>((resolve) => {
      let settled = false
      let tail = ''
      let timer: NodeJS.Timeout | null = null

      const finish = (result: InstallResult): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        timer = null
        unregisterChild?.()
        unregisterChild = null
        this.tails.set(worktreePath, tail)
        this.running.delete(worktreePath)
        // 先交还串行令牌，再结算 promise：排队的下一个安装能立即开工
        this.releaseSlot()
        resolve(result)
      }

      let unregisterChild: (() => void) | null = null

      entry.settle = finish

      const append = (chunk: unknown): void => {
        const text =
          typeof chunk === 'string'
            ? chunk
            : chunk instanceof Uint8Array
              ? Buffer.from(chunk).toString('utf8')
              : ''
        if (!text) return
        tail = (tail + text).slice(-MAX_TAIL_CHARS)
        log?.info(`[WorktreeDeps] ${info.manager}: ${text.trimEnd()}`)
      }

      let child: SpawnedProcess
      try {
        child = spawnFn(info.command, info.args, {
          cwd: worktreePath,
          env,
          windowsHide: true,
          shell: process.platform === 'win32',
        })
      } catch (error) {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }

      entry.child = child
      // 包管理器会派生孙进程（npm → node → tsc…）；登记 pid，退出时整棵树一起收
      if (typeof child.pid === 'number' && child.pid > 0) {
        unregisterChild = childRegistry.register({
          pid: child.pid,
          group: 'install',
          kill: () => child.kill('SIGTERM'),
        })
      }
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)

      child.on('error', (error: unknown) => {
        finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
      })
      child.on('exit', (...args: unknown[]) => {
        const code = typeof args[0] === 'number' ? args[0] : null
        if (entry.cancelled) {
          finish({ ok: false, cancelled: true })
          return
        }
        if (code === 0) {
          finish({ ok: true })
          return
        }
        finish({
          ok: false,
          error: truncateError(
            `${info.command} ${info.args.join(' ')} 退出码 ${code ?? 'unknown'}\n${tail}`
          ),
        })
      })

      timer = setTimeout(() => {
        log?.warn(`[WorktreeDeps] ${info.manager} install timed out in ${worktreePath}`)
        terminateTree(child)
        finish({
          ok: false,
          error: truncateError(
            `安装超时（超过 ${Math.round(timeoutMs / 1000)} 秒）\n${tail}`
          ),
        })
      }, timeoutMs)
      timer.unref?.()
    })
  }
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

export interface WorktreeDepsLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

export interface WorktreeDepsManagerOptions {
  /** 仓库根：lockfile 与安装命令都按它判定 */
  repoRoot: string
  logger: WorktreeDepsLogger
  /** 自动安装开关（设置项 autoInstallWorktreeDeps） */
  isAutoInstallEnabled: () => boolean
  /** 安装成功：把哈希写进工作树记录（协调器负责 serialize + 落盘） */
  onInstalled: (worktreePath: string, hash: string) => void
  /** 状态变化：推送给渲染层 */
  onStatusChange?: (worktreePath: string, status: WorktreeDepsStatus) => void
  installer?: WorktreeDepsInstaller
}

/**
 * 每个工作区一份：把「lockfile 哈希 + 依赖目录 + 内存状态」算成一个可展示状态，
 * 并在需要时启动后台安装。安装状态不落盘（重启后按哈希与目录重新判定）。
 */
export class WorktreeDepsManager {
  private readonly options: WorktreeDepsManagerOptions
  private readonly installer: WorktreeDepsInstaller
  /** 本次会话内装成功的哈希：落盘有延迟，期间不能把自己当成「未安装」 */
  private readonly installed = new Map<string, string>()
  private readonly failures = new Map<string, { hash: string; message: string }>()
  private readonly startedAt = new Map<string, string>()
  private readonly published = new Map<string, string>()

  constructor(options: WorktreeDepsManagerOptions) {
    this.options = options
    this.installer =
      options.installer ??
      new WorktreeDepsInstaller({ log: options.logger })
  }

  /**
   * 只读：算出某个工作树当前的依赖状态，**不启动安装**。
   * 它被 `listWorktrees()` / Agent 上下文这类高频读路径调用，不能有副作用
   * （否则光是枚举工作树就会给每个工作树装一遍依赖）。要安装请调 `ensureInstalled()`。
   */
  async statusFor(
    worktreePath: string,
    installedHash: string | null | undefined
  ): Promise<WorktreeDepsStatus> {
    const evaluated = await this.evaluate(worktreePath, installedHash)
    return evaluated.status
  }

  /**
   * 需要就安装（新建 / 首次复用绑定工作树时调用）。
   * 受 `autoInstallWorktreeDeps` 开关约束；已就绪 / 已失败 / 已在装时不会重复启动。
   */
  async ensureInstalled(
    worktreePath: string,
    installedHash: string | null | undefined
  ): Promise<WorktreeDepsStatus> {
    const { status, info } = await this.evaluate(worktreePath, installedHash)
    if (!info || status.state !== 'idle') return status
    if (!this.options.isAutoInstallEnabled()) return status
    if (this.installer.isRunning(worktreePath)) return status
    this.start(worktreePath, info)
    return {
      state: 'installing',
      manager: info.manager,
      hash: info.hash,
      ...(this.startedAt.has(worktreePath) ? { startedAt: this.startedAt.get(worktreePath) } : {}),
    }
  }

  /** 状态快照 + 本次安装会用的 lockfile（纯计算，不碰子进程） */
  private async evaluate(
    worktreePath: string,
    installedHash: string | null | undefined
  ): Promise<{ status: WorktreeDepsStatus; info: LockfileInfo | null }> {
    const info = await resolveLockfileForWorktree(this.options.repoRoot, worktreePath)
    if (!info) {
      this.publish(worktreePath, NO_DEPS)
      return { status: NO_DEPS, info: null }
    }
    const effectiveInstalled = this.installed.get(worktreePath) ?? installedHash ?? null
    const present = depsPresent(worktreePath, info.depsDir)
    const failure = this.failures.get(worktreePath)
    const failed = Boolean(failure && failure.hash === info.hash)
    const installing = this.installer.isRunning(worktreePath)

    const state = resolveDepsState({
      hasLockfile: true,
      installedHash: effectiveInstalled,
      currentHash: info.hash,
      depsPresent: present,
      installing,
      failed,
      // 这里只负责算状态：idle = 需要安装但没在装，由 ensureInstalled() 决定要不要启动
      autoInstall: false,
    })

    if (state === 'ready') this.startedAt.delete(worktreePath)
    const status: WorktreeDepsStatus = {
      state,
      manager: info.manager,
      hash: info.hash,
      ...(state === 'failed' && failure ? { error: failure.message } : {}),
      ...(this.startedAt.has(worktreePath) ? { startedAt: this.startedAt.get(worktreePath) } : {}),
    }
    this.publish(worktreePath, status)
    return { status, info }
  }

  /** 手动触发 / 重试：忽略自动安装开关，总是重跑一次 */
  async install(
    worktreePath: string,
    installedHash?: string | null
  ): Promise<WorktreeDepsStatus> {
    const info = await resolveLockfileForWorktree(this.options.repoRoot, worktreePath)
    if (!info) {
      this.publish(worktreePath, NO_DEPS)
      return NO_DEPS
    }
    if (this.installer.isRunning(worktreePath)) {
      return {
        state: 'installing',
        manager: info.manager,
        hash: info.hash,
        ...(this.startedAt.has(worktreePath)
          ? { startedAt: this.startedAt.get(worktreePath) }
          : {}),
      }
    }
    if (installedHash !== undefined && installedHash !== null && installedHash === info.hash) {
      // 哈希没变且目录还在：手动触发也只需确认，不必重跑
      if (depsPresent(worktreePath, info.depsDir)) {
        const status: WorktreeDepsStatus = {
          state: 'ready',
          manager: info.manager,
          hash: info.hash,
        }
        this.publish(worktreePath, status)
        return status
      }
    }
    this.start(worktreePath, info)
    return {
      state: 'installing',
      manager: info.manager,
      hash: info.hash,
      ...(this.startedAt.has(worktreePath) ? { startedAt: this.startedAt.get(worktreePath) } : {}),
    }
  }

  /** 工作树被删除 / 遗忘：终止安装并忘掉它的内存状态 */
  forget(worktreePath: string): void {
    this.installer.cancel(worktreePath)
    this.installed.delete(worktreePath)
    this.failures.delete(worktreePath)
    this.startedAt.delete(worktreePath)
    this.published.delete(worktreePath)
  }

  cancel(worktreePath: string): boolean {
    return this.installer.cancel(worktreePath)
  }

  dispose(): void {
    this.installer.dispose()
    this.installed.clear()
    this.failures.clear()
    this.startedAt.clear()
    this.published.clear()
  }

  private start(worktreePath: string, info: LockfileInfo): void {
    this.failures.delete(worktreePath)
    this.startedAt.set(worktreePath, new Date().toISOString())
    this.publish(worktreePath, {
      state: 'installing',
      manager: info.manager,
      hash: info.hash,
      startedAt: this.startedAt.get(worktreePath),
    })
    this.options.logger.info(
      `[WorktreeDeps] Installing ${info.manager} dependencies in ${worktreePath}`
    )
    void this.installer.install(worktreePath, info).then((result) => {
      if (result.cancelled) {
        this.startedAt.delete(worktreePath)
        return
      }
      if (result.ok) {
        this.startedAt.delete(worktreePath)
        if (!depsPresent(worktreePath, info.depsDir)) {
          // 命令成功却没产出依赖目录：当成失败处理，否则每次问状态都会重跑一次安装
          const message = `${info.command} ${info.args.join(' ')} 已成功退出，但没有生成 ${info.depsDir}`
          this.failures.set(worktreePath, { hash: info.hash, message })
          this.options.logger.warn(`[WorktreeDeps] ${message} (${worktreePath})`)
          this.publish(worktreePath, {
            state: 'failed',
            manager: info.manager,
            hash: info.hash,
            error: message,
          })
          return
        }
        this.installed.set(worktreePath, info.hash)
        this.failures.delete(worktreePath)
        this.startedAt.delete(worktreePath)
        this.options.logger.info(
          `[WorktreeDeps] Dependencies ready in ${worktreePath} (${info.manager})`
        )
        this.options.onInstalled(worktreePath, info.hash)
        this.publish(worktreePath, { state: 'ready', manager: info.manager, hash: info.hash })
        return
      }
      const message = truncateError(result.error ?? '依赖安装失败')
      this.failures.set(worktreePath, { hash: info.hash, message })
      this.options.logger.warn(
        `[WorktreeDeps] Install failed in ${worktreePath}: ${message.split('\n')[0]}`
      )
      this.publish(worktreePath, {
        state: 'failed',
        manager: info.manager,
        hash: info.hash,
        error: message,
        ...(this.startedAt.has(worktreePath)
          ? { startedAt: this.startedAt.get(worktreePath) }
          : {}),
      })
    })
  }

  /** 状态没变就不推事件：`listWorktrees()` 每条消息都会算一次 */
  private publish(worktreePath: string, status: WorktreeDepsStatus): void {
    const signature = JSON.stringify(status)
    if (this.published.get(worktreePath) === signature) return
    this.published.set(worktreePath, signature)
    this.options.onStatusChange?.(worktreePath, status)
  }
}
