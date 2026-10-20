/**
 * 自动更新（electron-updater）。
 *
 * 只在打包版本中启用；开发模式直接返回“不支持”，避免误触发。
 * 下载由用户显式触发，下载完成后再由用户选择重启安装。
 */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseNotes?: string }
  | { type: 'not-available'; version?: string }
  | { type: 'error'; message: string }
  | { type: 'download-progress'; percent: number; transferred: number; total: number }
  | { type: 'downloaded'; version: string }

export interface UpdateCheckResult {
  success: boolean
  update?: { version: string }
  error?: string
}

export interface UpdateActionResult {
  success: boolean
  error?: string
}

export class UpdateController {
  private initialized = false

  constructor(private readonly emitStatus: (status: UpdateStatus) => void) {}

  get supported(): boolean {
    return app.isPackaged
  }

  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => {
      this.emitStatus({ type: 'checking' })
    })
    autoUpdater.on('update-available', (info) => {
      this.emitStatus({
        type: 'available',
        version: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      })
    })
    autoUpdater.on('update-not-available', (info) => {
      this.emitStatus({ type: 'not-available', version: info?.version })
    })
    autoUpdater.on('error', (error) => {
      this.emitStatus({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    })
    autoUpdater.on('download-progress', (progress) => {
      this.emitStatus({
        type: 'download-progress',
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.emitStatus({ type: 'downloaded', version: info.version })
    })
  }

  async check(): Promise<UpdateCheckResult> {
    if (!this.supported) {
      return { success: false, error: 'Updates are only available in packaged builds.' }
    }
    this.ensureInitialized()
    try {
      const result = await autoUpdater.checkForUpdates()
      const version = result?.updateInfo?.version
      return version ? { success: true, update: { version } } : { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async download(): Promise<UpdateActionResult> {
    if (!this.supported) {
      return { success: false, error: 'Updates are only available in packaged builds.' }
    }
    this.ensureInitialized()
    try {
      await autoUpdater.downloadUpdate()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  install(): UpdateActionResult {
    if (!this.supported) {
      return { success: false, error: 'Updates are only available in packaged builds.' }
    }
    try {
      autoUpdater.quitAndInstall()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
