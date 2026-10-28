/** 应用设置读写、权限迁移与 settings IPC */

import * as path from 'path'
import { getAppDir, getBridgeEntryUrl } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.js'
import { refreshTray } from '../tray.js'
import { handleIpc } from './register.js'

const DEFAULT_SETTINGS = {
  language: 'zh',
  theme: 'light',
  autoSave: true,
  autoSaveDelay: 2000,
  runWhileBusy: 'queue',
  /** 新会话的默认权限档位；会话创建后自行持有权限，不再受此值影响 */
  permissionLevel: 'ask',
  explorerSortBy: 'name',
  explorerFoldersFirst: true,
  explorerSortReverse: false,
  /** 关闭主窗口时收进托盘而不是退出；Linux 降级为最小化 */
  closeToTray: true,
}

let settingsCache: Record<string, any> = {}

export function getAppSettingsCache(): Record<string, any> {
  return settingsCache
}

export function setAppSettingsCache(next: Record<string, any>): void {
  settingsCache = next
}

export function updateAppSettingsCache(patch: Record<string, any>): void {
  settingsCache = { ...settingsCache, ...patch }
}

export async function loadSettingsFile(): Promise<any> {
  const settingsPath = path.join(getAppDir(), 'config', 'settings.json')
  const result = readJsonWithBackup<Record<string, unknown>>(settingsPath)
  if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    if (result.source === 'backup') {
      console.warn('[Main] settings.json was unreadable; loaded backup copy')
    }
    return { ...DEFAULT_SETTINGS, ...result.data }
  }
  if (result.error) {
    console.warn('[Main] Failed to read settings.json:', result.error)
  }
  return { ...DEFAULT_SETTINGS }
}

export async function saveSettingsFile(settings: any): Promise<void> {
  const settingsPath = path.join(getAppDir(), 'config', 'settings.json')
  await writeJsonAtomic(settingsPath, settings)
}

export function normalizePermissionLevel(value: unknown): 'readonly' | 'ask' | 'auto' | null {
  return value === 'readonly' || value === 'ask' || value === 'auto' ? value : null
}

/**
 * 旧版 settings.json 只有 permissions 四类对象。启动时一次性迁移为 permissionLevel：
 * 取不宽于旧策略的最宽松档位，迁移只会变严不会变松。之后旧字段保留但不再读取。
 */
export async function migratePermissionLevel(): Promise<void> {
  const settingsPath = path.join(getAppDir(), 'config', 'settings.json')
  const result = readJsonWithBackup<Record<string, unknown>>(settingsPath)
  const raw = result.data
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  if (normalizePermissionLevel(raw.permissionLevel)) return

  let level: 'readonly' | 'ask' | 'auto' = 'ask'
  try {
    const { derivePermissionLevelFromPolicy } = await import(getBridgeEntryUrl())
    if (raw.permissions && typeof raw.permissions === 'object') {
      level = derivePermissionLevelFromPolicy(raw.permissions)
    }
  } catch (error) {
    console.warn('[Main] Failed to derive legacy permission level:', error)
  }

  try {
    const next = { ...raw, permissionLevel: level }
    await saveSettingsFile(next)
    updateAppSettingsCache({ permissionLevel: level })
    console.log('[Main] Migrated permission level:', level)
  } catch (error) {
    console.error('[Main] Failed to persist migrated permission level:', error)
    updateAppSettingsCache({ permissionLevel: level })
  }
}

handleIpc('app:getSettings', async () => {
  try {
    return { success: true, settings: await loadSettingsFile() }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('app:saveSettings', async (_event, settings: any) => {
  try {
    const sanitized = { ...(settings ?? {}) }
    // 最近工作区由主进程的 SQLite 独占管理，渲染层不再保存该字段
    delete sanitized.recentWorkspaces
    // 权限档位只接受三个合法值；缺失时保留现有值（旧前端不会发送该字段）
    const level = normalizePermissionLevel(sanitized.permissionLevel)
    if (level) {
      sanitized.permissionLevel = level
    } else {
      const currentLevel = normalizePermissionLevel(settingsCache.permissionLevel)
      if (currentLevel) sanitized.permissionLevel = currentLevel
      else delete sanitized.permissionLevel
    }
    // 文件树排序：只接受已知排序键与布尔开关，非法值落回默认
    if (sanitized.explorerSortBy !== 'name' && sanitized.explorerSortBy !== 'type') {
      delete sanitized.explorerSortBy
    }
    for (const key of ['explorerFoldersFirst', 'explorerSortReverse'] as const) {
      if (typeof sanitized[key] !== 'boolean') delete sanitized[key]
    }
    // 关闭按钮行为：缺失时保留现有值，不把旧前端没发过的字段写丢
    if (typeof sanitized.closeToTray !== 'boolean') {
      if (typeof settingsCache.closeToTray === 'boolean') {
        sanitized.closeToTray = settingsCache.closeToTray
      } else {
        delete sanitized.closeToTray
      }
    }
    await saveSettingsFile(sanitized)
    updateAppSettingsCache(sanitized)
    // 托盘开关与菜单文案跟随设置即时生效
    refreshTray()
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})
