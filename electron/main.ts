import { getAppDir, piAgentDir } from './app-paths.js'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, screen, type Rectangle } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { mkdirSync } from 'fs'
import { FileLogger, installConsoleTee } from './logger.js'
import { AgentRegistry } from './agent-registry.js'
import { childRegistry } from './child-registry.js'
import { createQuitSequencer, runShutdownSteps } from './shutdown.js'
import { disposeAllCoordinators } from './worktree-coordinator.js'
import { TerminalManager } from './terminal-manager.js'
import { PluginManager } from './plugin-manager.js'
import { DraftStore } from './draft-store.js'
import { ApprovalBroker } from './approval-broker.js'
import { NotificationRouter } from './notifications.js'
import { createWorkspaceStore, importRecentWorkspaces } from './workspace-store.js'
import { canonicalizePath, trustWorkspace } from './workspace-trust.js'
import { configureIpcWindow } from './ipc/register.js'
import { installAuxWindowSupport, registerAuxWindowIpc } from './aux-window.js'
import { appUrl, isAppUrl, registerAppProtocol } from './app-protocol.js'
import {
  destroyTray,
  installTray,
  isTrayReady,
  resolveCloseAction,
  showTrayHintOnce
} from './tray.js'
import { animateBounds, type WindowBounds } from './window-morph.js'
import { registerFilesIpc } from './ipc/files.js'
import { registerAttachmentsIpc } from './ipc/attachments.js'
import { registerFileProtocol } from './file-protocol.js'
import { registerSchemePrivileges } from './scheme-privileges.js'
import { registerAgentIpc } from './ipc/agent.js'
import { registerGitIpc } from './ipc/git.js'
import { repoSync } from './repo-sync.js'
import { registerWorkspaceIpc, closeAllWorkspaceWatchers } from './ipc/workspace.js'
import { getActiveProviderApiKey, setRunningAgentsProvider } from './ipc/api-config.js'
import { WEB_SEARCH_KEY_ENV_PREFIX, initializeWebSearch } from './ipc/web-search.js'
import { completeGithubOAuth, isGithubCallbackUrl, GITHUB_PROTOCOL } from './github-oauth.js'
import {
  getAppSettingsCache,
  loadSettingsFile,
  migratePermissionLevel,
  saveSettingsFile,
  setAppSettingsCache
} from './ipc/settings.js'
import {
  checkForUpdates,
  registerSystemIpc,
  setUpdateNotice,
  UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS
} from './ipc/system.js'
// Lazy load AgentManager to avoid early import errors
// import { AgentManager } from '../pi-bridge/dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 文件日志必须在单实例锁判定之前建立：锁被拒绝时也要能在 main.log 里留下原因，
// 否则用户看到的现象只是「双击没反应」，事后完全无从取证。
let fileLogger: FileLogger | null = null
let rendererLogger: FileLogger | null = null
let agentFileLogger: FileLogger | null = null
const logDir = path.join(getAppDir(), 'logs')
try {
  fileLogger = new FileLogger({ logDir })
  rendererLogger = new FileLogger({ logDir, fileName: 'renderer.log' })
  agentFileLogger = new FileLogger({ logDir, fileName: 'agent.log' })
  // 立刻把 console 接进文件：若等到 ready 再接，锁被拒 / 启动崩在 ready 之前的那句
  // 日志根本落不了盘，事后依旧无法取证。
  installConsoleTee(fileLogger)
} catch (error) {
  console.error('[Main] Failed to enable file logging:', error)
}

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

// 自定义 scheme 的特权必须在 app ready 之前一次声明：外壳（pw-app）与只读文件
// （pw-file）合并在同一次调用里，分开注册会被后者覆盖，媒体流与相对路径都会坏
registerSchemePrivileges()

let mainWindow: BrowserWindow | null = null
configureIpcWindow(() => mainWindow)
/** 真正退出流程已开始：关闭按钮不再收进托盘，窗口正常销毁 */
let quitting = false

