import { app, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import { existsSync, statSync, watch, type FSWatcher } from 'fs'
import { fileURLToPath } from 'url'
// Lazy load AgentManager to avoid early import errors
// import { AgentManager } from '../pi-bridge/dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
let agentManager: any | null = null // AgentManager type loaded dynamically
let workspaceWatcher: FSWatcher | null = null
let watchDebounce: NodeJS.Timeout | null = null

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
  await initAppDirectories()
  createWindow()
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
    const ignored = /(^|[\\/])(\.git|node_modules|\.pi-workbench|cache|dist|dist-electron|release)([\\/]|$)/

    workspaceWatcher = watch(workspacePath, { recursive: true }, (eventType, filename) => {
      if (!filename || ignored.test(filename)) return
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

// Agent 初始化
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
    console.log('[Main] Initializing Pi Agent with config:', {
      provider: config.apiConfig.provider,
      model: config.apiConfig.selectedModel,
      workspaceDir: config.workspaceDir
    })

    // 延迟加载 AgentManager
    const { AgentManager } = await import('../pi-bridge/dist/index.js')

    // 验证 API Key
    if (!config.apiConfig.apiKey) {
      return {
        success: false,
        error: 'API key not configured. Please set it in Settings.'
      }
    }

    // 重新初始化前先释放旧实例，避免会话/子进程泄漏
    if (agentManager) {
      try {
        await agentManager.dispose()
      } catch (error) {
        console.warn('[Main] Failed to dispose previous agent:', error)
      }
      agentManager = null
    }

    // 创建新的 Agent Manager 实例
    agentManager = new AgentManager()

    // 初始化 Agent（传入完整的 apiConfig + 便携式 agent 数据目录）
    const result = await agentManager.initialize({
      workspaceDir: config.workspaceDir,
      agentDir: path.join(getAppDir(), 'data', 'agent'),
      apiConfig: config.apiConfig
    })

    if (result.success) {
      console.log('[Main] Pi Agent initialized successfully')
    } else {
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
ipcMain.handle('agent:chat', async (_event, message: string) => {
  try {
    if (!agentManager) {
      return {
        success: false,
        error: 'Agent not initialized. Please initialize agent first.'
      }
    }

    console.log('[Main] Sending message to agent:', message.substring(0, 100))

    const result = await agentManager.chat(message)

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
ipcMain.handle('agent:isInitialized', async () => {
  try {
    const initialized = agentManager?.isInitialized() || false
    return { success: true, initialized }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// Agent 消息历史
ipcMain.handle('agent:getHistory', async () => {
  try {
    if (!agentManager) {
      return { success: false, error: 'Agent not initialized' }
    }

    // 返回持久化 Pi 会话中的可展示历史（跨重启恢复）
    const history = typeof agentManager.getSessionMessages === 'function'
      ? agentManager.getSessionMessages()
      : agentManager.getMessageHistory()
    return { success: true, history }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// Agent 清理
ipcMain.handle('agent:dispose', async () => {
  try {
    if (agentManager) {
      await agentManager.dispose()
      agentManager = null
      console.log('[Main] Agent disposed')
    }
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})
