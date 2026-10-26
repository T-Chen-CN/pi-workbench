import { getAppDir, piAgentDir } from './app-paths.js'
import {
  app,
  BrowserWindow,
  dialog,
  Notification,
} from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { mkdirSync } from 'fs'
import { FileLogger, installConsoleTee } from './logger.js'
import { AgentRegistry } from './agent-registry.js'
import { TerminalManager } from './terminal-manager.js'
import { PluginManager } from './plugin-manager.js'
import { DraftStore } from './draft-store.js'
import { ApprovalBroker } from './approval-broker.js'
import { NotificationRouter } from './notifications.js'
import { createWorkspaceStore, importRecentWorkspaces } from './workspace-store.js'
import { canonicalizePath, trustWorkspace } from './workspace-trust.js'
import { configureIpcWindow } from './ipc/register.js'
import { registerFilesIpc } from './ipc/files.js'
import { registerAgentIpc } from './ipc/agent.js'
import { registerGitIpc } from './ipc/git.js'
import { registerWorkspaceIpc, closeAllWorkspaceWatchers } from './ipc/workspace.js'
import { getActiveProviderApiKey } from './ipc/api-config.js'
import {
  WEB_SEARCH_KEY_ENV_PREFIX,
  initializeWebSearch,
} from './ipc/web-search.js'
import {
  completeGithubOAuth,
  isGithubCallbackUrl,
  GITHUB_PROTOCOL,
} from './github-oauth.js'
import {
  getAppSettingsCache,
  loadSettingsFile,
  migratePermissionLevel,
  saveSettingsFile,
  setAppSettingsCache,
} from './ipc/settings.js'
import {
  checkForUpdates,
  registerSystemIpc,
  UPDATE_CHECK_DELAY_MS,
} from './ipc/system.js'
// Lazy load AgentManager to avoid early import errors
// import { AgentManager } from '../pi-bridge/dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Chromium 的 profile 与单实例锁都必须落在应用目录。
// app.setPath('userData') 必须早于 requestSingleInstanceLock：否则单实例锁会在
// Electron 默认 userData（%APPDATA%\pi-workbench）下创建目录和锁文件。
const userDataDir = path.join(getAppDir(), 'data', 'profile')
try {
  mkdirSync(userDataDir, { recursive: true })
} catch {
  // 目录创建失败时仍让 Electron 使用默认路径，避免启动失败
}
app.setPath('userData', userDataDir)

let mainWindow: BrowserWindow | null = null
configureIpcWindow(() => mainWindow)

// GitHub OAuth 回调使用自定义协议；开发版需要带上脚本参数才能在 Windows 上回到 Electron
try {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(GITHUB_PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ])
  } else {
    app.setAsDefaultProtocolClient(GITHUB_PROTOCOL)
  }
} catch (error) {
  console.warn('[Main] Failed to register GitHub OAuth protocol:', error)
}

let pendingGithubAuthResult: Awaited<ReturnType<typeof completeGithubOAuth>> | null = null

function flushGithubAuthResult(): void {
  if (!pendingGithubAuthResult) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.webContents.isLoading()) return
  mainWindow.webContents.send('github:auth:complete', pendingGithubAuthResult)
  pendingGithubAuthResult = null
}

async function handleGithubCallback(url: string): Promise<void> {
  if (!isGithubCallbackUrl(url)) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  const result = await completeGithubOAuth(url)
  pendingGithubAuthResult = result
  flushGithubAuthResult()
}

app.on('open-url', (event, url) => {
  if (!isGithubCallbackUrl(url)) return
  event.preventDefault()
  void handleGithubCallback(url)
})
/** 每个被监听的工作区一个 watcher；切换工作区不再挤掉其他工作区 */
// 只允许一个实例：避免两个进程同时写同一份配置和数据库。
const singleInstanceLock =
  typeof app.requestSingleInstanceLock === 'function' ? app.requestSingleInstanceLock() : true
