import { getAppDir, getInstallDir, isPortableMode, piAgentDir } from './app-paths.js'
import { migrateLegacyInstallDirSync } from './legacy-paths.js'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, screen, session } from 'electron'
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
import { TerminalManager, sanitizeTerminalEnv } from './terminal-manager.js'
import { PluginManager } from './plugin-manager.js'
import { DraftStore } from './draft-store.js'
import { ApprovalBroker } from './approval-broker.js'
import { NotificationRouter, notificationCopy, notificationSummary } from './notifications.js'
import { createWorkspaceStore, importRecentWorkspaces } from './workspace-store.js'
import { canonicalizePath, trustWorkspace } from './workspace-trust.js'
import { configureIpcWindow } from './ipc/register.js'
import { installAuxWindowSupport, registerAuxWindowIpc } from './aux-window.js'
import { appUrl, isAppUrl, registerAppProtocol } from './app-protocol.js'
import { runStartupCacheMaintenance } from './cache-maintenance.js'
import { runLegacyCleanups } from './legacy-cleanup.js'
import {
  destroyTray,
  installTray,
  isTrayReady,
  resolveCloseAction,
  showTrayHintOnce,
  updateTrayBadge
} from './tray.js'
import { installSystemProxy } from './system-proxy.js'
import { createBootWindowController } from './boot-window.js'
import { registerFilesIpc } from './ipc/files.js'
import { registerAttachmentsIpc } from './ipc/attachments.js'
import { registerFileProtocol } from './file-protocol.js'
import { registerSchemePrivileges } from './scheme-privileges.js'
import { registerAgentIpc, type AgentIpcContext } from './ipc/agent.js'
import {
  notifyCloudWorkspacesChanged,
  registerCloudIpc,
  shutdownCloudDeviceAgent,
  startCloudDeviceAgentIfLinked,
  type CloudIpcContext
} from './ipc/cloud.js'
import { registerDocumentsIpc } from './ipc/documents.js'
import { configureRenderBridge } from './documents/render-bridge.js'
import { disposeAllWorkers } from './worker-runner.js'
import { registerGitIpc } from './ipc/git.js'
import { registerRepoMapIpc } from './ipc/repo-map.js'
import { repoSync } from './repo-sync.js'
import { registerWorkspaceIpc, closeAllWorkspaceWatchers } from './ipc/workspace.js'
import { registerProvidersIpc, broadcastAuthEvent } from './ipc/providers.js'
import { createDesktopProvidersConfigStore } from './providers-config.js'
import { configureAuthFlow } from './auth-flow.js'
import { setRunningSessionsProbe } from './providers-service.js'
import {
  initializeWebSearch,
  registerWebSearchIpc
} from './ipc/web-search.js'
import { completeGithubOAuth, isGithubCallbackUrl, GITHUB_PROTOCOL } from './github-oauth.js'
import {
  getAppSettingsCache,
  loadSettingsFile,
  migratePermissionLevel,
  registerSettingsIpc,
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

// 旧版（<=0.11.2）升级到标准两目录模型时，必须在建日志、setPath('userData') 与打开 workspaces.db
// 之前同步把旧安装目录中的用户数据迁入标准数据目录，避免新目录先生成空库和默认设置。
if (app.isPackaged && !isPortableMode()) {
  try {
    migrateLegacyInstallDirSync({
      installDir: getInstallDir(),
      dataDir: getAppDir(),
      logger: console,
    })
  } catch (error) {
    console.error('[Main] Failed to migrate legacy install-dir data:', error)
  }
}

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
/** 更新安装前已向用户完成未保存确认，放行紧随其后的 will-prevent-unload 避免重复弹窗 */
let bypassUnloadPrompt = false

/** 启动期的目录迁移、SQLite 播种与联网配置；最近工作区 IPC 会等它完成 */
let startupReady: Promise<void> = Promise.resolve()

const bootWindow = createBootWindowController({
  getMainWindow: () => mainWindow,
  onBootFinished: () => {
    void ensureAppDirWritable()
  },
})

function resolveTheme(settings: { theme?: unknown }): 'dark' | 'light' {
  if (settings.theme === 'dark') return 'dark'
  if (settings.theme === 'light') return 'light'
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** Windows / Linux 原生 TitleBarOverlay 配色（与 index.css 的 --panel / --ink-muted 严格一致） */
function titleBarOverlayFor(theme: 'dark' | 'light', height: number): {
  color: string
  symbolColor: string
  height: number
} {
  return theme === 'dark'
    ? { color: '#1A1815', symbolColor: '#A8A093', height }
    : { color: '#FBF9F4', symbolColor: '#615C52', height }
}

function syncAllTitleBarOverlays(themeSetting?: unknown): void {
  if (process.platform === 'darwin') return
  const theme = resolveTheme({ theme: themeSetting ?? getAppSettingsCache().theme })
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const height = win === mainWindow ? 45 : 34
    try {
      win.setTitleBarOverlay?.(titleBarOverlayFor(theme, height))
    } catch {
      // 旧平台或测试环境未实现 setTitleBarOverlay 时静默跳过
    }
  }
}

nativeTheme.on?.('updated', () => {
  syncAllTitleBarOverlays()
})

function resolveLanguage(settings: { language?: unknown }): 'zh' | 'en' {
  return settings.language === 'en' || settings.language === 'en-US' ? 'en' : 'zh'
}

ipcMain.on('app:boot-ready', (event) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (event.sender !== mainWindow.webContents) return
  bootWindow.handleReady()
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
// 只允许一个实例：避免两个进程同时写同一份配置和数据库。
// 第二实例（托盘唤回或 GitHub OAuth 自定义协议回调）交由主实例 second-instance 静默处理，不弹错误框。
const singleInstanceLock = typeof app.requestSingleInstanceLock === 'function' ? app.requestSingleInstanceLock() : true
if (!singleInstanceLock) {
  // 退出前必须先落日志：残留实例占着锁时，这是唯一的现场证据
  console.warn('[Boot] Another instance holds the single instance lock; exiting', {
    pid: process.pid,
    argv: process.argv.slice(1)
  })
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
// 配置保存前检查运行中会话：providers-service 不直接持有注册表，由这里注入查询
setRunningSessionsProbe(() => agentRegistry.listRunning().length > 0)
/** settings.json 的内存副本；权限策略随工具调用实时读取 */

/** 桌面通知文案（跟随应用语言）；文案本体在 notifications.ts，本地与云端共用 */
function notificationText() {
  return notificationCopy(getAppSettingsCache().language)
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
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      throw new Error('Main window unavailable for approval')
    }
    mainWindow.webContents.send('agent:approval-request', payload)
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
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
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
  // 复用统一的环境清洗：同时剔除已知供应商 Key 与 PI_WORKBENCH_* 内部凭据（Windows 大小写不敏感）
  envSanitizer: (env) => sanitizeTerminalEnv(env)
})

const pluginManager = new PluginManager({
  stateFilePath: path.join(getAppDir(), 'config', 'workspace-plugins.json'),
  onChanged: (workspaceDir) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('plugins:changed', { workspaceDir })
    }
  }
})

