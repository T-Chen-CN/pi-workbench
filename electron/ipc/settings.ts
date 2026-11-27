/** 应用设置读写、权限迁移与 settings IPC */

import * as path from 'path'
import { getAppDir, getBridgeEntryUrl } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.js'
import { refreshTray } from '../tray.js'
import { refreshSystemProxy } from '../system-proxy.js'
import { handleIpc } from './register.js'
import { appSaveSettingsSchema, parseIpcInput } from './schemas.js'

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
  /** 新建 / 首次复用的链接工作树自动后台安装依赖（默认关闭，需用户在设置中主动开启） */
  autoInstallWorktreeDeps: false,
  /** 主进程请求（AI 供应商 / GitHub / 联网搜索）跟随操作系统代理 */
  useSystemProxy: true,
  /** 后台自动跟随 pi.dev 模型目录；PI_OFFLINE=1 时总开关优先关闭（D6） */
  autoRefreshCatalog: true,
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

export interface SettingsIpcOptions {
  onSettingsSaved?: (settings: Record<string, unknown>) => void
}

export function registerSettingsIpc(options?: SettingsIpcOptions): void {
  handleIpc('app:getSettings', async () => {
    try {
      return { success: true, settings: await loadSettingsFile() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('app:saveSettings', async (_event, settings: unknown) => {
    try {
      const parsed = parseIpcInput(appSaveSettingsSchema, settings ?? {})
      if (!parsed.ok) {
        return { success: false, error: parsed.error }
      }
      const sanitized: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(parsed.data)) {
        if (value !== undefined) sanitized[key] = value
      }
      // 权限档位缺失时保留现有值（旧前端不会发送该字段）
      if (!sanitized.permissionLevel) {
        const currentLevel = normalizePermissionLevel(settingsCache.permissionLevel)
        if (currentLevel) sanitized.permissionLevel = currentLevel
      }
      // 缺失时保留现有值，不把旧前端没发过的字段写丢
      for (const key of [
        'closeToTray',
        'autoInstallWorktreeDeps',
        'useSystemProxy',
        'autoRefreshCatalog',
      ] as const) {
        if (typeof sanitized[key] !== 'boolean' && typeof settingsCache[key] === 'boolean') {
          sanitized[key] = settingsCache[key]
        }
      }
      await saveSettingsFile(sanitized)
      updateAppSettingsCache(sanitized)
      // 托盘开关、菜单文案、系统代理与标题栏配色跟随设置即时生效
      refreshTray()
      refreshSystemProxy()
      options?.onSettingsSaved?.(sanitized)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
