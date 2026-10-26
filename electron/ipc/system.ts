/** 终端、插件、自动更新、应用信息、渲染日志与窗口按钮 IPC */

import { app, type BrowserWindow } from 'electron'
import { handleIpc } from './register.js'
import { getAppDir } from '../app-paths.js'
import { isTrustedWorkspacePath, canonicalizePath, isPathInsideRoot } from '../workspace-trust.js'
import type { TerminalManager } from '../terminal-manager.js'
import type { PluginManager } from '../plugin-manager.js'
import type { FileLogger, LogLevel } from '../logger.js'
import type { UpdateController, UpdateState } from '../updater.js'

/** 启动后延迟检查，避免和窗口首屏、插件加载抢网络 */
export const UPDATE_CHECK_DELAY_MS = 12_000

export interface SystemIpcContext {
  getMainWindow: () => BrowserWindow | null
  terminalManager: TerminalManager
  pluginManager: PluginManager
  getFileLogger: () => FileLogger | null
  getRendererLogger: () => FileLogger | null
}

let updateController: UpdateController | null = null
let checkUpdatesImpl: (() => Promise<void>) | null = null

/** 启动后延迟调用；未注册 IPC 或未打包时为空操作 */
export async function checkForUpdates(): Promise<void> {
  await checkUpdatesImpl?.()
}

