import { create } from 'zustand'
import type { PermissionAction, PermissionPolicy, ToolCategory } from '../types/electron'
import {
  DEFAULT_KEYBINDINGS,
  normalizeKeybindings,
  type ShortcutId,
} from '../utils/keybindings'

export const MIN_AUTO_SAVE_DELAY = 500
export const MAX_AUTO_SAVE_DELAY = 10_000
export const DEFAULT_AUTO_SAVE_DELAY = 2000

/** 任务运行时发送消息的默认处理方式 */
export type RunWhileBusy = 'queue' | 'steer'

export const DEFAULT_RUN_WHILE_BUSY: RunWhileBusy = 'queue'

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  read: 'allow',
  write: 'ask',
  command: 'ask',
  other: 'ask',
}

export const TOOL_CATEGORIES: ToolCategory[] = ['read', 'write', 'command', 'other']

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

export function isPermissionAction(value: unknown): value is PermissionAction {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

export function normalizePermissionPolicy(input: unknown): PermissionPolicy {
  const source = (input ?? {}) as Record<string, unknown>
  const result = { ...DEFAULT_PERMISSION_POLICY }
  for (const category of TOOL_CATEGORIES) {
    const value = source[category]
    if (isPermissionAction(value)) result[category] = value
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
  permissions: PermissionPolicy
  notifications: NotificationPrefs
  /** 会话成本预算（美元，0 表示不提醒） */
  budgetUsd: number
  runWhileBusy: RunWhileBusy
  keybindings: Record<ShortcutId, string>
  setAutoSave: (enabled: boolean) => void
  setAutoSaveDelay: (delayMs: number) => void
  setPermission: (category: ToolCategory, action: PermissionAction) => void
  setNotificationPrefs: (patch: Partial<NotificationPrefs>) => void
  setBudgetUsd: (value: number) => void
  setRunWhileBusy: (mode: RunWhileBusy) => void
  setKeybinding: (id: ShortcutId, combo: string) => void
  resetKeybindings: () => void
  hydrate: (settings: {
    autoSave?: unknown
    autoSaveDelay?: unknown
    permissions?: unknown
    notifications?: unknown
    budgetUsd?: unknown
    runWhileBusy?: unknown
    keybindings?: unknown
  }) => void
}

/** 应用级编辑偏好：由 App 从 config/settings.json 载入，Settings 修改后写回 */
export const useSettingsStore = create<SettingsState>((set) => ({
  autoSave: true,
  autoSaveDelay: DEFAULT_AUTO_SAVE_DELAY,
  permissions: { ...DEFAULT_PERMISSION_POLICY },
  notifications: { ...DEFAULT_NOTIFICATION_PREFS },
  budgetUsd: 0,
  runWhileBusy: DEFAULT_RUN_WHILE_BUSY,
  keybindings: { ...DEFAULT_KEYBINDINGS },

  setAutoSave: (enabled) => set({ autoSave: enabled }),

  setAutoSaveDelay: (delayMs) => set({ autoSaveDelay: clampAutoSaveDelay(delayMs) }),

  setPermission: (category, action) =>
    set((state) => ({ permissions: { ...state.permissions, [category]: action } })),

  setNotificationPrefs: (patch) =>
    set((state) => ({ notifications: { ...state.notifications, ...patch } })),

  setBudgetUsd: (value) =>
    set({ budgetUsd: Number.isFinite(value) ? Math.max(0, value) : 0 }),

  setRunWhileBusy: (mode) => set({ runWhileBusy: mode === 'steer' ? 'steer' : 'queue' }),

  setKeybinding: (id, combo) =>
    set((state) => ({ keybindings: { ...state.keybindings, [id]: combo.toLowerCase() } })),

  resetKeybindings: () => set({ keybindings: { ...DEFAULT_KEYBINDINGS } }),

  hydrate: (settings) =>
    set((state) => ({
      autoSave:
        typeof settings.autoSave === 'boolean' ? settings.autoSave : state.autoSave,
      autoSaveDelay:
        typeof settings.autoSaveDelay === 'number'
          ? clampAutoSaveDelay(settings.autoSaveDelay)
          : state.autoSaveDelay,
      permissions:
        settings.permissions === undefined
          ? state.permissions
          : normalizePermissionPolicy(settings.permissions),
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
    })),
}))
