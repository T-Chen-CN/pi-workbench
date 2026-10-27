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
  ApiConfigGetResult,
  ApiConfigSaveResult,
  FetchModelsResult,
  ApiProvider,
  WebSearchConfig,
  WebSearchGetResult,
  WebSearchSaveResult,
  RecentWorkspacesResult,
  PluginsListResult,
  PluginCommandResult,
  TerminalCreateResult,
  TerminalResult,
  UpdateCheckResult,
  UpdateActionResult,
  UpdateState,
  UpdateStateResult,
  AppInfoResult,
  AppActiveWorkResult,
  DraftListResult,
  DraftResult,
  PendingMessagesMap,
  EditorTabs,
  EditorTabsResult,
  GithubDeviceLoginEvent,
  GitChangedPayload,
} from '../types/electron'

// Mock API for browser development
const MOCK_CONFIG_KEY = 'pi-workbench-api-config'
const MOCK_WEB_SEARCH_KEY = 'pi-workbench-web-search-config'
const MOCK_SETTINGS_KEY = 'pi-workbench-settings'

const mockUpdateState: UpdateState = {
  status: 'unsupported',
  currentVersion: '0.0.0-web',
  platform: 'web',
  canAutoInstall: false,
}

const mockAPI = {
  platform: 'web',
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
  unwatchWorkspace: async (_workspacePath?: string): Promise<WorkspaceResult> => {
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
  logRenderer: async () => ({ success: true }),
  updateCheck: async (): Promise<UpdateCheckResult> => ({
    success: false,
    state: mockUpdateState,
    error: 'ERR_UPDATE_NOT_PACKAGED',
  }),
  updateDownload: async (): Promise<UpdateActionResult> => ({
    success: false,
    error: 'ERR_UPDATE_NOT_PACKAGED',
  }),
  updateInstall: async (): Promise<UpdateActionResult> => ({
    success: false,
    error: 'ERR_UPDATE_NOT_PACKAGED',
  }),
  updateGetState: async (): Promise<UpdateStateResult> => ({
    success: true,
    state: mockUpdateState,
  }),
  updateOpenDownload: async (): Promise<UpdateActionResult> => ({
    success: false,
    error: 'ERR_UPDATE_NOT_PACKAGED',
  }),
  onUpdateStatus: (_callback: (status: UpdateState) => void) => () => {},
  appGetInfo: async (): Promise<AppInfoResult> => ({
    success: true,
    info: {
      version: '0.0.0-web',
      electron: '-',
      chrome: '-',
      node: '-',
      platform: 'web',
      arch: '-',
      appDir: '/mock/app/dir',
    },
  }),
  appHasActiveWork: async (): Promise<AppActiveWorkResult> => ({
    success: true,
    terminal: false,
  }),
  getSettings: async (): Promise<GetSettingsResult> => {
    const defaults = {
      language: 'zh',
      theme: 'light',
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
  minimizeWindow: async (): Promise<{ success: boolean }> => ({ success: false }),
  toggleMaximizeWindow: async (): Promise<{ success: boolean; maximized: boolean }> => ({
    success: false,
    maximized: false,
  }),
  closeWindow: async (): Promise<{ success: boolean }> => ({ success: false }),
  isWindowMaximized: async (): Promise<{ success: boolean; maximized: boolean }> => ({
    success: true,
    maximized: false,
  }),
  onWindowMaximizedChange: (_callback: (maximized: boolean) => void) => () => {},
  appBootReady: () => {},
  onAppBootExpanded: (_callback: () => void) => () => {},
  initWorkspace: async (workspacePath: string): Promise<WorkspaceResult> => {
    console.log('[Mock] initWorkspace:', workspacePath)
    return { success: true }
  },
  disposeWorkspace: async (workspacePath: string): Promise<WorkspaceResult> => {
    console.log('[Mock] disposeWorkspace:', workspacePath)
    return { success: true }
  },
  draftSave: async (): Promise<DraftResult> => ({ success: true }),
  draftDelete: async (): Promise<DraftResult> => ({ success: true }),
  draftList: async (): Promise<DraftListResult> => ({ success: true, drafts: [] }),
  draftClear: async (): Promise<DraftResult> => ({ success: true }),
  editorTabsGet: async (workspacePath: string): Promise<EditorTabsResult> => {
    try {
      const raw = localStorage.getItem(`pi-workbench-editor-tabs:${workspacePath}`)
      if (!raw) return { success: true, tabs: { open: [], active: null } }
      const parsed = JSON.parse(raw) as { open?: unknown; active?: unknown }
      return {
        success: true,
        tabs: {
          open: Array.isArray(parsed.open)
            ? parsed.open.filter((item): item is string => typeof item === 'string')
            : [],
          active: typeof parsed.active === 'string' ? parsed.active : null,
        },
      }
    } catch {
      return { success: true, tabs: { open: [], active: null } }
    }
  },
  editorTabsSet: async (workspacePath: string, tabs: EditorTabs): Promise<WorkspaceResult> => {
    localStorage.setItem(`pi-workbench-editor-tabs:${workspacePath}`, JSON.stringify(tabs))
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

  // 纯 Web 模式下联网配置只存在浏览器里，不参与实际搜索
  webSearchGet: async (): Promise<WebSearchGetResult> => {
    try {
      const saved = localStorage.getItem(MOCK_WEB_SEARCH_KEY)
      if (saved) {
        return { success: true, config: JSON.parse(saved) as WebSearchConfig }
      }
    } catch (error) {
      console.warn('[Mock] Failed to read web search config:', error)
    }
    return { success: true, config: { provider: null, endpoint: 'china', keys: {} } }
  },
  webSearchSave: async (config: WebSearchConfig): Promise<WebSearchSaveResult> => {
    localStorage.setItem(MOCK_WEB_SEARCH_KEY, JSON.stringify(config))
    return { success: true }
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

  // Terminal（Web 模式没有 PTY，返回失败而不是抛异常）
  terminalCreate: async (): Promise<TerminalCreateResult> => ({
    success: false,
    error: 'Terminal is only available in the Electron app',
  }),
  gitRepoInfo: async () => ({ success: true, repo: null, worktrees: [] }),
  gitFetch: async () => ({
    success: false,
    skipped: true,
    error: 'Git is only available in the Electron app',
  }),
  onGitChanged: (_callback: (payload: GitChangedPayload) => void) => () => {},
  gitListWorktrees: async () => ({ success: true, worktrees: [] }),
  gitBranches: async () => ({ success: true, branches: [] }),
  gitStatus: async () => ({
    success: true,
    status: {
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      detached: false,
      clean: true,
      files: [],
    },
  }),
  gitSessionBinding: async () => ({
    success: true,
    binding: { key: 'main', path: '', branch: null },
  }),
  gitBindWorktree: async () => ({
    success: false,
    error: 'Git is only available in the Electron app',
  }),
  gitReleaseSession: async () => ({ success: true, removed: false, dirty: false }),
  gitCleanupOrphans: async () => ({ success: true, removed: [], dirty: [], external: [] }),
  gitLog: async () => ({ success: true, commits: [] }),
  gitCommitStats: async () => ({ success: true, stats: {} }),
  gitCreateBranch: async () => ({ success: false, error: 'Git is only available in the Electron app' }),
  gitCommitDetail: async () => ({ success: false, error: 'Git is only available in the Electron app' }),
  gitDiff: async () => ({ success: true, patch: '' }),
  gitCheckout: async () => ({ success: false, error: 'Git is only available in the Electron app' }),
  gitMerge: async () => ({ success: false, error: 'Git is only available in the Electron app' }),
  gitGithubTokenStatus: async () => ({ success: true, configured: false }),
  githubAuthConfig: async () => ({ success: true, appConfigured: false, linked: false }),
  githubAuthStart: async () => ({
    success: false,
    error: 'GitHub login is only available in the Electron app',
  }),
  githubAuthStatus: async () => ({ success: true, configured: false }),
  githubAuthLogout: async () => ({ success: true }),
  onGithubAuthComplete: () => () => {},
  githubAuthDeviceStart: async () => ({
    success: false,
    error: 'GitHub login is only available in the Electron app',
  }),
  githubAuthDeviceCancel: async () => ({ success: true, cancelled: false }),
  githubAuthDeviceOpen: async () => ({ success: false }),
  onGithubAuthDeviceEvent: () => () => {},
  gitSetGithubToken: async () => ({ success: true }),
  gitPrStatus: async () => ({
    success: true,
    status: { available: false, reason: 'Git is only available in the Electron app' },
  }),
  onAgentSessionRootChanged: () => () => {},
  terminalWrite: async (): Promise<TerminalResult> => ({ success: false }),
  terminalResize: async (): Promise<TerminalResult> => ({ success: false }),
  terminalClose: async (): Promise<TerminalResult> => ({ success: false }),
  terminalFlush: async (): Promise<TerminalResult> => ({ success: false }),
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
  searchWorkspaceFiles: (workspaceDir: string, query: string, limit?: number) =>
    typeof electronAPI.searchWorkspaceFiles === 'function'
      ? electronAPI.searchWorkspaceFiles(workspaceDir, query, limit)
      : Promise.resolve({ success: true, files: [] as string[] }),
  getPathForFile: (file: File) =>
    typeof electronAPI.getPathForFile === 'function' ? electronAPI.getPathForFile(file) : '',
  getSessionMeta: (workspaceDir: string) =>
    typeof electronAPI.agentSessionsMetaGet === 'function'
      ? electronAPI.agentSessionsMetaGet(workspaceDir)
      : Promise.resolve({ success: true, meta: { pinned: [], archived: [] } }),
  setSessionMeta: (workspaceDir: string, meta: { pinned: string[]; archived: string[] }) =>
    typeof electronAPI.agentSessionsMetaSet === 'function'
      ? electronAPI.agentSessionsMetaSet(workspaceDir, meta)
      : Promise.resolve({ success: true }),
  getPendingMessages: (workspaceDir: string) =>
    typeof electronAPI.chatPendingGet === 'function'
      ? electronAPI.chatPendingGet(workspaceDir)
      : Promise.resolve({ success: true, sessions: {} as PendingMessagesMap }),
  setPendingMessages: (workspaceDir: string, sessions: PendingMessagesMap) =>
    typeof electronAPI.chatPendingSet === 'function'
      ? electronAPI.chatPendingSet(workspaceDir, sessions)
      : Promise.resolve({ success: true }),
  readFile: (path: string) => electronAPI.readFile(path),
  writeFile: (path: string, content: string) => electronAPI.writeFile(path, content),
  exists: (path: string) => electronAPI.exists(path),
  stat: (path: string) => electronAPI.stat(path),
  deletePath: (path: string) => electronAPI.deletePath(path),
  renamePath: (oldPath: string, newPath: string) => electronAPI.renamePath(oldPath, newPath),
  watchWorkspace: (workspacePath: string) => electronAPI.watchWorkspace(workspacePath),
  unwatchWorkspace: (workspacePath?: string) => electronAPI.unwatchWorkspace(workspacePath),
  onFsChanged: (callback: (payload: { type: string; path: string }) => void) =>
    electronAPI.onFsChanged(callback),

  // App configuration (portable architecture)
  getAppDir: () => electronAPI.getAppDir(),
  logRenderer: (level: string, args: unknown[]) => electronAPI.logRenderer(level, args),
  updateCheck: () => electronAPI.updateCheck(),
  updateDownload: () => electronAPI.updateDownload(),
  updateInstall: () => electronAPI.updateInstall(),
  updateGetState: () => electronAPI.updateGetState(),
  updateOpenDownload: () => electronAPI.updateOpenDownload(),
  onUpdateStatus: (callback: (status: UpdateState) => void) => electronAPI.onUpdateStatus(callback),
  appGetInfo: () => electronAPI.appGetInfo(),
  appHasActiveWork: () => electronAPI.appHasActiveWork(),
  getSettings: () => electronAPI.getSettings(),
  saveSettings: (settings: any) => electronAPI.saveSettings(settings),
  getRecentWorkspaces: () => electronAPI.getRecentWorkspaces(),
  addRecentWorkspace: (workspacePath: string) => electronAPI.addRecentWorkspace(workspacePath),
  minimizeWindow: () => electronAPI.minimizeWindow(),
  toggleMaximizeWindow: () => electronAPI.toggleMaximizeWindow(),
  closeWindow: () => electronAPI.closeWindow(),
  isWindowMaximized: () => electronAPI.isWindowMaximized(),
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) =>
    electronAPI.onWindowMaximizedChange(callback),
  appBootReady: () => {
    if (typeof electronAPI.appBootReady === 'function') electronAPI.appBootReady()
  },
  onAppBootExpanded: (callback: () => void) =>
    typeof electronAPI.onAppBootExpanded === 'function'
      ? electronAPI.onAppBootExpanded(callback)
      : () => {},

  // Workspace configuration
  initWorkspace: (workspacePath: string) => electronAPI.initWorkspace(workspacePath),
  disposeWorkspace: (workspacePath: string) => electronAPI.disposeWorkspace(workspacePath),
  draftSave: (workspacePath: string, filePath: string, content: string) =>
    electronAPI.draftSave(workspacePath, filePath, content),
  draftDelete: (workspacePath: string, filePath: string) =>
    electronAPI.draftDelete(workspacePath, filePath),
  draftList: (workspacePath: string) => electronAPI.draftList(workspacePath),
  draftClear: (workspacePath: string) => electronAPI.draftClear(workspacePath),
  editorTabsGet: (workspacePath: string) => electronAPI.editorTabsGet(workspacePath),
  editorTabsSet: (workspacePath: string, tabs: EditorTabs) =>
    electronAPI.editorTabsSet(workspacePath, tabs),

  // API Configuration management (portable architecture)
  apiConfigGet: () => electronAPI.apiConfigGet(),
  apiConfigSave: (config: any) => electronAPI.apiConfigSave(config),
  apiConfigFetchModels: (apiUrl: string, apiKey: string, provider: ApiProvider) =>
    electronAPI.apiConfigFetchModels(apiUrl, apiKey, provider),

  // Web search (内置联网能力)
  webSearchGet: () => electronAPI.webSearchGet(),
  webSearchSave: (config: WebSearchConfig) => electronAPI.webSearchSave(config),

  // Workbench plugins
  pluginsList: (workspaceDir: string) => electronAPI.pluginsList(workspaceDir),
  pluginsInvoke: (workspaceDir: string, commandId: string, args?: unknown) =>
    electronAPI.pluginsInvoke(workspaceDir, commandId, args),
  pluginsReload: (workspaceDir: string) => electronAPI.pluginsReload(workspaceDir),
  pluginsSetEnabled: (workspaceDir: string, pluginId: string, enabled: boolean) =>
    electronAPI.pluginsSetEnabled(workspaceDir, pluginId, enabled),
  onPluginsChanged: (callback: (payload: { workspaceDir: string }) => void) =>
    electronAPI.onPluginsChanged(callback),

  // Git worktrees / read-only history / GitHub status
  gitRepoInfo: (workspaceDir: string) => electronAPI.gitRepoInfo(workspaceDir),
  gitFetch: (workspaceDir: string, options?: { force?: boolean }) =>
    electronAPI.gitFetch(workspaceDir, options),
  onGitChanged: (callback: (payload: GitChangedPayload) => void) =>
    electronAPI.onGitChanged(callback),
  gitListWorktrees: (workspaceDir: string, activeSessionId?: string) =>
    electronAPI.gitListWorktrees(workspaceDir, activeSessionId),
  gitBranches: (workspaceDir: string) => electronAPI.gitBranches(workspaceDir),
  gitStatus: (workspaceDir: string, worktreePath?: string) =>
    electronAPI.gitStatus(workspaceDir, worktreePath),
  gitSessionBinding: (workspaceDir: string, sessionId: string) =>
    electronAPI.gitSessionBinding(workspaceDir, sessionId),
  gitBindWorktree: (workspaceDir: string, sessionId: string, target: string, base?: string) =>
    electronAPI.gitBindWorktree(workspaceDir, sessionId, target, base),
  gitReleaseSession: (workspaceDir: string, sessionId: string) =>
    electronAPI.gitReleaseSession(workspaceDir, sessionId),
  gitCleanupOrphans: (workspaceDir: string) => electronAPI.gitCleanupOrphans(workspaceDir),
  gitLog: (workspaceDir: string, limit?: number, branch?: string, all?: boolean) =>
    electronAPI.gitLog(workspaceDir, limit, branch, all),
  gitCommitStats: (workspaceDir: string, limit?: number, branch?: string, all?: boolean) =>
    electronAPI.gitCommitStats(workspaceDir, limit, branch, all),
  gitCreateBranch: (workspaceDir: string, sha: string, name: string) =>
    electronAPI.gitCreateBranch(workspaceDir, sha, name),
  gitCommitDetail: (workspaceDir: string, sha: string) =>
    electronAPI.gitCommitDetail(workspaceDir, sha),
  gitDiff: (workspaceDir: string, from: string, to: string) =>
    electronAPI.gitDiff(workspaceDir, from, to),
  gitCheckout: (workspaceDir: string, worktreePath: string, branch: string) =>
    electronAPI.gitCheckout(workspaceDir, worktreePath, branch),
  gitMerge: (
    workspaceDir: string,
    worktreePath: string,
    branch: string,
    strategy?: 'merge' | 'squash' | 'rebase'
  ) => electronAPI.gitMerge(workspaceDir, worktreePath, branch, strategy),
  gitGithubTokenStatus: () => electronAPI.gitGithubTokenStatus(),
  githubAuthConfig: () => electronAPI.githubAuthConfig(),
  githubAuthStart: () => electronAPI.githubAuthStart(),
  githubAuthStatus: () => electronAPI.githubAuthStatus(),
  githubAuthLogout: () => electronAPI.githubAuthLogout(),
  onGithubAuthComplete: (
    callback: (payload: {
      success: boolean
      user?: { login: string; name: string | null; avatarUrl: string | null } | null
      error?: string
    }) => void
  ) => electronAPI.onGithubAuthComplete(callback),
  githubAuthDeviceStart: () => electronAPI.githubAuthDeviceStart(),
  githubAuthDeviceCancel: () => electronAPI.githubAuthDeviceCancel(),
  githubAuthDeviceOpen: () => electronAPI.githubAuthDeviceOpen(),
  onGithubAuthDeviceEvent: (callback: (payload: GithubDeviceLoginEvent) => void) =>
    electronAPI.onGithubAuthDeviceEvent(callback),
  gitSetGithubToken: (token: string) => electronAPI.gitSetGithubToken(token),
  gitPrStatus: (workspaceDir: string, worktreePath?: string) =>
    electronAPI.gitPrStatus(workspaceDir, worktreePath),
  onAgentSessionRootChanged: (
    callback: (payload: { workspaceDir: string; sessionId: string; root: string }) => void
  ) => electronAPI.onAgentSessionRootChanged(callback),

  // Terminal
  terminalCreate: (workspaceDir: string, cols: number, rows: number, cwd?: string) =>
    electronAPI.terminalCreate(workspaceDir, cols, rows, cwd),
  terminalWrite: (id: string, data: string) => electronAPI.terminalWrite(id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    electronAPI.terminalResize(id, cols, rows),
  terminalClose: (id: string) => electronAPI.terminalClose(id),
  terminalFlush: (id: string) => electronAPI.terminalFlush(id),
  onTerminalData: (callback: (payload: { id: string; data: string }) => void) =>
    electronAPI.onTerminalData(callback),
  onTerminalExit: (callback: (payload: { id: string; exitCode: number }) => void) =>
    electronAPI.onTerminalExit(callback),
}

