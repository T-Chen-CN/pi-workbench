/**
 * 终端管理：每个终端一个 PTY 进程，输出通过回调推送给渲染进程，
 * 同时把最近输出写入工作区的 .pi-workbench/terminal.log 供 Agent 读取。
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
  logPathFor?: (workspaceDir: string) => string | null
  onData?: (id: string, data: string) => void
  onExit?: (id: string, exitCode: number) => void
}

export interface TerminalCreateResult {
  success: boolean
  id?: string
  error?: string
}

interface TerminalEntry {
  id: string
  workspaceDir: string
  pty: PtyProcess
  /** 最近输出（用于 Agent 读取 / 诊断） */
  buffer: string
  /** 尚未写入日志文件的内容 */
  pending: string
  logPath: string | null
}

const MAX_BUFFER_CHARS = 200_000
const FLUSH_DELAY_MS = 500

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

  create(workspaceDir: string, cols: number, rows: number): TerminalCreateResult {
    if (!workspaceDir) {
      return { success: false, error: 'Workspace path is required' }
    }

    const id = `term-${this.nextId++}`
    const logPath = this.options.logPathFor?.(workspaceDir) ?? null

    try {
      const pty = this.options.spawn(this.options.shell ?? defaultShell(), this.options.shellArgs ?? [], {
        name: 'xterm-256color',
        cols: Math.max(cols, 20),
        rows: Math.max(rows, 5),
        cwd: workspaceDir,
        env: this.options.env ?? process.env,
      })

      const entry: TerminalEntry = {
        id,
        workspaceDir,
        pty,
        buffer: '',
        pending: '',
        logPath,
      }

      // 新终端会话使用新的日志文件
      if (logPath) {
        try {
          fs.mkdirSync(path.dirname(logPath), { recursive: true })
          fs.writeFileSync(logPath, '', 'utf-8')
        } catch (error) {
          console.warn('[Terminal] Failed to reset terminal log:', error)
        }
      }

      pty.onData((data) => {
        entry.buffer = (entry.buffer + data).slice(-MAX_BUFFER_CHARS)
        entry.pending += data
        this.scheduleFlush(entry)
        this.options.onData?.(id, data)
      })

      pty.onExit(({ exitCode }) => {
        this.flush(entry)
        this.terminals.delete(id)
        this.options.onExit?.(id, exitCode)
      })

      this.terminals.set(id, entry)
      return { success: true, id }
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
    entry.pty.resize(Math.max(cols, 20), Math.max(rows, 5))
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

  /** 立即把待写入内容刷到日志文件 */
  flushNow(id: string): boolean {
    const entry = this.terminals.get(id)
    if (!entry) return false
    this.clearFlushTimer(id)
    this.flush(entry)
    return true
  }

  getRecentOutput(id: string): string {
    return this.terminals.get(id)?.buffer ?? ''
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
    try {
      fs.mkdirSync(path.dirname(entry.logPath), { recursive: true })
      fs.appendFileSync(entry.logPath, entry.pending, 'utf-8')
      entry.pending = ''
    } catch (error) {
      console.warn('[Terminal] Failed to write terminal log:', error)
    }
  }
}
