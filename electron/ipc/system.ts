/** 终端、插件、自动更新、应用信息、渲染日志与窗口按钮 IPC */

import { app, clipboard, shell, type BrowserWindow } from 'electron'
import { handleIpc } from './register.js'
import {
  clipboardWriteSchema,
  parseIpcInput,
  pluginToggleSchema,
  shellOpenExternalSchema,
  terminalCreateSchema,
  terminalIdSchema,
  terminalListSchema,
  terminalResizeSchema,
  terminalWriteSchema,
} from './schemas.js'
import { getAppDir, getInstallDir, isPortableMode } from '../app-paths.js'
import { isExternalUrl } from '../external-links.js'
import { isTrustedWorkspacePath, canonicalizePath, isPathInsideRoot } from '../workspace-trust.js'
import type { TerminalManager } from '../terminal-manager.js'
import type { PluginManager } from '../plugin-manager.js'
import type { FileLogger, LogLevel } from '../logger.js'
import type { UpdateController, UpdateState } from '../updater.js'

/** 启动后延迟检查，避免和窗口首屏、插件加载抢网络 */
export const UPDATE_CHECK_DELAY_MS = 12_000

/** 启动后的定时检查间隔：12 小时 */
export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000

export interface SystemIpcContext {
  getMainWindow: () => BrowserWindow | null
  terminalManager: TerminalManager
  pluginManager: PluginManager
  getFileLogger: () => FileLogger | null
  getRendererLogger: () => FileLogger | null
  /** 更新安装前确认钩子（Decision 4.A）：取消时返回 false，避免先派生 NSIS 安装器 */
  confirmBeforeUpdateInstall?: () => boolean
  /** 安装未成功触发退出时复位 unload 免弹标记 */
  onUpdateInstallAborted?: () => void
}

let updateController: UpdateController | null = null
let checkUpdatesImpl: (() => Promise<void>) | null = null

/** 更新后首次启动的提示；渲染进程读取一次后清空 */
let pendingUpdateNotice: { from: string; to: string } | null = null

