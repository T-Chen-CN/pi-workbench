import { create } from 'zustand'
import type { PermissionLevel } from '../types/electron'
import {
  DEFAULT_KEYBINDINGS,
  normalizeKeybindings,
  type ShortcutId,
} from '../utils/keybindings'
import {
  DEFAULT_SORT_OPTIONS,
  isExplorerSortBy,
  type ExplorerSortBy,
} from '../utils/fileTree'

export const MIN_AUTO_SAVE_DELAY = 500
export const MAX_AUTO_SAVE_DELAY = 10_000
export const DEFAULT_AUTO_SAVE_DELAY = 2000

/** 任务运行时发送消息的默认处理方式 */
export type RunWhileBusy = 'queue' | 'steer'

export const DEFAULT_RUN_WHILE_BUSY: RunWhileBusy = 'queue'

/** 新会话的默认权限档位；会话创建后自行持有权限 */
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'ask'

/** 关闭主窗口时收进托盘（Linux 上降级为最小化），而不是退出进程 */
export const DEFAULT_CLOSE_TO_TRAY = true

/** 新建 / 首次复用的链接工作树自动后台安装依赖（会执行仓库里的 install 脚本） */
export const DEFAULT_AUTO_INSTALL_WORKTREE_DEPS = true

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === 'readonly' || value === 'ask' || value === 'auto'
}

export interface NotificationPrefs {
  enabled: boolean
  approval: boolean
  complete: boolean
  error: boolean
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  approval: true,
  complete: true,
  error: true,
}

export function normalizeNotificationPrefs(input: unknown): NotificationPrefs {
  const source = (input ?? {}) as Record<string, unknown>
  const result = { ...DEFAULT_NOTIFICATION_PREFS }
  for (const key of ['enabled', 'approval', 'complete', 'error'] as const) {
    if (typeof source[key] === 'boolean') result[key] = source[key] as boolean
  }
  return result
}

export function clampAutoSaveDelay(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTO_SAVE_DELAY
  return Math.min(MAX_AUTO_SAVE_DELAY, Math.max(MIN_AUTO_SAVE_DELAY, Math.round(value)))
}

interface SettingsState {
  autoSave: boolean
  autoSaveDelay: number
  permissionLevel: PermissionLevel
  notifications: NotificationPrefs
  /** 会话成本预算（美元，0 表示不提醒） */
  budgetUsd: number
  runWhileBusy: RunWhileBusy
  keybindings: Record<ShortcutId, string>
  /** 文件树排序方式与开关，持久化到 config/settings.json */
  explorerSortBy: ExplorerSortBy
  explorerFoldersFirst: boolean
  explorerSortReverse: boolean
  /** 关闭按钮：收进托盘 / 直接退出；主进程读取同一字段 */
  closeToTray: boolean
  /** 链接工作树自动安装依赖；主进程读取同一字段 */
  autoInstallWorktreeDeps: boolean
  setAutoSave: (enabled: boolean) => void
  setAutoSaveDelay: (delayMs: number) => void
  setPermissionLevel: (level: PermissionLevel) => void
  setNotificationPrefs: (patch: Partial<NotificationPrefs>) => void
  setBudgetUsd: (value: number) => void
  setRunWhileBusy: (mode: RunWhileBusy) => void
  setKeybinding: (id: ShortcutId, combo: string) => void
  resetKeybindings: () => void
  setExplorerSortBy: (by: ExplorerSortBy) => void
  setExplorerFoldersFirst: (enabled: boolean) => void
  setExplorerSortReverse: (enabled: boolean) => void
  setCloseToTray: (enabled: boolean) => void
  setAutoInstallWorktreeDeps: (enabled: boolean) => void
  hydrate: (settings: {
    autoSave?: unknown
    autoSaveDelay?: unknown
    permissionLevel?: unknown
    notifications?: unknown
    budgetUsd?: unknown
    runWhileBusy?: unknown
    keybindings?: unknown
    explorerSortBy?: unknown
    explorerFoldersFirst?: unknown
    explorerSortReverse?: unknown
    closeToTray?: unknown
    autoInstallWorktreeDeps?: unknown
  }) => void
}

