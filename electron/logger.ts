/**
 * 主进程文件日志。
 *
 * Electron 打包后没有控制台，这里把 console 输出同时写入 {appDir}/logs/main.log，
 * 按大小轮转并保留一份 main.log.1 备份。使用同步写入：日志量小，且能保证
 * 进程退出前内容已落盘。
 */
import * as fs from 'fs'
import * as path from 'path'

export interface FileLoggerOptions {
  logDir: string
  fileName?: string
  /** 单个日志文件的上限，超过后轮转为 <fileName>.1 */
  maxBytes?: number
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

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
  private fd: number | null = null
  private bytesWritten: number

  constructor(options: FileLoggerOptions) {
    fs.mkdirSync(options.logDir, { recursive: true })
    this.filePath = path.join(options.logDir, options.fileName ?? 'main.log')
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.bytesWritten = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0
    this.fd = this.open()
  }

  private open(): number | null {
    try {
      return fs.openSync(this.filePath, 'a')
    } catch {
      return null
    }
  }

  write(level: LogLevel, args: unknown[]): void {
    if (this.fd === null) return

    const line = `${new Date().toISOString()} [${level}] ${args.map(formatArg).join(' ')}\n`
    try {
      fs.writeSync(this.fd, line)
      this.bytesWritten += Buffer.byteLength(line)
      if (this.bytesWritten >= this.maxBytes) {
        this.rotate()
      }
    } catch {
      // 日志写入失败不应影响应用运行
    }
  }

  /** 关闭当前文件，把内容转存为 .1（只保留一份），再重新打开 main.log */
  private rotate(): void {
    if (this.fd === null) return

    try {
      fs.closeSync(this.fd)
      this.fd = null

      const backup = `${this.filePath}.1`
      if (fs.existsSync(backup)) fs.unlinkSync(backup)
      fs.renameSync(this.filePath, backup)

      this.bytesWritten = 0
      this.fd = this.open()
    } catch {
      // 轮转失败时尽量恢复写入能力，避免日志丢失后完全静默
      this.fd = this.open()
    }
  }

  close(): void {
    if (this.fd === null) return
    try {
      fs.closeSync(this.fd)
    } catch {
      // ignore
    }
    this.fd = null
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
