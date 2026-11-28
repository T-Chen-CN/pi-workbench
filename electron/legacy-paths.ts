/**
 * 旧版本数据迁移与残留目录清理：
 *
 * - 旧便携安装目录迁移（0.11.x → 标准两目录模型）：首次升级启动时把旧安装目录的
 *   `config/`、`data/`、`logs/`、`cache/drafts/` 合并复制到 `<appData>/pi-workbench`
 *   （不覆盖目标已有文件），完成后写标记并尽力归档旧目录。
 * - `~/.pi`：Pi SDK 默认 agent 目录，合并进 `{dataDir}/data/agent` 后删除（检测到独立 Pi CLI 时保留）。
 * - `%LOCALAPPDATA%\Pi-Workbench-Update` / `%LOCALAPPDATA%\pi-workbench-updater`：
 *   旧版外部更新缓存与 electron-builder 差分副本，统一迁回 `{dataDir}/cache` 后清理。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface LegacyLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface LegacyInstallMigrationOptions {
  installDir: string
  dataDir: string
  logger?: LegacyLogger
}

export interface LegacyInstallMigrationResult {
  needed: boolean
  migratedFiles: number
  skippedFiles: number
  archivedLegacy: boolean
  reason?: string
}

const INSTALL_MIGRATION_MARKER = path.join('config', '.migrated-from-install-dir')
const PENDING_LEGACY_MIGRATION_DIR = '.pending-legacy-migration'
const CHROMIUM_LOCK_FILES = new Set([
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'lockfile',
])

/**
 * 同步迁移旧版本（<=0.11.2）留在程序安装目录内或由安装器提前暂存的用户数据到标准数据目录。
 * 必须在主进程建立日志、setPath('userData')、打开 workspaces.db 之前调用，
 * 否则新目录会先建出空库和默认配置。
 */
export function migrateLegacyInstallDirSync(
  options: LegacyInstallMigrationOptions
): LegacyInstallMigrationResult {
  const logger = options.logger ?? console
  const installDir = path.resolve(options.installDir)
  const dataDir = path.resolve(options.dataDir)
  const result: LegacyInstallMigrationResult = {
    needed: false,
    migratedFiles: 0,
    skippedFiles: 0,
    archivedLegacy: false,
  }

  if (installDir === dataDir) {
    result.reason = 'same-directory'
    return result
  }

  const markerPath = path.join(dataDir, INSTALL_MIGRATION_MARKER)
  if (fs.existsSync(markerPath)) {
    result.reason = 'already-migrated'
    return result
  }

  const stagedDir = path.join(dataDir, PENDING_LEGACY_MIGRATION_DIR)
  const hasStagedData =
    isDirectorySync(path.join(stagedDir, 'config')) ||
    isDirectorySync(path.join(stagedDir, 'data'))
  const hasLegacyInstallData =
    isDirectorySync(path.join(installDir, 'config')) ||
    isDirectorySync(path.join(installDir, 'data'))
  if (!hasStagedData && !hasLegacyInstallData) {
    result.reason = 'no-legacy-data'
    return result
  }

  result.needed = true
  let hadError = false

  const copyTreeNoOverwrite = (sourceRoot: string, targetRoot: string): void => {
    if (!isDirectorySync(sourceRoot)) return
    fs.mkdirSync(targetRoot, { recursive: true })
    for (const dirent of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (CHROMIUM_LOCK_FILES.has(dirent.name)) continue
      const source = path.join(sourceRoot, dirent.name)
      const target = path.join(targetRoot, dirent.name)
      try {
        if (dirent.isSymbolicLink()) continue
        if (dirent.isDirectory()) {
          copyTreeNoOverwrite(source, target)
          continue
        }
        if (fs.existsSync(target)) {
          result.skippedFiles += 1
          continue
        }
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(source, target)
        result.migratedFiles += 1
      } catch (error) {
        hadError = true
        logger.warn('[Legacy] Failed to copy legacy install-dir file:', source, error)
      }
    }
  }

  const subtrees = ['config', 'data', 'logs', path.join('cache', 'drafts')]
  const sources: string[] = []
  // 若安装目录内仍保留旧数据，其内容必然比安装器提前暂存的副本更新或一致，必须优先于暂存目录合并
  if (hasLegacyInstallData) sources.push(installDir)
  if (hasStagedData) sources.push(stagedDir)

  for (const sourceBase of sources) {
    for (const subtree of subtrees) {
      try {
        copyTreeNoOverwrite(path.join(sourceBase, subtree), path.join(dataDir, subtree))
      } catch (error) {
        hadError = true
        logger.warn('[Legacy] Failed to scan legacy install-dir subtree:', subtree, error)
      }
    }
  }

  if (hadError) {
    result.reason = 'incomplete'
    return result
  }

  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    fs.writeFileSync(
      markerPath,
      JSON.stringify(
        {
          from: hasStagedData ? stagedDir : installDir,
          migratedAt: new Date().toISOString(),
          migratedFiles: result.migratedFiles,
          skippedFiles: result.skippedFiles,
        },
        null,
        2
      ),
      'utf-8'
    )
  } catch (error) {
    logger.warn('[Legacy] Failed to write install-dir migration marker:', error)
    result.reason = 'marker-write-failed'
    return result
  }

  // 合并完成后清理安装器暂存目录
  if (hasStagedData) {
    try {
      fs.rmSync(stagedDir, { recursive: true, force: true })
    } catch (error) {
      logger.warn('[Legacy] Could not remove staged legacy migration directory:', stagedDir, error)
    }
  }

  // 尽力把旧安装目录内的数据目录归档到 .legacy-data-backup，便于用户回退或后续卸载清理；
  // 若安装目录只读则静默跳过，绝不影响启动。
  const backupRoot = path.join(installDir, '.legacy-data-backup')
  let archivedAny = false
  for (const top of ['config', 'data', 'logs', 'cache']) {
    const source = path.join(installDir, top)
    if (!isDirectorySync(source)) continue
    try {
      fs.mkdirSync(backupRoot, { recursive: true })
      const dest = path.join(backupRoot, top)
      if (!fs.existsSync(dest)) {
        fs.renameSync(source, dest)
        archivedAny = true
      }
    } catch (error) {
      logger.warn('[Legacy] Could not archive legacy install-dir folder (leaving in place):', source, error)
    }
  }
  result.archivedLegacy = archivedAny
  logger.info('[Legacy] Migrated legacy install-dir data to standard data directory:', {
    from: hasStagedData ? stagedDir : installDir,
    to: dataDir,
    migratedFiles: result.migratedFiles,
    skippedFiles: result.skippedFiles,
    archivedLegacy: result.archivedLegacy,
  })
  return result
}

function isDirectorySync(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
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
 * 清理旧版本在系统目录留下的多余更新缓存目录（保证全机严格两目录）。
 * 绝不删除 `<appData>/pi-workbench`、当前 userData 或数据目录内的路径。
 */
export async function cleanupLegacySystemPaths(
  options: LegacySystemCleanupOptions
): Promise<string[]> {
  const logger = options.logger ?? console
  const retries = Math.max(1, options.retries ?? 3)
  const delayMs = Math.max(0, options.delayMs ?? 300)
  const targets: string[] = []

  if (options.platform === 'win32') {
    const local = options.localAppDataPath ?? options.appDataPath
    targets.push(path.join(local, 'pi-workbench-updater'))
    targets.push(path.join(local, 'Pi-Workbench-Update'))
    targets.push(path.join(local, 'Pi-Workbench-Update.flag'))
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