export function setUpdateNotice(notice: { from: string; to: string }): void {
  pendingUpdateNotice = notice
}

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
      const parsed = parseIpcInput(terminalCreateSchema, { workspaceDir, cols, rows, cwd })
      if (!parsed.ok) return { success: false, error: parsed.error }
      if (!isTrustedWorkspacePath(parsed.data.workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const trusted = canonicalizePath(parsed.data.workspaceDir) ?? parsed.data.workspaceDir
      let spawnCwd = trusted
      if (parsed.data.cwd) {
        const target = canonicalizePath(parsed.data.cwd)
        if (!target || !isPathInsideRoot(trusted, target)) {
          return { success: false, error: 'Terminal cwd is outside the workspace' }
        }
        spawnCwd = target
      }
      return context.terminalManager.create(trusted, parsed.data.cols, parsed.data.rows, spawnCwd)
    }
  )

  handleIpc('terminal:write', async (_event, id: string, data: string) => {
    const parsed = parseIpcInput(terminalWriteSchema, { id, data })
    if (!parsed.ok) return { success: false, error: parsed.error }
    return { success: context.terminalManager.write(parsed.data.id, parsed.data.data) }
  })

  handleIpc('terminal:resize', async (_event, id: string, cols: number, rows: number) => {
    const parsed = parseIpcInput(terminalResizeSchema, { id, cols, rows })
    if (!parsed.ok) return { success: false, error: parsed.error }
    return {
      success: context.terminalManager.resize(parsed.data.id, parsed.data.cols, parsed.data.rows),
    }
  })

  handleIpc('terminal:close', async (_event, id: string) => {
    const parsed = parseIpcInput(terminalIdSchema, { id })
    if (!parsed.ok) return { success: false, error: parsed.error }
    return { success: context.terminalManager.close(parsed.data.id) }
  })

  handleIpc('terminal:flush', async (_event, id: string) => {
    const parsed = parseIpcInput(terminalIdSchema, { id })
    if (!parsed.ok) return { success: false, error: parsed.error }
    return { success: context.terminalManager.flushNow(parsed.data.id) }
  })

  handleIpc('terminal:list', async (_event, workspaceDir: string) => {
    const parsed = parseIpcInput(terminalListSchema, { workspaceDir })
    if (!parsed.ok) return { success: false, error: parsed.error }
    if (!isTrustedWorkspacePath(parsed.data.workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const trusted = canonicalizePath(parsed.data.workspaceDir) ?? parsed.data.workspaceDir
    return {
      success: true,
      terminals: context.terminalManager.listForWorkspace(trusted),
    }
  })

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
        const parsed = parseIpcInput(pluginToggleSchema, {
          workspaceDir,
          pluginId,
          enabled: Boolean(enabled),
        })
        if (!parsed.ok) return { success: false, plugins: [], error: parsed.error }
        if (!isTrustedWorkspacePath(parsed.data.workspaceDir)) {
          return { success: false, plugins: [], error: 'Workspace is not approved' }
        }
        return {
          success: true,
          plugins: context.pluginManager.setEnabled(
            parsed.data.workspaceDir,
            parsed.data.pluginId,
            parsed.data.enabled
          ),
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
        installDir: getInstallDir(),
        portable: isPortableMode(),
        emit: sendUpdateState,
        currentVersion: app.getVersion(),
        platform: process.platform,
        supported: true,
        logger: updateLogger,
        confirmBeforeInstall: context.confirmBeforeUpdateInstall,
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
    const result = controller.install()
    if (!result.success) {
      context.onUpdateInstallAborted?.()
    }
    return result
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

  handleIpc('app:consumeUpdateNotice', () => {
    const notice = pendingUpdateNotice
    pendingUpdateNotice = null
    return { success: true, notice }
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
      portable: isPortableMode(),
    },
  }))

  // 重启安装前提示：终端仍在持续输出时认为有任务在运行
  handleIpc('app:hasActiveWork', () => ({
    success: true,
    terminal: context.terminalManager.hasRecentActivity(3000),
  }))

  // ---- 渲染进程日志（按发送方限速 + 单条体积上限，防止渲染异常刷爆磁盘） ----
  const RENDERER_LOG_LEVELS: LogLevel[] = ['INFO', 'WARN', 'ERROR', 'DEBUG']
  const RENDERER_LOG_MAX_PER_SEC = 120
  const RENDERER_LOG_MAX_CHARS = 8192
  const rendererLogBudget = new Map<number, { windowStart: number; count: number; dropped: number }>()

  handleIpc('log:renderer', async (event, level: unknown, args: unknown) => {
    const senderId = event.sender?.id ?? 0
    const now = Date.now()
    let bucket = rendererLogBudget.get(senderId)
    if (!bucket || now - bucket.windowStart >= 1000) {
      if (bucket && bucket.dropped > 0) {
        try {
          context.getRendererLogger()?.write('WARN', [
            `[RendererLog] Dropped ${bucket.dropped} rate-limited log message(s)`,
          ])
        } catch {
          // ignore
        }
      }
      bucket = { windowStart: now, count: 0, dropped: 0 }
      rendererLogBudget.set(senderId, bucket)
    }
    bucket.count += 1
    if (bucket.count > RENDERER_LOG_MAX_PER_SEC) {
      bucket.dropped += 1
      return { success: true }
    }

    const normalized = RENDERER_LOG_LEVELS.includes(String(level).toUpperCase() as LogLevel)
      ? (String(level).toUpperCase() as LogLevel)
      : 'INFO'
    const values = (Array.isArray(args) ? args : [args]).slice(0, 16).map((item) => {
      if (typeof item === 'string' && item.length > RENDERER_LOG_MAX_CHARS) {
        return `${item.slice(0, RENDERER_LOG_MAX_CHARS)}…`
      }
      return item
    })
    try {
      context.getRendererLogger()?.write(normalized, values)
    } catch {
      // 日志失败不影响渲染进程
    }
    return { success: true }
  })

  // ---- 外部链接 ----
  // 自定义协议下 window.open / target=_blank 一律被主窗口拒绝，链接只能走这条通道
  handleIpc('shell:openExternal', async (_event, url: unknown) => {
    const parsed = parseIpcInput(shellOpenExternalSchema, { url })
    if (!parsed.ok || !isExternalUrl(parsed.data.url)) {
      return { success: false, error: 'Unsupported URL' }
    }
    try {
      await shell.openExternal(parsed.data.url)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('clipboard:writeText', async (_event, text: unknown) => {
    const parsed = parseIpcInput(clipboardWriteSchema, {
      text: typeof text === 'string' ? text : '',
    })
    if (!parsed.ok) return { success: false, error: parsed.error }
    try {
      await clipboard.writeText(parsed.data.text)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('app:getAppDir', async () => {
    try {
      return { success: true, appDir: getAppDir() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('app:openDataDir', async () => {
    try {
      const target = getAppDir()
      const errMsg = await shell.openPath(target)
      if (errMsg) return { success: false, error: errMsg }
      return { success: true }
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