/** 找到文件所属的已加载工作区（用于插件钩子） */
function workspaceForPath(filePath: string): string | null {
  const norm = (value: string) => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const target = norm(filePath)
  for (const workspaceDir of pluginManager.loadedWorkspaces()) {
    const base = norm(workspaceDir)
    if (target === base) return workspaceDir
    const prefix = base.endsWith(path.sep) ? base : base + path.sep
    if (target.startsWith(prefix)) return workspaceDir
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

// 若安装目录只读，模块顶层建库不能直接未捕获崩溃，必须降级到内存替身以让 whenReady 里的 ensureAppDirWritable 正常提示
const workspaceStore = (() => {
  try {
    return createWorkspaceStore(path.join(getAppDir(), 'data', 'workspaces.db'))
  } catch (error) {
    console.error('[Main] Failed to initialize workspaceStore; falling back to in-memory store:', error)
    return {
      recordOpen: () => undefined,
      list: () => [],
      listRecent: () => [],
      remove: () => undefined,
      close: () => undefined,
    }
  }
})()
const draftStore = new DraftStore(path.join(getAppDir(), 'cache', 'drafts'))

registerFilesIpc({
  draftStore,
  onFileSaved: (target) => {
    const workspaceDir = workspaceForPath(target)
    if (workspaceDir) void pluginManager.emit(workspaceDir, 'file:saved', { path: target })
  }
})

const agentIpcContext: AgentIpcContext = {
  agentRegistry,
  approvalBroker,
  pluginManager,
  getMainWindow: () => mainWindow,
  getDefaultPermissionLevel: () => getAppSettingsCache().permissionLevel,
  getLanguage: () => ((getAppSettingsCache().language ?? 'zh') === 'en' ? 'en' : 'zh'),
  logger: agentLogger,
  notificationText,
  notify: (event) => notificationRouter.notify(event)
}

registerAgentIpc(agentIpcContext)

// 供应商登录事件（授权链接 / 设备码 / 需要输入）广播到所有窗口
configureAuthFlow({ emit: broadcastAuthEvent })
registerProvidersIpc()

registerAttachmentsIpc({
  getMainWindow: () => mainWindow,
  getLanguage: () => ((getAppSettingsCache().language ?? 'zh') === 'en' ? 'en' : 'zh')
})

configureRenderBridge({ getMainWindow: () => mainWindow })
registerDocumentsIpc()

registerRepoMapIpc()

registerWorkspaceIpc({
  getMainWindow: () => mainWindow,
  pluginManager,
  terminalManager,
  workspaceStore,
  waitForStartup: () => startupReady,
    onWorkspacesChanged: () => notifyCloudWorkspacesChanged()
})

registerGitIpc({
  agentRegistry,
  getMainWindow: () => mainWindow,
  logger: agentLogger
})

/** 更新安装前确认（Decision 4.A）：必须在 quitAndInstall 派生 NSIS 之前拦截未保存修改或运行中工作 */
function confirmBeforeUpdateInstall(): boolean {
  const hasDrafts = pluginManager.loadedWorkspaces().some((loaded) => {
    const canonical = canonicalizePath(loaded)
    return Boolean(canonical && draftStore.list(canonical).length > 0)
  })
  const hasActiveWork =
    hasDrafts ||
    agentRegistry.listRunning().length > 0 ||
    approvalBroker.pendingCount > 0 ||
    terminalManager.hasRecentActivity(3000)

  if (!hasActiveWork) {
    return true
  }
  if (!mainWindow || mainWindow.isDestroyed() || typeof dialog.showMessageBoxSync !== 'function') {
    bypassUnloadPrompt = true
    return true
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  const zh = app.getLocale?.().toLowerCase().startsWith('zh') ?? true
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: zh ? ['取消', '继续安装'] : ['Cancel', 'Install anyway'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: zh ? '还有未完成的工作' : 'Unfinished work',
    message: zh
      ? '有未保存的修改，或仍有会话 / 审批 / 终端在进行。'
      : 'There are unsaved changes, or sessions, approvals, or terminals are still active.',
    detail: zh
      ? '重启安装更新会丢失未保存的修改，并中止运行中的会话与等待中的审批。'
      : 'Restarting to install the update will discard unsaved changes and stop running sessions and pending approvals.'
  })
  if (choice !== 1) return false
  bypassUnloadPrompt = true
  for (const loaded of pluginManager.loadedWorkspaces()) {
    const canonical = canonicalizePath(loaded)
    if (canonical) draftStore.clear(canonical)
  }
  return true
}

registerSystemIpc({
  getMainWindow: () => mainWindow,
  terminalManager,
  pluginManager,
  getFileLogger: () => fileLogger,
  getRendererLogger: () => rendererLogger,
  confirmBeforeUpdateInstall,
  onUpdateInstallAborted: () => {
    bypassUnloadPrompt = false
  }
})

registerAuxWindowIpc({ getMainWindow: () => mainWindow })

// 主进程同步追踪云端运行中工单数与未读数，即使窗口收进托盘也能刷新角标（F-32 / C-03c）
const cloudTrayTaskStatuses = new Map<string, string>()
let cloudTrayUnreadCount = 0
const CLOUD_ACTIVE_TRAY_STATUSES = new Set(['assigned', 'running', 'waiting_human'])

function syncCloudTrayBadge(): void {
  let runningTasks = 0
  for (const status of cloudTrayTaskStatuses.values()) {
    if (CLOUD_ACTIVE_TRAY_STATUSES.has(status)) runningTasks += 1
  }
  updateTrayBadge({ runningTasks, unreadCount: cloudTrayUnreadCount })
}

function updateCloudTrayFromFrame(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return
  const frame = raw as Record<string, unknown>
  if (frame.type === 'snapshot' && frame.snapshot && typeof frame.snapshot === 'object') {
    const snap = frame.snapshot as Record<string, unknown>
    cloudTrayTaskStatuses.clear()
    if (Array.isArray(snap.tasks)) {
      for (const item of snap.tasks) {
        if (item && typeof item === 'object') {
          const id = String((item as Record<string, unknown>).id ?? '')
          const status = String((item as Record<string, unknown>).status ?? '')
          if (id && status) cloudTrayTaskStatuses.set(id, status)
        }
      }
    }
    cloudTrayUnreadCount =
      typeof snap.unreadCount === 'number' && Number.isFinite(snap.unreadCount)
        ? Math.max(0, Math.floor(snap.unreadCount))
        : 0
    syncCloudTrayBadge()
    return
  }
  if (frame.type === 'event' && frame.event && typeof frame.event === 'object') {
    const event = frame.event as Record<string, unknown>
    if (event.type === 'task' && event.task && typeof event.task === 'object') {
      const task = event.task as Record<string, unknown>
      const id = String(task.id ?? '')
      const status = String(task.status ?? '')
      if (id && status) {
        cloudTrayTaskStatuses.set(id, status)
        syncCloudTrayBadge()
      }
    } else if (event.type === 'read_state') {
      cloudTrayUnreadCount =
        typeof event.unreadCount === 'number' && Number.isFinite(event.unreadCount)
          ? Math.max(0, Math.floor(event.unreadCount))
          : 0
      syncCloudTrayBadge()
    } else if (event.type === 'message_end') {
      const messageId = String(event.messageId ?? '')
      const text = String(event.text ?? '').trim()
      if (!messageId.startsWith('u-') && text) {
        cloudTrayUnreadCount += 1
        syncCloudTrayBadge()
      }
    }
  }
}

const cloudIpcContext: CloudIpcContext = {
  logger: agentLogger,
  listWorkspacePaths: () => workspaceStore.list().map((record) => record.path),
  onStateChange: (state) => {
    if (state.status === 'unlinked') {
      cloudTrayTaskStatuses.clear()
      cloudTrayUnreadCount = 0
      syncCloudTrayBadge()
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('cloud:state', state)
    }
  },
  onClientFrame: (frame) => {
    updateCloudTrayFromFrame(frame)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('cloud:client-frame', frame)
    }
  },
  onClientState: (state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('cloud:client-state', state)
    }
  }
}

