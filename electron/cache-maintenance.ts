/**
 * 纯自动缓存、更新包与日志维护。
 *
 * 启动后延迟异步执行，绝不阻塞窗口首屏，也不在设置页暴露手动清理按钮：
 * - 更新缓存：存在安装完成标记或 `pending/` 内存在超期（默认 7 天）残留时清理 `pending/` 与标记（保留差分基准）；
 * - 临时缓存：清理 `{appDir}/cache/temp/` 中超期（默认 7 天）或超出总容量上限（默认 100 MiB）的最旧文件；
 * - 孤儿草稿：清理 `{appDir}/cache/drafts/` 中超过 30 天的陈旧草稿；
 * - 终端日志：限制工作区 `.pi-workbench/terminal-*.log` 单文件大小并裁剪多余轮转备份。
 */

import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'

const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_UPDATER_PENDING_MAX_AGE_MS = 7 * DAY_MS
export const DEFAULT_TEMP_MAX_AGE_MS = 7 * DAY_MS
export const DEFAULT_TEMP_MAX_BYTES = 100 * 1024 * 1024
export const DEFAULT_DRAFT_MAX_AGE_MS = 30 * DAY_MS
export const DEFAULT_TERMINAL_LOG_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_TERMINAL_LOG_KEEP = 3

const DEFAULT_UPDATER_DIR_NAME = 'pi-workbench-updater'
const TERMINAL_BASE_LOG_RE = /^terminal(?:-[^.]+)?\.log$/
const TERMINAL_ROTATED_LOG_RE = /^(terminal(?:-[^.]+)?\.log)\.(\d+)$/

export interface UpdaterCleanupResult {
  removedPending: boolean
  removedFiles: number
  freedBytes: number
  clearedFlag: boolean
}

export interface FileCleanupResult {
  removedFiles: number
  freedBytes: number
}

export interface TerminalLogRotationResult {
  rotated: number
  pruned: number
  freedBytes: number
}

export interface StartupMaintenanceResult {
  updater: UpdaterCleanupResult
  temp: FileCleanupResult
  drafts: FileCleanupResult
}

interface ScannedFile {
  fullPath: string
  size: number
  mtimeMs: number
}

/** 递归扫描目录内的常规文件与子目录（绝不跟随符号链接，防止越界删除） */
async function scanDirectoryTree(
  rootDir: string
): Promise<{ files: ScannedFile[]; dirs: string[] }> {
  const files: ScannedFile[] = []
  const dirs: string[] = []

  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        dirs.push(fullPath)
        await walk(fullPath)
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.lstat(fullPath)
          if (stat.isFile()) {
            files.push({ fullPath, size: stat.size, mtimeMs: stat.mtimeMs })
          }
        } catch {
          // 文件并发消失时忽略
        }
      }
    }
  }

  await walk(rootDir)
  return { files, dirs }
}

async function removeEmptyDirsBottomUp(dirs: string[]): Promise<void> {
  // 路径越深越先删，确保嵌套空目录能一层层收干净
  const sorted = [...dirs].sort((a, b) => b.length - a.length)
  for (const dir of sorted) {
    try {
      await fsp.rmdir(dir)
    } catch {
      // 非空或已删除时忽略
    }
  }
}

/**
 * 清理已安装完成或长期陈旧的更新下载缓存（`cache/pi-workbench-updater/pending/`）。
 * 绝不删除同级的 `installer.exe` / `current.blockmap` 差分基准与兄弟目录 `drafts/`、`temp/`。
 */
