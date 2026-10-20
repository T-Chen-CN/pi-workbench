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
  disposeWorkspace: (workspacePath: string) => ipcRenderer.invoke('workspace:dispose', workspacePath),

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
  agentChat: (message: string, requestId?: string, workspaceDir?: string) =>
    ipcRenderer.invoke('agent:chat', message, requestId, workspaceDir),
  agentAbort: (workspaceDir?: string) => ipcRenderer.invoke('agent:abort', workspaceDir),
  onAgentStream: (callback: (payload: { requestId?: string; delta: string }) => void) => {
    const listener = (_event: unknown, payload: { requestId?: string; delta: string }) => callback(payload)
    ipcRenderer.on('agent:stream', listener)
    return () => ipcRenderer.removeListener('agent:stream', listener)
  },
  agentIsInitialized: (workspaceDir?: string) => ipcRenderer.invoke('agent:isInitialized', workspaceDir),
  agentGetHistory: (workspaceDir?: string) => ipcRenderer.invoke('agent:getHistory', workspaceDir),
  agentDispose: (workspaceDir?: string) => ipcRenderer.invoke('agent:dispose', workspaceDir),

  // 终端
  terminalCreate: (workspaceDir: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:create', workspaceDir, cols, rows),
  terminalWrite: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', id, cols, rows),
  terminalClose: (id: string) => ipcRenderer.invoke('terminal:close', id),
  terminalFlush: (id: string) => ipcRenderer.invoke('terminal:flush', id),
  terminalGetRecentOutput: (id: string) => ipcRenderer.invoke('terminal:getRecentOutput', id),
  onTerminalData: (callback: (payload: { id: string; data: string }) => void) => {
    const listener = (_event: unknown, payload: { id: string; data: string }) => callback(payload)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onTerminalExit: (callback: (payload: { id: string; exitCode: number }) => void) => {
    const listener = (_event: unknown, payload: { id: string; exitCode: number }) => callback(payload)
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  },

  // 工作台插件
  pluginsList: (workspaceDir: string) => ipcRenderer.invoke('plugins:list', workspaceDir),
  pluginsInvoke: (workspaceDir: string, commandId: string, args?: unknown) =>
    ipcRenderer.invoke('plugins:invoke', workspaceDir, commandId, args),
  pluginsReload: (workspaceDir: string) => ipcRenderer.invoke('plugins:reload', workspaceDir),
  pluginsSetEnabled: (workspaceDir: string, pluginId: string, enabled: boolean) =>
    ipcRenderer.invoke('plugins:setEnabled', workspaceDir, pluginId, enabled),
  onPluginsChanged: (callback: (payload: { workspaceDir: string }) => void) => {
    const listener = (_event: unknown, payload: { workspaceDir: string }) => callback(payload)
    ipcRenderer.on('plugins:changed', listener)
    return () => ipcRenderer.removeListener('plugins:changed', listener)
  },

  // Fleet 后台任务
  fleetCreate: (workspaceDir: string, name: string, prompt: string) =>
    ipcRenderer.invoke('fleet:create', workspaceDir, name, prompt),
  fleetList: (workspaceDir: string) => ipcRenderer.invoke('fleet:list', workspaceDir),
  fleetGet: (id: string) => ipcRenderer.invoke('fleet:get', id),
  fleetCancel: (id: string, workspaceDir?: string) =>
    ipcRenderer.invoke('fleet:cancel', id, workspaceDir),
  fleetCleanup: (id: string, workspaceDir?: string) =>
    ipcRenderer.invoke('fleet:cleanup', id, workspaceDir),
  onFleetTaskUpdated: (callback: (task: unknown) => void) => {
    const listener = (_event: unknown, task: unknown) => callback(task)
    ipcRenderer.on('fleet:task-updated', listener)
    return () => ipcRenderer.removeListener('fleet:task-updated', listener)
  },

  // API Configuration 管理（便携式架构）
  apiConfigGet: () => ipcRenderer.invoke('apiConfig:get'),
  apiConfigSave: (config: any) => ipcRenderer.invoke('apiConfig:save', config),
  apiConfigFetchModels: (apiUrl: string, apiKey: string, provider: string) =>
    ipcRenderer.invoke('apiConfig:fetchModels', apiUrl, apiKey, provider),
})


