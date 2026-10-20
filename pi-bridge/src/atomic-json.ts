/**
 * 原子 JSON 持久化（pi-bridge 独立构建，无法复用 electron/ 下的模块）。
 * 行为与 electron/atomic-json.ts 保持一致：临时文件 + fsync + rename，覆盖前留 .bak。
 */
import * as fs from 'fs'
import * as path from 'path'

export function writeJsonAtomicSync(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
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
      fs.copyFileSync(filePath, `${filePath}.bak`)
    }
  } catch (error) {
    console.warn(`[AtomicJson] Failed to back up ${filePath}:`, error)
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
