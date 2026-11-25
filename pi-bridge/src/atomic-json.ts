/**
 * 原子 JSON 持久化（pi-bridge 独立构建，无法复用 electron/ 下的模块）。
 * 行为与 electron/atomic-json.ts 保持一致：临时文件 + fsync + rename，覆盖前留 .bak。
 */
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'

const asyncQueues = new Map<string, Promise<void>>()

function queueKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
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

/** 异步串行原子写 JSON：临时文件 + fsync + .bak 备份 + rename，避免阻塞主进程事件循环 */
export async function writeJsonAtomicAsync(filePath: string, value: unknown): Promise<void> {
  const key = queueKey(filePath)
  const prev = asyncQueues.get(key) ?? Promise.resolve()
  const run = prev.then(async () => {
    const dir = path.dirname(filePath)
    await fsp.mkdir(dir, { recursive: true })
    const random = Math.random().toString(36).slice(2, 8)
    const tmpPath = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${random}.tmp`
    )
    const content = JSON.stringify(value, null, 2)
    let handle: fsp.FileHandle | null = null
    try {
      handle = await fsp.open(tmpPath, 'w', 0o600)
      await handle.writeFile(content, 'utf-8')
      await handle.sync()
    } catch (error) {
      await handle?.close().catch(() => undefined)
      handle = null
      await fsp.unlink(tmpPath).catch(() => undefined)
      throw error
    } finally {
      if (handle) await handle.close()
    }

    try {
      if (fs.existsSync(filePath)) {
        JSON.parse(await fsp.readFile(filePath, 'utf-8'))
        await fsp.copyFile(filePath, `${filePath}.bak`)
      }
    } catch (error) {
      console.warn(`[AtomicJson] Skipped backing up unreadable ${filePath}:`, error)
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

export function writeJsonAtomicSync(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  const random = Math.random().toString(36).slice(2, 8)
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${random}.tmp`
  )
  const content = JSON.stringify(value, null, 2)

  let fd: number | null = null
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600)
    fs.writeFileSync(fd, content, 'utf-8')
    fs.fsyncSync(fd)
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }

  try {
    if (fs.existsSync(filePath)) {
      // 只有主文件仍是合法 JSON 时才覆盖备份，避免把损坏内容写进 .bak
      JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      fs.copyFileSync(filePath, `${filePath}.bak`)
    }
  } catch (error) {
    console.warn(`[AtomicJson] Skipped backing up unreadable ${filePath}:`, error)
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
