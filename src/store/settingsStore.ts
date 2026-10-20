import { create } from 'zustand'

export const MIN_AUTO_SAVE_DELAY = 500
export const MAX_AUTO_SAVE_DELAY = 10_000
export const DEFAULT_AUTO_SAVE_DELAY = 2000

export function clampAutoSaveDelay(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTO_SAVE_DELAY
  return Math.min(MAX_AUTO_SAVE_DELAY, Math.max(MIN_AUTO_SAVE_DELAY, Math.round(value)))
}

interface SettingsState {
  autoSave: boolean
  autoSaveDelay: number
  setAutoSave: (enabled: boolean) => void
  setAutoSaveDelay: (delayMs: number) => void
  hydrate: (settings: { autoSave?: unknown; autoSaveDelay?: unknown }) => void
}

/** 应用级编辑偏好：由 App 从 config/settings.json 载入，Settings 修改后写回 */
export const useSettingsStore = create<SettingsState>((set) => ({
  autoSave: true,
  autoSaveDelay: DEFAULT_AUTO_SAVE_DELAY,

  setAutoSave: (enabled) => set({ autoSave: enabled }),

  setAutoSaveDelay: (delayMs) => set({ autoSaveDelay: clampAutoSaveDelay(delayMs) }),

  hydrate: (settings) =>
    set((state) => ({
      autoSave:
        typeof settings.autoSave === 'boolean' ? settings.autoSave : state.autoSave,
      autoSaveDelay:
        typeof settings.autoSaveDelay === 'number'
          ? clampAutoSaveDelay(settings.autoSaveDelay)
          : state.autoSaveDelay,
    })),
}))
