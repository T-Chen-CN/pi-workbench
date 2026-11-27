/**
 * 主进程文件日志。
 *
 * Electron 打包后没有控制台，这里把 console 输出同时写入 {appDir}/logs/main.log，
 * 按大小轮转并保留一份 main.log.1 备份。
 * 正常运行时采用异步合并刷盘（50ms 或 32KB），避免每次 console.* 同步 writeSync/renameSync 阻塞 GUI 线程；
 * close() 时同步冲刷残余缓冲，确保退出前不丢日志。
 */
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'

export interface FileLoggerOptions {
  logDir: string
  fileName?: string
  /** 单个日志文件的上限，超过后轮转为 <fileName>.1 */
  maxBytes?: number
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const FLUSH_INTERVAL_MS = 50
const FLUSH_THRESHOLD_BYTES = 32 * 1024

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export class FileLogger {
  readonly filePath: string
  private readonly maxBytes: number
  private closed = false
  private bytesWritten: number
  private pendingLines: string[] = []
  private pendingBytes = 0
  private flushTimer: NodeJS.Timeout | null = null
  private flushChain: Promise<void> = Promise.resolve()

  constructor(options: FileLoggerOptions) {
    fs.mkdirSync(options.logDir, { recursive: true })
    this.filePath = path.join(options.logDir, options.fileName ?? 'main.log')
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.bytesWritten = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0
  }

  write(level: LogLevel, args: unknown[]): void {
    if (this.closed) return

    const line = `${new Date().toISOString()} [${level}] ${args.map(formatArg).join(' ')}\n`
    const bytes = Buffer.byteLength(line)
    this.pendingLines.push(line)
    this.pendingBytes += bytes

    if (this.pendingBytes >= FLUSH_THRESHOLD_BYTES) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer)
        this.flushTimer = null
      }
      void this.flushAsync()
      return
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        void this.flushAsync()
      }, FLUSH_INTERVAL_MS)
      this.flushTimer.unref?.()
    }
  }

  /** 异步合并刷盘与按行轮转（不阻塞事件循环） */
  flushAsync(): Promise<void> {
    if (this.pendingLines.length === 0) return this.flushChain
    const lines = this.pendingLines
    this.pendingLines = []
    this.pendingBytes = 0
    const next = this.flushChain.then(async () => {
      await this.writeLinesAsync(lines)
    })
    this.flushChain = next.catch(() => undefined)
    return next
  }

  private async writeLinesAsync(lines: string[]): Promise<void> {
    let chunk = ''
    let chunkBytes = 0
    for (const line of lines) {
      const bytes = Buffer.byteLength(line)
      chunk += line
      chunkBytes += bytes
      if (this.bytesWritten + chunkBytes >= this.maxBytes) {
        try {
          await fsp.appendFile(this.filePath, chunk, 'utf-8')
          this.bytesWritten += chunkBytes
          chunk = ''
          chunkBytes = 0
          await this.rotateAsync()
        } catch {
          chunk = ''
          chunkBytes = 0
        }
      }
    }
    if (chunk) {
      try {
        await fsp.appendFile(this.filePath, chunk, 'utf-8')
        this.bytesWritten += chunkBytes
      } catch {
        // 日志写入失败不应影响应用运行
      }
    }
  }

  private async rotateAsync(): Promise<void> {
    try {
      const backup = `${this.filePath}.1`
      await fsp.rm(backup, { force: true })
      await fsp.rename(this.filePath, backup)
      this.bytesWritten = 0
    } catch {
      // 轮转失败时继续追加，避免静默丢日志
    }
  }

  private rotateSync(): void {
    try {
      const backup = `${this.filePath}.1`
      if (fs.existsSync(backup)) fs.unlinkSync(backup)
      if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, backup)
      this.bytesWritten = 0
    } catch {
      // ignore
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const lines = this.pendingLines
    this.pendingLines = []
    this.pendingBytes = 0
    if (lines.length === 0) return

    let chunk = ''
    let chunkBytes = 0
    for (const line of lines) {
      const bytes = Buffer.byteLength(line)
      chunk += line
      chunkBytes += bytes
      if (this.bytesWritten + chunkBytes >= this.maxBytes) {
        try {
          fs.appendFileSync(this.filePath, chunk, 'utf-8')
          this.bytesWritten += chunkBytes
          chunk = ''
          chunkBytes = 0
          this.rotateSync()
        } catch {
          chunk = ''
          chunkBytes = 0
        }
      }
    }
    if (chunk) {
      try {
        fs.appendFileSync(this.filePath, chunk, 'utf-8')
        this.bytesWritten += chunkBytes
      } catch {
        // ignore
      }
    }
  }
}

/**
 * 把 console 输出同时写入文件（pi-bridge 的 Agent 日志走同一个 console）。
 * 返回恢复函数。
 */
export function installConsoleTee(logger: FileLogger): () => void {
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }

  console.log = (...args: unknown[]) => {
    original.log(...args)
    logger.write('INFO', args)
  }
  console.info = (...args: unknown[]) => {
    original.info(...args)
    logger.write('INFO', args)
  }
  console.warn = (...args: unknown[]) => {
    original.warn(...args)
    logger.write('WARN', args)
  }
  console.error = (...args: unknown[]) => {
    original.error(...args)
    logger.write('ERROR', args)
  }
  console.debug = (...args: unknown[]) => {
    original.debug(...args)
    logger.write('DEBUG', args)
  }

  return () => {
    console.log = original.log
    console.info = original.info
    console.warn = original.warn
    console.error = original.error
    console.debug = original.debug
  }
}
