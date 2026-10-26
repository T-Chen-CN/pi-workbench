/**
 * 旧版本遗留在系统目录中的应用数据：一次性回收与清理。
 *
 * - `~/.pi`：Pi SDK 的全局 agent 目录（默认 getAgentDir()）。应用主流程已显式
 *   传入 agentDir，但 SDK 的若干默认入口仍会落在这里；把内容合并进
 *   `{appDir}/data/agent` 后删除。
 * - `%APPDATA%\pi-workbench`：旧版 Electron 默认 userData（单实例锁在 setPath
 *   之前创建）。当前版本已改为应用目录，这里只负责清理存量。
 * - `%LOCALAPPDATA%\pi-workbench-updater`：electron-builder 安装器的差分副本，
 *   我们的更新缓存在别处，这份副本不会被读取。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface LegacyLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface PiAgentHomeMigrationOptions {
  homeDir: string
  agentDir: string
  logger?: LegacyLogger
  /** 测试用：覆盖 CLI 检测 */
  isPiCliAvailable?: () => boolean
}

export interface PiAgentHomeMigrationResult {
  found: boolean
  migrated: number
  conflicts: number
  removed: boolean
  reason?: string
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** PATH 中是否存在独立的 Pi CLI（存在时保留 ~/.pi，避免影响命令行工具） */
export function hasPiCliOnPath(): boolean {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const names =
    process.platform === 'win32' ? ['pi.exe', 'pi.cmd', 'pi.bat'] : ['pi']
  return entries.some((entry) => {
    const dir = entry.replace(/^"(.*)"$/u, '$1')
    return names.some((name) => fs.existsSync(path.join(dir, name)))
  })
}

/**
 * 把 `~/.pi` 合并进应用的 agent 目录。
 * 目标已存在的文件不覆盖，来源另存到 `{agentDir}/legacy-home/`；
 * 全部成功且未检测到 Pi CLI 时才删除旧目录。
 */
export function migratePiAgentHome(
  options: PiAgentHomeMigrationOptions
): PiAgentHomeMigrationResult {
  const logger = options.logger ?? console
  const legacyRoot = path.join(options.homeDir, '.pi')
  const agentDir = path.resolve(options.agentDir)
  const result: PiAgentHomeMigrationResult = {
    found: false,
    migrated: 0,
    conflicts: 0,
    removed: false,
  }

  try {
    if (!fs.statSync(legacyRoot).isDirectory()) return result
  } catch {
    return result
  }
  result.found = true

  if (path.resolve(legacyRoot) === agentDir) {
    result.reason = 'same-directory'
    return result
  }

  if ((options.isPiCliAvailable ?? hasPiCliOnPath)()) {
    result.reason = 'pi-cli-present'
    logger.info('[Legacy] Pi CLI detected; leaving legacy agent directory untouched:', legacyRoot)
    return result
  }

  let failed = false
  const merge = (sourceDir: string, relativeDir: string): void => {
    for (const dirent of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      const source = path.join(sourceDir, dirent.name)
      const relative = path.join(relativeDir, dirent.name)
      const target = path.join(agentDir, relative)
      try {
        if (dirent.isDirectory()) {
          fs.mkdirSync(target, { recursive: true })
          merge(source, relative)
          continue
        }
        if (!fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.copyFileSync(source, target)
          result.migrated += 1
        } else {
          const backup = path.join(agentDir, 'legacy-home', relative)
          fs.mkdirSync(path.dirname(backup), { recursive: true })
          fs.copyFileSync(source, backup)
          result.conflicts += 1
        }
      } catch (error) {
        failed = true
        logger.warn('[Legacy] Failed to migrate Pi file:', source, error)
      }
    }
  }

  const backup = (source: string, target: string): void => {
    try {
      const stat = fs.statSync(source)
      if (stat.isDirectory()) {
        fs.mkdirSync(target, { recursive: true })
        for (const dirent of fs.readdirSync(source, { withFileTypes: true })) {
          backup(path.join(source, dirent.name), path.join(target, dirent.name))
        }
        return
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
      result.conflicts += 1
    } catch (error) {
      failed = true
      logger.warn('[Legacy] Failed to back up legacy Pi file:', source, error)
    }
  }

  try {
    // SDK 的 agent 目录是 ~/.pi/agent；合并它的内容，而不是整个 ~/.pi。
    const entries = fs.readdirSync(legacyRoot, { withFileTypes: true })
    const agentEntry = entries.find((entry) => entry.name === 'agent' && entry.isDirectory())
    if (agentEntry) {
      merge(path.join(legacyRoot, 'agent'), '')
      for (const entry of entries) {
        if (entry.name === 'agent') continue
        backup(
          path.join(legacyRoot, entry.name),
          path.join(agentDir, 'legacy-home', 'pi-other', entry.name)
        )
      }
    } else {
      merge(legacyRoot, '')
    }
  } catch (error) {
    failed = true
    logger.warn('[Legacy] Failed to scan legacy Pi directory:', error)
  }

  if (failed) {
    result.reason = 'incomplete'
    return result
  }

  try {
    fs.rmSync(legacyRoot, { recursive: true, force: true })
    result.removed = true
    logger.info(
      '[Legacy] Migrated legacy Pi agent directory:',
      legacyRoot,
      `(${result.migrated} files, ${result.conflicts} conflicts)`
    )
  } catch (error) {
    result.reason = 'remove-failed'
    logger.warn('[Legacy] Failed to remove legacy Pi directory:', error)
  }
  return result
}

export interface LegacySystemCleanupOptions {
  appDir: string
  platform: NodeJS.Platform
  appDataPath: string
  userDataPath: string
  localAppDataPath?: string
  cachePath: string
  logger?: LegacyLogger
  retries?: number
  delayMs?: number
}

function isInside(parentDir: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function removeWithRetry(
  target: string,
  logger: LegacyLogger,
  retries: number,
  delayMs: number
): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
      logger.info('[Legacy] Removed system directory:', target)
      return true
    } catch (error) {
      if (attempt === retries) {
        logger.warn('[Legacy] Failed to remove system directory:', target, error)
        return false
      }
      await delay(delayMs)
    }
  }
  return false
}

/**
 * 清理旧版本在系统目录留下的应用目录。
 * 永远不删除应用目录内的路径，也不会删除当前 userData。
 */
export async function cleanupLegacySystemPaths(
  options: LegacySystemCleanupOptions
): Promise<string[]> {
  const logger = options.logger ?? console
  const retries = Math.max(1, options.retries ?? 3)
  const delayMs = Math.max(0, options.delayMs ?? 300)
  const targets: string[] = []

  // macOS 的 <appData>/pi-workbench 是当前数据目录，不能删
  if (options.platform !== 'darwin') {
    targets.push(path.join(options.appDataPath, 'pi-workbench'))
  }
  if (options.platform === 'win32') {
    const local = options.localAppDataPath ?? options.appDataPath
    targets.push(path.join(local, 'pi-workbench-updater'))
  } else {
    targets.push(path.join(options.cachePath, 'pi-workbench-updater'))
  }

  const removed: string[] = []
  for (const target of targets) {
    if (path.resolve(target) === path.resolve(options.userDataPath)) continue
    if (isInside(options.appDir, target)) continue
    try {
      if (!fs.existsSync(target)) continue
    } catch {
      continue
    }
    if (await removeWithRetry(target, logger, retries, delayMs)) {
      removed.push(target)
    }
  }
  return removed
}
