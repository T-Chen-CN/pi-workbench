/**
 * 终端管理：每个终端一个 PTY 进程，输出通过回调推送给渲染进程，
 * 同时把输出写入工作区的 .pi-workbench/terminal-{id}.log 供 Agent 读取。
 */
import * as fs from 'fs'
import * as path from 'path'
import { childRegistry, killProcessTree } from './child-registry.js'

export interface PtyProcess {
  /** shell 进程 pid；node-pty 会提供，测试替身可能没有 */
  pid?: number
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (event: { exitCode: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
}

export interface PtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: NodeJS.ProcessEnv
}

export type PtySpawner = (
  shell: string,
  args: string[],
  options: PtySpawnOptions
) => PtyProcess

export interface TerminalManagerOptions {
  spawn: PtySpawner
  shell?: string
  shellArgs?: string[]
  env?: NodeJS.ProcessEnv
  /** 终端输出落盘路径；返回 null 表示不落盘 */
  logPathFor?: (workspaceDir: string, terminalId: string) => string | null
  /** 自定义环境过滤（默认删除已知供应商 Key） */
  envSanitizer?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  onData?: (id: string, data: string) => void
  onExit?: (id: string, exitCode: number) => void
}

export interface TerminalCreateResult {
  success: boolean
  id?: string
  /** 该终端输出日志文件（按终端拆分） */
  logPath?: string | null
  /** 实际启动的 shell 名称（用于终端标题） */
  shell?: string
  error?: string
}

interface TerminalEntry {
  id: string
  workspaceDir: string
  pty: PtyProcess
  /** 尚未写入日志文件的内容 */
  pending: string
  logPath: string | null
  /** 当前日志文件大小，用于轮转 */
  logBytes: number
  /** 后台异步写日志的串行链，避免重叠 append / rotate */
  logWriteChain: Promise<void>
  /** 最近一次输出时间，用于判断终端是否仍在执行任务 */
  lastActivityAt: number
  /** 从子进程登记表注销；进程退出 / 终端关闭时调用 */
  unregisterChild: (() => void) | null
}

const FLUSH_DELAY_MS = 500
const MAX_LOG_BYTES = 5 * 1024 * 1024
/** 待落盘内存缓冲上限，防止高频输出在写盘慢时耗尽内存 */
const MAX_PENDING_LOG_BYTES = 1024 * 1024

function workspacePathKey(dir: string): string {
  const resolved = path.resolve(dir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
/** 终端与子进程不应继承 Agent 的供应商密钥及应用内部凭据 */
const SENSITIVE_ENV_KEYS = new Set(['PI_WORKBENCH_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
/** 应用注入的敏感环境变量前缀（Windows 环境变量名大小写不敏感，必须统一大写比对） */
const SENSITIVE_ENV_PREFIXES = ['PI_WORKBENCH_']

export function sanitizeTerminalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (SENSITIVE_ENV_KEYS.has(upper)) continue
    if (SENSITIVE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue
    sanitized[key] = value
  }
  return sanitized
}

function clampDimension(value: number, min: number, max: number): number {
  const numeric = Number.isFinite(value) ? Math.floor(value) : min
  return Math.min(Math.max(numeric, min), max)
}

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

export class TerminalManager {
  private readonly options: TerminalManagerOptions
  private readonly terminals = new Map<string, TerminalEntry>()
  private readonly flushTimers = new Map<string, NodeJS.Timeout>()
  private nextId = 1

  constructor(options: TerminalManagerOptions) {
    this.options = options
  }

  create(workspaceDir: string, cols: number, rows: number, cwd?: string): TerminalCreateResult {
    if (!workspaceDir) {
      return { success: false, error: 'Workspace path is required' }
    }

    const spawnCwd = cwd || workspaceDir
    const id = `term-${this.nextId++}`
    const logPath = this.options.logPathFor?.(workspaceDir, id) ?? null

    try {
      const baseEnv = this.options.env ?? process.env
      const spawnEnv = this.options.envSanitizer
        ? this.options.envSanitizer(baseEnv)
        : sanitizeTerminalEnv(baseEnv)

      const shell = this.options.shell ?? defaultShell()
      const pty = this.options.spawn(shell, this.options.shellArgs ?? [], {
        name: 'xterm-256color',
        cols: clampDimension(cols, 20, 1000),
        rows: clampDimension(rows, 5, 500),
        cwd: spawnCwd,
        env: spawnEnv,
      })

      const entry: TerminalEntry = {
        id,
        workspaceDir,
        pty,
        pending: '',
        logPath,
        logBytes: 0,
        logWriteChain: Promise.resolve(),
        lastActivityAt: 0,
        unregisterChild: null,
      }

      // 登记 shell 进程：退出时用 taskkill /T 收整棵树，否则用户启动的
      // 子进程（dev server、测试运行器）会变成孤儿
      if (typeof pty.pid === 'number' && pty.pid > 0) {
        entry.unregisterChild = childRegistry.register({
          pid: pty.pid,
          group: 'pty',
          kill: () => pty.kill(),
        })
      }

      // 同一工作区的终端共用一个日志文件：追加会话标记而不是清空历史
      if (logPath) {
        try {
          fs.mkdirSync(path.dirname(logPath), { recursive: true })
          try {
            entry.logBytes = fs.statSync(logPath).size
          } catch {
            entry.logBytes = 0
          }
          if (entry.logBytes > MAX_LOG_BYTES) {
            this.rotateLog(entry)
          }
          this.appendToLog(
            entry,
            `\n--- terminal ${id} started at ${new Date().toISOString()} ---\n`
          )
        } catch (error) {
          console.warn('[Terminal] Failed to prepare terminal log:', error)
        }
      }

      pty.onData((data) => {
        entry.pending += data
        if (entry.pending.length > MAX_PENDING_LOG_BYTES) {
          entry.pending = entry.pending.slice(-MAX_PENDING_LOG_BYTES)
        }
        entry.lastActivityAt = Date.now()
        this.scheduleFlush(entry)
        this.options.onData?.(id, data)
      })

      pty.onExit(({ exitCode }) => {
        this.flush(entry)
        this.terminals.delete(id)
        entry.unregisterChild?.()
        entry.unregisterChild = null
        this.options.onExit?.(id, exitCode)
      })

      this.terminals.set(id, entry)
      return { success: true, id, logPath, shell: path.basename(shell) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[Terminal] Failed to create terminal:', message)
      return { success: false, error: message }
    }
  }

  write(id: string, data: string): boolean {
    const entry = this.terminals.get(id)
    if (!entry) return false
    entry.pty.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): boolean {
    const entry = this.terminals.get(id)
    if (!entry) return false
    entry.pty.resize(clampDimension(cols, 20, 1000), clampDimension(rows, 5, 500))
    return true
  }

  close(id: string): boolean {
    const entry = this.terminals.get(id)
    if (!entry) return false
    this.terminals.delete(id)
    this.clearFlushTimer(id)
    const pid = typeof entry.pty.pid === 'number' && entry.pty.pid > 0 ? entry.pty.pid : null
    // Windows 上先 taskkill /T 杀整棵进程树再 kill PTY，避免根进程先死导致孙进程变为孤儿
    if (pid !== null && process.platform === 'win32') {
      killProcessTree(pid)
    }
    try {
      entry.pty.kill()
    } catch (error) {
      console.warn('[Terminal] Failed to kill terminal:', error)
    } finally {
      entry.unregisterChild?.()
      entry.unregisterChild = null
    }
    if (this.activeAsyncWrites.has(id)) {
      this.flushAsync(entry)
    } else {
      this.flush(entry)
    }
    return true
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) {
      const entry = this.terminals.get(id)
      this.close(id)
      // 进程退出兜底：若前面因异步写链让路而仍有残余缓冲，同步落盘
      if (entry) this.flush(entry)
    }
  }

  /**
   * 最近一段时间内是否有终端输出。
   * 用于重启安装更新前提示：停在提示符的终端不算运行中任务，持续输出的才算。
   */
  hasRecentActivity(withinMs = 3000): boolean {
    const threshold = Date.now() - withinMs
    for (const entry of this.terminals.values()) {
      if (entry.lastActivityAt >= threshold) return true
    }
    return false
  }

  /** 关闭某个工作区的全部终端（关闭工作区标签时调用） */
  closeWorkspace(workspaceDir: string): void {
    const normalized = workspacePathKey(workspaceDir)
    for (const [id, entry] of [...this.terminals.entries()]) {
      if (workspacePathKey(entry.workspaceDir) === normalized) {
        this.close(id)
      }
    }
  }

  /** 正在执行异步写/轮转的终端集合，防止 flushNow 同步写与后台异步轮转并发竞态 */
  private activeAsyncWrites = new Set<string>()

  /** 立即把待写入内容刷到日志文件：空闲时同步落盘，异步写进行中则排进串行链防轮转竞态 */
  flushNow(id: string): boolean {
    const entry = this.terminals.get(id)
    if (!entry) return false
    this.clearFlushTimer(id)
    if (this.activeAsyncWrites.has(id)) {
      this.flushAsync(entry)
    } else {
      this.flush(entry)
    }
    return true
  }

  private scheduleFlush(entry: TerminalEntry): void {
    if (!entry.logPath || this.flushTimers.has(entry.id)) return
    const timer = setTimeout(() => {
      this.flushTimers.delete(entry.id)
      this.flushAsync(entry)
    }, FLUSH_DELAY_MS)
    timer.unref?.()
    this.flushTimers.set(entry.id, timer)
  }

  private clearFlushTimer(id: string): void {
    const timer = this.flushTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.flushTimers.delete(id)
    }
  }

  private flushAsync(entry: TerminalEntry): void {
    if (!entry.logPath || !entry.pending) return
    const text = entry.pending
    entry.pending = ''
    const logPath = entry.logPath
    this.activeAsyncWrites.add(entry.id)
    entry.logWriteChain = entry.logWriteChain
      .then(async () => {
        await fs.promises.mkdir(path.dirname(logPath), { recursive: true })
        await fs.promises.appendFile(logPath, text, 'utf-8')
        entry.logBytes += Buffer.byteLength(text, 'utf-8')
        if (entry.logBytes > MAX_LOG_BYTES) {
          const rotated = `${logPath}.1`
          await fs.promises.rm(rotated, { force: true }).catch(() => undefined)
          await fs.promises.rename(logPath, rotated).catch(() => undefined)
          entry.logBytes = 0
        }
      })
      .catch((error) => {
        console.warn('[Terminal] Failed to write terminal log:', error)
      })
      .finally(() => {
        this.activeAsyncWrites.delete(entry.id)
      })
  }

  private flush(entry: TerminalEntry): void {
    if (!entry.logPath || !entry.pending) return
    const text = entry.pending
    entry.pending = ''
    this.appendToLog(entry, text)
  }

  private appendToLog(entry: TerminalEntry, text: string): void {
    if (!entry.logPath || !text) return
    try {
      fs.mkdirSync(path.dirname(entry.logPath), { recursive: true })
      fs.appendFileSync(entry.logPath, text, 'utf-8')
      entry.logBytes += Buffer.byteLength(text, 'utf-8')
      if (entry.logBytes > MAX_LOG_BYTES) {
        this.rotateLog(entry)
      }
    } catch (error) {
      console.warn('[Terminal] Failed to write terminal log:', error)
    }
  }

  private rotateLog(entry: TerminalEntry): void {
    if (!entry.logPath) return
    const rotated = `${entry.logPath}.1`
    try {
      fs.rmSync(rotated, { force: true })
      fs.renameSync(entry.logPath, rotated)
      entry.logBytes = 0
    } catch (error) {
      console.warn('[Terminal] Failed to rotate terminal log:', error)
    }
  }
}
