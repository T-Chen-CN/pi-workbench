import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  Notification,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'
import { existsSync, mkdirSync, realpathSync, statSync, watch, type FSWatcher } from 'fs'
import { isIgnoredWatchPath } from './watch-filter.js'
import { WatchBatcher } from './watch-batcher.js'
import { FileLogger, installConsoleTee, type LogLevel } from './logger.js'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-json.js'
import { AgentRegistry } from './agent-registry.js'
import { TerminalManager } from './terminal-manager.js'
import { PluginManager } from './plugin-manager.js'
import { DraftStore } from './draft-store.js'
import type { UpdateController, UpdateState } from './updater.js'
import { ApprovalBroker, sanitizeApprovalDecision } from './approval-broker.js'
import { NotificationRouter } from './notifications.js'
import { createWorkspaceStore } from './workspace-store.js'
// Lazy load AgentManager to avoid early import errors
// import { AgentManager } from '../pi-bridge/dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
/** 每个被监听的工作区一个 watcher；切换工作区不再挤掉其他工作区 */
interface WorkspaceWatchEntry {
  watcher: FSWatcher
  batcher: WatchBatcher
}
const workspaceWatchers = new Map<string, WorkspaceWatchEntry>()

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
  app.on('second-instance', () => {
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
let appSettingsCache: Record<string, any> = {}

/** 桌面通知文案（跟随应用语言） */
function notificationText() {
  const zh = (appSettingsCache.language ?? 'zh') !== 'en'
  return zh
    ? { approval: '需要审批', complete: '会话已完成', error: '会话运行失败' }
    : { approval: 'Approval required', complete: 'Session finished', error: 'Session failed' }
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
  () => appSettingsCache.notifications,
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
      body: `${payload.toolName} · ${payload.summary}`,
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
let activeProviderApiKey = ''

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
    if (activeProviderApiKey) {
      for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
        if (sanitized[key] === activeProviderApiKey) {
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

/** 用户明确批准过的工作区根（realpath 规范化后的小写形式，Windows 大小写不敏感） */
const trustedWorkspaceRoots = new Set<string>()

function normalizeForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** realpath 规范化；目标尚不存在时向上找到最近的已存在祖先再拼回剩余路径（覆盖多级新建） */
function canonicalizePath(targetPath: string): string | null {
  if (typeof targetPath !== 'string' || !targetPath) return null

  let current = path.resolve(targetPath)
  const missingSegments: string[] = []

  for (let depth = 0; depth < 64; depth++) {
    try {
      const resolved = realpathSync.native(current)
      return missingSegments.length > 0
        ? path.join(resolved, ...missingSegments.reverse())
        : resolved
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return null
      missingSegments.push(path.basename(current))
      current = parent
    }
  }

  return null
}

/**
 * 判断 target 是否位于 root 内。使用 path.relative 而不是字符串前缀比较，
 * 避免 C:\foo 与 C:\foobar 这类前缀误判，也能正确处理符号链接解析后的路径。
 */
function isPathInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(normalizeForComparison(root), normalizeForComparison(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** 登记用户通过原生目录选择器批准的工作区根 */
function trustWorkspace(targetPath: string): string | null {
  const canonical = canonicalizePath(targetPath)
  if (!canonical) return null
  try {
    if (!statSync(canonical).isDirectory()) return null
  } catch {
    return null
  }
  trustedWorkspaceRoots.add(normalizeForComparison(canonical))
  return canonical
}

function isTrustedWorkspacePath(targetPath: string): boolean {
  const canonical = canonicalizePath(targetPath)
  return canonical !== null && trustedWorkspaceRoots.has(normalizeForComparison(canonical))
}

/** 文件写删改操作允许的范围：受信任工作区与应用缓存目录 */
function resolveAllowedFileTarget(targetPath: string): string | null {
  const target = canonicalizePath(targetPath)
  if (!target) return null

  const roots = [...trustedWorkspaceRoots]
  const cacheRoot = canonicalizePath(path.join(getAppDir(), 'cache'))
  if (cacheRoot) roots.push(normalizeForComparison(cacheRoot))

  return roots.some((root) => isPathInsideRoot(root, target)) ? target : null
}

/** 受保护的应用/工作区根目录：允许操作其中内容，但不允许删除或改名根本身 */
function isProtectedRoot(canonicalPath: string): boolean {
  const normalized = normalizeForComparison(canonicalPath)
  if (trustedWorkspaceRoots.has(normalized)) return true
  const cacheRoot = canonicalizePath(path.join(getAppDir(), 'cache'))
  return cacheRoot !== null && normalizeForComparison(cacheRoot) === normalized
}

function workspaceWatchKey(workspacePath: string): string {
  return normalizeForComparison(canonicalizePath(workspacePath) ?? path.resolve(workspacePath))
}

function closeWorkspaceWatcher(workspacePath: string): void {
  const key = workspaceWatchKey(workspacePath)
  const entry = workspaceWatchers.get(key)
  if (!entry) return
  entry.batcher.cancel()
  entry.watcher.close()
  workspaceWatchers.delete(key)
}

function closeAllWorkspaceWatchers(): void {
  for (const entry of workspaceWatchers.values()) {
    entry.batcher.cancel()
    entry.watcher.close()
  }
  workspaceWatchers.clear()
}

/** 校验工作区与文件路径，用于草稿等按文件持久化的能力 */
function resolveWorkspaceFile(
  workspacePath: string,
  filePath: string
): { workspace: string; file: string } | null {
  if (!isTrustedWorkspacePath(workspacePath)) return null
  const workspace = canonicalizePath(workspacePath)
  const file = canonicalizePath(filePath)
  if (!workspace || !file || !isPathInsideRoot(workspace, file)) return null
  return { workspace, file }
}

/** 启动时把最近打开的工作区视为已批准（它们都来自此前的目录选择器） */
async function seedTrustedWorkspacesFromSettings(): Promise<void> {
  try {
    const settings = await loadSettingsFile()
    const recent: unknown = settings.recentWorkspaces
    if (!Array.isArray(recent)) return
    for (const workspacePath of recent) {
      if (typeof workspacePath === 'string') trustWorkspace(workspacePath)
    }
  } catch (error) {
    console.warn('[Main] Failed to seed trusted workspaces:', error)
  }
}

const workspaceStore = createWorkspaceStore(path.join(getAppDir(), 'data', 'workspaces.db'))
const draftStore = new DraftStore(path.join(getAppDir(), 'cache', 'drafts'))

// 便携式架构：获取应用目录
function getAppDir(): string {
  // AppImage：可执行文件位于只读挂载点，数据放在 .AppImage 文件旁边
  if (process.env.APPIMAGE) {
    return path.dirname(process.env.APPIMAGE)
  }
  if (!app.isPackaged) {
    // 开发模式：项目根目录（比 process.cwd() 更稳定，不依赖启动目录）
    return app.getAppPath()
  }
  if (process.platform === 'darwin') {
    // macOS 应用包内不可写，且会被更新整体替换。
    // 经项目所有者确认，macOS 使用系统标准数据目录作为便携式约束的例外。
    return path.join(app.getPath('appData'), 'pi-workbench')
  }
  // 生产模式：可执行文件所在目录
  return path.dirname(app.getPath('exe'))
}

// Chromium 的 profile（localStorage、缓存等）也放进应用目录，保证整体可迁移
const userDataDir = path.join(getAppDir(), 'data', 'profile')
try {
  mkdirSync(userDataDir, { recursive: true })
} catch {
  // 目录创建失败时仍让 Electron 使用默认路径，避免启动失败
}
app.setPath('userData', userDataDir)

// 初始化应用目录结构
async function initAppDirectories() {
  const appDir = getAppDir()

  const dirs = [
    path.join(appDir, 'config'),
    path.join(appDir, 'cache'),
    path.join(appDir, 'cache', 'temp'),
    path.join(appDir, 'data'),
    path.join(appDir, 'data', 'sessions'),
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
  appSettingsCache = await loadSettingsFile()
  await migratePermissionLevel()
  await seedTrustedWorkspacesFromSettings()
  createWindow()

  // Windows / Linux 的配置、数据和更新缓存都写在安装目录：安装到 Program Files
  // 这类只读位置时提前告知，避免用户以为设置没有保存。
  if (app.isPackaged && process.platform !== 'darwin') {
    void ensureAppDirWritable()
  }

  // 启动后静默检查更新：Windows / Linux 发现新版本会自动下载，但不会自动安装。
  setTimeout(() => {
    void ensureUpdateController().then((controller) => controller?.check())
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

/** 只接受主窗口主框架发来的 IPC；应用 ready 之后 fail-closed */
function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  // 测试替身没有 isReady，直接放行
  if (typeof app.isReady !== 'function') return true
  if (!app.isReady()) return true
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (event.sender !== mainWindow.webContents) return false
  if (event.senderFrame && event.senderFrame !== mainWindow.webContents.mainFrame) return false
  return true
}

function handleIpc(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcSender(event)) {
      return { success: false, error: 'Untrusted IPC sender' }
    }
    return listener(event, ...args)
  })
}

handleIpc('dialog:openDirectory', async () => {
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] })

  const picked = result.filePaths[0]
  if (result.canceled || !picked) {
    return { success: true, canceled: true }
  }

  // 只有用户通过原生对话框明确选择的目录才会被批准为工作区
  const trusted = trustWorkspace(picked)
  if (!trusted) {
    return {
      success: false,
      canceled: false,
      error: 'Selected directory could not be approved as a workspace'
    }
  }

  return { success: true, canceled: false, path: trusted }
})

handleIpc('fs:readFile', async (_event, filePath: string) => {
  try {
    const target = resolveAllowedFileTarget(filePath)
    if (!target) {
      return { success: false, error: 'Path is outside the open workspace' }
    }
    const content = await fs.readFile(target, 'utf-8')
    return { success: true, content }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc('fs:writeFile', async (_event, filePath: string, content: string) => {
  try {
    const target = resolveAllowedFileTarget(filePath)
    if (!target) {
      return { success: false, error: 'Path is outside the open workspace' }
    }
    await fs.writeFile(target, content, 'utf-8')
    const workspaceDir = workspaceForPath(target)
    if (workspaceDir) {
      void pluginManager.emit(workspaceDir, 'file:saved', { path: target })
    }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc('fs:listDirectory', async (_event, dirPath: string) => {
  try {
    const target = resolveAllowedFileTarget(dirPath)
    if (!target) {
      return { success: false, error: 'Path is outside the open workspace' }
    }
    const entries = await fs.readdir(target, { withFileTypes: true })
    const items = entries.map(entry => ({
      name: entry.name,
      path: path.join(target, entry.name),
      isDirectory: entry.isDirectory()
    }))
    return { success: true, items }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc('fs:exists', async (_event, filePath: string) => {
  try {
    const target = resolveAllowedFileTarget(filePath)
    if (!target) {
      return { success: true, exists: false }
    }
    return { success: true, exists: existsSync(target) }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc('fs:stat', async (_event, filePath: string) => {
  try {
    const target = resolveAllowedFileTarget(filePath)
    if (!target) {
      return { success: false, error: 'Path is outside the open workspace' }
    }
    const stats = statSync(target)
    return {
      success: true,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      size: stats.size
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc('fs:delete', async (_event, targetPath: string) => {
  try {
    const target = resolveAllowedFileTarget(targetPath)
    if (!target) {
      return { success: false, error: 'Path is outside the open workspace' }
    }
    if (isProtectedRoot(target)) {
      return { success: false, error: 'Cannot delete a workspace root' }
    }
    await fs.rm(target, { recursive: true, force: false })
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc('fs:rename', async (_event, oldPath: string, newPath: string) => {
  try {
    const source = resolveAllowedFileTarget(oldPath)
    const destination = resolveAllowedFileTarget(newPath)
    if (!source || !destination) {
      return { success: false, error: 'Path is outside the open workspace' }
    }
    if (isProtectedRoot(source) || isProtectedRoot(destination)) {
      return { success: false, error: 'Cannot rename a workspace root' }
    }
    await fs.rename(source, destination)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// 工作区文件监听（递归，忽略依赖/构建/应用数据目录）
handleIpc('fs:watch', async (event, workspacePath: string) => {
  try {
    const trustedWorkspace = isTrustedWorkspacePath(workspacePath)
      ? canonicalizePath(workspacePath)
      : null
    if (!trustedWorkspace) {
      return { success: false, error: 'Workspace is not approved' }
    }

    const key = workspaceWatchKey(trustedWorkspace)
    // 同一工作区重复 watch 时先替换旧监听，其他工作区不受影响
    const previous = workspaceWatchers.get(key)
    if (previous) {
      previous.batcher.cancel()
      previous.watcher.close()
      workspaceWatchers.delete(key)
    }

    const sender = event.sender
    const batcher = new WatchBatcher((changes) => {
      if (sender.isDestroyed()) return
      for (const change of changes) {
        sender.send('fs:changed', change)
      }
    })

    const watcher = watch(trustedWorkspace, { recursive: true }, (eventType, filename) => {
      if (!filename || isIgnoredWatchPath(filename)) return
      const fullPath = path.join(trustedWorkspace, filename)
      const changeKey = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath
      batcher.add({ type: eventType, path: fullPath }, changeKey)
    })

    watcher.on('error', (error) => {
      console.error('[Main] Workspace watcher error:', error)
    })

    workspaceWatchers.set(key, { watcher, batcher })
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc('fs:unwatch', async (_event, workspacePath?: string) => {
  try {
    if (workspacePath) {
      closeWorkspaceWatcher(workspacePath)
    } else {
      closeAllWorkspaceWatchers()
    }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// ---- 终端（PTY） ----

handleIpc('terminal:create', async (_event, workspaceDir: string, cols: number, rows: number) => {
  if (!isTrustedWorkspacePath(workspaceDir)) {
    return { success: false, error: 'Workspace is not approved' }
  }
  const trusted = canonicalizePath(workspaceDir) ?? workspaceDir
  return terminalManager.create(trusted, cols, rows)
})

handleIpc('terminal:write', async (_event, id: string, data: string) => ({
  success: terminalManager.write(id, data),
}))

handleIpc('terminal:resize', async (_event, id: string, cols: number, rows: number) => ({
  success: terminalManager.resize(id, cols, rows),
}))

handleIpc('terminal:close', async (_event, id: string) => ({
  success: terminalManager.close(id),
}))

handleIpc('terminal:flush', async (_event, id: string) => ({
  success: terminalManager.flushNow(id),
}))

// ---- 工作台插件 ----

handleIpc('plugins:list', async (_event, workspaceDir: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, plugins: [], error: 'Workspace is not approved' }
    }
    return { success: true, plugins: pluginManager.list(workspaceDir) }
  } catch (error) {
    return {
      success: false,
      plugins: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc('plugins:invoke', async (_event, workspaceDir: string, commandId: string, args?: unknown) => {
  if (!isTrustedWorkspacePath(workspaceDir)) {
    return { success: false, error: 'Workspace is not approved' }
  }
  return pluginManager.invoke(workspaceDir, commandId, args)
})

handleIpc('plugins:reload', async (_event, workspaceDir: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, plugins: [], error: 'Workspace is not approved' }
    }
    return { success: true, plugins: pluginManager.reload(workspaceDir) }
  } catch (error) {
    return {
      success: false,
      plugins: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc(
  'plugins:setEnabled',
  async (_event, workspaceDir: string, pluginId: string, enabled: boolean) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, plugins: [], error: 'Workspace is not approved' }
      }

      // 插件在主进程拥有完整 Node 权限：首次启用某工作区的插件前必须显式确认
      if (enabled && !pluginManager.hasExplicitEnableList(workspaceDir)) {
        if (typeof dialog.showMessageBoxSync === 'function') {
          const zh = app.getLocale?.().toLowerCase().startsWith('zh') ?? true
          const messageOptions = {
            type: 'warning' as const,
            buttons: zh ? ['取消', '启用插件'] : ['Cancel', 'Enable plugin'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            title: zh ? '启用工作区插件' : 'Enable workspace plugins',
            message: zh
              ? '插件在主进程中运行，拥有完整的 Node.js 权限。'
              : 'Plugins run in the main process with full Node.js access.',
            detail: zh
              ? '只应启用你信任的工作区插件。'
              : 'Only enable plugins from workspaces you trust.',
          }
          const choice =
            mainWindow && !mainWindow.isDestroyed()
              ? dialog.showMessageBoxSync(mainWindow, messageOptions)
              : dialog.showMessageBoxSync(messageOptions)
          if (choice !== 1) {
            return { success: false, plugins: pluginManager.list(workspaceDir), error: 'Cancelled' }
          }
        }
      }

      return {
        success: true,
        plugins: pluginManager.setEnabled(workspaceDir, pluginId, Boolean(enabled)),
      }
    } catch (error) {
      return {
        success: false,
        plugins: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
)

// ---- 自动更新 ----

/** 启动后延迟检查，避免和窗口首屏、插件加载抢网络 */
const UPDATE_CHECK_DELAY_MS = 12_000

let updateController: UpdateController | null = null

function unsupportedUpdateState(): UpdateState {
  return {
    status: 'unsupported',
    currentVersion: app.getVersion(),
    platform: process.platform,
    canAutoInstall: false,
  }
}

function sendUpdateState(state: UpdateState): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', state)
  }
}

const updateLogger = {
  info: (...args: unknown[]) => fileLogger?.write('INFO', args),
  warn: (...args: unknown[]) => fileLogger?.write('WARN', args),
  error: (...args: unknown[]) => fileLogger?.write('ERROR', args),
}

/**
 * electron-updater 只在打包版本有意义；懒加载避免开发/测试环境引入其运行时。
 */
async function ensureUpdateController(): Promise<UpdateController | null> {
  if (!app.isPackaged) return null
  if (updateController) return updateController
  try {
    const { UpdateController: Controller } = await import('./updater.js')
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
  if (!controller) {
    return { success: false, error: 'ERR_UPDATE_NOT_PACKAGED' }
  }
  return controller.download()
})

handleIpc('update:install', async () => {
  const controller = await ensureUpdateController()
  if (!controller) {
    return { success: false, error: 'ERR_UPDATE_NOT_PACKAGED' }
  }
  return controller.install()
})

handleIpc('update:getState', async () => {
  const controller = await ensureUpdateController()
  if (!controller) {
    return { success: true, state: unsupportedUpdateState() }
  }
  return { success: true, state: controller.getState() }
})

handleIpc('update:openDownload', async () => {
  const controller = await ensureUpdateController()
  if (!controller) {
    return { success: false, error: 'ERR_UPDATE_NOT_PACKAGED' }
  }
  return controller.openDownloadPage()
})

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
  terminal: terminalManager.hasRecentActivity(3000),
}))

// ---- 渲染进程日志 ----

const RENDERER_LOG_LEVELS: LogLevel[] = ['INFO', 'WARN', 'ERROR', 'DEBUG']

handleIpc('log:renderer', async (_event, level: unknown, args: unknown) => {
  const normalized = RENDERER_LOG_LEVELS.includes(String(level).toUpperCase() as LogLevel)
    ? (String(level).toUpperCase() as LogLevel)
    : 'INFO'
  const values = Array.isArray(args) ? args : [args]
  try {
    rendererLogger?.write(normalized, values)
  } catch {
    // 日志失败不影响渲染进程
  }
  return { success: true }
})

// 便携式架构：应用配置管理
handleIpc('app:getAppDir', async () => {  try {
    return { success: true, appDir: getAppDir() }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// ---- 应用设置（settings.json）----

const DEFAULT_SETTINGS = {
  language: 'zh',
  theme: 'light',
  autoSave: true,
  autoSaveDelay: 2000,
  runWhileBusy: 'queue',
  /** 新会话的默认权限档位；会话创建后自行持有权限，不再受此值影响 */
  permissionLevel: 'ask',
  recentWorkspaces: [] as string[],
}

async function loadSettingsFile(): Promise<any> {
  const settingsPath = path.join(getAppDir(), 'config', 'settings.json')
  const result = readJsonWithBackup<Record<string, unknown>>(settingsPath)
  if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    if (result.source === 'backup') {
      console.warn('[Main] settings.json was unreadable; loaded backup copy')
    }
    return { ...DEFAULT_SETTINGS, ...result.data }
  }
  if (result.error) {
    console.warn('[Main] Failed to read settings.json:', result.error)
  }
  return { ...DEFAULT_SETTINGS }
}

async function saveSettingsFile(settings: any): Promise<void> {
  const settingsPath = path.join(getAppDir(), 'config', 'settings.json')
  await writeJsonAtomic(settingsPath, settings)
}

function normalizePermissionLevel(value: unknown): 'readonly' | 'ask' | 'auto' | null {
  return value === 'readonly' || value === 'ask' || value === 'auto' ? value : null
}

/**
 * 旧版 settings.json 只有 permissions 四类对象。启动时一次性迁移为 permissionLevel：
 * 取不宽于旧策略的最宽松档位，迁移只会变严不会变松。之后旧字段保留但不再读取。
 */
async function migratePermissionLevel(): Promise<void> {
  const settingsPath = path.join(getAppDir(), 'config', 'settings.json')
  const result = readJsonWithBackup<Record<string, unknown>>(settingsPath)
  const raw = result.data
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  if (normalizePermissionLevel(raw.permissionLevel)) return

  let level: 'readonly' | 'ask' | 'auto' = 'ask'
  try {
    const bridgePath = path.join(__dirname, '..', 'pi-bridge', 'dist', 'index.js')
    const { derivePermissionLevelFromPolicy } = await import(pathToFileURL(bridgePath).href)
    if (raw.permissions && typeof raw.permissions === 'object') {
      level = derivePermissionLevelFromPolicy(raw.permissions)
    }
  } catch (error) {
    console.warn('[Main] Failed to derive legacy permission level:', error)
  }

  try {
    const next = { ...raw, permissionLevel: level }
    await saveSettingsFile(next)
    appSettingsCache = { ...appSettingsCache, permissionLevel: level }
    console.log('[Main] Migrated permission level:', level)
  } catch (error) {
    console.error('[Main] Failed to persist migrated permission level:', error)
    appSettingsCache = { ...appSettingsCache, permissionLevel: level }
  }
}

handleIpc('app:getSettings', async () => {
  try {
    return { success: true, settings: await loadSettingsFile() }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc('app:saveSettings', async (_event, settings: any) => {
  try {
    const sanitized = { ...(settings ?? {}) }
    // 最近工作区只允许保存已批准路径，避免渲染进程借此为任意目录背书
    if (Array.isArray(sanitized.recentWorkspaces)) {
      sanitized.recentWorkspaces = sanitized.recentWorkspaces.filter(
        (workspacePath: unknown): boolean =>
          typeof workspacePath === 'string' && isTrustedWorkspacePath(workspacePath)
      )
    }
    // 权限档位只接受三个合法值；缺失时保留现有值（旧前端不会发送该字段）
    const level = normalizePermissionLevel(sanitized.permissionLevel)
    if (level) {
      sanitized.permissionLevel = level
    } else {
      const currentLevel = normalizePermissionLevel(appSettingsCache.permissionLevel)
      if (currentLevel) sanitized.permissionLevel = currentLevel
      else delete sanitized.permissionLevel
    }
    await saveSettingsFile(sanitized)
    appSettingsCache = { ...appSettingsCache, ...sanitized }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// 文件引用：在工作区内按文件名 / 路径片段搜索（跳过依赖与构建目录）
handleIpc(
  'workspace:searchFiles',
  async (_event, workspaceDir: string, query: string, limit = 20) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const needle = String(query ?? '').trim().toLowerCase()
      const maxResults = Math.min(50, Math.max(1, Number(limit) || 20))
      const ignored = new Set([
        'node_modules',
        '.git',
        '.pi-workbench',
        '.pi-worktrees',
        '.atelier',
        'dist',
        'dist-electron',
        'cache',
        'logs',
        'release',
      ])
      const results: string[] = []
      let visited = 0
      const maxVisited = 6000

      async function walk(dir: string, depth: number): Promise<void> {
        if (results.length >= maxResults || visited >= maxVisited || depth > 8) return
        let entries
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (results.length >= maxResults || visited >= maxVisited) return
          if (entry.name.startsWith('.') && entry.name !== '.env') continue
          if (entry.isDirectory()) {
            if (ignored.has(entry.name)) continue
            await walk(path.join(dir, entry.name), depth + 1)
            continue
          }
          if (!entry.isFile()) continue
          visited++
          const relative = path.relative(workspaceDir, path.join(dir, entry.name)).split(path.sep).join('/')
          if (!needle || relative.toLowerCase().includes(needle)) {
            results.push(relative)
          }
        }
      }

      await walk(workspaceDir, 0)
      return { success: true, files: results }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 自绘窗口按钮（Windows / Linux；macOS 保留原生红绿灯）
handleIpc('window:minimize', () => {
  mainWindow?.minimize()
  return { success: true }
})

handleIpc('window:toggleMaximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { success: false, maximized: false }
  }
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
  return { success: true, maximized: mainWindow.isMaximized() }
})

handleIpc('window:close', () => {
  mainWindow?.close()
  return { success: true }
})

handleIpc('window:isMaximized', () => ({
  success: true,
  maximized: mainWindow?.isMaximized() ?? false,
}))

handleIpc('app:getRecentWorkspaces', async () => {
  try {
    const settings = await loadSettingsFile()
    const fromSettings: string[] = Array.isArray(settings.recentWorkspaces)
      ? settings.recentWorkspaces.filter(
          (item: unknown): item is string =>
            typeof item === 'string' && isTrustedWorkspacePath(item)
        )
      : []
    const fromStore = workspaceStore.listRecent(30)
    const merged: string[] = []
    for (const workspacePath of [...fromStore, ...fromSettings]) {
      if (!isTrustedWorkspacePath(workspacePath)) continue
      if (!merged.includes(workspacePath)) merged.push(workspacePath)
      if (merged.length >= 10) break
    }
    return { success: true, workspaces: merged }
  } catch (error) {
    return {
      success: false,
      workspaces: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc('app:addRecentWorkspace', async (_event, workspacePath: string) => {
  try {
    if (!isTrustedWorkspacePath(workspacePath)) {
      return { success: false, workspaces: [], error: 'Workspace is not approved' }
    }
    workspaceStore.recordOpen(workspacePath)
    const settings = await loadSettingsFile()
    const existing: string[] = Array.isArray(settings.recentWorkspaces) ? settings.recentWorkspaces : []
    const workspaces = [workspacePath, ...existing.filter((p) => p !== workspacePath)].slice(0, 10)
    await saveSettingsFile({ ...settings, recentWorkspaces: workspaces })
    return { success: true, workspaces }
  } catch (error) {
    return {
      success: false,
      workspaces: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// 工作区配置管理
handleIpc('workspace:init', async (_event, workspacePath: string) => {
  try {
    // 工作区根必须由主进程批准（目录选择器或启动时的最近工作区）
    if (!isTrustedWorkspacePath(workspacePath)) {
      return {
        success: false,
        error: 'Workspace is not approved. Open it with the Open Project dialog.',
      }
    }
    workspaceStore.recordOpen(workspacePath)

    const configDir = path.join(workspacePath, '.pi-workbench')
    const pluginsDir = path.join(configDir, 'plugins')
    const sessionsDir = path.join(configDir, 'sessions')

    // 创建目录
    await fs.mkdir(configDir, { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })
    await fs.mkdir(sessionsDir, { recursive: true })

    // 创建默认配置
    const configPath = path.join(configDir, 'config.json')
    if (!existsSync(configPath)) {
      const defaultConfig = {
        version: '1.0',
        enabledPlugins: [],
      }
      await writeJsonAtomic(configPath, defaultConfig)
    }

    // 加载工作区插件并派发打开事件
    pluginManager.loadWorkspace(workspacePath)
    await pluginManager.emit(workspacePath, 'workspace:opened', { workspaceDir: workspacePath })

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc('workspace:getConfig', async (_event, workspacePath: string) => {
  try {
    if (!isTrustedWorkspacePath(workspacePath)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const configPath = path.join(workspacePath, '.pi-workbench', 'config.json')

    if (!existsSync(configPath)) {
      return { success: false, error: 'Workspace not initialized' }
    }

    const result = readJsonWithBackup<Record<string, unknown>>(configPath)
    if (!result.data) {
      return { success: false, error: result.error || 'Failed to parse workspace config' }
    }
    return { success: true, config: result.data }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

handleIpc('workspace:saveConfig', async (_event, workspacePath: string, config: any) => {
  try {
    if (!isTrustedWorkspacePath(workspacePath)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const configPath = path.join(workspacePath, '.pi-workbench', 'config.json')

    // 插件启用状态由 PluginManager 独占管理：合并保存时保留磁盘上的插件字段，
    // 避免渲染进程拿旧配置覆盖掉期间发生的启用/禁用
    const current = readJsonWithBackup<Record<string, unknown>>(configPath).data ?? {}
    const incoming =
      config && typeof config === 'object' && !Array.isArray(config)
        ? { ...(config as Record<string, unknown>) }
        : {}
    const merged: Record<string, unknown> = { ...current, ...incoming }

    for (const key of ['enabledPlugins', 'pluginsConfigured']) {
      if (key in current) {
        merged[key] = current[key]
      } else {
        delete merged[key]
      }
    }

    await writeJsonAtomic(configPath, merged)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// 关闭工作区标签时释放该工作区的主进程资源（插件、监听）
handleIpc('workspace:dispose', async (_event, workspacePath: string) => {
  try {
    if (!isTrustedWorkspacePath(workspacePath)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    // 关闭该工作区的监听与终端，其他打开的工作区不受影响
    closeWorkspaceWatcher(workspacePath)
    terminalManager.closeWorkspace(canonicalizePath(workspacePath) ?? workspacePath)
    pluginManager.unload(workspacePath)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// ---- 崩溃恢复草稿 ----

handleIpc('draft:save', async (_event, workspacePath: string, filePath: string, content: unknown) => {
  try {
    const target = resolveWorkspaceFile(workspacePath, filePath)
    if (!target) {
      return { success: false, error: 'Path is outside the open workspace' }
    }
    if (typeof content !== 'string') {
      return { success: false, error: 'Draft content must be a string' }
    }
    draftStore.save(target.workspace, target.file, content)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('draft:delete', async (_event, workspacePath: string, filePath: string) => {
  try {
    const target = resolveWorkspaceFile(workspacePath, filePath)
    if (!target) {
      return { success: false, error: 'Path is outside the open workspace' }
    }
    draftStore.remove(target.workspace, target.file)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('draft:list', async (_event, workspacePath: string) => {
  try {
    if (!isTrustedWorkspacePath(workspacePath)) {
      return { success: false, drafts: [], error: 'Workspace is not approved' }
    }
    const workspace = canonicalizePath(workspacePath) ?? workspacePath
    return { success: true, drafts: draftStore.list(workspace) }
  } catch (error) {
    return {
      success: false,
      drafts: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
})

handleIpc('draft:clear', async (_event, workspacePath: string) => {
  try {
    if (!isTrustedWorkspacePath(workspacePath)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    draftStore.clear(canonicalizePath(workspacePath) ?? workspacePath)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// ==================== API Configuration Management ====================

/**
 * API Key 静态加密（Electron safeStorage：Windows DPAPI / macOS Keychain / Linux libsecret）。
 * 文件仍保存在便携式目录中，只有加密所用的系统密钥来自操作系统。
 * 系统不支持加密时回退为明文，并打印警告。
 */
function encryptApiKey(apiKey: string): string {
  if (!apiKey) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(apiKey).toString('base64')
    }
  } catch (error) {
    console.warn('[Main] safeStorage encryption failed:', error)
  }
  console.warn('[Main] safeStorage unavailable — API key will be stored in plain text')
  return apiKey
}

function decryptApiKey(stored: string): string {
  if (!stored) return ''
  if (!stored.startsWith('enc:')) {
    // 兼容旧版明文配置
    return stored
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  } catch (error) {
    console.error('[Main] Failed to decrypt stored API key:', error)
    return ''
  }
}

/** 只支持 OpenAI 兼容渠道；provider 字段保留给 AgentManager 兼容旧结构 */
const DEFAULT_API_CONFIG = {
  provider: 'custom',
  apiUrl: '',
  apiKey: '',
  availableModels: [] as string[],
  selectedModel: '',
  /** 已知支持图片的模型；仅用于旧配置迁移时的预勾选 */
  imageModels: ['deepseek-flash'] as string[],
}

/** 图片附件通用上限：与渲染层、pi-bridge 保持一致 */
const MAX_CHAT_IMAGES = 20
const MAX_IMAGE_BASE64_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3)
const MAX_TOTAL_IMAGE_BASE64_CHARS = 48 * 1024 * 1024
const CHAT_IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/i

// Helper function to load API Config
async function loadApiConfig(): Promise<any> {
  try {
    activeProviderApiKey = ''
    const appDir = getAppDir()
    const configPath = path.join(appDir, 'config', 'api-config.json')

    if (!existsSync(configPath)) {
      // Return minimal default config (no hardcoded models)
      return { ...DEFAULT_API_CONFIG }
    }

    const configResult = readJsonWithBackup<any>(configPath)
    if (!configResult.data || typeof configResult.data !== 'object') {
      if (configResult.error) {
        console.warn('[Main] Failed to parse API config:', configResult.error)
      }
      return { ...DEFAULT_API_CONFIG }
    }
    const config = configResult.data

    // 旧版供应商（Anthropic / OpenAI）配置已不再支持：备份后清空，避免旧配置继续生效
    if (config.provider !== 'custom') {
      const backupPath = path.join(path.dirname(configPath), 'api-config.legacy.json')
      try {
        if (!existsSync(backupPath)) {
          await fs.rename(configPath, backupPath)
        } else {
          await fs.unlink(configPath)
        }
      } catch (error) {
        console.warn('[Main] Failed to back up legacy API config:', error)
      }
      console.warn('[Main] Legacy provider config cleared; only OpenAI-compatible channels are supported')
      return { ...DEFAULT_API_CONFIG }
    }

    config.apiKey = decryptApiKey(config.apiKey)
    config.imageModels = Array.isArray(config.imageModels)
      ? config.imageModels.filter((id: unknown): id is string => typeof id === 'string')
      : [...DEFAULT_API_CONFIG.imageModels]
    activeProviderApiKey = typeof config.apiKey === 'string' ? config.apiKey : ''
    return config
  } catch (error) {
    console.error('[Main] Failed to load API config:', error)
    return null
  }
}

// Get API Configuration
handleIpc('apiConfig:get', async () => {
  try {
    const config = await loadApiConfig()
    return { success: true, config }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// Save API Configuration
handleIpc('apiConfig:save', async (_event, config: any) => {
  try {
    const appDir = getAppDir()
    const configPath = path.join(appDir, 'config', 'api-config.json')

    const stored = {
      ...config,
      availableModels: Array.isArray(config?.availableModels)
        ? [
            ...new Set(
              config.availableModels.filter(
                (id: unknown): id is string => typeof id === 'string' && id.length > 0
              )
            ),
          ]
        : [],
      imageModels: Array.isArray(config?.imageModels)
        ? [
            ...new Set(
              config.imageModels.filter(
                (id: unknown): id is string => typeof id === 'string' && id.length > 0
              )
            ),
          ]
        : [...DEFAULT_API_CONFIG.imageModels],
      apiKey: encryptApiKey(String(config?.apiKey ?? '')),
    }
    await writeJsonAtomic(configPath, stored)
    activeProviderApiKey = String(config?.apiKey ?? '')

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// Fetch available models from API
handleIpc('apiConfig:fetchModels', async (_event, apiUrl: string, apiKey: string, provider: string) => {
  try {
    // 归一化 Base URL：去掉末尾斜杠，模板占位符视为未填写
    const baseUrl = (apiUrl || '').trim().replace(/\/+$/, '')
    if (!baseUrl || baseUrl.includes('your-api-endpoint')) {
      throw new Error('Please enter a valid API URL')
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error('API URL must start with http:// or https://')
    }

    const modelsEndpoint = `${baseUrl}/models`
    console.log(`[Main] Fetching models from ${modelsEndpoint} (provider: ${provider})`)

    const headers: Record<string, string> = provider === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { 'Authorization': `Bearer ${apiKey}` }

    // 主进程发起请求：必须有超时，避免供应商无响应时永久挂起
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    let response: Response
    try {
      response = await fetch(modelsEndpoint, { headers, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('Request timed out after 15s')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
    console.log(`[Main] Response status: ${response.status}`)

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }

    const data: any = await response.json()

    // 兼容常见返回格式：{ data: [{id}] } / { models: [...] } / [...]
    let models: string[] = []
    if (Array.isArray(data?.data)) {
      models = data.data.map((m: any) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
    } else if (Array.isArray(data?.models)) {
      models = data.models.map((m: any) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
    } else if (Array.isArray(data)) {
      models = data.map((m: any) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
    }

    console.log(`[Main] Fetched ${models.length} models`)
    return { success: true, models }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[Main] fetchModels error:', errorMessage)
    return {
      success: false,
      error: errorMessage,
      models: []
    }
  }
})

// ==================== Pi Agent Integration ====================

/** 配置签名：同一工作区配置变化时需要重建 Agent，否则复用 */
function agentConfigKey(apiConfig: {
  provider: string
  apiUrl: string
  apiKey: string
  selectedModel: string
  availableModels?: string[]
  imageModels?: string[]
}): string {
  return JSON.stringify({
    provider: apiConfig.provider,
    apiUrl: apiConfig.apiUrl,
    selectedModel: apiConfig.selectedModel,
    apiKey: apiConfig.apiKey,
    availableModels: apiConfig.availableModels ?? [],
    // 图片能力勾选决定 models.json 的 input，变化时必须重建 Agent
    imageModels: [...(apiConfig.imageModels ?? [])].sort(),
  })
}

// Agent 初始化（按工作区）
handleIpc('agent:initialize', async (_event, config: {
  workspaceDir: string
  apiConfig: {
    provider: string
    apiUrl: string
    apiKey: string
    selectedModel: string
    availableModels?: string[]
    imageModels?: string[]
  }
}) => {
  try {
    const { workspaceDir, apiConfig } = config

    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }

    console.log('[Main] Initializing Pi Agent with config:', {
      provider: apiConfig.provider,
      model: apiConfig.selectedModel,
      workspaceDir
    })

    // 验证 API Key
    if (!apiConfig.apiKey) {
      return {
        success: false,
        error: 'API key not configured. Please set it in Settings.'
      }
    }

    const configKey = agentConfigKey(apiConfig)
    if (agentRegistry.shouldReuse(workspaceDir, configKey)) {
      console.log('[Main] Reusing agent for workspace:', workspaceDir)
      return { success: true }
    }

    // 延迟加载 AgentManager（用运行时路径解析，避免类型检查依赖未构建的 pi-bridge/dist）
    const bridgePath = path.join(__dirname, '..', 'pi-bridge', 'dist', 'index.js')
    const { AgentManager } = await import(pathToFileURL(bridgePath).href)
    const agent = new AgentManager()

    // 初始化 Agent（传入完整的 apiConfig + 便携式 agent 数据目录）
    const result = await agent.initialize({
      workspaceDir,
      agentDir: path.join(getAppDir(), 'data', 'agent'),
      apiConfig,
      logger: agentLogger,
      onSessionTitle: (sessionId: string, title: string) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:session-title', { workspaceDir, sessionId, title })
        }
      },
      // 会话权限：全局只提供新会话的默认档位；无审批通道时 Agent 侧按拒绝处理
      getDefaultPermissionLevel: () => appSettingsCache.permissionLevel,
      requestApproval: (request: unknown) => approvalBroker.request(request as any),
    })

    if (result.success) {
      // 登记实例；若该工作区已有旧实例会先释放
      await agentRegistry.set(workspaceDir, agent, configKey)
      console.log('[Main] Pi Agent initialized successfully')
    } else {
      await agent.dispose().catch(() => undefined)
      console.error('[Main] Failed to initialize Pi Agent:', result.error)
    }

    return result
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[Main] Agent initialization error:', errorMessage)
    return {
      success: false,
      error: `Failed to initialize agent: ${errorMessage}`
    }
  }
})

// 会话元数据：置顶 / 归档（按工作区存 .pi-workbench/sessions-meta.json）
handleIpc('agent:sessions:meta:get', async (_event, workspaceDir: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const metaPath = path.join(workspaceDir, '.pi-workbench', 'sessions-meta.json')
    const result = readJsonWithBackup<{ pinned?: unknown; archived?: unknown }>(metaPath)
    const sanitize = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((id): id is string => typeof id === 'string').slice(0, 500)
        : []
    return {
      success: true,
      meta: {
        pinned: sanitize(result.data?.pinned),
        archived: sanitize(result.data?.archived),
      },
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc(
  'agent:sessions:meta:set',
  async (_event, workspaceDir: string, meta: { pinned?: unknown; archived?: unknown }) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const sanitize = (value: unknown): string[] =>
        Array.isArray(value)
          ? [...new Set(value.filter((id): id is string => typeof id === 'string'))].slice(0, 500)
          : []
      const dir = path.join(workspaceDir, '.pi-workbench')
      await fs.mkdir(dir, { recursive: true })
      await writeJsonAtomic(path.join(dir, 'sessions-meta.json'), {
        pinned: sanitize(meta?.pinned),
        archived: sanitize(meta?.archived),
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 排队消息持久化（R-02）：按会话分组存 .pi-workbench/pending-messages.json
// 旧版本可能带 behavior 字段，读取时忽略；排队消息统一表示“下一轮发送”。
type PendingMessageRecord = { id: string; text: string }

function sanitizePendingSessions(value: unknown): Record<string, PendingMessageRecord[]> {
  const sessions: Record<string, PendingMessageRecord[]> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return sessions
  for (const [sessionId, list] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(sessions).length >= 200) break
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) continue
    if (!Array.isArray(list)) continue
    const items: PendingMessageRecord[] = []
    for (const entry of list) {
      if (items.length >= 50) break
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const text = typeof record.text === 'string' ? record.text.slice(0, 20000) : ''
      if (text.trim().length === 0) continue
      items.push({
        id:
          typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 128
            ? record.id
            : `pending-${items.length + 1}`,
        text,
      })
    }
    if (items.length > 0) sessions[sessionId] = items
  }
  return sessions
}

handleIpc('chat:pending:get', async (_event, workspaceDir: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const filePath = path.join(workspaceDir, '.pi-workbench', 'pending-messages.json')
    const result = readJsonWithBackup<{ sessions?: unknown }>(filePath)
    return { success: true, sessions: sanitizePendingSessions(result.data?.sessions) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('chat:pending:set', async (_event, workspaceDir: string, sessions: unknown) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const dir = path.join(workspaceDir, '.pi-workbench')
    await fs.mkdir(dir, { recursive: true })
    await writeJsonAtomic(path.join(dir, 'pending-messages.json'), {
      sessions: sanitizePendingSessions(sessions),
    })
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// 导出文本：弹出保存对话框后写入用户选择的位置
handleIpc('app:saveTextFile', async (_event, suggestedName: string, content: string) => {
  try {
    if (typeof content !== 'string') {
      return { success: false, error: 'Nothing to save' }
    }
    const safeName =
      typeof suggestedName === 'string' && suggestedName.trim()
        ? path.basename(suggestedName.trim())
        : 'export.txt'
    const options = {
      defaultPath: path.join(app.getPath('documents'), safeName),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All files', extensions: ['*'] },
      ],
    }
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { success: false, canceled: true }
    await fs.writeFile(result.filePath, content, 'utf-8')
    return { success: true, path: result.filePath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// Agent 聊天
handleIpc(
  'agent:chat',
  async (
    event,
    message: string,
    requestId?: string,
    workspaceDir?: string,
    sessionId?: string,
    images?: unknown
  ) => {
    const startedAt = Date.now()
    try {
      if (workspaceDir && !isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = workspaceDir ? agentRegistry.get(workspaceDir) : null
      if (!agent) {
        return {
          success: false,
          error: 'Agent not initialized for this workspace. Please initialize agent first.',
        }
      }

      // 图像附件：格式 / 张数 / 单张与总大小统一校验，超限明确报错而不是静默丢弃
      const safeImages: Array<{ data: string; mimeType: string }> = []
      if (images !== undefined && images !== null) {
        if (!Array.isArray(images)) {
          return { success: false, error: 'Images must be an array.' }
        }
        if (images.length > MAX_CHAT_IMAGES) {
          return {
            success: false,
            error: `At most ${MAX_CHAT_IMAGES} images can be sent at once.`,
          }
        }
        let totalChars = 0
        for (const image of images) {
          const data = (image as { data?: unknown } | null)?.data
          const mimeType = (image as { mimeType?: unknown } | null)?.mimeType
          if (typeof data !== 'string' || data.length === 0) {
            return { success: false, error: 'Invalid image payload.' }
          }
          if (typeof mimeType !== 'string' || !CHAT_IMAGE_MIME.test(mimeType)) {
            return { success: false, error: 'Unsupported image format.' }
          }
          if (data.length > MAX_IMAGE_BASE64_CHARS) {
            return { success: false, error: 'Each image must be at most 10 MB.' }
          }
          totalChars += data.length
          if (totalChars > MAX_TOTAL_IMAGE_BASE64_CHARS) {
            return { success: false, error: 'Images exceed the total size limit.' }
          }
          safeImages.push({ data, mimeType })
        }
      }

      console.log('[Main] Sending message to agent:', message.substring(0, 100))
      if (workspaceDir) {
        void pluginManager.emit(workspaceDir, 'chat:message', { message })
      }

      // 流式事件统一走 agent:stream（文本 / 思考 / 工具），带路由字段供渲染层过滤
      const onTrace = (trace: { type: string; [key: string]: unknown }) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('agent:stream', { requestId, workspaceDir, sessionId, ...trace })
        }
      }
      const chatOptions = safeImages.length > 0 ? { onTrace, images: safeImages } : { onTrace }
      const result = sessionId
        ? await agent.chat(sessionId, message, chatOptions)
        : await agent.chat(message, chatOptions)

      if (result.success) {
        console.log('[Main] Agent response received')
        const elapsed = Date.now() - startedAt
        // 短任务不打扰；只有超过阈值且窗口不在前台时才通知
        if (workspaceDir && elapsed >= 15_000) {
          const text = notificationText()
          notificationRouter.notify({
            kind: 'complete',
            workspaceDir,
            sessionId: sessionId ?? '',
            title: text.complete,
            body: `${path.basename(workspaceDir)} · ${Math.round(elapsed / 1000)}s`,
          })
        }
      } else {
        console.error('[Main] Agent chat error:', result.error)
        if (workspaceDir) {
          const text = notificationText()
          notificationRouter.notify({
            kind: 'error',
            workspaceDir,
            sessionId: sessionId ?? '',
            title: text.error,
            body: (result.error ?? '').slice(0, 140),
          })
        }
      }

      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[Main] Agent chat error:', errorMessage)
      if (workspaceDir) {
        const text = notificationText()
        notificationRouter.notify({
          kind: 'error',
          workspaceDir,
          sessionId: sessionId ?? '',
          title: text.error,
          body: errorMessage.slice(0, 140),
        })
      }
      return {
        success: false,
        error: `Agent error: ${errorMessage}`,
      }
    }
  }
)

// 上下文占用与压缩
handleIpc('agent:context:usage', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.getContextUsage !== 'function') {
      return { success: false, error: 'Context usage is not supported by this agent' }
    }
    return await agent.getContextUsage(sessionId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('agent:context:compact', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.compactContext !== 'function') {
      return { success: false, error: 'Compaction is not supported by this agent' }
    }
    return await agent.compactContext(sessionId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// 重试 / 编辑重发：回退到最后一条用户消息
handleIpc(
  'agent:rewind',
  async (_event, workspaceDir: string, sessionId: string, newText?: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.rewindToLastUser !== 'function') {
        return { success: false, error: 'Rewind is not supported by this agent' }
      }
      return await agent.rewindToLastUser(
        sessionId,
        typeof newText === 'string' ? newText : undefined
      )
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 分支切换（R-03）：列出同一用户消息下的多条回复，或切换到指定回复
handleIpc('agent:branches:list', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.listBranches !== 'function') {
      return { success: false, error: 'Branches are not supported by this agent' }
    }
    return await agent.listBranches(sessionId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc(
  'agent:branches:switch',
  async (_event, workspaceDir: string, sessionId: string, entryId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (typeof entryId !== 'string' || !entryId) {
        return { success: false, error: 'Branch entry is required' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.switchBranch !== 'function') {
        return { success: false, error: 'Branches are not supported by this agent' }
      }
      return await agent.switchBranch(sessionId, entryId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 运行中插话：把消息注入当前轮
handleIpc('agent:steer', async (_event, workspaceDir: string, sessionId: string, message: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    if (typeof message !== 'string' || !message.trim()) {
      return { success: false, error: 'Message is empty' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.steer !== 'function') {
      return { success: false, error: 'Steering is not supported by this agent' }
    }
    return await agent.steer(sessionId, message)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// Agent 中止请求（按会话；不传 sessionId 时中止该工作区全部会话）
handleIpc('agent:abort', async (_event, workspaceDir?: string, sessionId?: string) => {
  try {
    if (workspaceDir && !isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = workspaceDir ? agentRegistry.get(workspaceDir) : null
    if (!agent) {
      return { success: false, error: 'Agent not initialized for this workspace' }
    }
    if (typeof agent.abort !== 'function') {
      return { success: false, error: 'Agent does not support abort' }
    }
    await agent.abort(sessionId)
    // 中止后挂起的审批已无意义，通知渲染层移除卡片
    if (sessionId) approvalBroker.cancelForSession(sessionId)
    else if (workspaceDir) approvalBroker.cancelForWorkspace(workspaceDir)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
})

// Agent 状态查询
handleIpc('agent:isInitialized', async (_event, workspaceDir?: string) => {
  try {
    const agent = workspaceDir ? agentRegistry.get(workspaceDir) : null
    return { success: true, initialized: agent?.isInitialized() || false }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// Agent 消息历史
handleIpc('agent:getHistory', async (_event, workspaceDir?: string, sessionId?: string) => {
  try {
    if (workspaceDir && !isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = workspaceDir ? agentRegistry.get(workspaceDir) : null
    if (!agent) {
      return { success: false, error: 'Agent not initialized for this workspace' }
    }

    // 返回持久化 Pi 会话中的可展示历史（跨重启恢复）
    const history = typeof agent.getSessionMessages === 'function'
      ? agent.getSessionMessages(sessionId)
      : agent.getMessageHistory?.(sessionId)
    return { success: true, history }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// 会话列表 / 打开 / 新建 / 关闭 / 重命名 / 删除
handleIpc('agent:sessions:list', async (_event, workspaceDir: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    const sessions = typeof agent.listSessions === 'function' ? await agent.listSessions() : []
    return { success: true, sessions, currentId: agent.getCurrentSessionId?.() ?? null }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('agent:sessions:open', async (_event, workspaceDir: string, sessionId?: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.openSession !== 'function') {
      return { success: false, error: 'Sessions are not supported by this agent' }
    }
    return await agent.openSession(sessionId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('agent:sessions:create', async (_event, workspaceDir: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.createSession !== 'function') {
      return { success: false, error: 'Sessions are not supported by this agent' }
    }
    return await agent.createSession()
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('agent:sessions:close', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.closeSession !== 'function') {
      return { success: false, error: 'Sessions are not supported by this agent' }
    }
    await agent.closeSession(sessionId)
    approvalBroker.cancelForSession(sessionId)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// 历史工具 Diff（会话 sidecar）
handleIpc(
  'agent:tool-diff',
  async (_event, workspaceDir: string, sessionId: string, toolCallId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.getToolEdit !== 'function') {
        return { success: false, error: 'Historical diffs are not supported by this agent' }
      }
      return await agent.getToolEdit(sessionId, toolCallId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 工具结果全量查看（R-20）：只读访问会话消息中的完整结果
handleIpc('agent:tool-result:meta', async (_event, workspaceDir: string, sessionId: string, toolCallId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.getToolResultMeta !== 'function') {
      return { success: false, error: 'Tool results are not supported by this agent' }
    }
    return await agent.getToolResultMeta(sessionId, toolCallId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc(
  'agent:tool-result:chunk',
  async (
    _event,
    workspaceDir: string,
    sessionId: string,
    toolCallId: string,
    offset?: number,
    limit?: number
  ) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.readToolResultChunk !== 'function') {
        return { success: false, error: 'Tool results are not supported by this agent' }
      }
      const safeOffset = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0
      const safeLimit = typeof limit === 'number' && Number.isFinite(limit) ? limit : 65_536
      return await agent.readToolResultChunk(sessionId, toolCallId, safeOffset, safeLimit)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc(
  'agent:tool-result:image',
  async (_event, workspaceDir: string, sessionId: string, toolCallId: string, index?: number) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.getToolResultImage !== 'function') {
        return { success: false, error: 'Tool results are not supported by this agent' }
      }
      return await agent.getToolResultImage(
        sessionId,
        toolCallId,
        typeof index === 'number' && Number.isFinite(index) ? index : 0
      )
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 完整结果导出到应用缓存并用系统编辑器打开（不产生第二份长期副本）
handleIpc(
  'agent:tool-result:open',
  async (_event, workspaceDir: string, sessionId: string, toolCallId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.getToolResultText !== 'function') {
        return { success: false, error: 'Tool results are not supported by this agent' }
      }
      const result = await agent.getToolResultText(sessionId, toolCallId)
      if (!result.success || typeof result.text !== 'string') return result

      const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'result'
      const filePath = path.join(
        getAppDir(),
        'cache',
        'temp',
        `tool-result-${safeId}.txt`
      )
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, result.text, 'utf-8')
      const openError = await shell.openPath(filePath)
      return openError
        ? { success: false, error: openError, path: filePath }
        : { success: true, path: filePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 会话导出（R-10）：Markdown / 自带样式 HTML / 原始 JSONL
handleIpc(
  'agent:export-session',
  async (
    _event,
    workspaceDir: string,
    sessionId: string,
    format: string,
    language?: string
  ) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (format !== 'md' && format !== 'html' && format !== 'jsonl') {
        return { success: false, error: 'Unsupported export format' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      const lang: 'zh' | 'en' = language === 'en' ? 'en' : 'zh'

      let title = sessionId
      let content: string | null = null
      let sourcePath: string | null = null

      if (format === 'jsonl') {
        if (typeof agent.getSessionJsonlPath !== 'function') {
          return { success: false, error: 'JSONL export is not supported by this agent' }
        }
        const result = await agent.getSessionJsonlPath(sessionId)
        if (!result.success || !result.path) return result
        title = result.title ?? sessionId
        sourcePath = result.path
      } else if (format === 'md') {
        if (typeof agent.exportSessionMarkdown !== 'function') {
          return { success: false, error: 'Markdown export is not supported by this agent' }
        }
        const result = await agent.exportSessionMarkdown(sessionId, lang)
        if (!result.success || typeof result.content !== 'string') return result
        title = result.title ?? sessionId
        content = result.content
      } else {
        if (typeof agent.exportSessionHtml !== 'function') {
          return { success: false, error: 'HTML export is not supported by this agent' }
        }
        const result = await agent.exportSessionHtml(sessionId, lang)
        if (!result.success || typeof result.content !== 'string') return result
        title = result.title ?? sessionId
        content = result.content
      }

      const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'session'
      const extension = format === 'md' ? 'md' : format === 'html' ? 'html' : 'jsonl'
      const filterName = format === 'md' ? 'Markdown' : format === 'html' ? 'HTML' : 'JSONL'
      const options = {
        defaultPath: path.join(workspaceDir, `${safeTitle}.${extension}`),
        filters: [{ name: filterName, extensions: [extension] }],
      }
      const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      const picked = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options)
      if (picked.canceled || !picked.filePath) {
        return { success: true, canceled: true }
      }

      if (sourcePath) {
        await fs.copyFile(sourcePath, picked.filePath)
      } else {
        await fs.writeFile(picked.filePath, content ?? '', 'utf-8')
      }
      return { success: true, path: picked.filePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 模型能力提示（R-06）：上下文窗口、思考与图像输入
handleIpc('agent:models:capabilities', async (_event, workspaceDir: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.getModelCapabilities !== 'function') {
      return { success: false, error: 'Model capabilities are not supported by this agent' }
    }
    return await agent.getModelCapabilities()
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// 提示模板与技能（R-13）
handleIpc(
  'agent:prompt-resources',
  async (_event, workspaceDir: string, sessionId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.listPromptResources !== 'function') {
        return { success: false, error: 'Prompt resources are not supported by this agent' }
      }
      return await agent.listPromptResources(sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 结构化计划（R-04）：读取 / 批准 / 拒绝
handleIpc('agent:plan:get', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.getPlan !== 'function') {
      return { success: false, error: 'Plans are not supported by this agent' }
    }
    return await agent.getPlan(sessionId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc(
  'agent:plan:approve',
  async (
    _event,
    workspaceDir: string,
    sessionId: string,
    planId: string,
    targetMode: 'ask' | 'auto'
  ) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (targetMode !== 'ask' && targetMode !== 'auto') {
        return { success: false, error: 'Invalid execute mode' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.approvePlan !== 'function') {
        return { success: false, error: 'Plans are not supported by this agent' }
      }
      return await agent.approvePlan(sessionId, planId, targetMode)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc(
  'agent:plan:reject',
  async (_event, workspaceDir: string, sessionId: string, planId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.rejectPlan !== 'function') {
        return { success: false, error: 'Plans are not supported by this agent' }
      }
      return await agent.rejectPlan(sessionId, planId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc('agent:session:stats', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.getSessionStats !== 'function') {
      return { success: false, error: 'Session stats are not supported by this agent' }
    }
    return await agent.getSessionStats(sessionId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('agent:session:settings', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.getSessionSettings !== 'function') {
      return { success: false, error: 'Session settings are not supported by this agent' }
    }
    return await agent.getSessionSettings(sessionId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc(
  'agent:session:setPermission',
  async (_event, workspaceDir: string, sessionId: string, permission: unknown) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.setSessionPermission !== 'function') {
        return { success: false, error: 'Session permissions are not supported by this agent' }
      }
      return await agent.setSessionPermission(sessionId, permission)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc(
  'agent:session:setModel',
  async (_event, workspaceDir: string, sessionId: string, modelId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (typeof modelId !== 'string' || !modelId) {
        return { success: false, error: 'Invalid model id' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.setSessionModel !== 'function') {
        return { success: false, error: 'Model switching is not supported by this agent' }
      }
      return await agent.setSessionModel(sessionId, modelId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc(
  'agent:session:setThinking',
  async (_event, workspaceDir: string, sessionId: string, level: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.setSessionThinking !== 'function') {
        return { success: false, error: 'Thinking control is not supported by this agent' }
      }
      return await agent.setSessionThinking(sessionId, level)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc(
  'agent:sessions:rename',
  async (_event, workspaceDir: string, sessionId: string, name: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.renameSession !== 'function') {
        return { success: false, error: 'Sessions are not supported by this agent' }
      }
      return await agent.renameSession(sessionId, name)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc('agent:sessions:delete', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.deleteSession !== 'function') {
      return { success: false, error: 'Sessions are not supported by this agent' }
    }
    return await agent.deleteSession(sessionId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// 会话标签持久化（按工作区）
handleIpc('agent:sessions:getTabs', async (_event, workspaceDir: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const file = path.join(workspaceDir, '.pi-workbench', 'chat-tabs.json')
    const result = readJsonWithBackup<{ open?: string[]; active?: string | null }>(file)
    if (!result.data) {
      return { success: true, tabs: { open: [], active: null } }
    }
    const open = Array.isArray(result.data.open)
      ? result.data.open.filter((id): id is string => typeof id === 'string')
      : []
    const active = typeof result.data.active === 'string' ? result.data.active : null
    return { success: true, tabs: { open, active } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc(
  'agent:sessions:setTabs',
  async (_event, workspaceDir: string, tabs: { open?: string[]; active?: string | null }) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const open = Array.isArray(tabs?.open)
        ? tabs.open.filter((id): id is string => typeof id === 'string').slice(0, 20)
        : []
      const active = typeof tabs?.active === 'string' ? tabs.active : null
      const dir = path.join(workspaceDir, '.pi-workbench')
      await fs.mkdir(dir, { recursive: true })
      await writeJsonAtomic(path.join(dir, 'chat-tabs.json'), { open, active })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// Agent 清理
handleIpc('agent:dispose', async (_event, workspaceDir?: string) => {
  try {
    if (workspaceDir && !isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    if (workspaceDir) {
      await agentRegistry.dispose(workspaceDir)
      approvalBroker.cancelForWorkspace(workspaceDir)
      console.log('[Main] Agent disposed:', workspaceDir)
    }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// 工具审批响应：渲染层选择“允许一次 / 本会话 / 始终 / 拒绝”
handleIpc('agent:approval:respond', async (_event, requestId: unknown, decision: unknown) => {
  if (typeof requestId !== 'string' || !requestId) {
    return { success: false, error: 'Invalid approval request id' }
  }
  const sanitized = sanitizeApprovalDecision(decision)
  if (!sanitized) {
    return { success: false, error: 'Invalid approval decision' }
  }
  const delivered = approvalBroker.respond(requestId, sanitized)
  if (!delivered) {
    return { success: false, error: 'Approval request is no longer pending' }
  }
  return { success: true }
})
