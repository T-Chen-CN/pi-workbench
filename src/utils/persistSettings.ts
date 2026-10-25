import { api } from '../api'

/**
 * 把 patch 合并进 {appDir}/config/settings.json。
 * 每次保存都会先读磁盘再合并，因此写入必须串行，并发保存会互相覆盖。
 */
let persistQueue: Promise<void> = Promise.resolve()

export function persistAppSettings(patch: Record<string, unknown>): Promise<void> {
  persistQueue = persistQueue.then(async () => {
    try {
      const current = await api.getSettings()
      const settings = current.success && current.settings ? current.settings : {}
      await api.saveSettings({ ...settings, ...patch })
    } catch (error) {
      console.error('Failed to persist settings:', error)
    }
  })
  return persistQueue
}
