import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
// Lazy load AgentManager to avoid early import errors
// import { AgentManager } from '../pi-bridge/dist/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
let agentManager: any | null = null // AgentManager type loaded dynamically

// 便携式架构：获取应用目录
function getAppDir(): string {
  if (app.isPackaged) {
    // 生产模式：可执行文件所在目录
    return path.dirname(app.getPath('exe'))
  } else {
    // 开发模式：项目根目录
    return process.cwd()
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../app-icon.png'),
  })

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

ipcMain.handle('app:getSettings', async () => {
  try {
    const settingsPath = path.join(getAppDir(), 'config', 'settings.json')

    if (!existsSync(settingsPath)) {
      // 返回默认配置
      const defaultSettings = {
        language: 'zh-CN',
        theme: 'dark',
        autoSave: true,
        autoSaveDelay: 2000
      }
      return { success: true, settings: defaultSettings }
    }

    const content = await fs.readFile(settingsPath, 'utf-8')
    const settings = JSON.parse(content)
    return { success: true, settings }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('app:saveSettings', async (_event, settings: any) => {
  try {
    const settingsPath = path.join(getAppDir(), 'config', 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
    return { success: true }
  } catch (error) {
    return {
      success: false,
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
          model: 'claude-3-5-sonnet',
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

// Default API configurations
const DEFAULT_API_CONFIGS: Record<string, { url: string; models: string[] }> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-sonnet-20240229']
  },
  openai: {
    url: 'https://api.openai.com/v1',
    models: ['gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo']
  }
}

// Helper function to load API Config
async function loadApiConfig(): Promise<any> {
  try {
    const appDir = getAppDir()
    const configPath = path.join(appDir, 'config', 'api-config.json')

    if (!existsSync(configPath)) {
      // Return default Anthropic config
      return {
        provider: 'anthropic',
        apiUrl: DEFAULT_API_CONFIGS.anthropic.url,
        apiKey: '',
        availableModels: DEFAULT_API_CONFIGS.anthropic.models,
        selectedModel: DEFAULT_API_CONFIGS.anthropic.models[0]
      }
    }

    const content = await fs.readFile(configPath, 'utf-8')
    const config = JSON.parse(content)
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

    // TODO: 后续版本添加 API Key 的 AES 加密
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))

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
    console.log(`[Main] Fetching models from ${provider}...`)

    let models: string[] = []

    if (provider === 'anthropic') {
      // Anthropic doesn't have a models API, return known models
      models = DEFAULT_API_CONFIGS.anthropic.models
    } else if (provider === 'openai') {
      // Call OpenAI /v1/models endpoint
      const response = await fetch(`${apiUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.statusText}`)
      }

      const data: any = await response.json()
      models = data.data.map((m: any) => m.id)
    } else {
      // For custom providers, try OpenAI-compatible format
      try {
        const response = await fetch(`${apiUrl}/models`, {
          headers: {
            'Authorization': `Bearer ${apiKey}`
          }
        })

        if (response.ok) {
          const data: any = await response.json()
          models = data.data.map((m: any) => m.id)
        } else {
          // If /models fails, return empty array
          models = []
        }
      } catch {
        models = []
      }
    }

    return { success: true, models }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
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

    // 创建新的 Agent Manager 实例
    agentManager = new AgentManager()

    // 初始化 Agent（传入完整的 apiConfig）
    const result = await agentManager.initialize({
      workspaceDir: config.workspaceDir,
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

    const history = agentManager.getMessageHistory()
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

// API Key 管理（加密存储）
ipcMain.handle('apiKey:save', async (_event, provider: string, apiKey: string) => {
  try {
    const apiKeysPath = path.join(getAppDir(), 'config', 'api-keys.json')

    let apiKeys: Record<string, string> = {}

    // 读取现有的 API Keys
    if (existsSync(apiKeysPath)) {
      const content = await fs.readFile(apiKeysPath, 'utf-8')
      apiKeys = JSON.parse(content)
    }

    // 更新 API Key
    apiKeys[provider] = apiKey

    // 保存（TODO: 后续可以添加加密）
    await fs.writeFile(apiKeysPath, JSON.stringify(apiKeys, null, 2), 'utf-8')

    console.log(`[Main] API Key saved for provider: ${provider}`)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

ipcMain.handle('apiKey:load', async (_event, provider: string) => {
  try {
    const apiKeysPath = path.join(getAppDir(), 'config', 'api-keys.json')

    if (!existsSync(apiKeysPath)) {
      return { success: true, apiKey: null }
    }

    const content = await fs.readFile(apiKeysPath, 'utf-8')
    const apiKeys = JSON.parse(content)

    return { success: true, apiKey: apiKeys[provider] || null }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

