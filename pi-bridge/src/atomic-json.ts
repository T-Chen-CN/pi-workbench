/**
 * 原子 JSON 持久化（pi-bridge 独立构建，无法复用 electron/ 下的模块）。
 * 行为与 electron/atomic-json.ts 保持一致：临时文件 + fsync + rename，覆盖前留 .bak。
 */
import * as fs from 'fs'
import * as path from 'path'

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
