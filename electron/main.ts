import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null

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

