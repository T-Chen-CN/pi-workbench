/**
 * 统一原子 JSON 持久化（pi-bridge / electron / apps/cloud 共用）。
 *
 * 行为约束：同目录临时文件（`.` 开头，带 pid + 时间戳 + 随机后缀）→ 写盘 + fsync →
 * 仅在旧主文件为合法 JSON 时留 `.bak` → rename 替换目标（Windows 下带短暂重试）；
 * 异步版本按规范化路径串行化，避免并发写交错或阻塞事件循环。
 */
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'

export interface JsonReadResult<T> {
  data: T | null
  /** 数据来自主文件还是 .bak 备份；均不可读时为 undefined */
  source?: 'primary' | 'backup'
  error?: string
}

export interface JsonWriteOptions {
  /** 覆盖前是否把旧文件留一份 `.bak`（默认 true） */
  backup?: boolean
  /** 是否 fsync（默认 true；高频缓存草稿可关） */
  fsync?: boolean
}

const asyncQueues = new Map<string, Promise<void>>()

function queueKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function temporaryPathFor(filePath: string): string {
  const dir = path.dirname(filePath)
  const name = path.basename(filePath)
  const random = Math.random().toString(36).slice(2, 8)
  // 临时文件以 . 开头，避免被文件树或监听器当作正常文件
  return path.join(dir, `.${name}.${process.pid}.${Date.now()}.${random}.tmp`)
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  const retries = process.platform === 'win32' ? 5 : 1
  let lastError: unknown
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await fsp.rename(from, to)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException)?.code
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)))
    }
  }
  throw lastError
}

/** 同步读取 JSON；主文件损坏时回退 `.bak`，不抛异常。 */
export function readJsonWithBackup<T>(filePath: string): JsonReadResult<T> {
  const candidates: Array<{ source: 'primary' | 'backup'; file: string }> = [
    { source: 'primary', file: filePath },
    { source: 'backup', file: `${filePath}.bak` },
  ]

  let lastError: string | undefined
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate.file)) continue
      const content = fs.readFileSync(candidate.file, 'utf-8')
      return { data: JSON.parse(content) as T, source: candidate.source }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }

  return { data: null, error: lastError }
}

/** 异步读取 JSON；主文件损坏时回退 `.bak`，不抛异常。 */
export async function readJsonAsyncWithBackup<T>(filePath: string): Promise<JsonReadResult<T>> {
  const candidates: Array<{ source: 'primary' | 'backup'; file: string }> = [
    { source: 'primary', file: filePath },
    { source: 'backup', file: `${filePath}.bak` },
  ]

  let lastError: string | undefined
  for (const candidate of candidates) {
    try {
      const content = await fsp.readFile(candidate.file, 'utf-8')
      return { data: JSON.parse(content) as T, source: candidate.source }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') continue
      lastError = error instanceof Error ? error.message : String(error)
    }
  }

  return { data: null, error: lastError }
}

/** 异步串行原子写 JSON：按路径串行 + 临时文件 + 可选 fsync/.bak + rename */
export async function writeJsonAtomicAsync(
  filePath: string,
  value: unknown,
  options: JsonWriteOptions = {}
): Promise<void> {
  const { backup = true, fsync = true } = options
  const key = queueKey(filePath)
  const prev = asyncQueues.get(key) ?? Promise.resolve()
  const run = prev.then(async () => {
    const dir = path.dirname(filePath)
    await fsp.mkdir(dir, { recursive: true })
    const tmpPath = temporaryPathFor(filePath)
    const content = JSON.stringify(value, null, 2)
    let handle: fsp.FileHandle | null = null
    try {
      handle = await fsp.open(tmpPath, 'w', 0o600)
      await handle.writeFile(content, 'utf-8')
      if (fsync) await handle.sync()
    } catch (error) {
      await handle?.close().catch(() => undefined)
      handle = null
      await fsp.unlink(tmpPath).catch(() => undefined)
      throw error
    } finally {
      if (handle) await handle.close()
    }

    if (backup) {
      try {
        if (fs.existsSync(filePath)) {
          JSON.parse(await fsp.readFile(filePath, 'utf-8'))
          await fsp.copyFile(filePath, `${filePath}.bak`)
        }
      } catch (error) {
        console.warn(`[AtomicJson] Skipped backing up unreadable ${filePath}:`, error)
      }
    }

    try {
      await renameWithRetry(tmpPath, filePath)
    } catch (error) {
      await fsp.unlink(tmpPath).catch(() => undefined)
      throw error
    }
  })
  const tail = run.catch(() => undefined)
  asyncQueues.set(key, tail)
  try {
    await run
  } finally {
    if (asyncQueues.get(key) === tail) asyncQueues.delete(key)
  }
}

/** 异步串行原子写 JSON（默认带 .bak 与 fsync，不阻塞主进程 UI 线程） */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options?: JsonWriteOptions
): Promise<void> {
  await writeJsonAtomicAsync(filePath, value, options)
}

/** 同步原子写 JSON（仅限启动期或必须同步落盘的极小状态文件） */
export function writeJsonAtomicSync(
  filePath: string,
  value: unknown,
  options: JsonWriteOptions = {}
): void {
  const { backup = true, fsync = true } = options
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  const tmpPath = temporaryPathFor(filePath)
  const content = JSON.stringify(value, null, 2)

  let fd: number | null = null
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600)
    fs.writeFileSync(fd, content, 'utf-8')
    if (fsync) fs.fsyncSync(fd)
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // ignore
      }
      fd = null
    }
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // ignore
    }
    throw error
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }

  if (backup) {
    try {
      if (fs.existsSync(filePath)) {
        // 只有主文件仍是合法 JSON 时才覆盖备份，避免把损坏内容写进 .bak
        JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        fs.copyFileSync(filePath, `${filePath}.bak`)
      }
    } catch (error) {
      console.warn(`[AtomicJson] Skipped backing up unreadable ${filePath}:`, error)
    }
  }

  try {
    fs.renameSync(tmpPath, filePath)
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // ignore
    }
    throw error
  }
}