registerSettingsIpc({ onSettingsSaved: (saved) => syncAllTitleBarOverlays(saved.theme) })
registerWebSearchIpc()
registerCloudIpc(cloudIpcContext)

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

  // 已移除功能的一次性迁移（幂等，失败不阻断启动）
  runLegacyCleanups(appDir)

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
 * 数据目录不可写时给出明确提示（标准模式为系统用户数据目录，便携模式为程序所在目录）。
 */
async function ensureAppDirWritable(): Promise<void> {
  const dataDir = getAppDir()
  const probePath = path.join(dataDir, '.write-probe')
  let writable = true
  try {
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(probePath, 'ok', 'utf-8')
    await fs.unlink(probePath)
  } catch {
    writable = false
  }
  if (writable) return

  console.error('[Main] Data directory is not writable:', dataDir)
  const zh = app.getLocale?.().toLowerCase().startsWith('zh') ?? true
  const portable = isPortableMode()
  try {
    await dialog.showMessageBox({
      type: 'warning',
      buttons: [zh ? '知道了' : 'OK'],
      defaultId: 0,
      noLink: true,
      title: zh ? '数据目录不可写' : 'Data folder is not writable',
      message: zh
        ? '当前数据目录无法写入，设置、会话和更新都会保存失败。'
        : 'The data folder is not writable; settings, sessions, and updates cannot be saved.',
      detail: portable
        ? zh
          ? `便携目录：${dataDir}\n请把便携版目录移动到当前用户有写权限的位置。`
          : `Portable folder: ${dataDir}\nMove the portable folder to a location your user can write to.`
        : zh
          ? `数据目录：${dataDir}\n请检查当前用户对该目录的写入权限。`
          : `Data folder: ${dataDir}\nCheck that your user account has write permissions for this folder.`
    })
  } catch (error) {
    console.error('[Main] Failed to show data folder warning:', error)
  }
}