/**
 * 启动页：窗口先以 420×260 出现，面板数据就绪后放大到工作台尺寸。
 * 总视觉时长 = 停留（≥600ms）+ 放大（400ms），即最短 1 秒。
 */
const BOOT_WINDOW_WIDTH = 420
const BOOT_WINDOW_HEIGHT = 260
const APP_WINDOW_WIDTH = 1200
const APP_WINDOW_HEIGHT = 800
const BOOT_HOLD_MS = 600
const BOOT_EXPAND_MS = 400
const BOOT_READY_TIMEOUT_MS = 8000

let bootActive = false
let bootStartedAt = 0
let bootReadyAt: number | null = null
let bootExpanded = false
let bootCompleted = false
let bootTimers: ReturnType<typeof setTimeout>[] = []
let expandScheduled = false
let cancelExpandAnimation: (() => void) | null = null

/** 启动期的目录迁移、SQLite 播种与联网配置；最近工作区 IPC 会等它完成 */
let startupReady: Promise<void> = Promise.resolve()

function resolveTheme(settings: { theme?: unknown }): 'dark' | 'light' {
  if (settings.theme === 'dark') return 'dark'
  if (settings.theme === 'light') return 'light'
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function resolveLanguage(settings: { language?: unknown }): 'zh' | 'en' {
  return settings.language === 'en' || settings.language === 'en-US' ? 'en' : 'zh'
}

function centeredWindowBounds(workArea: Rectangle, width: number, height: number): WindowBounds {
  const w = Math.min(width, workArea.width)
  const h = Math.min(height, workArea.height)
  return {
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + (workArea.height - h) / 2),
    width: Math.round(w),
    height: Math.round(h)
  }
}

/** 放大目标以窗口当前中心为准（用户可能拖过小窗），并限制在所在显示器工作区内 */
function expandedWindowBounds(win: BrowserWindow): WindowBounds {
  const current = win.getBounds()
  const workArea = screen.getDisplayMatching(current).workArea
  const width = Math.min(APP_WINDOW_WIDTH, workArea.width)
  const height = Math.min(APP_WINDOW_HEIGHT, workArea.height)
  const centerX = current.x + current.width / 2
  const centerY = current.y + current.height / 2
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
  return {
    x: Math.round(clamp(centerX - width / 2, workArea.x, workArea.x + workArea.width - width)),
    y: Math.round(clamp(centerY - height / 2, workArea.y, workArea.y + workArea.height - height)),
    width: Math.round(width),
    height: Math.round(height)
  }
}

function clearBootTimers(): void {
  for (const timer of bootTimers) clearTimeout(timer)
  bootTimers = []
}

function beginBoot(win: BrowserWindow): void {
  bootActive = true
  bootStartedAt = Date.now()
  bootReadyAt = null
  bootExpanded = false
  expandScheduled = false
  clearBootTimers()
  const fallback = setTimeout(() => {
    if (bootExpanded) return
    console.warn('[Boot] Renderer did not signal ready in time; expanding anyway')
    scheduleExpansion(win)
  }, BOOT_READY_TIMEOUT_MS)
  bootTimers.push(fallback)
}

/** 渲染层启动数据就绪：满足最短停留后开始放大 */
function handleBootReady(): void {
  if (!bootActive || bootExpanded || !mainWindow || mainWindow.isDestroyed()) return
  bootReadyAt = Date.now()
  console.log('[Boot] Renderer ready after', bootReadyAt - bootStartedAt, 'ms')
  scheduleExpansion(mainWindow)
}

function scheduleExpansion(win: BrowserWindow): void {
  if (bootExpanded || expandScheduled || win.isDestroyed()) return
  expandScheduled = true
  const startAt = Math.max(bootStartedAt + BOOT_HOLD_MS, bootReadyAt ?? Date.now())
  const timer = setTimeout(() => startExpansion(win), Math.max(0, startAt - Date.now()))
  bootTimers.push(timer)
}