export async function cleanupInstalledUpdaterCache(
  appDir: string,
  options: { maxPendingAgeMs?: number; now?: number; updaterDirName?: string } = {}
): Promise<UpdaterCleanupResult> {
  const cacheBase = path.join(appDir, 'cache')
  const updaterDirName = options.updaterDirName ?? DEFAULT_UPDATER_DIR_NAME
  const flagPath = path.join(cacheBase, `${updaterDirName}.flag`)
  const updaterDir = path.join(cacheBase, updaterDirName)
  const pendingDir = path.join(updaterDir, 'pending')
  const maxPendingAgeMs = options.maxPendingAgeMs ?? DEFAULT_UPDATER_PENDING_MAX_AGE_MS
  const now = options.now ?? Date.now()

  let hasFlag = false
  try {
    await fsp.lstat(flagPath)
    hasFlag = true
  } catch {
    hasFlag = false
  }

  let removedPending = false
  let removedFiles = 0
  let freedBytes = 0
  let clearedFlag = false

  if (hasFlag) {
    let pendingExists = false
    try {
      const stat = await fsp.lstat(pendingDir)
      pendingExists = stat.isDirectory()
    } catch {
      pendingExists = false
    }
    if (pendingExists) {
      const scanned = await scanDirectoryTree(pendingDir)
      for (const file of scanned.files) {
        removedFiles += 1
        freedBytes += file.size
      }
      try {
        await fsp.rm(pendingDir, { recursive: true, force: true })
        removedPending = true
      } catch {
        // 文件暂时被安装器占用时保留 flag，留给下次启动再清
        return { removedPending: false, removedFiles: 0, freedBytes: 0, clearedFlag: false }
      }
    }
    try {
      await fsp.rm(flagPath, { force: true })
      clearedFlag = true
    } catch {
      // ignore
    }
    return { removedPending, removedFiles, freedBytes, clearedFlag }
  }

  let pendingStat: fs.Stats | null = null
  try {
    const stat = await fsp.lstat(pendingDir)
    if (stat.isDirectory()) pendingStat = stat
  } catch {
    pendingStat = null
  }
  if (!pendingStat) {
    return { removedPending: false, removedFiles: 0, freedBytes: 0, clearedFlag: false }
  }

  const cutoff = now - maxPendingAgeMs
  const { files, dirs } = await scanDirectoryTree(pendingDir)
  let remaining = 0
  for (const file of files) {
    if (file.mtimeMs < cutoff) {
      try {
        await fsp.unlink(file.fullPath)
        removedFiles += 1
        freedBytes += file.size
      } catch {
        remaining += 1
      }
    } else {
      remaining += 1
    }
  }
  await removeEmptyDirsBottomUp(dirs)

  if (remaining === 0 && (removedFiles > 0 || pendingStat.mtimeMs < cutoff)) {
    try {
      await fsp.rmdir(pendingDir)
      removedPending = true
    } catch {
      // 目录非空或暂时被占用时保留
    }
  }

  return { removedPending, removedFiles, freedBytes, clearedFlag }
}

/**
 * 清理 `{appDir}/cache/temp/` 中过期或超出容量预算的临时文件（含历史 `tool-result-*.txt`）。
 */
export async function cleanupTempCache(
  appDir: string,
  options: { maxAgeMs?: number; maxTotalBytes?: number; now?: number } = {}
): Promise<FileCleanupResult> {
  const tempDir = path.join(appDir, 'cache', 'temp')
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TEMP_MAX_AGE_MS
  const maxTotalBytes = Math.max(0, options.maxTotalBytes ?? DEFAULT_TEMP_MAX_BYTES)
  const now = options.now ?? Date.now()
  const cutoff = now - maxAgeMs

  const { files, dirs } = await scanDirectoryTree(tempDir)
  let removedFiles = 0
  let freedBytes = 0
  const remaining: ScannedFile[] = []

  for (const file of files) {
    if (file.mtimeMs < cutoff) {
      try {
        await fsp.unlink(file.fullPath)
        removedFiles += 1
        freedBytes += file.size
      } catch {
        remaining.push(file)
      }
    } else {
      remaining.push(file)
    }
  }

  let totalBytes = remaining.reduce((sum, file) => sum + file.size, 0)
  if (totalBytes > maxTotalBytes) {
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs || a.fullPath.localeCompare(b.fullPath))
    for (const file of remaining) {
      if (totalBytes <= maxTotalBytes) break
      try {
        await fsp.unlink(file.fullPath)
        removedFiles += 1
        freedBytes += file.size
        totalBytes -= file.size
      } catch {
        // 跳过正在被占用的文件
      }
    }
  }

  await removeEmptyDirsBottomUp(dirs)
  return { removedFiles, freedBytes }
}

