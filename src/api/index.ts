/**
 * Unified API layer for Electron
 * Portable Architecture: All app data stored in application directory
 */

import type {
  OpenDirectoryResult,
  ListDirectoryResult,
  ReadFileResult,
  WriteFileResult,
  ExistsResult,
  StatResult,
  GetAppDirResult,
  GetSettingsResult,
  SaveSettingsResult,
  WorkspaceResult,
  GetWorkspaceConfigResult,
  ApiConfigGetResult,
  ApiConfigSaveResult,
  FetchModelsResult,
  ApiProvider,
} from '../types/electron'

// Mock API for browser development
const MOCK_CONFIG_KEY = 'pi-workbench-api-config'

const mockAPI = {
  openDirectoryDialog: async (): Promise<OpenDirectoryResult> => {
    console.log('[Mock] openDirectoryDialog')
    return { success: true, path: '/mock/selected/path' }
  },
  listDirectory: async (dirPath: string): Promise<ListDirectoryResult> => {
    console.log('[Mock] listDirectory:', dirPath)
    return {
      success: true,
      items: [
        { name: 'src', path: '/mock/src', isDirectory: true },
        { name: 'package.json', path: '/mock/package.json', isDirectory: false },
      ]
    }
  },
  readFile: async (filePath: string): Promise<ReadFileResult> => {
    console.log('[Mock] readFile:', filePath)
    return { success: true, content: `// Mock content for ${filePath}` }
  },
  writeFile: async (filePath: string, content: string): Promise<WriteFileResult> => {
    console.log('[Mock] writeFile:', filePath, content.length, 'bytes')
    return { success: true }
  },
  exists: async (filePath: string): Promise<ExistsResult> => {
    console.log('[Mock] exists:', filePath)
    return { success: true, exists: true }
  },
  stat: async (filePath: string): Promise<StatResult> => {
    console.log('[Mock] stat:', filePath)
    return { success: true, isFile: true, isDirectory: false, size: 1024 }
  },
  getAppDir: async (): Promise<GetAppDirResult> => {
    console.log('[Mock] getAppDir')
    return { success: true, appDir: '/mock/app/dir' }
  },
  getSettings: async (): Promise<GetSettingsResult> => {
    console.log('[Mock] getSettings')
    return {
      success: true,
      settings: {
        language: 'zh-CN',
        theme: 'dark',
        autoSave: true,
        autoSaveDelay: 2000
      }
    }
  },
  saveSettings: async (settings: any): Promise<SaveSettingsResult> => {
    console.log('[Mock] saveSettings:', settings)
    return { success: true }
  },
  initWorkspace: async (workspacePath: string): Promise<WorkspaceResult> => {
    console.log('[Mock] initWorkspace:', workspacePath)
    return { success: true }
  },
  getWorkspaceConfig: async (workspacePath: string): Promise<GetWorkspaceConfigResult> => {
    console.log('[Mock] getWorkspaceConfig:', workspacePath)
    return {
      success: true,
      config: {
        version: '1.0',
        enabledPlugins: [],
        agentConfig: {
          model: '',
          temperature: 0.7
        }
      }
    }
  },
  saveWorkspaceConfig: async (workspacePath: string, config: any): Promise<WorkspaceResult> => {
    console.log('[Mock] saveWorkspaceConfig:', workspacePath, config)
    return { success: true }
  },

  apiConfigGet: async (): Promise<ApiConfigGetResult> => {
    console.log('[Mock] apiConfigGet')
    try {
      const saved = localStorage.getItem(MOCK_CONFIG_KEY)
      if (saved) {
        return { success: true, config: JSON.parse(saved) }
      }
    } catch (error) {
      console.warn('[Mock] Failed to read saved config:', error)
    }
    return {
      success: true,
      config: {
        provider: 'anthropic',
        apiUrl: 'https://api.anthropic.com/v1',
        apiKey: '',
        availableModels: [],
        selectedModel: ''
      }
    }
  },
  apiConfigSave: async (config: any): Promise<ApiConfigSaveResult> => {
    console.log('[Mock] apiConfigSave:', config.provider)
    localStorage.setItem(MOCK_CONFIG_KEY, JSON.stringify(config))
    return { success: true }
  },
  apiConfigFetchModels: async (apiUrl: string, apiKey: string, provider: string): Promise<FetchModelsResult> => {
    console.log('[Mock] apiConfigFetchModels via dev proxy:', provider)
    // 纯 Web 模式下走 Vite dev server 代理，真实请求供应商的 /models
    try {
      const response = await fetch(
        `/__pi/fetch-models?apiUrl=${encodeURIComponent(apiUrl)}&provider=${encodeURIComponent(provider)}`,
        { headers: { 'x-pi-api-key': apiKey } }
      )
      const result = await response.json()
      return result as FetchModelsResult
    } catch (error) {
      return {
        success: false,
        models: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  },
}

const electronAPI = window.electronAPI || mockAPI

if (!window.electronAPI) {
  console.warn(
    '[API] window.electronAPI is undefined — falling back to mock API. ' +
    'In Electron this usually means the preload script failed to load.'
  )
}

export const api = {
  // File system operations
  openDirectoryDialog: () => electronAPI.openDirectoryDialog(),
  listDirectory: (path: string) => electronAPI.listDirectory(path),
  readFile: (path: string) => electronAPI.readFile(path),
  writeFile: (path: string, content: string) => electronAPI.writeFile(path, content),
  exists: (path: string) => electronAPI.exists(path),
  stat: (path: string) => electronAPI.stat(path),

  // App configuration (portable architecture)
  getAppDir: () => electronAPI.getAppDir(),
  getSettings: () => electronAPI.getSettings(),
  saveSettings: (settings: any) => electronAPI.saveSettings(settings),

  // Workspace configuration
  initWorkspace: (workspacePath: string) => electronAPI.initWorkspace(workspacePath),
  getWorkspaceConfig: (workspacePath: string) => electronAPI.getWorkspaceConfig(workspacePath),
  saveWorkspaceConfig: (workspacePath: string, config: any) => electronAPI.saveWorkspaceConfig(workspacePath, config),

  // API Configuration management (portable architecture)
  apiConfigGet: () => electronAPI.apiConfigGet(),
  apiConfigSave: (config: any) => electronAPI.apiConfigSave(config),
  apiConfigFetchModels: (apiUrl: string, apiKey: string, provider: ApiProvider) =>
    electronAPI.apiConfigFetchModels(apiUrl, apiKey, provider),
}

