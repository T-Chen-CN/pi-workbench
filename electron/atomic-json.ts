/**
 * 原子 JSON 持久化。
 *
 * 直接 writeFile 在崩溃或断电时会留下截断的 JSON，导致下次启动无法解析。
 * 这里先写同目录临时文件并 fsync，再 rename 覆盖目标（同一文件系统内 rename 是原子的），
 * 覆盖前把旧文件复制为 .bak，读取时主文件损坏可以回退到备份。
 */
import * as fs from 'fs'
import * as path from 'path'

export interface JsonReadResult<T> {
  data: T | null
  /** 数据来自主文件还是 .bak 备份 */
  source?: 'primary' | 'backup'
  error?: string
}

/** 读取 JSON；主文件损坏时尝试 .bak。不抛异常。 */
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

function temporaryPathFor(filePath: string): string {
  const dir = path.dirname(filePath)
  const name = path.basename(filePath)
  const random = Math.random().toString(36).slice(2, 8)
  // 临时文件以 . 开头，避免被文件树或监听器当作正常文件
  return path.join(dir, `.${name}.${process.pid}.${Date.now()}.${random}.tmp`)
}

/** 同步原子写 JSON（文件很小，主进程直接写即可） */
export function writeJsonAtomicSync(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  const tmpPath = temporaryPathFor(filePath)
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

/** 异步签名版本：内部仍是同步写，避免同一文件的并发写交错 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  writeJsonAtomicSync(filePath, value)
}