function startExpansion(win: BrowserWindow): void {
  if (bootExpanded || win.isDestroyed()) return
  const from = win.getBounds()
  const to = expandedWindowBounds(win)
  console.log('[Boot] Expanding window', `${from.width}×${from.height}`, '→', `${to.width}×${to.height}`)
  cancelExpandAnimation = animateBounds({
    from,
    to,
    durationMs: BOOT_EXPAND_MS,
    apply: (bounds) => {
      if (!win.isDestroyed()) win.setBounds(bounds)
    },
    onDone: () => finishBoot(win)
  })
}

function finishBoot(win: BrowserWindow): void {
  if (!bootActive || bootExpanded) return
  bootActive = false
  bootExpanded = true
  bootCompleted = true
  expandScheduled = false
  cancelExpandAnimation = null
  clearBootTimers()
  console.log('[Boot] Window expanded after', Date.now() - bootStartedAt, 'ms')
  if (!win.isDestroyed()) {
    win.setResizable(true)
    if (process.platform === 'darwin') {
      try {
        win.setWindowButtonVisibility(true)
      } catch {
        // 旧版本 macOS / 非 macOS 没有该方法
      }
    }
    try {
      win.webContents.send('app:boot-expanded')
    } catch (error) {
      console.warn('[Boot] Failed to notify renderer:', error)
    }
  }
  // 安装目录不可写的提示等界面就绪后再弹，避免盖住启动页
  if (app.isPackaged && process.platform !== 'darwin') {
    void ensureAppDirWritable()
  }
}

ipcMain.on('app:boot-ready', (event) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (event.sender !== mainWindow.webContents) return
  handleBootReady()
})

// GitHub OAuth 回调使用自定义协议；开发版需要带上脚本参数才能在 Windows 上回到 Electron
try {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(GITHUB_PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
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
/** 系统语言是否中文（ready 之前可用） */
function systemPrefersChinese(): boolean {
  try {
    const first = app.getPreferredSystemLanguages?.()[0] ?? ''
    if (first) return first.toLowerCase().startsWith('zh')
  } catch {
    // 拿不到系统语言时退回英文，宁可文案不地道也不要抢在初始化前报错
  }
  return false
}

/**
 * 单实例锁被拒绝时的提示。
 *
 * 为什么不在 ready 之后弹：ready 一到，模块顶层的 whenReady 回调就会初始化
 * 目录、SQLite、托盘与窗口 —— 第二个进程同样会跑一遗（同一份 userData 与
 * workspaces.db 被两个进程同时写）。`showErrorBox` 是 ready 之前就能用的原生
 * 弹框，弹完立即退出，全程不做任何初始化。
 */
function reportExistingInstance(): void {
  const zh = systemPrefersChinese()
  try {
    dialog.showErrorBox(
      zh ? 'Pi Workbench 已在运行' : 'Pi Workbench is already running',
      zh
        ? '已请求唤回正在运行的窗口。如果窗口没有出现，请检查任务栏或托盘图标；仍找不到时，在任务管理器结束残留的 “Pi Workbench” 进程后再启动。'
        : 'The running window has been brought to the front. If no window appears, check the taskbar or the tray icon. If it is still missing, end any leftover “Pi Workbench” process in Task Manager and start again.'
    )
  } catch (error) {
    // 弹框失败也必须退出，不能因为提示失败多留一个进程
    console.error('[Boot] Failed to show single instance notice:', error)
  }
}

// 只允许一个实例：避免两个进程同时写同一份配置和数据库。
const singleInstanceLock = typeof app.requestSingleInstanceLock === 'function' ? app.requestSingleInstanceLock() : true
if (!singleInstanceLock) {
  // 退出前必须先落日志：残留实例占着锁时，这是唯一的现场证据
  console.warn('[Boot] Another instance holds the single instance lock; exiting', {
    pid: process.pid,
    argv: process.argv.slice(1)
  })
  reportExistingInstance()
  if (typeof app.exit === 'function') app.exit(0)
  else app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    console.log('[Main] Second instance started; focusing main window')
    const callbackUrl = argv.find((arg) => isGithubCallbackUrl(arg))
    if (callbackUrl) void handleGithubCallback(callbackUrl)
    // 清理进行中不再唤回：窗口正在销毁，唤回会打断退出并让退出卡死
    if (quitSequencer.isShuttingDown()) return
    // 窗口可能已被销毁（启动期 / 退出中途），showMainWindow 会重建
    showMainWindow()
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
// 配置保存前检查运行中会话：api-config 不直接持有注册表，由这里注入查询
setRunningAgentsProvider(() => agentRegistry.listRunning())
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
        sessionId: payload.sessionId
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
    warn: (message) => console.warn(message)
  },
  // 退出前 / 退出中都不投递：退出时 abort 会话会走 error 分支，不拦就是误报
  () => quitting || quitSequencer.isShuttingDown()
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
      body: `${payload.toolName} · ${notificationSummary(payload.summary)}`
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
  debug: (...args: unknown[]) => agentFileLogger?.write('DEBUG', args)
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
  logPathFor: (workspaceDir, terminalId) => path.join(workspaceDir, '.pi-workbench', `terminal-${terminalId}.log`),
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
  }
})

