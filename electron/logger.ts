/**
 * 主进程文件日志。
 *
 * Electron 打包后没有控制台，这里把 console 输出同时写入 {appDir}/logs/main.log，
 * 按大小轮转并保持有界文件总数（默认 5 MB × 3 份：活动文件 + .1 + .2），超界旧轮转文件自动清理。
 * 正常运行时采用异步合并刷盘（50ms 或 32KB），避免每次 console.* 同步 writeSync/renameSync 阻塞 GUI 线程；
 * close() 时同步冲刷残余缓冲，确保退出前不丢日志。
 */
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { rotateLogFileAsync, rotateLogFileSync } from './cache-maintenance.js'

export interface FileLoggerOptions {
  logDir: string
  fileName?: string
  /** 单个日志文件的上限，超过后轮转 */
  maxBytes?: number
  /** 含活动日志在内的最大文件总数（默认 3：main.log + .1 + .2） */
  maxFiles?: number
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_FILES = 3
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

interface PendingLogBatch {
  lines: string[]
  nextIndex: number
  flushed: boolean
  claimedByClose: boolean
}

export class FileLogger {
  readonly filePath: string
  private readonly maxBytes: number
  private readonly maxBackups: number
  private closed = false
  private bytesWritten: number
  private pendingLines: string[] = []
  private pendingBytes = 0
  private inFlightBatches: PendingLogBatch[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private flushChain: Promise<void> = Promise.resolve()

  constructor(options: FileLoggerOptions) {
    fs.mkdirSync(options.logDir, { recursive: true })
    this.filePath = path.join(options.logDir, options.fileName ?? 'main.log')
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES))
    this.maxBackups = maxFiles - 1
    this.bytesWritten = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0
    this.pruneExcessBackupsSync()
  }

  private pruneExcessBackupsSync(): void {
    const dir = path.dirname(this.filePath)
    const prefix = `${path.basename(this.filePath)}.`
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
        const suffix = entry.name.slice(prefix.length)
        if (!/^\d+$/.test(suffix)) continue
        const generation = Number(suffix)
        if (generation > this.maxBackups || generation < 1) {
          try {
            fs.rmSync(path.join(dir, entry.name), { force: true })
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
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
    const batch: PendingLogBatch = {
      lines: this.pendingLines,
      nextIndex: 0,
      flushed: false,
      claimedByClose: false,
    }
    this.pendingLines = []
    this.pendingBytes = 0
    this.inFlightBatches.push(batch)
    const next = this.flushChain.then(async () => {
      if (batch.claimedByClose || batch.flushed) return
      await this.writeBatchAsync(batch)
    })
    this.flushChain = next.catch(() => undefined)
    return next
  }

  private async writeBatchAsync(batch: PendingLogBatch): Promise<void> {
    try {
      let chunk = ''
      let chunkBytes = 0
      let chunkCount = 0
      for (let i = batch.nextIndex; i < batch.lines.length; i += 1) {
        if (this.closed || batch.claimedByClose) return
        const line = batch.lines[i]
        const bytes = Buffer.byteLength(line)
        chunk += line
        chunkBytes += bytes
        chunkCount += 1
        if (this.bytesWritten + chunkBytes >= this.maxBytes) {
          try {
            await fsp.appendFile(this.filePath, chunk, 'utf-8')
            if (this.closed || batch.claimedByClose) return
            this.bytesWritten += chunkBytes
            batch.nextIndex += chunkCount
            chunk = ''
            chunkBytes = 0
            chunkCount = 0
            await this.rotateAsync()
          } catch {
            batch.nextIndex += chunkCount
            chunk = ''
            chunkBytes = 0
            chunkCount = 0
          }
        }
      }
      if (chunk && !this.closed && !batch.claimedByClose) {
        try {
          await fsp.appendFile(this.filePath, chunk, 'utf-8')
          if (this.closed || batch.claimedByClose) return
          this.bytesWritten += chunkBytes
          batch.nextIndex += chunkCount
        } catch {
          // 日志写入失败不应影响应用运行
        }
      }
      batch.flushed = true
    } finally {
      const idx = this.inFlightBatches.indexOf(batch)
      if (idx >= 0) this.inFlightBatches.splice(idx, 1)
    }
  }

  private async rotateAsync(): Promise<void> {
    try {
      await rotateLogFileAsync(this.filePath, this.maxBackups)
      this.bytesWritten = 0
    } catch {
      // 轮转失败时继续追加，避免静默丢日志
    }
  }

  private rotateSync(): void {
    try {
      rotateLogFileSync(this.filePath, this.maxBackups)
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
    // 必须按顺序接管所有已移交 flushChain 但尚未落盘的批次，再追加 pendingLines，
    // 否则退出前同步 close() 会丢掉在途批次或与异步链乱序交错
    const lines: string[] = []
    for (const batch of this.inFlightBatches) {
      batch.claimedByClose = true
      if (!batch.flushed && batch.nextIndex < batch.lines.length) {
        lines.push(...batch.lines.slice(batch.nextIndex))
      }
    }
    this.inFlightBatches = []
    if (this.pendingLines.length > 0) {
      lines.push(...this.pendingLines)
      this.pendingLines = []
      this.pendingBytes = 0
    }
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
