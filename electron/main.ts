import { app, BrowserWindow, ipcMain, dialog, safeStorage, type IpcMainInvokeEvent } from 'electron'
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
import { FleetWorktree } from './fleet-worktree.js'
import { createFleetStore } from './fleet-store.js'
import { FleetManager } from './fleet-manager.js'
import { DraftStore } from './draft-store.js'
import type { UpdateController } from './updater.js'
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

// 只允许一个实例：避免两个进程同时写同一份配置和 Fleet 数据库。
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

/** 每个打开的工作区一个 Agent 实例 */
const agentRegistry = new AgentRegistry()
let fileLogger: FileLogger | null = null
let rendererLogger: FileLogger | null = null

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

const fleetStore = createFleetStore(path.join(getAppDir(), 'data', 'fleet-tasks.db'))
const draftStore = new DraftStore(path.join(getAppDir(), 'cache', 'drafts'))
const fleetManager = new FleetManager({
  store: fleetStore,
  worktrees: new FleetWorktree(),
  createAgent: async () => {
    const bridgePath = path.join(__dirname, '..', 'pi-bridge', 'dist', 'index.js')
    const { AgentManager } = await import(pathToFileURL(bridgePath).href)
    return new AgentManager()
  },
  getApiConfig: async () => {
    const config = await loadApiConfig()
    if (!config?.apiKey) return null
    return {
      provider: config.provider,
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      selectedModel: config.selectedModel,
    }
  },
  agentDir: path.join(getAppDir(), 'data', 'agent'),
  logDir: path.join(getAppDir(), 'logs'),
  onUpdate: (task) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fleet:task-updated', task)
    }
  },
})

// 便携式架构：获取应用目录
function getAppDir(): string {
  // AppImage：可执行文件位于只读挂载点，数据放在 .AppImage 文件旁边
  if (process.env.APPIMAGE) {
    return path.dirname(process.env.APPIMAGE)
  }
  if (app.isPackaged) {
    // 生产模式：可执行文件所在目录
    return path.dirname(app.getPath('exe'))
  } else {
    // 开发模式：项目根目录（比 process.cwd() 更稳定，不依赖启动目录）
    return app.getAppPath()
  }
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

  console.log('应用目录已初始化:', appDir)
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

  // 渲染进程 beforeunload 阻止关闭时，Electron 会保持窗口打开但不给用户任何提示。
  // 这里用原生对话框把选择权交给用户；确认放弃后才允许卸载（will-prevent-unload）。
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (typeof dialog.showMessageBoxSync !== 'function') {
      event.preventDefault()
      return
    }
    const zh = app.getLocale?.().toLowerCase().startsWith('zh') ?? true
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: zh ? ['取消', '放弃修改并关闭'] : ['Cancel', 'Discard and close'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: zh ? '未保存的修改' : 'Unsaved changes',
      message: zh ? '有文件尚未保存。' : 'Some files have unsaved changes.',
      detail: zh ? '关闭窗口会丢失这些修改。' : 'Closing the window will discard them.',
    })
    if (choice === 1) {
      // 用户明确放弃未保存内容：清掉已加载工作区的草稿，避免下次启动又提示恢复
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
    installConsoleTee(fileLogger)
    console.log('[Main] File logging enabled:', fileLogger.filePath)
  } catch (error) {
    console.error('[Main] Failed to enable file logging:', error)
  }

  await initAppDirectories()
  await seedTrustedWorkspacesFromSettings()
  createWindow()

  // 应用 ready、safeStorage 可用之后再恢复上次排队的 Fleet 任务
  void fleetManager.resumeQueued().then((result) => {
    if (result.reason) {
      console.log('[Main] Fleet queue not resumed:', result.reason)
    } else if (result.resumed > 0) {
      console.log(`[Main] Resumed ${result.resumed} Fleet task(s)`)
    }
  })
})

let shuttingDown = false