export function registerSystemIpc(context: SystemIpcContext): void {
  const mainWindow = () => context.getMainWindow()

  // ---- 终端（PTY） ----
  handleIpc(
    'terminal:create',
    async (_event, workspaceDir: string, cols: number, rows: number, cwd?: string) => {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const trusted = canonicalizePath(workspaceDir) ?? workspaceDir
      let spawnCwd = trusted
      if (typeof cwd === 'string' && cwd) {
        const target = canonicalizePath(cwd)
        if (!target || !isPathInsideRoot(trusted, target)) {
          return { success: false, error: 'Terminal cwd is outside the workspace' }
        }
        spawnCwd = target
      }
      return context.terminalManager.create(trusted, cols, rows, spawnCwd)
    }
  )

  handleIpc('terminal:write', async (_event, id: string, data: string) => ({
    success: context.terminalManager.write(id, data),
  }))

  handleIpc('terminal:resize', async (_event, id: string, cols: number, rows: number) => ({
    success: context.terminalManager.resize(id, cols, rows),
  }))

  handleIpc('terminal:close', async (_event, id: string) => ({
    success: context.terminalManager.close(id),
  }))

  handleIpc('terminal:flush', async (_event, id: string) => ({
    success: context.terminalManager.flushNow(id),
  }))

  // ---- 工作台插件 ----
  handleIpc('plugins:list', async (_event, workspaceDir: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, plugins: [], error: 'Workspace is not approved' }
      }
      return { success: true, plugins: context.pluginManager.list(workspaceDir) }
    } catch (error) {
      return {
        success: false,
        plugins: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  handleIpc('plugins:invoke', async (_event, workspaceDir: string, commandId: string, args?: unknown) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      return await context.pluginManager.invoke(workspaceDir, commandId, args)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('plugins:reload', async (_event, workspaceDir: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, plugins: [], error: 'Workspace is not approved' }
      }
      return { success: true, plugins: context.pluginManager.reload(workspaceDir) }
    } catch (error) {
      return {
        success: false,
        plugins: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  handleIpc(
    'plugins:setEnabled',
    async (_event, workspaceDir: string, pluginId: string, enabled: unknown) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, plugins: [], error: 'Workspace is not approved' }
        }
        return {
          success: true,
          plugins: context.pluginManager.setEnabled(workspaceDir, pluginId, Boolean(enabled)),
        }
      } catch (error) {
        return {
          success: false,
          plugins: [],
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
  )

  // ---- 自动更新 ----
  const unsupportedUpdateState = (): UpdateState => ({
    status: 'unsupported',
    currentVersion: app.getVersion(),
    platform: process.platform,
    canAutoInstall: false,
  })

  const sendUpdateState = (state: UpdateState): void => {
    const win = mainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:status', state)
    }
  }

  const updateLogger = {
    info: (...args: unknown[]) => context.getFileLogger()?.write('INFO', args),
    warn: (...args: unknown[]) => context.getFileLogger()?.write('WARN', args),
    error: (...args: unknown[]) => context.getFileLogger()?.write('ERROR', args),
  }

  /** electron-updater 只在打包版本有意义；懒加载避免开发/测试环境引入其运行时 */
  const ensureUpdateController = async (): Promise<UpdateController | null> => {
    if (!app.isPackaged) return null
    if (updateController) return updateController
    try {
      const { UpdateController: Controller } = await import('../updater.js')
      updateController = new Controller({
        appDir: getAppDir(),
        emit: sendUpdateState,
        currentVersion: app.getVersion(),
        platform: process.platform,
        supported: true,
        logger: updateLogger,
      })
      return updateController
    } catch (error) {
      console.error('[Main] Failed to initialize auto updater:', error)
      return null
    }
  }

  handleIpc('update:check', async () => {
    const controller = await ensureUpdateController()
    if (!controller) {
      return {
        success: false,
        state: unsupportedUpdateState(),
        error: 'ERR_UPDATE_NOT_PACKAGED',
      }
    }
    return controller.check()
  })

  handleIpc('update:download', async () => {
    const controller = await ensureUpdateController()
    if (!controller) return { success: false, error: 'ERR_UPDATE_NOT_PACKAGED' }
    return controller.download()
  })

  handleIpc('update:install', async () => {
    const controller = await ensureUpdateController()
    if (!controller) return { success: false, error: 'ERR_UPDATE_NOT_PACKAGED' }
    return controller.install()
  })

  handleIpc('update:getState', async () => {
    const controller = await ensureUpdateController()
    if (!controller) return { success: true, state: unsupportedUpdateState() }
    return { success: true, state: controller.getState() }
  })

  handleIpc('update:openDownload', async () => {
    const controller = await ensureUpdateController()
    if (!controller) return { success: false, error: 'ERR_UPDATE_NOT_PACKAGED' }
    return controller.openDownloadPage()
  })

  checkUpdatesImpl = async () => {
    const controller = await ensureUpdateController()
    await controller?.check()
  }

  handleIpc('app:getInfo', () => ({
    success: true,
    info: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      appDir: getAppDir(),
    },
  }))

  // 重启安装前提示：终端仍在持续输出时认为有任务在运行
  handleIpc('app:hasActiveWork', () => ({
    success: true,
    terminal: context.terminalManager.hasRecentActivity(3000),
  }))

  // ---- 渲染进程日志 ----
  const RENDERER_LOG_LEVELS: LogLevel[] = ['INFO', 'WARN', 'ERROR', 'DEBUG']
  handleIpc('log:renderer', async (_event, level: unknown, args: unknown) => {
    const normalized = RENDERER_LOG_LEVELS.includes(String(level).toUpperCase() as LogLevel)
      ? (String(level).toUpperCase() as LogLevel)
      : 'INFO'
    const values = Array.isArray(args) ? args : [args]
    try {
      context.getRendererLogger()?.write(normalized, values)
    } catch {
      // 日志失败不影响渲染进程
    }
    return { success: true }
  })

  handleIpc('app:getAppDir', async () => {
    try {
      return { success: true, appDir: getAppDir() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // ---- 自绘窗口按钮（Windows / Linux；macOS 保留原生红绿灯） ----
  handleIpc('window:minimize', () => {
    mainWindow()?.minimize()
    return { success: true }
  })

  handleIpc('window:toggleMaximize', () => {
    const win = mainWindow()
    if (!win || win.isDestroyed()) {
      return { success: false, maximized: false }
    }
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
    return { success: true, maximized: win.isMaximized() }
  })

  handleIpc('window:close', () => {
    mainWindow()?.close()
    return { success: true }
  })

  handleIpc('window:isMaximized', () => ({
    success: true,
    maximized: mainWindow()?.isMaximized() ?? false,
  }))
}