/** 应用级编辑偏好：由 App 从 config/settings.json 载入，Settings 修改后写回 */
export const useSettingsStore = create<SettingsState>((set) => ({
  autoSave: true,
  autoSaveDelay: DEFAULT_AUTO_SAVE_DELAY,
  permissionLevel: DEFAULT_PERMISSION_LEVEL,
  notifications: { ...DEFAULT_NOTIFICATION_PREFS },
  budgetUsd: 0,
  runWhileBusy: DEFAULT_RUN_WHILE_BUSY,
  keybindings: { ...DEFAULT_KEYBINDINGS },
  explorerSortBy: DEFAULT_SORT_OPTIONS.by,
  explorerFoldersFirst: DEFAULT_SORT_OPTIONS.foldersFirst,
  explorerSortReverse: DEFAULT_SORT_OPTIONS.reverse,
  closeToTray: DEFAULT_CLOSE_TO_TRAY,
  autoInstallWorktreeDeps: DEFAULT_AUTO_INSTALL_WORKTREE_DEPS,

  setAutoSave: (enabled) => set({ autoSave: enabled }),

  setAutoSaveDelay: (delayMs) => set({ autoSaveDelay: clampAutoSaveDelay(delayMs) }),

  setPermissionLevel: (level) =>
    set({ permissionLevel: isPermissionLevel(level) ? level : DEFAULT_PERMISSION_LEVEL }),

  setNotificationPrefs: (patch) =>
    set((state) => ({ notifications: { ...state.notifications, ...patch } })),

  setBudgetUsd: (value) =>
    set({ budgetUsd: Number.isFinite(value) ? Math.max(0, value) : 0 }),

  setRunWhileBusy: (mode) => set({ runWhileBusy: mode === 'steer' ? 'steer' : 'queue' }),

  setKeybinding: (id, combo) =>
    set((state) => ({ keybindings: { ...state.keybindings, [id]: combo.toLowerCase() } })),

  resetKeybindings: () => set({ keybindings: { ...DEFAULT_KEYBINDINGS } }),

  setExplorerSortBy: (by) =>
    set({ explorerSortBy: isExplorerSortBy(by) ? by : DEFAULT_SORT_OPTIONS.by }),

  setExplorerFoldersFirst: (enabled) => set({ explorerFoldersFirst: enabled }),

  setExplorerSortReverse: (enabled) => set({ explorerSortReverse: enabled }),

  setCloseToTray: (enabled) => set({ closeToTray: enabled }),

  setAutoInstallWorktreeDeps: (enabled) => set({ autoInstallWorktreeDeps: enabled }),

  hydrate: (settings) =>
    set((state) => ({
      autoSave:
        typeof settings.autoSave === 'boolean' ? settings.autoSave : state.autoSave,
      autoSaveDelay:
        typeof settings.autoSaveDelay === 'number'
          ? clampAutoSaveDelay(settings.autoSaveDelay)
          : state.autoSaveDelay,
      permissionLevel: isPermissionLevel(settings.permissionLevel)
        ? settings.permissionLevel
        : state.permissionLevel,
      notifications:
        settings.notifications === undefined
          ? state.notifications
          : normalizeNotificationPrefs(settings.notifications),
      budgetUsd:
        typeof settings.budgetUsd === 'number' && Number.isFinite(settings.budgetUsd)
          ? Math.max(0, settings.budgetUsd)
          : state.budgetUsd,
      runWhileBusy:
        settings.runWhileBusy === 'steer' || settings.runWhileBusy === 'queue'
          ? settings.runWhileBusy
          : state.runWhileBusy,
      keybindings:
        settings.keybindings === undefined
          ? state.keybindings
          : normalizeKeybindings(settings.keybindings),
      explorerSortBy: isExplorerSortBy(settings.explorerSortBy)
        ? settings.explorerSortBy
        : state.explorerSortBy,
      explorerFoldersFirst:
        typeof settings.explorerFoldersFirst === 'boolean'
          ? settings.explorerFoldersFirst
          : state.explorerFoldersFirst,
      explorerSortReverse:
        typeof settings.explorerSortReverse === 'boolean'
          ? settings.explorerSortReverse
          : state.explorerSortReverse,
      closeToTray:
        typeof settings.closeToTray === 'boolean'
          ? settings.closeToTray
          : state.closeToTray,
      autoInstallWorktreeDeps:
        typeof settings.autoInstallWorktreeDeps === 'boolean'
          ? settings.autoInstallWorktreeDeps
          : state.autoInstallWorktreeDeps,
    })),
}))
