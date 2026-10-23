import { contextBridge, ipcRenderer, webUtils } from 'electron'

type AgentStreamPayload = {
  requestId?: string
  workspaceDir?: string
  sessionId?: string
  type:
    | 'text_delta'
    | 'thinking_delta'
    | 'thinking_redacted'
    | 'tool_start'
    | 'tool_update'
    | 'tool_end'
  delta?: string
  toolCallId?: string
  toolName?: string
  argsSummary?: string
  startedAt?: number
  status?: 'success' | 'error'
  durationMs?: number
  resultPreview?: string
  filePath?: string
}

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
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
  unwatchWorkspace: (workspacePath?: string) => ipcRenderer.invoke('fs:unwatch', workspacePath),
  onFsChanged: (callback: (payload: { type: string; path: string }) => void) => {
    const listener = (_event: unknown, payload: { type: string; path: string }) => callback(payload)
    ipcRenderer.on('fs:changed', listener)
    return () => ipcRenderer.removeListener('fs:changed', listener)
  },

  // 自动更新
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateGetState: () => ipcRenderer.invoke('update:getState'),
  updateOpenDownload: () => ipcRenderer.invoke('update:openDownload'),
  onUpdateStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: unknown, status: unknown) => callback(status)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },

  // 应用信息与运行状态
  appGetInfo: () => ipcRenderer.invoke('app:getInfo'),
  appHasActiveWork: () => ipcRenderer.invoke('app:hasActiveWork'),

  // 渲染进程日志（写入 {appDir}/logs/renderer.log）
  logRenderer: (level: string, args: unknown[]) => ipcRenderer.invoke('log:renderer', level, args),

  // 应用配置管理（便携式架构）
  getAppDir: () => ipcRenderer.invoke('app:getAppDir'),
  getSettings: () => ipcRenderer.invoke('app:getSettings'),
  saveSettings: (settings: any) => ipcRenderer.invoke('app:saveSettings', settings),
  getRecentWorkspaces: () => ipcRenderer.invoke('app:getRecentWorkspaces'),
  addRecentWorkspace: (workspacePath: string) => ipcRenderer.invoke('app:addRecentWorkspace', workspacePath),

  // 自绘窗口按钮
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => {
    const listener = (_event: unknown, maximized: boolean) => callback(maximized)
    ipcRenderer.on('window:maximized-changed', listener)
    return () => ipcRenderer.removeListener('window:maximized-changed', listener)
  },

  // 工作区配置管理
  initWorkspace: (workspacePath: string) => ipcRenderer.invoke('workspace:init', workspacePath),
  getWorkspaceConfig: (workspacePath: string) => ipcRenderer.invoke('workspace:getConfig', workspacePath),
  saveWorkspaceConfig: (workspacePath: string, config: any) => ipcRenderer.invoke('workspace:saveConfig', workspacePath, config),
  disposeWorkspace: (workspacePath: string) => ipcRenderer.invoke('workspace:dispose', workspacePath),

  // 崩溃恢复草稿
  draftSave: (workspacePath: string, filePath: string, content: string) =>
    ipcRenderer.invoke('draft:save', workspacePath, filePath, content),
  draftDelete: (workspacePath: string, filePath: string) =>
    ipcRenderer.invoke('draft:delete', workspacePath, filePath),
  draftList: (workspacePath: string) => ipcRenderer.invoke('draft:list', workspacePath),
  draftClear: (workspacePath: string) => ipcRenderer.invoke('draft:clear', workspacePath),

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
  agentChat: (
    message: string,
    requestId?: string,
    workspaceDir?: string,
    sessionId?: string,
    images?: Array<{ data: string; mimeType: string }>
  ) => ipcRenderer.invoke('agent:chat', message, requestId, workspaceDir, sessionId, images),
  agentAbort: (workspaceDir?: string, sessionId?: string) =>
    ipcRenderer.invoke('agent:abort', workspaceDir, sessionId),
  onAgentStream: (callback: (payload: AgentStreamPayload) => void) => {
    const listener = (_event: unknown, payload: AgentStreamPayload) => callback(payload)
    ipcRenderer.on('agent:stream', listener)
    return () => ipcRenderer.removeListener('agent:stream', listener)
  },
  onAgentSessionTitle: (
    callback: (payload: { workspaceDir: string; sessionId: string; title: string }) => void
  ) => {
    const listener = (
      _event: unknown,
      payload: { workspaceDir: string; sessionId: string; title: string }
    ) => callback(payload)
    ipcRenderer.on('agent:session-title', listener)
    return () => ipcRenderer.removeListener('agent:session-title', listener)
  },
  agentIsInitialized: (workspaceDir?: string) => ipcRenderer.invoke('agent:isInitialized', workspaceDir),
  agentGetHistory: (workspaceDir?: string, sessionId?: string) =>
    ipcRenderer.invoke('agent:getHistory', workspaceDir, sessionId),
  agentDispose: (workspaceDir?: string) => ipcRenderer.invoke('agent:dispose', workspaceDir),
  agentSessionsList: (workspaceDir: string) =>
    ipcRenderer.invoke('agent:sessions:list', workspaceDir),
  agentSessionsOpen: (workspaceDir: string, sessionId?: string) =>
    ipcRenderer.invoke('agent:sessions:open', workspaceDir, sessionId),
  agentSessionsCreate: (workspaceDir: string) =>
    ipcRenderer.invoke('agent:sessions:create', workspaceDir),
  agentSessionsClose: (workspaceDir: string, sessionId: string) =>
    ipcRenderer.invoke('agent:sessions:close', workspaceDir, sessionId),
  agentSessionsRename: (workspaceDir: string, sessionId: string, name: string) =>
    ipcRenderer.invoke('agent:sessions:rename', workspaceDir, sessionId, name),
  agentSessionsDelete: (workspaceDir: string, sessionId: string) =>
    ipcRenderer.invoke('agent:sessions:delete', workspaceDir, sessionId),
  agentSessionsGetTabs: (workspaceDir: string) =>
    ipcRenderer.invoke('agent:sessions:getTabs', workspaceDir),
  agentSessionsSetTabs: (workspaceDir: string, tabs: { open: string[]; active: string | null }) =>
    ipcRenderer.invoke('agent:sessions:setTabs', workspaceDir, tabs),
  agentSessionsSetMode: (workspaceDir: string, sessionId: string, mode: 'plan' | 'act') =>
    ipcRenderer.invoke('agent:sessions:setMode', workspaceDir, sessionId, mode),
  agentSteer: (workspaceDir: string, sessionId: string, message: string) =>
    ipcRenderer.invoke('agent:steer', workspaceDir, sessionId, message),
  agentContextUsage: (workspaceDir: string, sessionId: string) =>
    ipcRenderer.invoke('agent:context:usage', workspaceDir, sessionId),
  agentCompactContext: (workspaceDir: string, sessionId: string) =>
    ipcRenderer.invoke('agent:context:compact', workspaceDir, sessionId),
  agentCheckpointsList: (workspaceDir: string, sessionId?: string) =>
    ipcRenderer.invoke('agent:checkpoints:list', workspaceDir, sessionId),
  agentCheckpointsRestore: (
    workspaceDir: string,
    sessionId: string,
    checkpointId: string,
    options: { files?: boolean; conversation?: boolean }
  ) => ipcRenderer.invoke('agent:checkpoints:restore', workspaceDir, sessionId, checkpointId, options),
  agentRewind: (workspaceDir: string, sessionId: string, newText?: string) =>
    ipcRenderer.invoke('agent:rewind', workspaceDir, sessionId, newText),
  agentSessionSettings: (workspaceDir: string, sessionId: string) =>
    ipcRenderer.invoke('agent:session:settings', workspaceDir, sessionId),
  agentSessionStats: (workspaceDir: string, sessionId: string) =>
    ipcRenderer.invoke('agent:session:stats', workspaceDir, sessionId),
  agentToolDiff: (workspaceDir: string, sessionId: string, toolCallId: string) =>
    ipcRenderer.invoke('agent:tool-diff', workspaceDir, sessionId, toolCallId),
  agentSessionSetModel: (workspaceDir: string, sessionId: string, modelId: string) =>
    ipcRenderer.invoke('agent:session:setModel', workspaceDir, sessionId, modelId),
  agentSessionSetThinking: (workspaceDir: string, sessionId: string, level: string) =>
    ipcRenderer.invoke('agent:session:setThinking', workspaceDir, sessionId, level),
  agentSessionsMetaGet: (workspaceDir: string) =>
    ipcRenderer.invoke('agent:sessions:meta:get', workspaceDir),
  agentSessionsMetaSet: (
    workspaceDir: string,
    meta: { pinned?: string[]; archived?: string[] }
  ) => ipcRenderer.invoke('agent:sessions:meta:set', workspaceDir, meta),
  chatPendingGet: (workspaceDir: string) => ipcRenderer.invoke('chat:pending:get', workspaceDir),
  chatPendingSet: (workspaceDir: string, sessions: unknown) =>
    ipcRenderer.invoke('chat:pending:set', workspaceDir, sessions),
  saveTextFile: (suggestedName: string, content: string) =>
    ipcRenderer.invoke('app:saveTextFile', suggestedName, content),
  searchWorkspaceFiles: (workspaceDir: string, query: string, limit?: number) =>
    ipcRenderer.invoke('workspace:searchFiles', workspaceDir, query, limit),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  onNotifyClick: (
    callback: (payload: { workspaceDir: string; sessionId: string }) => void
  ) => {
    const listener = (_event: unknown, payload: { workspaceDir: string; sessionId: string }) =>
      callback(payload)
    ipcRenderer.on('app:notify-click', listener)
    return () => ipcRenderer.removeListener('app:notify-click', listener)
  },
  onAgentApprovalRequest: (
    callback: (payload: {
      requestId: string
      workspaceDir: string
      sessionId: string
      toolCallId: string
      toolName: string
      category: 'read' | 'write' | 'command' | 'other'
      summary: string
      details: { path?: string; command?: string; preview?: string; editCount?: number }
      createdAt: number
      expiresAt: number
    }) => void
  ) => {
    const listener = (_event: unknown, payload: any) => callback(payload)
    ipcRenderer.on('agent:approval-request', listener)
    return () => ipcRenderer.removeListener('agent:approval-request', listener)
  },
  agentRespondApproval: (requestId: string, decision: unknown) =>
    ipcRenderer.invoke('agent:approval:respond', requestId, decision),
  onAgentApprovalResolved: (
    callback: (payload: {
      requestId: string
      workspaceDir: string
      sessionId: string
      decision: unknown
    }) => void
  ) => {
    const listener = (_event: unknown, payload: any) => callback(payload)
    ipcRenderer.on('agent:approval-resolved', listener)
    return () => ipcRenderer.removeListener('agent:approval-resolved', listener)
  },

  // 终端
  terminalCreate: (workspaceDir: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:create', workspaceDir, cols, rows),
  terminalWrite: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', id, cols, rows),
  terminalClose: (id: string) => ipcRenderer.invoke('terminal:close', id),
  terminalFlush: (id: string) => ipcRenderer.invoke('terminal:flush', id),
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
  fleetDiff: (id: string, workspaceDir?: string) =>
    ipcRenderer.invoke('fleet:diff', id, workspaceDir),
  fleetMerge: (id: string, workspaceDir?: string) =>
    ipcRenderer.invoke('fleet:merge', id, workspaceDir),
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