if (!singleInstanceLock) {
  // 立即退出，避免第二个进程继续打开数据库或执行队列
  if (typeof app.exit === 'function') {
    app.exit(0)
  } else {
    app.quit()
  }
} else {
  app.on('second-instance', (_event, argv) => {
    const callbackUrl = argv.find((arg) => isGithubCallbackUrl(arg))
    if (callbackUrl) void handleGithubCallback(callbackUrl)
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

// Windows 通知需要 AppUserModelID；开发版没有安装快捷方式，用可执行文件路径兜底，
// 否则 Notification 会被系统静默丢弃。
if (process.platform === 'win32') {
  try {
    app.setAppUserModelId(app.isPackaged ? 'com.piworkbench.app' : process.execPath)
  } catch (error) {
    console.warn('[Main] Failed to set AppUserModelId:', error)
  }
}

/** 每个打开的工作区一个 Agent 实例 */
const agentRegistry = new AgentRegistry()
let fileLogger: FileLogger | null = null
let rendererLogger: FileLogger | null = null
let agentFileLogger: FileLogger | null = null
/** settings.json 的内存副本；权限策略随工具调用实时读取 */

/** 桌面通知文案（跟随应用语言） */
function notificationText() {
  const zh = (getAppSettingsCache().language ?? 'zh') !== 'en'
  return zh
    ? { approval: '需要审批', complete: '会话已完成', error: '会话运行失败' }
    : { approval: 'Approval required', complete: 'Session finished', error: 'Session failed' }
}

/** 通知里只放一行短摘要，避免把完整命令（可能含密钥）显示在锁屏上 */
function notificationSummary(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > 120 ? `${single.slice(0, 117)}…` : single
}

/** 正在显示的系统通知；必须保持引用，否则对象被 GC 后 click 事件不会触发 */
const activeNotifications = new Set<Notification>()

/** 桌面通知：仅应用不在前台时发送；点击回到对应工作区与会话 */
const notificationRouter = new NotificationRouter(
  (payload) => {
    if (!Notification.isSupported()) {
      console.warn('[Notifications] Notification.isSupported() = false; skipping')
      return
    }
    const notification = new Notification({ title: payload.title, body: payload.body })
    activeNotifications.add(notification)
    const cleanup = () => {
      activeNotifications.delete(notification)
    }
    notification.on('close', cleanup)
    notification.on('failed', (_event, error) => {
      cleanup()
      console.warn('[Notifications] Notification failed:', error)
    })
    notification.on('click', () => {
      cleanup()
      console.log('[Notifications] notification clicked')
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      if (typeof mainWindow.moveTop === 'function') mainWindow.moveTop()
      mainWindow.focus()
      // Windows 对后台进程抢前台有限制：短暂置顶再取消可把窗口带到前台
      if (process.platform === 'win32') {
        mainWindow.setAlwaysOnTop(true)
        mainWindow.setAlwaysOnTop(false)
        mainWindow.focus()
      }
      mainWindow.webContents.send('app:notify-click', {
        workspaceDir: payload.workspaceDir,
        sessionId: payload.sessionId,
      })
      setTimeout(() => {
        console.log('[Notifications] focus after click:', mainWindow?.isFocused())
      }, 300)
    })
    notification.show()
  },
  () => getAppSettingsCache().notifications,
  () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
  {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
  }
)

/** 工具审批：挂起 Agent 的工具调用，等待渲染层响应或超时 */
const approvalBroker = new ApprovalBroker(
  (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:approval-request', payload)
    }
    const text = notificationText()
    notificationRouter.notify({
      kind: 'approval',
      workspaceDir: payload.workspaceDir,
      sessionId: payload.sessionId,
      title: text.approval,
      body: `${payload.toolName} · ${notificationSummary(payload.summary)}`,
    })
  },
  (resolution) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:approval-resolved', resolution)
    }
  }
)

/** Agent 日志出口（延迟解析，文件日志在 app ready 后才创建） */
const agentLogger = {
  info: (...args: unknown[]) => agentFileLogger?.write('INFO', args),
  warn: (...args: unknown[]) => agentFileLogger?.write('WARN', args),
  error: (...args: unknown[]) => agentFileLogger?.write('ERROR', args),
  debug: (...args: unknown[]) => agentFileLogger?.write('DEBUG', args),
}

const requireFromMain = createRequire(import.meta.url)
let ptyModule: typeof import('node-pty') | null = null

/** 当前生效的供应商 Key（用于终端环境过滤，避免连用户自己的同名 Key 一起删掉） */
/** node-pty 是原生模块，延迟加载：加载失败不应阻止应用启动 */
function loadPty(): typeof import('node-pty') {
  if (!ptyModule) {
    ptyModule = requireFromMain('node-pty') as typeof import('node-pty')
  }
  return ptyModule
}

