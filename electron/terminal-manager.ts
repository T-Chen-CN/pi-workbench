/**
 * 终端管理：每个终端一个 PTY 进程，输出通过回调推送给渲染进程，
 * 同时把输出写入工作区的 .pi-workbench/terminal-{id}.log 供 Agent 读取。
 */
import * as fs from 'fs'
import * as path from 'path'

export interface PtyProcess {
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
  /** 最近一次输出时间，用于判断终端是否仍在执行任务 */
  lastActivityAt: number
}

const FLUSH_DELAY_MS = 500
const MAX_LOG_BYTES = 5 * 1024 * 1024
/** 终端子进程不应继承 Agent 的供应商密钥 */
const SENSITIVE_ENV_KEYS = ['PI_WORKBENCH_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']

export function sanitizeTerminalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...env }
  for (const key of SENSITIVE_ENV_KEYS) {
    delete sanitized[key]
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
        lastActivityAt: 0,
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
        entry.lastActivityAt = Date.now()
        this.scheduleFlush(entry)
        this.options.onData?.(id, data)
      })

      pty.onExit(({ exitCode }) => {
        this.flush(entry)
        this.terminals.delete(id)
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
    try {
      entry.pty.kill()
    } catch (error) {
      console.warn('[Terminal] Failed to kill terminal:', error)
    }
    this.flush(entry)
    return true
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) {
      this.close(id)
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
    const normalized = path.resolve(workspaceDir)
    for (const [id, entry] of [...this.terminals.entries()]) {
      if (path.resolve(entry.workspaceDir) === normalized) {
        this.close(id)
      }
    }
  }

  /** 立即把待写入内容刷到日志文件 */
  flushNow(id: string): boolean {
    const entry = this.terminals.get(id)
    if (!entry) return false
    this.clearFlushTimer(id)
    this.flush(entry)
    return true
  }

  private scheduleFlush(entry: TerminalEntry): void {
    if (!entry.logPath || this.flushTimers.has(entry.id)) return
    const timer = setTimeout(() => {
      this.flushTimers.delete(entry.id)
      this.flush(entry)
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