const pluginManager = new PluginManager({
  onChanged: (workspaceDir) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('plugins:changed', { workspaceDir })
    }
  }
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
      const candidates = Array.isArray(recent) ? recent.filter((item): item is string => typeof item === 'string') : []
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
  }
})

registerAgentIpc({
  agentRegistry,
  approvalBroker,
  pluginManager,
  getMainWindow: () => mainWindow,
  getDefaultPermissionLevel: () => getAppSettingsCache().permissionLevel,
  getLanguage: () => ((getAppSettingsCache().language ?? 'zh') === 'en' ? 'en' : 'zh'),
  logger: agentLogger,
  notificationText,
  notify: (event) => notificationRouter.notify(event)
})

registerAttachmentsIpc({
  getMainWindow: () => mainWindow,
  getLanguage: () => ((getAppSettingsCache().language ?? 'zh') === 'en' ? 'en' : 'zh')
})

registerWorkspaceIpc({
  getMainWindow: () => mainWindow,
  pluginManager,
  terminalManager,
  workspaceStore,
  waitForStartup: () => startupReady
})

registerGitIpc({
  agentRegistry,
  getMainWindow: () => mainWindow,
  logger: agentLogger
})

registerSystemIpc({
  getMainWindow: () => mainWindow,
  terminalManager,
  pluginManager,
  getFileLogger: () => fileLogger,
  getRendererLogger: () => rendererLogger
})

registerAuxWindowIpc({ getMainWindow: () => mainWindow })

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
        : `Location: ${getAppDir()}\nUninstall and reinstall into a folder your user can write to (for example Programs under your home folder), or move the app to a writable location.`
    })
  } catch (error) {
    console.error('[Main] Failed to show install folder warning:', error)
  }
}

