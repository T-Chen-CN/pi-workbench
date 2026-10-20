import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // 文件系统操作
  openDirectoryDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),
  listDirectory: (path: string) => ipcRenderer.invoke('fs:listDirectory', path),
  exists: (path: string) => ipcRenderer.invoke('fs:exists', path),
  stat: (path: string) => ipcRenderer.invoke('fs:stat', path),
  deletePath: (path: string) => ipcRenderer.invoke('fs:delete', path),
  renamePath: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
  watchWorkspace: (workspacePath: string) => ipcRenderer.invoke('fs:watch', workspacePath),
  unwatchWorkspace: () => ipcRenderer.invoke('fs:unwatch'),
  onFsChanged: (callback: (payload: { type: string; path: string }) => void) => {
    const listener = (_event: unknown, payload: { type: string; path: string }) => callback(payload)
    ipcRenderer.on('fs:changed', listener)
    return () => ipcRenderer.removeListener('fs:changed', listener)
  },

  // 应用配置管理（便携式架构）
  getAppDir: () => ipcRenderer.invoke('app:getAppDir'),
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  saveSettings: (settings: any) => ipcRenderer.invoke('app:saveSettings', settings),
  getRecentWorkspaces: () => ipcRenderer.invoke('app:getRecentWorkspaces'),
  addRecentWorkspace: (workspacePath: string) => ipcRenderer.invoke('app:addRecentWorkspace', workspacePath),

  // 工作区配置管理
  initWorkspace: (workspacePath: string) => ipcRenderer.invoke('workspace:init', workspacePath),
  getWorkspaceConfig: (workspacePath: string) => ipcRenderer.invoke('workspace:getConfig', workspacePath),
  saveWorkspaceConfig: (workspacePath: string, config: any) => ipcRenderer.invoke('workspace:saveConfig', workspacePath, config),

  // Pi Agent API
  agentInitialize: (config: {
    workspaceDir: string
    agentDir?: string
    apiConfig: {
      provider: string
      apiUrl: string
      apiKey: string
      selectedModel: string
    }
  }) => ipcRenderer.invoke('agent:initialize', config),
  agentChat: (message: string, requestId?: string) =>
    ipcRenderer.invoke('agent:chat', message, requestId),
  onAgentStream: (callback: (payload: { requestId?: string; delta: string }) => void) => {
    const listener = (_event: unknown, payload: { requestId?: string; delta: string }) => callback(payload)
    ipcRenderer.on('agent:stream', listener)
    return () => ipcRenderer.removeListener('agent:stream', listener)
  },
  agentIsInitialized: () => ipcRenderer.invoke('agent:isInitialized'),
  agentGetHistory: () => ipcRenderer.invoke('agent:getHistory'),
  agentDispose: () => ipcRenderer.invoke('agent:dispose'),

  // API Configuration 管理（便携式架构）
  apiConfigGet: () => ipcRenderer.invoke('apiConfig:get'),
  apiConfigSave: (config: any) => ipcRenderer.invoke('apiConfig:save', config),
  apiConfigFetchModels: (apiUrl: string, apiKey: string, provider: string) =>
    ipcRenderer.invoke('apiConfig:fetchModels', apiUrl, apiKey, provider),
})