const terminalManager = new TerminalManager({
  spawn: (shell, args, options) => loadPty().spawn(shell, args, options),
  onData: (id, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', { id, data })
    }
  },
  onExit: (id, exitCode) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', { id, exitCode })
    }
  },
  logPathFor: (workspaceDir, terminalId) =>
    path.join(workspaceDir, '.pi-workbench', `terminal-${terminalId}.log`),
  // 只移除应用自己注入的供应商 Key；用户 shell 里同名的其他 Key 保持不变
  envSanitizer: (env) => {
    const sanitized = { ...env }
    delete sanitized.PI_WORKBENCH_API_KEY
    for (const name of Object.keys(sanitized)) {
      if (name.startsWith(WEB_SEARCH_KEY_ENV_PREFIX)) delete sanitized[name]
    }
    const activeKey = getActiveProviderApiKey()
    if (activeKey) {
      for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
        if (sanitized[key] === activeKey) {
          delete sanitized[key]
        }
      }
    }
    return sanitized
  },
})

const pluginManager = new PluginManager({
  onChanged: (workspaceDir) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('plugins:changed', { workspaceDir })
    }
  },
})

/** 找到文件所属的已加载工作区（用于插件钩子） */
function workspaceForPath(filePath: string): string | null {
  for (const workspaceDir of pluginManager.loadedWorkspaces()) {
    if (filePath === workspaceDir) return workspaceDir
    const prefix = workspaceDir.endsWith(path.sep) ? workspaceDir : workspaceDir + path.sep
    if (filePath.startsWith(prefix)) return workspaceDir
  }
  return null
}

/** 启动时从 SQLite 恢复信任；旧版 settings.recentWorkspaces 一次性迁入后删除 */
async function seedTrustedWorkspaces(): Promise<void> {
  try {
    let records = workspaceStore.list()
    if (records.length === 0) {
      const settings = await loadSettingsFile()
      const recent: unknown = settings.recentWorkspaces
      const candidates = Array.isArray(recent)
        ? recent.filter((item): item is string => typeof item === 'string')
        : []
      if (candidates.length > 0) {
        const trusted: string[] = []
        for (const workspacePath of candidates) {
          if (trustWorkspace(workspacePath)) trusted.push(workspacePath)
        }
        importRecentWorkspaces(workspaceStore, trusted)
        const next = { ...settings }
        delete next.recentWorkspaces
        const cache = { ...getAppSettingsCache(), ...next }
        delete cache.recentWorkspaces
        setAppSettingsCache(cache)
        await saveSettingsFile(next)
        records = workspaceStore.list()
      }
    }
    for (const record of records) trustWorkspace(record.path)
  } catch (error) {
    console.warn('[Main] Failed to seed trusted workspaces:', error)
  }
}

const workspaceStore = createWorkspaceStore(path.join(getAppDir(), 'data', 'workspaces.db'))
const draftStore = new DraftStore(path.join(getAppDir(), 'cache', 'drafts'))

registerFilesIpc({
  draftStore,
  onFileSaved: (target) => {
    const workspaceDir = workspaceForPath(target)
    if (workspaceDir) void pluginManager.emit(workspaceDir, 'file:saved', { path: target })
  },
})

registerAgentIpc({
  agentRegistry,
  approvalBroker,
  pluginManager,
  getMainWindow: () => mainWindow,
  getDefaultPermissionLevel: () => getAppSettingsCache().permissionLevel,
  logger: agentLogger,
  notificationText,
  notify: (event) => notificationRouter.notify(event),
})

registerWorkspaceIpc({
  getMainWindow: () => mainWindow,
  pluginManager,
  terminalManager,
  workspaceStore,
})

registerGitIpc({
  agentRegistry,
  getMainWindow: () => mainWindow,
  logger: agentLogger,
})

registerSystemIpc({
  getMainWindow: () => mainWindow,
  terminalManager,
  pluginManager,
  getFileLogger: () => fileLogger,
  getRendererLogger: () => rendererLogger,
})


// 初始化应用目录结构
async function initAppDirectories() {
  const appDir = getAppDir()

  const dirs = [
    path.join(appDir, 'config'),
    path.join(appDir, 'cache'),
    path.join(appDir, 'cache', 'temp'),
    path.join(appDir, 'data'),
    path.join(appDir, 'logs')
  ]

  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch (error) {
      console.error(`Failed to create directory ${dir}:`, error)
    }
  }

  // 检查点功能已移除：清理旧版本留下的快照数据
  try {
    await fs.rm(path.join(appDir, 'data', 'checkpoints'), { recursive: true, force: true })
  } catch (error) {
    console.error('Failed to remove legacy checkpoint data:', error)
  }

  console.log('应用目录已初始化:', appDir)
}