function createWindow(settings: { theme?: unknown; language?: unknown }): void {
  const isMac = process.platform === 'darwin'
  const theme = resolveTheme(settings)
  const language = resolveLanguage(settings)
  // 首次启动从小窗开始；macOS 关掉全部窗口再激活时直接进入正常尺寸
  const skipBoot = bootWindow.isCompleted()
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const initialBounds = bootWindow.initialBounds(workArea)

  mainWindow = new BrowserWindow({
    ...initialBounds,
    backgroundColor: theme === 'dark' ? '#141311' : '#F4F1EA',
    resizable: true,
    autoHideMenuBar: true,
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 15 }
        }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: titleBarOverlayFor(theme, 45)
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
        const hasProvidersList = await mainWindow?.webContents.executeJavaScript(
          'typeof window.electronAPI?.providersList'
        )
        console.log(`[Main] Preload check: window.electronAPI = ${apiType}, providersList = ${hasProvidersList}`)
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
    bootWindow.skip()
  } else {
    bootWindow.begin(mainWindow)
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
    bootWindow.reset()
    mainWindow = null
  })

  // 渲染进程 beforeunload 阻止关闭时（未保存修改或运行中的会话 / 审批），
  // Electron 会保持窗口打开但不给用户任何提示；这里用原生对话框把选择权交给用户。
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (bypassUnloadPrompt) {
      bypassUnloadPrompt = false
      for (const loaded of pluginManager.loadedWorkspaces()) {
        const canonical = canonicalizePath(loaded)
        if (canonical) draftStore.clear(canonical)
      }
      event.preventDefault()
      return
    }
    // 必须先暂停退出卡死看门狗，否则用户在阻塞的原生确认框里思考超过 10s 会被强杀并跳过清理
    quitSequencer.cancel()
    // 从托盘退出时窗口是隐藏的，原生确认框必须挂在可见窗口上
    if (!mainWindow.isVisible()) mainWindow.show()
    if (typeof dialog.showMessageBoxSync !== 'function') {
      if (quitting) quitSequencer.handleBeforeQuit()
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
      // 用户明确继续关闭：若处于退出流程则重新武装看门狗；清掉已加载工作区的草稿避免下次又提示恢复
      if (quitting) quitSequencer.handleBeforeQuit()
      for (const loaded of pluginManager.loadedWorkspaces()) {
        const canonical = canonicalizePath(loaded)
        if (canonical) draftStore.clear(canonical)
      }
      event.preventDefault()
    } else {
      // 取消退出：关闭按钮回到「收进托盘」语义，下次点 X 不应该直接退掉
      quitting = false
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

  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL
    let sameDevOrigin = false
    if (devServerUrl) {
      try {
        sameDevOrigin = new URL(url).origin === new URL(devServerUrl).origin
      } catch {
        sameDevOrigin = false
      }
    }
    const allowed = isAppUrl(url) || sameDevOrigin
    if (!allowed) {
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Main] Renderer process gone:', details.reason)
    // 渲染进程崩溃后不再有可能收到 boot-ready，直接结束启动态
    if (mainWindow && !mainWindow.isDestroyed()) bootWindow.finish(mainWindow)
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 是导航被主动中止（重定向等），不是失败
    if (!isMainFrame || errorCode === -3) return
    console.error('[Main] Page failed to load:', errorCode, errorDescription, validatedURL)
    if (mainWindow && !mainWindow.isDestroyed()) bootWindow.finish(mainWindow)
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
  // 默认拒绝所有 Chromium Web 权限请求与权限检查（fail-closed；剪贴板与桌面通知均走主进程受控 API）
  if (session?.defaultSession) {
    session.defaultSession.setPermissionRequestHandler?.((_wc, _permission, callback) => {
      callback(false)
    })
    session.defaultSession.setPermissionCheckHandler?.(() => false)
  }
  // 外壳协议必须在任何 loadURL 之前注册；辅助窗口依赖它拿到同源文档
  registerAppProtocol(path.join(__dirname, '../dist'))
  // 只读文件协议：图片 / 音视频 / PDF / HTML 预览（外网请求按文件弹窗拦截）
  registerFileProtocol({
    getLanguage: () =>
      typeof getAppSettingsCache().language === 'string'
        ? getAppSettingsCache().language
        : undefined,
  })

  // 启动页要尽早出现：只读设置（主题与语言）就建窗，其余初始化与页面加载并行。
  let startupSettings: Record<string, unknown> = {}
  try {
    startupSettings = await loadSettingsFile()
  } catch (error) {
    console.error('[Main] Failed to load settings before window creation:', error)
  }
  setAppSettingsCache(startupSettings)
  // 系统代理包装必须在任何出站请求（云端连接、供应商刷新、Agent、GitHub）之前装好；设置里的开关热生效
  installSystemProxy({
    getEnabled: () => getAppSettingsCache().useSystemProxy !== false
  })
  // 权限迁移会写 settings.json，必须在渲染层读取设置之前完成
  await migratePermissionLevel()
  // 旧 api-config.json → providers.json + 加密凭证（必须在 ready 之后：要读 safeStorage），
  // 早于任何 IPC / Agent 初始化，否则设置页会看到一份空配置
  try {
    const migration = await createDesktopProvidersConfigStore().migrateLegacy()
    if (migration.migrated) {
      console.log('[Main] Provider config migrated:', migration.providerId, migration.modelId)
    }
  } catch (error) {
    console.warn('[Main] Provider config migration failed:', error)
  }
  createWindow(startupSettings)

  // 托盘常驻：紧接建窗装好，否则 Windows 上首次点关闭会因为没有可用的托盘图标
  // 而退回真正退出（见 resolveCloseAction）。设置里的开关会热生效。
  installTray({
    getEnabled: () => getAppSettingsCache().closeToTray !== false,
    getLanguage: () => getAppSettingsCache().language,
    showMainWindow: () => showMainWindow(),
    quit: () => quitApplication(),
    getMainWindow: () => mainWindow
  })

  // SQLite 播种与联网配置不阻塞首屏；最近工作区 IPC 会等它完成。
  startupReady = (async () => {
    await seedTrustedWorkspaces()
    await initializeWebSearch()
    // 已配对才连云端；失败只记日志，不影响应用启动
    await startCloudDeviceAgentIfLinked(cloudIpcContext).catch((error) =>
      console.warn('[Main] Cloud device agent unavailable:', error)
    )
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
        const { isNewerVersion } = await import('./updater.js')
        if (isNewerVersion(currentVersion, previousVersion)) {
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

  // 启动后静默预热 models.dev 独立富数据缓存（受 PI_OFFLINE 与 autoRefreshCatalog 约束，失败静默降级）
  void import('./providers-service.js')
    .then(async ({ isCatalogNetworkAllowed }) => {
      if (!isCatalogNetworkAllowed()) return
      const { refreshModelsDevSnapshot } = await import('./models-dev-store.js')
      await refreshModelsDevSnapshot({ force: false, allowNetwork: true })
    })
    .catch(() => undefined)

  // 启动后延迟异步执行纯自动缓存维护（更新 pending、temp、孤儿草稿），不阻塞首屏也不阻止进程退出
  const cacheMaintenanceTimer = setTimeout(() => {
    void runStartupCacheMaintenance(getAppDir(), { logger: console }).catch((error) =>
      console.warn('[Main] Startup cache maintenance failed:', error)
    )
  }, 5_000)
  cacheMaintenanceTimer.unref?.()

  // 启动后静默检查更新：Windows / Linux 发现新版本会自动下载，但不会自动安装。
  setTimeout(() => {
    void checkForUpdates()
  }, UPDATE_CHECK_DELAY_MS)

  // 长期不关机的用户每 12 小时复查一次；控制器会跳过下载中/已下载等待安装的状态。
  setInterval(() => {
    void checkForUpdates()
  }, UPDATE_CHECK_INTERVAL_MS)
}).catch((error) => {
  console.error('[Main] Startup failed:', error)
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
 * 各步超时之和（7.1s）必须小于 SHUTDOWN_TIMEOUT_MS（7.5s），否则看门狗会提前抢跑。
 */
async function shutdownApplication(): Promise<void> {
  try {
    await runShutdownSteps(
      [
        { name: 'approval-broker', timeoutMs: 400, run: () => approvalBroker.dispose() },
        { name: 'agents', timeoutMs: 1600, run: () => agentRegistry.disposeAll() },
        // 云端工单：先把自己标 interrupted 并冲队列（内部 flush 1.5s），超时必须大于 flush 上限
        {
          name: 'cloud-device',
          timeoutMs: 1800,
          run: () => shutdownCloudDeviceAgent()
        },
        { name: 'worktree-deps', timeoutMs: 400, run: () => disposeAllCoordinators() },
        {
          name: 'workspace-tasks',
          timeoutMs: 400,
          run: async () => {
            closeAllWorkspaceWatchers()
            repoSync.disposeAll()
            await Promise.allSettled([pluginManager.disposeAllAsync(), disposeAllWorkers()])
          }
        },
        { name: 'terminals', timeoutMs: 400, run: () => terminalManager.closeAll() },
        {
          name: 'child-processes',
          timeoutMs: 1500,
          run: async () => {
            // PTY shell、npm install 等子进程的孙进程会绕过 kill()，异步并行收尾整棵树不卡看门狗
            const { killed, failed } = await childRegistry.killAllAsync()
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
  // 托盘常驻已无意义：直接退出（macOS 保留 Dock 行为）。
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
