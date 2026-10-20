import { app, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import { fileURLToPath, pathToFileURL } from 'url'
import { createRequire } from 'module'
import { existsSync, statSync, watch, type FSWatcher } from 'fs'
import { isIgnoredWatchPath } from './watch-filter.js'
import { FileLogger, installConsoleTee } from './logger.js'
import { AgentRegistry } from './agent-registry.js'
import { TerminalManager } from './terminal-manager.js'
import { PluginManager } from './plugin-manager.js'
// Lazy load AgentManager to avoid early import errors
// import { AgentManager } from '../pi-bridge/dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
/** 每个打开的工作区一个 Agent 实例 */
const agentRegistry = new AgentRegistry()
let workspaceWatcher: FSWatcher | null = null
let watchDebounce: NodeJS.Timeout | null = null
let fileLogger: FileLogger | null = null

const requireFromMain = createRequire(import.meta.url)
let ptyModule: typeof import('node-pty') | null = null

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
  logPathFor: (workspaceDir) => path.join(workspaceDir, '.pi-workbench', 'terminal.log'),
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

// 便携式架构：获取应用目录
function getAppDir(): string {
  if (app.isPackaged) {
    // 生产模式：可执行文件所在目录
    return path.dirname(app.getPath('exe'))
  } else {
    // 开发模式：项目根目录（比 process.cwd() 更稳定，不依赖启动目录）
    return app.getAppPath()
  }
}

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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../app-icon.png'),
  })

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
}

app.whenReady().then(async () => {
  // 先启用文件日志，后续初始化与 Agent 日志都会落盘（打包后没有控制台）
  try {
    fileLogger = new FileLogger({ logDir: path.join(getAppDir(), 'logs') })
    installConsoleTee(fileLogger)
    console.log('[Main] File logging enabled:', fileLogger.filePath)
  } catch (error) {
    console.error('[Main] Failed to enable file logging:', error)
  }

  await initAppDirectories()
  createWindow()
})

