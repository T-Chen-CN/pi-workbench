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
  RecentWorkspacesResult,
  PluginsListResult,
  PluginCommandResult,
  FleetCreateResult,
  FleetListResult,
  FleetGetResult,
  FleetActionResult,
  FleetTask,
  TerminalCreateResult,
  TerminalResult,
  TerminalOutputResult,
} from '../types/electron'

// Mock API for browser development
const MOCK_CONFIG_KEY = 'pi-workbench-api-config'
const MOCK_SETTINGS_KEY = 'pi-workbench-settings'

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
  deletePath: async (targetPath: string): Promise<WorkspaceResult> => {
    console.log('[Mock] deletePath:', targetPath)
    return { success: true }
  },
  renamePath: async (oldPath: string, newPath: string): Promise<WorkspaceResult> => {
    console.log('[Mock] renamePath:', oldPath, '->', newPath)
    return { success: true }
  },
  watchWorkspace: async (workspacePath: string): Promise<WorkspaceResult> => {
    console.log('[Mock] watchWorkspace:', workspacePath)
    return { success: true }
  },
  unwatchWorkspace: async (): Promise<WorkspaceResult> => {
    return { success: true }
  },
  onFsChanged: (_callback: (payload: { type: string; path: string }) => void) => {
    // Web 开发模式没有文件监听
    return () => {}
  },
  getAppDir: async (): Promise<GetAppDirResult> => {
    console.log('[Mock] getAppDir')
    return { success: true, appDir: '/mock/app/dir' }
  },
  getSettings: async (): Promise<GetSettingsResult> => {
    const defaults = {
      language: 'zh',
      theme: 'dark',
      autoSave: true,
      autoSaveDelay: 2000,
    }
    try {
      const saved = localStorage.getItem(MOCK_SETTINGS_KEY)
      return { success: true, settings: saved ? { ...defaults, ...JSON.parse(saved) } : defaults }
    } catch {
      return { success: true, settings: defaults }
    }
  },
  saveSettings: async (settings: any): Promise<SaveSettingsResult> => {
    localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify(settings))
    return { success: true }
  },
  getRecentWorkspaces: async (): Promise<RecentWorkspacesResult> => {
    try {
      const saved = localStorage.getItem('pi-workbench-recent-workspaces')
      return { success: true, workspaces: saved ? JSON.parse(saved) : [] }
    } catch {
      return { success: true, workspaces: [] }
    }
  },
  addRecentWorkspace: async (workspacePath: string): Promise<RecentWorkspacesResult> => {
    let existing: string[] = []
    try {
      existing = JSON.parse(localStorage.getItem('pi-workbench-recent-workspaces') || '[]')
    } catch { /* ignore */ }
    const workspaces = [workspacePath, ...existing.filter(p => p !== workspacePath)].slice(0, 10)
    localStorage.setItem('pi-workbench-recent-workspaces', JSON.stringify(workspaces))
    return { success: true, workspaces }
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
  disposeWorkspace: async (workspacePath: string): Promise<WorkspaceResult> => {
    console.log('[Mock] disposeWorkspace:', workspacePath)
    return { success: true }
  },

  apiConfigGet: async (): Promise<ApiConfigGetResult> => {
    console.log('[Mock] apiConfigGet')
    try {
      const saved = localStorage.getItem(MOCK_CONFIG_KEY)
      if (saved) {
        const config = JSON.parse(saved)
        // 只支持 OpenAI 兼容渠道；旧版供应商配置在 Web 模式下同样作废
        if (config?.provider === 'custom') {
          return { success: true, config }
        }
        localStorage.removeItem(MOCK_CONFIG_KEY)
      }
    } catch (error) {
      console.warn('[Mock] Failed to read saved config:', error)
    }
    return {
      success: true,
      config: {
        provider: 'custom',
        apiUrl: '',
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

  // Workbench plugins（Web 模式没有主进程，返回空列表）
  pluginsList: async (): Promise<PluginsListResult> => ({ success: true, plugins: [] }),
  pluginsInvoke: async (): Promise<PluginCommandResult> => ({
    success: false,
    error: 'Plugins are only available in the Electron app',
  }),
  pluginsReload: async (): Promise<PluginsListResult> => ({ success: true, plugins: [] }),
  pluginsSetEnabled: async (): Promise<PluginsListResult> => ({ success: true, plugins: [] }),
  onPluginsChanged: (_callback: (payload: { workspaceDir: string }) => void) => () => {},

  // Fleet tasks（Web 模式不可用）
  fleetCreate: async (): Promise<FleetCreateResult> => ({
    success: false,
    error: 'Fleet tasks are only available in the Electron app',
  }),
  fleetList: async (): Promise<FleetListResult> => ({ success: true, tasks: [] }),
  fleetGet: async (): Promise<FleetGetResult> => ({
    success: false,
    error: 'Fleet tasks are only available in the Electron app',
  }),
  fleetCancel: async (): Promise<FleetActionResult> => ({
    success: false,
    error: 'Fleet tasks are only available in the Electron app',
  }),
  fleetCleanup: async (): Promise<FleetActionResult> => ({
    success: false,
    error: 'Fleet tasks are only available in the Electron app',
  }),
  onFleetTaskUpdated: (_callback: (task: FleetTask) => void) => () => {},

  // Terminal（Web 模式没有 PTY，返回失败而不是抛异常）
  terminalCreate: async (): Promise<TerminalCreateResult> => ({
    success: false,
    error: 'Terminal is only available in the Electron app',
  }),
  terminalWrite: async (): Promise<TerminalResult> => ({ success: false }),
  terminalResize: async (): Promise<TerminalResult> => ({ success: false }),
  terminalClose: async (): Promise<TerminalResult> => ({ success: false }),
  terminalFlush: async (): Promise<TerminalResult> => ({ success: false }),
  terminalGetRecentOutput: async (): Promise<TerminalOutputResult> => ({
    success: false,
    output: '',
    error: 'Terminal is only available in the Electron app',
  }),
  onTerminalData: (_callback: (payload: { id: string; data: string }) => void) => () => {},
  onTerminalExit: (_callback: (payload: { id: string; exitCode: number }) => void) => () => {},
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
  deletePath: (path: string) => electronAPI.deletePath(path),
  renamePath: (oldPath: string, newPath: string) => electronAPI.renamePath(oldPath, newPath),
  watchWorkspace: (workspacePath: string) => electronAPI.watchWorkspace(workspacePath),
  unwatchWorkspace: () => electronAPI.unwatchWorkspace(),
  onFsChanged: (callback: (payload: { type: string; path: string }) => void) =>
    electronAPI.onFsChanged(callback),

  // App configuration (portable architecture)
  getAppDir: () => electronAPI.getAppDir(),
  getSettings: () => electronAPI.getSettings(),
  saveSettings: (settings: any) => electronAPI.saveSettings(settings),
  getRecentWorkspaces: () => electronAPI.getRecentWorkspaces(),
  addRecentWorkspace: (workspacePath: string) => electronAPI.addRecentWorkspace(workspacePath),

  // Workspace configuration
  initWorkspace: (workspacePath: string) => electronAPI.initWorkspace(workspacePath),
  getWorkspaceConfig: (workspacePath: string) => electronAPI.getWorkspaceConfig(workspacePath),
  saveWorkspaceConfig: (workspacePath: string, config: any) => electronAPI.saveWorkspaceConfig(workspacePath, config),
  disposeWorkspace: (workspacePath: string) => electronAPI.disposeWorkspace(workspacePath),

  // API Configuration management (portable architecture)
  apiConfigGet: () => electronAPI.apiConfigGet(),
  apiConfigSave: (config: any) => electronAPI.apiConfigSave(config),
  apiConfigFetchModels: (apiUrl: string, apiKey: string, provider: ApiProvider) =>
    electronAPI.apiConfigFetchModels(apiUrl, apiKey, provider),

  // Workbench plugins
  pluginsList: (workspaceDir: string) => electronAPI.pluginsList(workspaceDir),
  pluginsInvoke: (workspaceDir: string, commandId: string, args?: unknown) =>
    electronAPI.pluginsInvoke(workspaceDir, commandId, args),
  pluginsReload: (workspaceDir: string) => electronAPI.pluginsReload(workspaceDir),
  pluginsSetEnabled: (workspaceDir: string, pluginId: string, enabled: boolean) =>
    electronAPI.pluginsSetEnabled(workspaceDir, pluginId, enabled),
  onPluginsChanged: (callback: (payload: { workspaceDir: string }) => void) =>
    electronAPI.onPluginsChanged(callback),

  // Fleet tasks
  fleetCreate: (workspaceDir: string, name: string, prompt: string) =>
    electronAPI.fleetCreate(workspaceDir, name, prompt),
  fleetList: (workspaceDir: string) => electronAPI.fleetList(workspaceDir),
  fleetGet: (id: string) => electronAPI.fleetGet(id),
  fleetCancel: (id: string, workspaceDir?: string) => electronAPI.fleetCancel(id, workspaceDir),
  fleetCleanup: (id: string, workspaceDir?: string) => electronAPI.fleetCleanup(id, workspaceDir),
  onFleetTaskUpdated: (callback: (task: FleetTask) => void) =>
    electronAPI.onFleetTaskUpdated(callback),

  // Terminal
  terminalCreate: (workspaceDir: string, cols: number, rows: number) =>
    electronAPI.terminalCreate(workspaceDir, cols, rows),
  terminalWrite: (id: string, data: string) => electronAPI.terminalWrite(id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    electronAPI.terminalResize(id, cols, rows),
  terminalClose: (id: string) => electronAPI.terminalClose(id),
  terminalFlush: (id: string) => electronAPI.terminalFlush(id),
  terminalGetRecentOutput: (id: string) => electronAPI.terminalGetRecentOutput(id),
  onTerminalData: (callback: (payload: { id: string; data: string }) => void) =>
    electronAPI.onTerminalData(callback),
  onTerminalExit: (callback: (payload: { id: string; exitCode: number }) => void) =>
    electronAPI.onTerminalExit(callback),
}