function createWindow(settings: { theme?: unknown; language?: unknown }): void {
  const isMac = process.platform === 'darwin'
  const theme = resolveTheme(settings)
  const language = resolveLanguage(settings)
  // 首次启动从小窗开始；macOS 关掉全部窗口再激活时直接进入正常尺寸
  const skipBoot = bootCompleted
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const initialBounds = skipBoot
    ? centeredWindowBounds(workArea, APP_WINDOW_WIDTH, APP_WINDOW_HEIGHT)
    : centeredWindowBounds(workArea, BOOT_WINDOW_WIDTH, BOOT_WINDOW_HEIGHT)

  mainWindow = new BrowserWindow({
    ...initialBounds,
    backgroundColor: theme === 'dark' ? '#141311' : '#F4F1EA',
    resizable: skipBoot,
    autoHideMenuBar: true,
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 15 }
        }
      : {
          frame: false
        }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    icon: path.join(__dirname, '../app-icon.png')
  })

  // Windows/Linux：隐藏默认菜单栏，但保留菜单角色提供的快捷键
  if (!isMac) {
    mainWindow.setMenuBarVisibility(false)
  }

  // 启动页期间隐藏 macOS 红绿灯：小窗里没有可用的标题栏布局
  if (isMac && !skipBoot) {
    try {
      mainWindow.setWindowButtonVisibility(false)
    } catch {
      // 旧版本 macOS 没有该方法
    }
  }

  // 通知渲染进程最大化状态，用于自绘窗口按钮的图标切换
  const sendMaximizedState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', {
        host: 'main',
        maximized: mainWindow.isMaximized()
      })
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

  // Load the app：主题与语言随 URL 传入，启动页在首帧之前就能用上
  const query: Record<string, string> = { theme, lang: language }
  if (skipBoot) query.boot = '0'
  if (process.env.VITE_DEV_SERVER_URL) {
    const devUrl = new URL(process.env.VITE_DEV_SERVER_URL)
    for (const [key, value] of Object.entries(query)) devUrl.searchParams.set(key, value)
    void mainWindow.loadURL(devUrl.toString())
    mainWindow.webContents.openDevTools()
  } else {
    void mainWindow.loadURL(appUrl('/index.html', query))
  }

  if (skipBoot) {
    bootActive = false
    expandScheduled = false
    clearBootTimers()
    cancelExpandAnimation?.()
    cancelExpandAnimation = null
  } else {
    beginBoot(mainWindow)
  }

  mainWindow.webContents.on('did-finish-load', () => {
    flushGithubAuthResult()
  })

  // 关闭按钮 = 收进托盘（设置里可改回直接退出）。收进托盘不拦未保存确认：
  // 窗口只是隐藏，Agent / 终端 / 文件监听与更新定时器继续运行；
  // 真退出只走托盘菜单「退出」或系统级退出（`quitting` 在 before-quit 置位）。
  mainWindow.on('close', (event) => {
    const action = resolveCloseAction({
      closeToTray: getAppSettingsCache().closeToTray !== false,
      quitting,
      trayReady: isTrayReady()
    })
    if (action === 'close') return
    event.preventDefault()
    if (action === 'minimize') {
      mainWindow?.minimize()
      return
    }
    mainWindow?.hide()
    // Windows 首次收起时用托盘气泡说明一次，避免误以为应用被退出了
    showTrayHintOnce()
  })

  mainWindow.on('closed', () => {
    // 启动动画与兜底定时器不能留到窗口销毁之后
    clearBootTimers()
    cancelExpandAnimation?.()
    cancelExpandAnimation = null
    expandScheduled = false
    bootActive = false
    mainWindow = null
  })

  // 渲染进程 beforeunload 阻止关闭时（未保存修改或运行中的会话 / 审批），
  // Electron 会保持窗口打开但不给用户任何提示；这里用原生对话框把选择权交给用户。
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    // 从托盘退出时窗口是隐藏的，原生确认框必须挂在可见窗口上
    if (!mainWindow.isVisible()) mainWindow.show()
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
        : 'Closing will discard unsaved changes and stop running sessions and pending approvals.'
    })
    if (choice === 1) {
      // 用户明确继续关闭：清掉已加载工作区的草稿，避免下次启动又提示恢复
      for (const loaded of pluginManager.loadedWorkspaces()) {
        const canonical = canonicalizePath(loaded)
        if (canonical) draftStore.clear(canonical)
      }
      event.preventDefault()
    } else {
      // 取消退出：关闭按钮回到「收进托盘」语义，下次点 X 不应该直接退掉
      quitting = false
      // 撤掉 before-quit 武装的看门狗，否则它会在这个被取消的退出里强制结束进程
      quitSequencer.cancel()
    }
  })

  // 面板辅助窗口：只放行 about:blank + pi-panel: 前缀的 window.open
  installAuxWindowSupport(mainWindow, {
    onClosed: (frameName) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('aux:window-closed', frameName)
      }
    }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL
    const allowed = isAppUrl(url) || url.startsWith('file://') || (devServerUrl ? url.startsWith(devServerUrl) : false)
    if (!allowed) {
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Main] Renderer process gone:', details.reason)
    // 渲染进程崩溃后不再有可能收到 boot-ready，直接结束启动态
    if (mainWindow && !mainWindow.isDestroyed()) finishBoot(mainWindow)
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 是导航被主动中止（重定向等），不是失败
    if (!isMainFrame || errorCode === -3) return
    console.error('[Main] Page failed to load:', errorCode, errorDescription, validatedURL)
    if (mainWindow && !mainWindow.isDestroyed()) finishBoot(mainWindow)
  })
}