/**
 * 清理 `{appDir}/cache/drafts/` 中超过保留期（默认 30 天）的孤儿草稿文件。
 */
export async function pruneOrphanDrafts(
  appDir: string,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<FileCleanupResult> {
  const draftsDir = path.join(appDir, 'cache', 'drafts')
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_DRAFT_MAX_AGE_MS
  const now = options.now ?? Date.now()
  const cutoff = now - maxAgeMs

  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(draftsDir, { withFileTypes: true })
  } catch {
    return { removedFiles: 0, freedBytes: 0 }
  }

  let removedFiles = 0
  let freedBytes = 0
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    if (
      !entry.name.endsWith('.json') &&
      !entry.name.endsWith('.json.bak') &&
      !entry.name.endsWith('.tmp')
    ) {
      continue
    }
    const fullPath = path.join(draftsDir, entry.name)
    try {
      const stat = await fsp.lstat(fullPath)
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue
      await fsp.unlink(fullPath)
      removedFiles += 1
      freedBytes += stat.size
    } catch {
      // 并发删除或占用时忽略
    }
  }

  return { removedFiles, freedBytes }
}

/** 同步轮转单个日志文件，保留最近 `keep` 份 `.1`..`.keep` 备份并删除更早世代 */
export function rotateLogFileSync(logPath: string, keep = DEFAULT_TERMINAL_LOG_KEEP): void {
  const maxKeep = Math.max(0, Math.floor(keep))
  if (maxKeep === 0) {
    try {
      fs.rmSync(logPath, { force: true })
    } catch {
      // ignore
    }
  } else {
    try {
      fs.rmSync(`${logPath}.${maxKeep}`, { force: true })
    } catch {
      // ignore
    }
    for (let i = maxKeep - 1; i >= 1; i -= 1) {
      const src = `${logPath}.${i}`
      const dst = `${logPath}.${i + 1}`
      if (fs.existsSync(src)) {
        try {
          fs.renameSync(src, dst)
        } catch {
          // ignore
        }
      }
    }
    if (fs.existsSync(logPath)) {
      fs.renameSync(logPath, `${logPath}.1`)
    }
  }

  const dir = path.dirname(logPath)
  const base = path.basename(logPath)
  const prefix = `${base}.`
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
      const suffix = entry.name.slice(prefix.length)
      if (!/^\d+$/.test(suffix)) continue
      const generation = Number(suffix)
      if (generation > maxKeep || generation < 1) {
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

/** 异步轮转单个日志文件，保留最近 `keep` 份 `.1`..`.keep` 备份并删除更早世代 */
export async function rotateLogFileAsync(
  logPath: string,
  keep = DEFAULT_TERMINAL_LOG_KEEP
): Promise<void> {
  const maxKeep = Math.max(0, Math.floor(keep))
  if (maxKeep === 0) {
    await fsp.rm(logPath, { force: true }).catch(() => undefined)
  } else {
    await fsp.rm(`${logPath}.${maxKeep}`, { force: true }).catch(() => undefined)
    for (let i = maxKeep - 1; i >= 1; i -= 1) {
      const src = `${logPath}.${i}`
      const dst = `${logPath}.${i + 1}`
      try {
        await fsp.rename(src, dst)
      } catch {
        // 源文件不存在或暂时占用时跳过
      }
    }
    await fsp.rename(logPath, `${logPath}.1`).catch(() => undefined)
  }

  const dir = path.dirname(logPath)
  const base = path.basename(logPath)
  const prefix = `${base}.`
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
      const suffix = entry.name.slice(prefix.length)
      if (!/^\d+$/.test(suffix)) continue
      const generation = Number(suffix)
      if (generation > maxKeep || generation < 1) {
        await fsp.rm(path.join(dir, entry.name), { force: true }).catch(() => undefined)
      }
    }
  } catch {
    // ignore
  }
}

/**
 * 扫描并轮转/裁剪工作区 `.pi-workbench/terminal-*.log`：
 * - 单文件超过 `maxBytes`（默认 5 MiB）时轮转，最多保留 `keep`（默认 3）份备份；
 * - 删除编号超过 `keep` 的多余轮转日志。
 */