/** 退出前等待异步资源释放，避免在任务仍写库时关闭 store */
async function shutdownApplication(): Promise<void> {
  try {
    closeAllWorkspaceWatchers()
    terminalManager.closeAll()
    pluginManager.disposeAll()
    await Promise.allSettled([fleetManager.disposeAll(), agentRegistry.disposeAll()])
  } catch (error) {
    console.error('[Main] Shutdown cleanup failed:', error)
  } finally {
    console.log('[Main] Shutdown complete')
    fileLogger?.close()
    rendererLogger?.close()
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

// ---- Fleet 后台任务 ----

handleIpc('fleet:create', async (_event, workspaceDir: string, name: string, prompt: string) => {
  if (!isTrustedWorkspacePath(workspaceDir)) {
    return { success: false, error: 'Workspace is not approved' }
  }
  return fleetManager.createTask(workspaceDir, name, prompt)
})

handleIpc('fleet:list', async (_event, workspaceDir: string) => {
  if (!isTrustedWorkspacePath(workspaceDir)) {
    return { success: false, tasks: [], error: 'Workspace is not approved' }
  }
  return { success: true, tasks: fleetManager.list(workspaceDir) }
})

handleIpc('fleet:get', async (_event, id: string) => {
  const task = fleetManager.get(id)
  return task ? { success: true, task } : { success: false, error: 'Task not found' }
})

handleIpc('fleet:cancel', async (_event, id: string, workspaceDir?: string) => {
  if (workspaceDir && !isTrustedWorkspacePath(workspaceDir)) {
    return { success: false, error: 'Workspace is not approved' }
  }
  return fleetManager.cancel(id, workspaceDir)
})

handleIpc('fleet:cleanup', async (_event, id: string, workspaceDir?: string) => {
  if (workspaceDir && !isTrustedWorkspacePath(workspaceDir)) {
    return { success: false, error: 'Workspace is not approved' }
  }
  return fleetManager.cleanupWorktree(id, workspaceDir)
})

// ---- 自动更新 ----

let updateController: UpdateController | null = null

/**
 * electron-updater 只在打包版本有意义；懒加载避免开发/测试环境引入其运行时。
 */
async function ensureUpdateController(): Promise<UpdateController | null> {
  if (!app.isPackaged) return null
  if (updateController) return updateController
  try {
    const { UpdateController: Controller } = await import('./updater.js')
    updateController = new Controller((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:status', status)
      }
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
    return { success: false, error: 'Updates are only available in packaged builds.' }
  }
  return controller.check()
})

handleIpc('update:download', async () => {
  const controller = await ensureUpdateController()
  if (!controller) {
    return { success: false, error: 'Updates are only available in packaged builds.' }
  }
  return controller.download()
})

handleIpc('update:install', async () => {
  const controller = await ensureUpdateController()
  if (!controller) {
    return { success: false, error: 'Updates are only available in packaged builds.' }
  }
  return controller.install()
})

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
    await saveSettingsFile(sanitized)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

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
    const workspaces: string[] = Array.isArray(settings.recentWorkspaces) ? settings.recentWorkspaces : []
    return { success: true, workspaces }
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
        error: 'Workspace is not approved. Open it with the Open Project dialog.'
      }
    }

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
}

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
      apiKey: encryptApiKey(String(config?.apiKey ?? '')),
    }
    await writeJsonAtomic(configPath, stored)
    activeProviderApiKey = String(config?.apiKey ?? '')
    // 配置好 Key 之后，恢复因缺少 Key 而停在队列中的 Fleet 任务
    void fleetManager.resumeQueued()

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
}): string {
  return JSON.stringify({
    provider: apiConfig.provider,
    apiUrl: apiConfig.apiUrl,
    selectedModel: apiConfig.selectedModel,
    apiKey: apiConfig.apiKey,
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
      apiConfig
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

// Agent 聊天
handleIpc('agent:chat', async (event, message: string, requestId?: string, workspaceDir?: string) => {
  try {
    if (workspaceDir && !isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = workspaceDir ? agentRegistry.get(workspaceDir) : null
    if (!agent) {
      return {
        success: false,
        error: 'Agent not initialized for this workspace. Please initialize agent first.'
      }
    }

    console.log('[Main] Sending message to agent:', message.substring(0, 100))
    if (workspaceDir) {
      void pluginManager.emit(workspaceDir, 'chat:message', { message })
    }

    // 流式文本增量推送给发起请求的窗口；requestId 用于渲染进程区分本次会话
    const result = await agent.chat(message, {
      onTextDelta: (delta: string) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('agent:stream', { requestId, delta })
        }
      },
    })

    if (result.success) {
      console.log('[Main] Agent response received')
    } else {
      console.error('[Main] Agent chat error:', result.error)
    }

    return result
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[Main] Agent chat error:', errorMessage)
    return {
      success: false,
      error: `Agent error: ${errorMessage}`
    }
  }
})

// Agent 中止当前请求
handleIpc('agent:abort', async (_event, workspaceDir?: string) => {
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
    await agent.abort()
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
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
handleIpc('agent:getHistory', async (_event, workspaceDir?: string) => {
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
      ? agent.getSessionMessages()
      : agent.getMessageHistory?.()
    return { success: true, history }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// Agent 清理
handleIpc('agent:dispose', async (_event, workspaceDir?: string) => {
  try {
    if (workspaceDir && !isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    if (workspaceDir) {
      await agentRegistry.dispose(workspaceDir)
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