app.whenReady().then(async () => {
  // 第二个实例只负责提示后退出：绝不能继续初始化目录 / SQLite / 托盘
  if (!singleInstanceLock) return
  // 日志器在单实例锁判定之前已建立并接管了 console（见文件顶部），这里只确认一声
  if (fileLogger) {
    console.log('[Main] File logging enabled:', fileLogger.filePath)
    console.log('[Main] Agent logging enabled:', agentFileLogger?.filePath ?? '(unavailable)')
  } else {
    console.warn('[Main] File logging unavailable; log directory is not writable')
  }

  await initAppDirectories()
  // 外壳协议必须在任何 loadURL 之前注册；辅助窗口依赖它拿到同源文档
  registerAppProtocol(path.join(__dirname, '../dist'))
  // 只读文件协议：图片 / 音视频 / PDF / HTML 预览
  registerFileProtocol()

  // 启动页要尽早出现：只读设置（主题与语言）就建窗，其余初始化与页面加载并行。
  let startupSettings: Record<string, any> = {}
  try {
    startupSettings = await loadSettingsFile()
  } catch (error) {
    console.error('[Main] Failed to load settings before window creation:', error)
  }
  setAppSettingsCache(startupSettings)
  // 权限迁移会写 settings.json，必须在渲染层读取设置之前完成
  await migratePermissionLevel()
  createWindow(startupSettings)

  // 托盘常驻：紧接建窗装好，否则 Windows 上首次点关闭会因为没有可用的托盘图标
  // 而退回真正退出（见 resolveCloseAction）。设置里的开关会热生效。
  installTray({
    getEnabled: () => getAppSettingsCache().closeToTray !== false,
    getLanguage: () => getAppSettingsCache().language,
    showMainWindow: () => showMainWindow(),
    quit: () => quitApplication()
  })

  // SQLite 播种与联网配置不阻塞首屏；最近工作区 IPC 会等它完成。
  startupReady = (async () => {
    await seedTrustedWorkspaces()
    await initializeWebSearch()
  })()
  void startupReady.catch((error) => console.warn('[Main] Startup preparation failed:', error))

  // 更新后首次启动：让系统重建图标与桌面菜单缓存（三平台各自实现，失败只记日志）。
  // 与 Windows 安装器里的 SHChangeNotify / ie4uinit 互为兜底。
  // 同时记录版本变化，供渲染进程提示“已更新到 vX”。
  if (app.isPackaged) {
    try {
      const { refreshShellCachesIfUpdated } = await import('./shell-refresh.js')
      const { previousVersion } = refreshShellCachesIfUpdated()
      const currentVersion = app.getVersion()
      if (previousVersion && previousVersion !== currentVersion) {
        const isNewer = (next: string, now: string) => next.localeCompare(now, undefined, { numeric: true }) > 0
        if (isNewer(currentVersion, previousVersion)) {
          setUpdateNotice({ from: previousVersion, to: currentVersion })
        }
      }
    } catch (error) {
      console.warn('[Main] Shell cache refresh failed:', error)
    }
  }

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
        logger: console
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
          logger: console
        })
      )
      .catch((error) => console.warn('[Main] Update cache cleanup failed:', error))
  }

  const initialGithubCallback = process.argv.find((arg) => isGithubCallbackUrl(arg))
  if (initialGithubCallback) void handleGithubCallback(initialGithubCallback)

  // 启动后静默检查更新：Windows / Linux 发现新版本会自动下载，但不会自动安装。
  setTimeout(() => {
    void checkForUpdates()
  }, UPDATE_CHECK_DELAY_MS)

  // 长期不关机的用户每 12 小时复查一次；控制器会跳过下载中/已下载等待安装的状态。
  setInterval(() => {
    void checkForUpdates()
  }, UPDATE_CHECK_INTERVAL_MS)
})