app.on('will-quit', () => {
  fileLogger?.close()
  terminalManager.closeAll()
  pluginManager.disposeAll()
  void agentRegistry.disposeAll()
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
ipcMain.handle('dialog:openDirectory', async () => {
  if (!mainWindow) return { success: false, error: 'No window available' }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  })

  return {
    success: true,
    canceled: result.canceled,
    path: result.filePaths[0]
  }
})

ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return { success: true, content }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('fs:writeFile', async (_event, filePath: string, content: string) => {
  try {
    await fs.writeFile(filePath, content, 'utf-8')
    const workspaceDir = workspaceForPath(filePath)
    if (workspaceDir) {
      void pluginManager.emit(workspaceDir, 'file:saved', { path: filePath })
    }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('fs:listDirectory', async (_event, dirPath: string) => {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const items = entries.map(entry => ({
      name: entry.name,
      path: path.join(dirPath, entry.name),
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

ipcMain.handle('fs:exists', async (_event, filePath: string) => {
  try {
    return { success: true, exists: existsSync(filePath) }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('fs:stat', async (_event, filePath: string) => {
  try {
    const stats = statSync(filePath)
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

ipcMain.handle('fs:delete', async (_event, targetPath: string) => {
  try {
    await fs.rm(targetPath, { recursive: true, force: false })
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('fs:rename', async (_event, oldPath: string, newPath: string) => {
  try {
    await fs.rename(oldPath, newPath)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// 工作区文件监听（递归，忽略依赖/构建/应用数据目录）
ipcMain.handle('fs:watch', async (event, workspacePath: string) => {
  try {
    if (workspaceWatcher) {
      workspaceWatcher.close()
      workspaceWatcher = null
    }

    const sender = event.sender

    workspaceWatcher = watch(workspacePath, { recursive: true }, (eventType, filename) => {
      if (!filename || isIgnoredWatchPath(filename)) return
      if (watchDebounce) clearTimeout(watchDebounce)
      watchDebounce = setTimeout(() => {
        if (!sender.isDestroyed()) {
          sender.send('fs:changed', {
            type: eventType,
            path: path.join(workspacePath, filename)
          })
        }
      }, 300)
    })

    workspaceWatcher.on('error', (error) => {
      console.error('[Main] Workspace watcher error:', error)
    })

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('fs:unwatch', async () => {
  try {
    if (watchDebounce) {
      clearTimeout(watchDebounce)
      watchDebounce = null
    }
    if (workspaceWatcher) {
      workspaceWatcher.close()
      workspaceWatcher = null
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

ipcMain.handle('terminal:create', async (_event, workspaceDir: string, cols: number, rows: number) =>
  terminalManager.create(workspaceDir, cols, rows)
)

ipcMain.handle('terminal:write', async (_event, id: string, data: string) => ({
  success: terminalManager.write(id, data),
}))

ipcMain.handle('terminal:resize', async (_event, id: string, cols: number, rows: number) => ({
  success: terminalManager.resize(id, cols, rows),
}))

ipcMain.handle('terminal:close', async (_event, id: string) => ({
  success: terminalManager.close(id),
}))

ipcMain.handle('terminal:flush', async (_event, id: string) => ({
  success: terminalManager.flushNow(id),
}))

ipcMain.handle('terminal:getRecentOutput', async (_event, id: string) => ({
  success: true,
  output: terminalManager.getRecentOutput(id),
}))

// ---- 工作台插件 ----

ipcMain.handle('plugins:list', async (_event, workspaceDir: string) => {
  try {
    return { success: true, plugins: pluginManager.list(workspaceDir) }
  } catch (error) {
    return {
      success: false,
      plugins: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('plugins:invoke', async (_event, workspaceDir: string, commandId: string, args?: unknown) =>
  pluginManager.invoke(workspaceDir, commandId, args)
)

ipcMain.handle('plugins:reload', async (_event, workspaceDir: string) => {
  try {
    return { success: true, plugins: pluginManager.reload(workspaceDir) }
  } catch (error) {
    return {
      success: false,
      plugins: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle(
  'plugins:setEnabled',
  async (_event, workspaceDir: string, pluginId: string, enabled: boolean) => {
    try {
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

// 便携式架构：应用配置管理
ipcMain.handle('app:getAppDir', async () => {
  try {
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
  language: 'zh-CN',
  theme: 'dark',
  autoSave: true,
  autoSaveDelay: 2000,
  recentWorkspaces: [] as string[],
}

async function loadSettingsFile(): Promise<any> {
  const settingsPath = path.join(getAppDir(), 'config', 'settings.json')
  if (!existsSync(settingsPath)) {
    return { ...DEFAULT_SETTINGS }
  }
  const content = await fs.readFile(settingsPath, 'utf-8')
  return { ...DEFAULT_SETTINGS, ...JSON.parse(content) }
}

async function saveSettingsFile(settings: any): Promise<void> {
  const settingsPath = path.join(getAppDir(), 'config', 'settings.json')
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
}

ipcMain.handle('app:getSettings', async () => {
  try {
    return { success: true, settings: await loadSettingsFile() }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('app:saveSettings', async (_event, settings: any) => {
  try {
    await saveSettingsFile(settings)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('app:getRecentWorkspaces', async () => {
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

ipcMain.handle('app:addRecentWorkspace', async (_event, workspacePath: string) => {
  try {
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
ipcMain.handle('workspace:init', async (_event, workspacePath: string) => {
  try {
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
        agentConfig: {
          // 模型由应用级 API 配置决定，工作区不再写死默认模型
          temperature: 0.7
        }
      }
      await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8')
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

ipcMain.handle('workspace:getConfig', async (_event, workspacePath: string) => {
  try {
    const configPath = path.join(workspacePath, '.pi-workbench', 'config.json')

    if (!existsSync(configPath)) {
      return { success: false, error: 'Workspace not initialized' }
    }

    const content = await fs.readFile(configPath, 'utf-8')
    const config = JSON.parse(content)
    return { success: true, config }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('workspace:saveConfig', async (_event, workspacePath: string, config: any) => {
  try {
    const configPath = path.join(workspacePath, '.pi-workbench', 'config.json')
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// 关闭工作区标签时释放该工作区的主进程资源（插件、监听）
ipcMain.handle('workspace:dispose', async (_event, workspacePath: string) => {
  try {
    pluginManager.unload(workspacePath)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
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

// Helper function to load API Config
async function loadApiConfig(): Promise<any> {
  try {
    const appDir = getAppDir()
    const configPath = path.join(appDir, 'config', 'api-config.json')

    if (!existsSync(configPath)) {
      // Return minimal default config (no hardcoded models)
      return {
        provider: 'anthropic',
        apiUrl: 'https://api.anthropic.com/v1',
        apiKey: '',
        availableModels: [],  // Empty by default, user must fetch
        selectedModel: ''
      }
    }

    const content = await fs.readFile(configPath, 'utf-8')
    const config = JSON.parse(content)
    config.apiKey = decryptApiKey(config.apiKey)
    return config
  } catch (error) {
    console.error('[Main] Failed to load API config:', error)
    return null
  }
}

// Get API Configuration
ipcMain.handle('apiConfig:get', async () => {
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
ipcMain.handle('apiConfig:save', async (_event, config: any) => {
  try {
    const appDir = getAppDir()
    const configPath = path.join(appDir, 'config', 'api-config.json')

    const stored = {
      ...config,
      apiKey: encryptApiKey(String(config?.apiKey ?? '')),
    }
    await fs.writeFile(configPath, JSON.stringify(stored, null, 2), 'utf-8')

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// Fetch available models from API
ipcMain.handle('apiConfig:fetchModels', async (_event, apiUrl: string, apiKey: string, provider: string) => {
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

    const response = await fetch(modelsEndpoint, { headers })
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
ipcMain.handle('agent:initialize', async (_event, config: {
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
ipcMain.handle('agent:chat', async (event, message: string, requestId?: string, workspaceDir?: string) => {
  try {
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

// Agent 状态查询
ipcMain.handle('agent:isInitialized', async (_event, workspaceDir?: string) => {
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
ipcMain.handle('agent:getHistory', async (_event, workspaceDir?: string) => {
  try {
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
ipcMain.handle('agent:dispose', async (_event, workspaceDir?: string) => {
  try {
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