/** electron-updater 在不同平台的默认缓存基目录（用于清理旧版本残留） */
function resolveSystemCachePath(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA ?? app.getPath('appData')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches')
  }
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache')
}

/**
 * 安装目录不可写时给出明确提示。
 * 应用把 config / data / logs / 更新缓存都放在安装目录；装到 Program Files
 * 这类位置时写入会失败，用户会误以为设置没保存。
 */
async function ensureAppDirWritable(): Promise<void> {
  const probePath = path.join(getAppDir(), '.write-probe')
  let writable = true
  try {
    await fs.writeFile(probePath, 'ok', 'utf-8')
    await fs.unlink(probePath)
  } catch {
    writable = false
  }
  if (writable) return

  console.error('[Main] App directory is not writable:', getAppDir())
  const zh = app.getLocale?.().toLowerCase().startsWith('zh') ?? true
  try {
    await dialog.showMessageBox({
      type: 'warning',
      buttons: [zh ? '知道了' : 'OK'],
      defaultId: 0,
      noLink: true,
      title: zh ? '安装目录不可写' : 'Install folder is not writable',
      message: zh
        ? '当前安装目录无法写入，设置、会话和更新都会保存失败。'
        : 'The install folder is not writable; settings, sessions, and updates cannot be saved.',
      detail: zh
        ? `安装位置：${getAppDir()}\n请卸载后重新安装到用户可写目录（例如用户文件夹下的 Programs），或把应用移动到有写权限的位置。`
        : `Location: ${getAppDir()}\nUninstall and reinstall into a folder your user can write to (for example Programs under your home folder), or move the app to a writable location.`,
    })
  } catch (error) {
    console.error('[Main] Failed to show install folder warning:', error)
  }
}

function createWindow() {
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#F4F1EA',
    autoHideMenuBar: true,
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 15 },
        }
      : {
          frame: false,
        }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    icon: path.join(__dirname, '../app-icon.png'),
  })

  // Windows/Linux：隐藏默认菜单栏，但保留菜单角色提供的快捷键
  if (!isMac) {
    mainWindow.setMenuBarVisibility(false)
  }

  // 通知渲染进程最大化状态，用于自绘窗口按钮的图标切换
  const sendMaximizedState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', sendMaximizedState)
  mainWindow.on('unmaximize', sendMaximizedState)

  // 如果 preload 加载失败，明确报错（否则 window.electronAPI 会静默缺失）
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[Main] Preload script failed to load:', preloadPath)
    console.error('[Main] Preload error:', error)
  })

  // 开发模式自检：确认 preload 已成功暴露 electronAPI
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const apiType = await mainWindow?.webContents.executeJavaScript('typeof window.electronAPI')
        const hasFetchModels = await mainWindow?.webContents.executeJavaScript(
          'typeof window.electronAPI?.apiConfigFetchModels'
        )
        console.log(`[Main] Preload check: window.electronAPI = ${apiType}, apiConfigFetchModels = ${hasFetchModels}`)
      } catch (error) {
        console.error('[Main] Preload check failed:', error)
      }
    })
  }

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.webContents.on('did-finish-load', () => {
    flushGithubAuthResult()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 渲染进程 beforeunload 阻止关闭时（未保存修改或运行中的会话 / 审批），
  // Electron 会保持窗口打开但不给用户任何提示；这里用原生对话框把选择权交给用户。
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (typeof dialog.showMessageBoxSync !== 'function') {
      event.preventDefault()
      return
    }
    const zh = app.getLocale?.().toLowerCase().startsWith('zh') ?? true
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: zh ? ['取消', '继续关闭'] : ['Cancel', 'Close anyway'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: zh ? '还有未完成的工作' : 'Unfinished work',
      message: zh
        ? '有未保存的修改，或仍有会话 / 审批在进行。'
        : 'There are unsaved changes, or sessions or approvals are still running.',
      detail: zh
        ? '关闭窗口会丢失未保存的修改，并中止运行中的会话与等待中的审批。'
        : 'Closing will discard unsaved changes and stop running sessions and pending approvals.',
    })
    if (choice === 1) {
      // 用户明确继续关闭：清掉已加载工作区的草稿，避免下次启动又提示恢复
      for (const loaded of pluginManager.loadedWorkspaces()) {
        const canonical = canonicalizePath(loaded)
        if (canonical) draftStore.clear(canonical)
      }
      event.preventDefault()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL
    const allowed =
      url.startsWith('file://') || (devServerUrl ? url.startsWith(devServerUrl) : false)
    if (!allowed) {
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Main] Renderer process gone:', details.reason)
  })
}