export async function rotateTerminalLogs(
  workspaceDir: string,
  options: { maxBytes?: number; keep?: number; excludeBaseNames?: string[] } = {}
): Promise<TerminalLogRotationResult> {
  const metaDir = path.join(workspaceDir, '.pi-workbench')
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_TERMINAL_LOG_MAX_BYTES)
  const keep = Math.max(0, Math.floor(options.keep ?? DEFAULT_TERMINAL_LOG_KEEP))
  const excluded = new Set(
    (options.excludeBaseNames ?? []).map((name) =>
      process.platform === 'win32' ? name.toLowerCase() : name
    )
  )
  const isExcluded = (name: string): boolean =>
    excluded.has(process.platform === 'win32' ? name.toLowerCase() : name)

  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(metaDir, { withFileTypes: true })
  } catch {
    return { rotated: 0, pruned: 0, freedBytes: 0 }
  }

  let rotated = 0
  let pruned = 0
  let freedBytes = 0

  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    if (!TERMINAL_BASE_LOG_RE.test(entry.name)) continue
    if (isExcluded(entry.name)) continue
    const fullPath = path.join(metaDir, entry.name)
    try {
      const stat = await fsp.lstat(fullPath)
      if (!stat.isFile() || stat.size <= maxBytes) continue
      await rotateLogFileAsync(fullPath, keep)
      rotated += 1
    } catch {
      // ignore
    }
  }

  let afterEntries: fs.Dirent[]
  try {
    afterEntries = await fsp.readdir(metaDir, { withFileTypes: true })
  } catch {
    return { rotated, pruned, freedBytes }
  }

  for (const entry of afterEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const match = TERMINAL_ROTATED_LOG_RE.exec(entry.name)
    if (!match) continue
    const baseName = match[1]
    if (isExcluded(baseName)) continue
    const generation = Number(match[2])
    if (generation <= keep && generation >= 1) continue
    const fullPath = path.join(metaDir, entry.name)
    try {
      const stat = await fsp.lstat(fullPath)
      if (!stat.isFile()) continue
      await fsp.unlink(fullPath)
      pruned += 1
      freedBytes += stat.size
    } catch {
      // ignore
    }
  }

  return { rotated, pruned, freedBytes }
}

/**
 * 启动期异步缓存维护总入口：并行执行更新缓存、临时文件与孤儿草稿清理，
 * 单项失败不影响其余项目，绝不向调用方抛错。
 */
export async function runStartupCacheMaintenance(
  appDir: string,
  options: { logger?: Pick<Console, 'log' | 'warn'>; now?: number } = {}
): Promise<StartupMaintenanceResult> {
  const logger = options.logger ?? console
  const now = options.now ?? Date.now()

  const emptyUpdater: UpdaterCleanupResult = {
    removedPending: false,
    removedFiles: 0,
    freedBytes: 0,
    clearedFlag: false,
  }
  const emptyFiles: FileCleanupResult = { removedFiles: 0, freedBytes: 0 }

  const [updater, temp, drafts] = await Promise.all([
    cleanupInstalledUpdaterCache(appDir, { now }).catch((error) => {
      logger.warn('[CacheMaintenance] Updater cache cleanup failed:', error)
      return emptyUpdater
    }),
    cleanupTempCache(appDir, { now }).catch((error) => {
      logger.warn('[CacheMaintenance] Temp cache cleanup failed:', error)
      return emptyFiles
    }),
    pruneOrphanDrafts(appDir, { now }).catch((error) => {
      logger.warn('[CacheMaintenance] Orphan drafts cleanup failed:', error)
      return emptyFiles
    }),
  ])

  const totalRemoved = updater.removedFiles + temp.removedFiles + drafts.removedFiles
  const totalFreed = updater.freedBytes + temp.freedBytes + drafts.freedBytes
  if (totalRemoved > 0 || updater.removedPending || updater.clearedFlag) {
    logger.log(
      `[CacheMaintenance] Cleaned ${totalRemoved} file(s), freed ${totalFreed} bytes ` +
        `(updaterPending=${updater.removedPending}, temp=${temp.removedFiles}, drafts=${drafts.removedFiles})`
    )
  }

  return { updater, temp, drafts }
}
