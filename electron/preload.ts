import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // 文件系统操作
  openDirectoryDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),
  listDirectory: (path: string) => ipcRenderer.invoke('fs:listDirectory', path),
  exists: (path: string) => ipcRenderer.invoke('fs:exists', path),
  stat: (path: string) => ipcRenderer.invoke('fs:stat', path),

  // 应用配置管理（便携式架构）
  getAppDir: () => ipcRenderer.invoke('app:getAppDir'),
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  saveSettings: (settings: any) => ipcRenderer.invoke('app:saveSettings', settings),

  // 工作区配置管理
  initWorkspace: (workspacePath: string) => ipcRenderer.invoke('workspace:init', workspacePath),
  getWorkspaceConfig: (workspacePath: string) => ipcRenderer.invoke('workspace:getConfig', workspacePath),
  saveWorkspaceConfig: (workspacePath: string, config: any) => ipcRenderer.invoke('workspace:saveConfig', workspacePath, config),
})