app.whenReady().then(async () => {
  // 先启用文件日志，后续初始化与 Agent 日志都会落盘（打包后没有控制台）
  try {
    fileLogger = new FileLogger({ logDir: path.join(getAppDir(), 'logs') })
    rendererLogger = new FileLogger({
      logDir: path.join(getAppDir(), 'logs'),
      fileName: 'renderer.log',
    })
    agentFileLogger = new FileLogger({
      logDir: path.join(getAppDir(), 'logs'),
      fileName: 'agent.log',
    })
    installConsoleTee(fileLogger)
    console.log('[Main] File logging enabled:', fileLogger.filePath)
    console.log('[Main] Agent logging enabled:', agentFileLogger.filePath)
  } catch (error) {
    console.error('[Main] Failed to enable file logging:', error)
  }

  await initAppDirectories()

  // 回收旧版本遗留在系统目录中的内容：Pi SDK 的 ~/.pi、默认 userData、安装器副本。
  // 只在打包版执行；迁移/清理都是幂等的，失败只记日志。
  if (app.isPackaged) {
    void (async () => {
      const { migratePiAgentHome, cleanupLegacySystemPaths } = await import('./legacy-paths.js')
      migratePiAgentHome({ homeDir: os.homedir(), agentDir: piAgentDir, logger: console })
      await cleanupLegacySystemPaths({
        appDir: getAppDir(),
        platform: process.platform,
        appDataPath: app.getPath('appData'),
        userDataPath: app.getPath('userData'),
        localAppDataPath: process.env.LOCALAPPDATA,
        cachePath: resolveSystemCachePath(),
        logger: console,
      })
    })().catch((error) => console.warn('[Main] Legacy path cleanup failed:', error))
  }

  // 安装完成后的首次启动：安装器已写入标记，清空安装目录之外的更新缓存。
  // 安装器可能仍在退出、文件暂时被占用，清理内部会重试，失败则留给下次启动。
  if (app.isPackaged) {
    void import('./updater.js')
      .then(({ cleanupCompletedUpdateCache }) =>
        cleanupCompletedUpdateCache({
          appDir: getAppDir(),
          platform: process.platform,
          logger: console,
        })
      )
      .catch((error) => console.warn('[Main] Update cache cleanup failed:', error))
  }

  setAppSettingsCache(await loadSettingsFile())
  await migratePermissionLevel()
  await seedTrustedWorkspaces()
  // 联网搜索是应用基础能力：启动时把配置落到 Agent 目录并注入 Key 环境变量
  await initializeWebSearch()
  createWindow()

  const initialGithubCallback = process.argv.find((arg) => isGithubCallbackUrl(arg))
  if (initialGithubCallback) void handleGithubCallback(initialGithubCallback)

  // Windows / Linux 的配置、数据和更新缓存都写在安装目录：安装到 Program Files
  // 这类只读位置时提前告知，避免用户以为设置没有保存。
  if (app.isPackaged && process.platform !== 'darwin') {
    void ensureAppDirWritable()
  }

  // 启动后静默检查更新：Windows / Linux 发现新版本会自动下载，但不会自动安装。
  setTimeout(() => {
    void checkForUpdates()
  }, UPDATE_CHECK_DELAY_MS)
})

let shuttingDown = false

/** 退出前等待异步资源释放，避免在任务仍写库时关闭 store */
async function shutdownApplication(): Promise<void> {
  try {
    closeAllWorkspaceWatchers()
    terminalManager.closeAll()
    pluginManager.disposeAll()
    approvalBroker.dispose()
    workspaceStore.close()
    await Promise.allSettled([agentRegistry.disposeAll()])
  } catch (error) {
    console.error('[Main] Shutdown cleanup failed:', error)
  } finally {
    console.log('[Main] Shutdown complete')
    fileLogger?.close()
    rendererLogger?.close()
    agentFileLogger?.close()
  }
}

// 退出顺序：先让窗口完成 beforeunload / will-prevent-unload 的未保存确认，
// 所有窗口真正关闭后再在 will-quit 里做异步清理，避免用户取消关闭时资源已被释放。
app.on('will-quit', (event) => {
  if (shuttingDown) return
  event.preventDefault()
  shuttingDown = true
  void shutdownApplication().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// IPC Handlers