/** 从托盘 / 第二实例 / Dock 唤回主窗口：还原尺寸、显示并聚焦 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(getAppSettingsCache())
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 唯一真退出入口：托盘菜单「退出」/ 系统级退出（Cmd+Q、关机）也走这里 */
function quitApplication(): void {
  quitting = true
  app.quit()
}

/**
 * 退出清理。
 *
 * 顺序按依赖反序：先停审批与 Agent（可能还在写会话 / 数据库），再收工作树
 * 依赖安装与监听，然后关终端与子进程，最后关数据库。托盘放在最后销毁：
 * 清理一旦变慢，用户还能从托盘重新触发退出，而不是只能开任务管理器。
 *
 * 每一步都带超时；超时只记警告并继续，真正的兜底是 shutdown.ts 里的看门狗。
 * 各步超时之和（5.9s）必须小于 SHUTDOWN_TIMEOUT_MS（6s），否则看门狗会提前抢跑。
 */
async function shutdownApplication(): Promise<void> {
  try {
    await runShutdownSteps(
      [
        { name: 'approval-broker', timeoutMs: 400, run: () => approvalBroker.dispose() },
        { name: 'agents', timeoutMs: 2000, run: () => agentRegistry.disposeAll() },
        { name: 'worktree-deps', timeoutMs: 400, run: () => disposeAllCoordinators() },
        {
          name: 'workspace-tasks',
          timeoutMs: 400,
          run: () => {
            closeAllWorkspaceWatchers()
            repoSync.disposeAll()
            pluginManager.disposeAll()
          }
        },
        { name: 'terminals', timeoutMs: 400, run: () => terminalManager.closeAll() },
        {
          name: 'child-processes',
          timeoutMs: 1500,
          run: () => {
            // PTY shell、npm install 等子进程的孙进程会绕过 kill()，这里收尾整棵树
            const { killed, failed } = childRegistry.killAll()
            if (killed > 0 || failed > 0) {
              console.log(`[Shutdown] child processes: killed=${killed} failed=${failed}`)
            }
          }
        },
        { name: 'workspace-store', timeoutMs: 400, run: () => workspaceStore.close() },
        { name: 'tray', timeoutMs: 400, run: () => destroyTray() }
      ],
      { logger: console }
    )
  } catch (error) {
    console.error('[Main] Shutdown cleanup failed:', error)
  } finally {
    console.log('[Main] Shutdown complete')
    fileLogger?.close()
    rendererLogger?.close()
    agentFileLogger?.close()
  }
}

// 退出流程的兜底：清理卡住 / 渲染层不回应时强制 exit，避免留下握着单实例锁的僵尸进程
const quitSequencer = createQuitSequencer({
  app,
  shutdown: shutdownApplication,
  logger: console
})

// 退出顺序：先让窗口完成 beforeunload / will-prevent-unload 的未保存确认，
// 所有窗口真正关闭后再在 will-quit 里做异步清理，避免用户取消关闭时资源已被释放。
app.on('before-quit', () => {
  quitting = true
  quitSequencer.handleBeforeQuit()
})

app.on('will-quit', (event) => {
  quitSequencer.handleWillQuit(event)
})

app.on('window-all-closed', () => {
  // 收进托盘时窗口只是隐藏，不会走到这里；走到这里说明主窗口真的关了，
  // 托盘常驻也没有意义，和以前一样退出（macOS 保留 Dock 行为）。
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 回到窗口时补一次远端同步（受最小间隔限制）
app.on('browser-window-focus', () => {
  repoSync.touchAll()
})

app.on('activate', () => {
  // macOS：Dock 图标被点击时，隐藏的主窗口要能回来
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow(getAppSettingsCache())
    return
  }
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    showMainWindow()
  }
})

// IPC Handlers
