/**
 * Unified API layer for Electron
 * Portable Architecture: All app data stored in application directory
 */

import {
  createContractApiCall,
  createContractEventSub,
  normalizeIpcError,
  type IpcEventBridge,
  type IpcInvokeBridge,
} from '../../electron/ipc/contract'
import type {
  RepoMapResult,
  RepoMapCanvasState,
  RepoMapCanvasGetResult,
  RepoMapCanvasSetResult,
  OpenDirectoryResult,
  CloudLinkStatusResult,
  CloudPairResult,
  CloudDeviceState,
  CloudWorkspaceEntry,
  CloudClientState,
  CloudCatalogModel,
  CloudConfigResult,
  ListDirectoryResult,
  ReadFileResult,
  WriteFileResult,
  CreateFileResult,
  ExistsResult,
  StatResult,
  GetAppDirResult,
  GetSettingsResult,
  SaveSettingsResult,
  WorkspaceResult,
  ProvidersListResult,
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
  UpdateNoticeResult,
  UpdateState,
  UpdateStateResult,
  AppInfoResult,
  AppActiveWorkResult,
  DraftListResult,
  DraftResult,
  EditorTabs,
  EditorTabsResult,
  GitChangedPayload,
  GitWorktreeDepsPayload,
  AuxDetachResult,
  AuxWindowCommandResult,
  WindowCommand,
  WindowMaximizedState,
  AttachmentPickResult,
  DocumentPreviewResult,
  NotifyClickPayload,
} from '../types/electron'
import { frameNameOf, type HostId } from '../panelHost/types'
import { emptyCanvasState, sanitizeCanvasState } from '../utils/repoMapCanvasState'

// Mock API for browser development
/** 旧 preload（未重启主进程）时的降级文案，语气与 repo-map 的失败文案一致 */
const CANVAS_UNAVAILABLE = 'Restart the app to save the canvas layout'
const MOCK_WEB_SEARCH_KEY = 'pi-workbench-web-search-config'
const MOCK_SETTINGS_KEY = 'pi-workbench-settings'

const fallbackUpdateState: UpdateState = {
  status: 'unsupported',
  currentVersion: '0.0.0-web',
  platform: 'web',
  canAutoInstall: false,
}

const mockExistingFiles = new Set<string>(['/mock/src', '/mock/package.json'])

const mockAPI = {
  platform: 'web',
  openDirectoryDialog: async (): Promise<OpenDirectoryResult> => {
    console.log('[Mock] openDirectoryDialog')
    return { success: true, path: '/mock/selected/path' }
  },
  pickAttachments: async (): Promise<AttachmentPickResult> => {
    console.log('[Mock] pickAttachments')
    return { success: true, canceled: true, files: [] }
  },
  listDirectory: async (dirPath: string): Promise<ListDirectoryResult> => {
    console.log('[Mock] listDirectory:', dirPath)
    return {
      success: true,
      items: [
        { name: 'src', path: '/mock/src', isDirectory: true },
        { name: 'package.json', path: '/mock/package.json', isDirectory: false },
      ],
    }
  },
  readFile: async (filePath: string): Promise<ReadFileResult> => {
    console.log('[Mock] readFile:', filePath)
    return { success: true, content: `// Mock content for ${filePath}` }
  },
  writeFile: async (filePath: string, content: string): Promise<WriteFileResult> => {
    console.log('[Mock] writeFile:', filePath, content.length, 'bytes')
    mockExistingFiles.add(filePath)
    return { success: true }
  },
  createFile: async (filePath: string): Promise<CreateFileResult> => {
    console.log('[Mock] createFile:', filePath)
    if (mockExistingFiles.has(filePath)) {
      return { success: false, code: 'EEXIST', error: 'File already exists' }
    }
    mockExistingFiles.add(filePath)
    return { success: true }
  },
  openPathExternally: async (_filePath: string): Promise<WorkspaceResult> => ({
    success: false,
    error: 'Only available in the Electron app',
  }),
  openExternalUrl: async (url: string): Promise<WorkspaceResult> => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, error: 'Only http/https URLs can be opened externally' }
      }
      window.open(parsed.toString(), '_blank', 'noopener,noreferrer')
      return { success: true }
    } catch {
      return { success: false, error: 'Invalid URL' }
    }
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
    mockExistingFiles.delete(targetPath)
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
  openDataDir: async (): Promise<{ success: boolean; error?: string }> => {
    console.log('[Mock] openDataDir')
    return { success: true }
  },
  logRenderer: async () => ({ success: true }),
  updateCheck: async (): Promise<UpdateCheckResult> => ({
    success: false,
    state: fallbackUpdateState,
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
    state: fallbackUpdateState,
  }),
  updateOpenDownload: async (): Promise<UpdateActionResult> => ({
    success: false,
    error: 'ERR_UPDATE_NOT_PACKAGED',
  }),
  consumeUpdateNotice: async (): Promise<UpdateNoticeResult> => ({ success: true, notice: null }),
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
      useSystemProxy: true,
      autoRefreshCatalog: true,
    }
    try {
      const saved = localStorage.getItem(MOCK_SETTINGS_KEY)
      return {
        success: true,
        settings: saved ? { ...defaults, ...(JSON.parse(saved) as Record<string, unknown>) } : defaults,
      }
    } catch {
      return { success: true, settings: defaults }
    }
  },
  saveSettings: async (settings: Record<string, unknown>): Promise<SaveSettingsResult> => {
    localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify(settings))
    return { success: true }
  },
  getRecentWorkspaces: async (): Promise<RecentWorkspacesResult> => {
    try {
      const saved = localStorage.getItem('pi-workbench-recent-workspaces')
      return { success: true, workspaces: saved ? (JSON.parse(saved) as string[]) : [] }
    } catch {
      return { success: true, workspaces: [] }
    }
  },
  addRecentWorkspace: async (workspacePath: string): Promise<RecentWorkspacesResult> => {
    let existing: string[] = []
    try {
      existing = JSON.parse(localStorage.getItem('pi-workbench-recent-workspaces') || '[]') as string[]
    } catch {
      /* ignore */
    }
    const workspaces = [workspacePath, ...existing.filter((p) => p !== workspacePath)].slice(0, 10)
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
  onWindowMaximizedChange: (_callback: (state: WindowMaximizedState) => void) => () => {},
  // 浏览器开发模式没有辅助窗口的主进程支持：拆窗退化为普通 window.open，由渲染层用 screenX/screenY 定位
  onAuxWindowClosed: (_callback: (frameName: string) => void) => () => {},
  auxDetachAt: async (): Promise<AuxDetachResult> => ({ success: false, error: 'Not supported' }),
  auxDragBegin: async (): Promise<{ success: boolean }> => ({ success: false }),
  auxWindowCommand: async (
    _host: string,
    _command: WindowCommand
  ): Promise<AuxWindowCommandResult> => ({
    success: false,
    error: 'Not supported',
  }),
  auxWindowState: async (_host: string): Promise<AuxWindowCommandResult> => ({
    success: false,
    error: 'Not supported',
  }),
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
  // 浏览器里没有 git：给一份固定的示例地图，方便调面板样式
  repoMapScan: async (): Promise<RepoMapResult> => ({
    success: true,
    isRepo: true,
    repoRoot: '/mock/repo',
    total: 4,
    described: 4,
    truncated: false,
    files: [
      {
        path: 'src/components/WorkspacePanel.tsx',
        role: 'component',
        binary: false,
        size: 4096,
        mtimeMs: 0,
        described: true,
        headComment: '工作区面板：编辑区的默认视图',
        exports: ['WorkspacePanel'],
        symbol: 'WorkspacePanel',
      },
      {
        path: 'src/store/repoMapStore.ts',
        role: 'state',
        binary: false,
        size: 2048,
        mtimeMs: 0,
        described: true,
        headComment: '仓库地图状态：按工作区缓存扫描结果',
        exports: ['useRepoMapStore'],
        symbol: 'useRepoMapStore',
      },
      {
        path: 'docs/README.md',
        role: 'doc',
        binary: false,
        size: 1024,
        mtimeMs: 0,
        described: true,
      },
      {
        path: 'package.json',
        role: 'config',
        binary: false,
        size: 512,
        mtimeMs: 0,
        described: true,
      },
    ],
  }),
  repoMapDescribe: async (): Promise<RepoMapResult> => mockAPI.repoMapScan(),
  repoMapCanvasGet: async (workspacePath: string): Promise<RepoMapCanvasGetResult> => {
    try {
      const raw = localStorage.getItem(`pi-workbench-repo-map-canvas:${workspacePath}`)
      if (!raw) return { success: true, state: emptyCanvasState() }
      return { success: true, state: sanitizeCanvasState(JSON.parse(raw)) }
    } catch {
      return { success: true, state: emptyCanvasState() }
    }
  },
  repoMapCanvasSet: async (
    workspacePath: string,
    state: RepoMapCanvasState
  ): Promise<RepoMapCanvasSetResult> => {
    try {
      localStorage.setItem(
        `pi-workbench-repo-map-canvas:${workspacePath}`,
        JSON.stringify(sanitizeCanvasState(state))
      )
      return { success: true }
    } catch (error) {
      return { success: false, error: normalizeIpcError(error) }
    }
  },

  // Web 模式下没有主进程：供应商列表只用于展示，登录 / 凭证不可用
  providersList: async (): Promise<ProvidersListResult> => {
    console.log('[Mock] providersList')
    return { success: true, providers: [], activeProvider: null, offline: false }
  },
  providersSetActive: async (): Promise<{ success: boolean; error?: string }> => ({
    success: false,
    error: 'Desktop only',
  }),
  providersSetOverrides: async (): Promise<{
    success: boolean
    error?: string
    pending?: boolean
  }> => ({ success: false, error: 'Desktop only' }),
  providersRefresh: async (): Promise<{
    success: boolean
    added: number
    removed: number
    checkedAt: number
    error?: string
  }> => ({ success: false, added: 0, removed: 0, checkedAt: Date.now(), error: 'Desktop only' }),
  providersSetApiKey: async (): Promise<{ success: boolean; error?: string }> => ({
    success: false,
    error: 'Desktop only',
  }),
  providersForget: async (): Promise<{ success: boolean }> => ({ success: false }),
  providersLogin: async (): Promise<{ success: boolean; error?: string }> => ({
    success: false,
    error: 'Desktop only',
  }),
  providersAuthAnswer: async (): Promise<{ ok: boolean }> => ({ ok: false }),
  providersCancelLogin: async (): Promise<{ ok: boolean }> => ({ ok: false }),
  onProvidersAuthEvent: () => () => {},

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

  // 云端连接：Web 模式下没有主进程，一律按未配对处理
  cloudLinkStatus: async (): Promise<CloudLinkStatusResult> => ({
    success: true,
    link: { linked: false },
    state: { status: 'unlinked', pending: 0 },
    error: 'Cloud pairing is only available in the Electron app',
  }),
  cloudPair: async (): Promise<CloudPairResult> => ({
    success: false,
    error: 'Cloud pairing is only available in the Electron app',
  }),
  cloudUnlink: async () => ({
    success: false,
    error: 'Cloud pairing is only available in the Electron app',
  }),
  cloudReconnect: async () => ({
    success: false,
    error: 'Cloud pairing is only available in the Electron app',
  }),
  cloudRefreshWorkspaces: async () => ({
    success: false,
    error: 'Cloud pairing is only available in the Electron app',
  }),
  cloudListWorkspaces: async (): Promise<{
    success: boolean
    workspaces: CloudWorkspaceEntry[]
  }> => ({
    success: true,
    workspaces: [],
  }),
  onCloudState: (_callback: (state: CloudDeviceState) => void) => () => {},
  cloudClientOpen: async () => ({
    success: false,
    state: { status: 'closed' } as CloudClientState,
    error: 'Cloud connection is only available in the Electron app',
  }),
  cloudClientClose: async () => ({ success: true }),
  cloudClientSend: async () => ({
    success: false,
    error: 'Cloud connection is only available in the Electron app',
  }),
  cloudClientState: async () => ({
    success: true,
    state: { status: 'closed' } as CloudClientState,
  }),
  cloudGetConfig: async (): Promise<CloudConfigResult> => ({
    success: false,
    error: 'Cloud settings are only available in the Electron app',
  }),
  cloudSaveConfig: async () => ({
    success: false,
    error: 'Cloud settings are only available in the Electron app',
  }),
  cloudFetchModels: async (): Promise<{
    success: boolean
    models: string[]
    catalog?: CloudCatalogModel[]
    error?: string
  }> => ({
    success: false,
    models: [],
    catalog: [],
    error: 'Cloud settings are only available in the Electron app',
  }),
  cloudGetMemoryData: async () => ({
    success: false,
    error: 'Cloud memory is only available in the Electron app',
  }),
  cloudAddMemory: async () => ({
    success: false,
    error: 'Cloud memory is only available in the Electron app',
  }),
  cloudUpdateMemory: async () => ({
    success: false,
    error: 'Cloud memory is only available in the Electron app',
  }),
  cloudDeleteMemory: async () => ({
    success: false,
    error: 'Cloud memory is only available in the Electron app',
  }),
  cloudSaveDoc: async () => ({
    success: false,
    error: 'Cloud memory is only available in the Electron app',
  }),
  cloudRunDream: async () => ({
    success: false,
    error: 'Cloud memory is only available in the Electron app',
  }),
  onCloudClientFrame: (_callback: (frame: unknown) => void) => () => {},
  onCloudClientState: (_callback: (state: CloudClientState) => void) => () => {},

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
  gitForgetWorktree: async () => ({
    success: false,
    error: 'Git is only available in the Electron app',
  }),
  gitInstallWorktreeDeps: async () => ({
    success: false,
    error: 'Git is only available in the Electron app',
  }),
  onGitWorktreeDeps: (_callback: (payload: GitWorktreeDepsPayload) => void) => () => {},
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
  gitCreateBranch: async () => ({
    success: false,
    error: 'Git is only available in the Electron app',
  }),
  gitCommitDetail: async () => ({
    success: false,
    error: 'Git is only available in the Electron app',
  }),
  gitDiff: async () => ({ success: true, patch: '' }),
  gitCheckout: async () => ({
    success: false,
    error: 'Git is only available in the Electron app',
  }),
  gitMerge: async () => ({
    success: false,
    error: 'Git is only available in the Electron app',
  }),
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
  onAgentHostCrashed: () => () => {},
  agentHostInfo: async (_workspaceDir: string) => ({
    success: true,
    isolated: false,
    mainPid: 0,
    utilityProcessPid: null,
    runningSessionIds: [] as string[],
  }),
  terminalWrite: async (): Promise<TerminalResult> => ({ success: false }),
  terminalResize: async (): Promise<TerminalResult> => ({ success: false }),
  terminalClose: async (): Promise<TerminalResult> => ({ success: false }),
  terminalFlush: async (): Promise<TerminalResult> => ({ success: false }),
  onTerminalData: (_callback: (payload: { id: string; data: string }) => void) => () => {},
  onTerminalExit: (_callback: (payload: { id: string; exitCode: number }) => void) => () => {},
  onDocumentRenderRequest: (
    _callback: (payload: {
      id: string
      name: string
      bytes: Uint8Array
      pages: number[]
      scale: number
    }) => void
  ) => () => {},
  documentsPreview: async (_path: string): Promise<DocumentPreviewResult> => ({
    success: false,
    error: 'Document preview is only available in the Electron app',
  }),
  documentRenderResult: async (_payload: {
    id: string
    images?: { data: string; mimeType: string }[]
    error?: string
  }) => ({ success: false }),
  searchWorkspaceFiles: async (_workspaceDir: string, _query: string, _limit?: number) => ({
    success: true,
    files: [] as string[],
  }),
  getPathForFile: (_file: File) => '',
  agentSessionsMetaGet: async (_workspaceDir: string) => ({
    success: true,
    meta: { pinned: [] as string[], archived: [] as string[] },
  }),
  agentSessionsMetaSet: async (
    _workspaceDir: string,
    _meta: { pinned: string[]; archived: string[] }
  ) => ({ success: true }),
  writeClipboardText: async (text: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return { success: true }
      }
    } catch {
      // fall through
    }
    return { success: false, error: 'Clipboard unavailable in web mock' }
  },
  onNotifyClick: (_callback: (payload: NotifyClickPayload) => void) => () => {},
}

const prodFallbackAPI = new Proxy(
  { platform: 'unknown' },
  {
    get(target, prop) {
      if (prop in target) return (target as Record<PropertyKey, unknown>)[prop]
      if (typeof prop === 'string' && prop.startsWith('on')) return () => () => {}
      return async () => ({ success: false, error: 'Electron preload bridge is unavailable' })
    },
  }
) as unknown as typeof mockAPI

// 生产包由 import.meta.env.DEV 编译期常量裁掉全部 mockAPI（含 localStorage）
const electronAPI = window.electronAPI || (import.meta.env.DEV ? mockAPI : prodFallbackAPI)

if (!window.electronAPI) {
  console.warn(
    '[API] window.electronAPI is undefined — falling back to mock API. ' +
      'In Electron this usually means the preload script failed to load.'
  )
}

const getBridge = (): Partial<IpcInvokeBridge & IpcEventBridge> =>
  electronAPI as unknown as Partial<IpcInvokeBridge & IpcEventBridge>

const auxWindowCommandCall = createContractApiCall(getBridge, 'auxWindowCommand', {
  fallback: () => ({ success: false, error: 'Not supported' }),
})
const auxWindowStateCall = createContractApiCall(getBridge, 'auxWindowState', {
  fallback: () => ({ success: false, error: 'Not supported' }),
})

const repoMapUnavailable = (): RepoMapResult => ({
  success: false,
  isRepo: false,
  total: 0,
  described: 0,
  truncated: false,
  files: [],
  error: 'Restart the app to enable the repository map',
})

export const api = {
  // File system operations
  openDirectoryDialog: createContractApiCall(getBridge, 'openDirectoryDialog'),
  pickAttachments: createContractApiCall(getBridge, 'pickAttachments', {
    fallback: () => ({ success: true, canceled: true, files: [] }),
    onError: (error) => ({ success: false, canceled: true, files: [], error }),
  }),
  listDirectory: createContractApiCall(getBridge, 'listDirectory'),
  searchWorkspaceFiles: createContractApiCall(getBridge, 'searchWorkspaceFiles', {
    fallback: () => ({ success: true, files: [] }),
  }),
  getPathForFile: (file: File) =>
    typeof electronAPI.getPathForFile === 'function' ? electronAPI.getPathForFile(file) : '',
  getSessionMeta: createContractApiCall(getBridge, 'agentSessionsMetaGet', {
    fallback: () => ({ success: true, meta: { pinned: [], archived: [] } }),
  }),
  setSessionMeta: createContractApiCall(getBridge, 'agentSessionsMetaSet', {
    fallback: () => ({ success: true }),
  }),
  readFile: createContractApiCall(getBridge, 'readFile'),
  writeFile: createContractApiCall(getBridge, 'writeFile'),
  createFile: createContractApiCall(getBridge, 'createFile'),
  writeClipboardText: createContractApiCall(getBridge, 'writeClipboardText', {
    fallback: () => ({ success: false, error: 'Clipboard unavailable' }),
  }),
  openPathExternally: createContractApiCall(getBridge, 'openPathExternally', {
    fallback: () => ({ success: false, error: 'Not available in the browser' }),
  }),
  openExternalUrl: createContractApiCall(getBridge, 'openExternalUrl', {
    fallback: () => ({ success: false, error: 'Not available in the browser' }),
  }),
  exists: createContractApiCall(getBridge, 'exists'),
  stat: createContractApiCall(getBridge, 'stat'),
  deletePath: createContractApiCall(getBridge, 'deletePath'),
  renamePath: createContractApiCall(getBridge, 'renamePath'),
  watchWorkspace: createContractApiCall(getBridge, 'watchWorkspace'),
  unwatchWorkspace: createContractApiCall(getBridge, 'unwatchWorkspace'),
  onFsChanged: createContractEventSub(getBridge, 'onFsChanged'),

  // 文档扫描页渲染：主进程发请求，渲染层回传 PNG
  onDocumentRenderRequest: createContractEventSub(getBridge, 'onDocumentRenderRequest'),
  documentsPreview: createContractApiCall(getBridge, 'documentsPreview', {
    fallback: () => ({
      success: false,
      error: 'Document preview is only available in the Electron app',
    }),
  }),
  documentRenderResult: createContractApiCall(getBridge, 'documentRenderResult', {
    fallback: () => ({ success: false }),
    onError: () => ({ success: false }),
  }),

  // App configuration & data directory
  getAppDir: createContractApiCall(getBridge, 'getAppDir'),
  openDataDir: createContractApiCall(getBridge, 'openDataDir', {
    fallback: () => ({ success: false, error: 'Unsupported' }),
  }),
  logRenderer: createContractApiCall(getBridge, 'logRenderer', {
    onError: () => ({ success: false }),
  }),
  updateCheck: createContractApiCall(getBridge, 'updateCheck', {
    onError: (error) => ({ success: false, state: fallbackUpdateState, error }),
  }),
  updateDownload: createContractApiCall(getBridge, 'updateDownload'),
  updateInstall: createContractApiCall(getBridge, 'updateInstall'),
  updateGetState: createContractApiCall(getBridge, 'updateGetState', {
    onError: (error) => ({ success: false, state: fallbackUpdateState, error }),
  }),
  updateOpenDownload: createContractApiCall(getBridge, 'updateOpenDownload'),
  consumeUpdateNotice: createContractApiCall(getBridge, 'consumeUpdateNotice'),
  onUpdateStatus: createContractEventSub(getBridge, 'onUpdateStatus'),
  appGetInfo: createContractApiCall(getBridge, 'appGetInfo'),
  appHasActiveWork: createContractApiCall(getBridge, 'appHasActiveWork', {
    onError: () => ({ success: false, terminal: false }),
  }),
  getSettings: createContractApiCall(getBridge, 'getSettings'),
  saveSettings: createContractApiCall(getBridge, 'saveSettings'),
  getRecentWorkspaces: createContractApiCall(getBridge, 'getRecentWorkspaces', {
    onError: (error) => ({ success: false, workspaces: [], error }),
  }),
  addRecentWorkspace: createContractApiCall(getBridge, 'addRecentWorkspace', {
    onError: (error) => ({ success: false, workspaces: [], error }),
  }),
  minimizeWindow: createContractApiCall(getBridge, 'minimizeWindow', {
    onError: () => ({ success: false }),
  }),
  toggleMaximizeWindow: createContractApiCall(getBridge, 'toggleMaximizeWindow', {
    onError: () => ({ success: false, maximized: false }),
  }),
  closeWindow: createContractApiCall(getBridge, 'closeWindow', {
    onError: () => ({ success: false }),
  }),
  isWindowMaximized: createContractApiCall(getBridge, 'isWindowMaximized', {
    onError: () => ({ success: false, maximized: false }),
  }),
  onWindowMaximizedChange: createContractEventSub(getBridge, 'onWindowMaximizedChange'),
  // 主进程只接受带 `pi-panel:` 前缀的 frameName，渲染层统一用 HostId
  auxWindowCommand: (host: HostId, command: WindowCommand): Promise<AuxWindowCommandResult> =>
    auxWindowCommandCall(frameNameOf(host), command),
  auxWindowState: (host: HostId): Promise<AuxWindowCommandResult> =>
    auxWindowStateCall(frameNameOf(host)),
  onAuxWindowClosed: createContractEventSub(getBridge, 'onAuxWindowClosed'),
  auxDetachAt: createContractApiCall(getBridge, 'auxDetachAt'),
  auxDragBegin: createContractApiCall(getBridge, 'auxDragBegin', {
    fallback: () => ({ success: false }),
    onError: () => ({ success: false }),
  }),
  appBootReady: () => {
    if (typeof electronAPI.appBootReady === 'function') electronAPI.appBootReady()
  },
  onAppBootExpanded: createContractEventSub(getBridge, 'onAppBootExpanded'),

  // Workspace configuration
  initWorkspace: createContractApiCall(getBridge, 'initWorkspace'),
  disposeWorkspace: createContractApiCall(getBridge, 'disposeWorkspace'),
  draftSave: createContractApiCall(getBridge, 'draftSave'),
  draftDelete: createContractApiCall(getBridge, 'draftDelete'),
  draftList: createContractApiCall(getBridge, 'draftList', {
    onError: (error) => ({ success: false, drafts: [], error }),
  }),
  draftClear: createContractApiCall(getBridge, 'draftClear'),
  editorTabsGet: createContractApiCall(getBridge, 'editorTabsGet'),
  editorTabsSet: createContractApiCall(getBridge, 'editorTabsSet'),
  // 旧 preload（热更新期间尚未重启主进程）没有这两个接口：降级为明确的失败，而不是抛异常
  repoMapScan: createContractApiCall(getBridge, 'repoMapScan', {
    fallback: repoMapUnavailable,
    onError: (error) => ({ ...repoMapUnavailable(), error }),
  }),
  repoMapDescribe: createContractApiCall(getBridge, 'repoMapDescribe', {
    fallback: repoMapUnavailable,
    onError: (error) => ({ ...repoMapUnavailable(), error }),
  }),
  repoMapCanvasGet: createContractApiCall(getBridge, 'repoMapCanvasGet', {
    fallback: () => ({ success: false, state: emptyCanvasState(), error: CANVAS_UNAVAILABLE }),
    onError: (error) => ({ success: false, state: emptyCanvasState(), error }),
  }),
  repoMapCanvasSet: createContractApiCall(getBridge, 'repoMapCanvasSet', {
    fallback: () => ({ success: false, error: CANVAS_UNAVAILABLE }),
  }),

  // API Configuration management (portable architecture)
  providersList: createContractApiCall(getBridge, 'providersList'),
  providersSetActive: createContractApiCall(getBridge, 'providersSetActive'),
  providersSetOverrides: createContractApiCall(getBridge, 'providersSetOverrides'),
  providersRefresh: createContractApiCall(getBridge, 'providersRefresh', {
    onError: (error) => ({ success: false, added: 0, removed: 0, checkedAt: Date.now(), error }),
  }),
  providersSetApiKey: createContractApiCall(getBridge, 'providersSetApiKey'),
  providersForget: createContractApiCall(getBridge, 'providersForget', {
    onError: () => ({ success: false }),
  }),
  providersLogin: createContractApiCall(getBridge, 'providersLogin'),
  providersAuthAnswer: createContractApiCall(getBridge, 'providersAuthAnswer', {
    onError: () => ({ ok: false }),
  }),
  providersCancelLogin: createContractApiCall(getBridge, 'providersCancelLogin', {
    onError: () => ({ ok: false }),
  }),
  onProvidersAuthEvent: createContractEventSub(getBridge, 'onProvidersAuthEvent'),

  // Web search (内置联网能力)
  webSearchGet: createContractApiCall(getBridge, 'webSearchGet'),
  webSearchSave: createContractApiCall(getBridge, 'webSearchSave'),

  // Workbench plugins
  pluginsList: createContractApiCall(getBridge, 'pluginsList', {
    onError: (error) => ({ success: false, plugins: [], error }),
  }),
  pluginsInvoke: createContractApiCall(getBridge, 'pluginsInvoke'),
  pluginsReload: createContractApiCall(getBridge, 'pluginsReload', {
    onError: (error) => ({ success: false, plugins: [], error }),
  }),
  pluginsSetEnabled: createContractApiCall(getBridge, 'pluginsSetEnabled', {
    onError: (error) => ({ success: false, plugins: [], error }),
  }),
  onPluginsChanged: createContractEventSub(getBridge, 'onPluginsChanged'),

  // 云端连接（配对 / 解绑 / 状态）
  cloudLinkStatus: createContractApiCall(getBridge, 'cloudLinkStatus', {
    onError: (error) => ({
      success: false,
      link: { linked: false },
      state: { status: 'error', pending: 0, lastError: error },
      error,
    }),
  }),
  cloudPair: createContractApiCall(getBridge, 'cloudPair'),
  cloudUnlink: createContractApiCall(getBridge, 'cloudUnlink'),
  cloudReconnect: createContractApiCall(getBridge, 'cloudReconnect'),
  cloudRefreshWorkspaces: createContractApiCall(getBridge, 'cloudRefreshWorkspaces'),
  cloudListWorkspaces: createContractApiCall(getBridge, 'cloudListWorkspaces', {
    onError: () => ({ success: false, workspaces: [] }),
  }),
  onCloudState: createContractEventSub(getBridge, 'onCloudState'),
  cloudClientOpen: createContractApiCall(getBridge, 'cloudClientOpen', {
    onError: (error) => ({ success: false, state: { status: 'closed' }, error }),
  }),
  cloudClientClose: createContractApiCall(getBridge, 'cloudClientClose', {
    onError: () => ({ success: false }),
  }),
  cloudClientSend: createContractApiCall(getBridge, 'cloudClientSend'),
  cloudClientState: createContractApiCall(getBridge, 'cloudClientState', {
    onError: () => ({ success: false, state: { status: 'closed' } }),
  }),
  cloudGetConfig: createContractApiCall(getBridge, 'cloudGetConfig'),
  cloudSaveConfig: createContractApiCall(getBridge, 'cloudSaveConfig'),
  cloudFetchModels: createContractApiCall(getBridge, 'cloudFetchModels', {
    onError: (error) => ({ success: false, models: [], error }),
  }),
  cloudGetMemoryData: createContractApiCall(getBridge, 'cloudGetMemoryData'),
  cloudAddMemory: createContractApiCall(getBridge, 'cloudAddMemory'),
  cloudUpdateMemory: createContractApiCall(getBridge, 'cloudUpdateMemory'),
  cloudDeleteMemory: createContractApiCall(getBridge, 'cloudDeleteMemory'),
  cloudSaveDoc: createContractApiCall(getBridge, 'cloudSaveDoc'),
  cloudRunDream: createContractApiCall(getBridge, 'cloudRunDream'),
  onCloudClientFrame: createContractEventSub(getBridge, 'onCloudClientFrame'),
  onCloudClientState: createContractEventSub(getBridge, 'onCloudClientState'),

  // Git worktrees / read-only history / GitHub status
  gitRepoInfo: createContractApiCall(getBridge, 'gitRepoInfo'),
  gitFetch: createContractApiCall(getBridge, 'gitFetch'),
  onGitChanged: createContractEventSub(getBridge, 'onGitChanged'),
  gitListWorktrees: createContractApiCall(getBridge, 'gitListWorktrees'),
  gitForgetWorktree: createContractApiCall(getBridge, 'gitForgetWorktree'),
  gitInstallWorktreeDeps: createContractApiCall(getBridge, 'gitInstallWorktreeDeps'),
  onGitWorktreeDeps: createContractEventSub(getBridge, 'onGitWorktreeDeps'),
  gitBranches: createContractApiCall(getBridge, 'gitBranches'),
  gitStatus: createContractApiCall(getBridge, 'gitStatus'),
  gitSessionBinding: createContractApiCall(getBridge, 'gitSessionBinding'),
  gitBindWorktree: createContractApiCall(getBridge, 'gitBindWorktree'),
  gitReleaseSession: createContractApiCall(getBridge, 'gitReleaseSession'),
  gitCleanupOrphans: createContractApiCall(getBridge, 'gitCleanupOrphans'),
  gitLog: createContractApiCall(getBridge, 'gitLog'),
  gitCommitStats: createContractApiCall(getBridge, 'gitCommitStats'),
  gitCreateBranch: createContractApiCall(getBridge, 'gitCreateBranch'),
  gitCommitDetail: createContractApiCall(getBridge, 'gitCommitDetail'),
  gitDiff: createContractApiCall(getBridge, 'gitDiff'),
  gitCheckout: createContractApiCall(getBridge, 'gitCheckout'),
  gitMerge: createContractApiCall(getBridge, 'gitMerge'),
  gitGithubTokenStatus: createContractApiCall(getBridge, 'gitGithubTokenStatus', {
    onError: () => ({ success: false }),
  }),
  githubAuthConfig: createContractApiCall(getBridge, 'githubAuthConfig'),
  githubAuthStart: createContractApiCall(getBridge, 'githubAuthStart'),
  githubAuthStatus: createContractApiCall(getBridge, 'githubAuthStatus'),
  githubAuthLogout: createContractApiCall(getBridge, 'githubAuthLogout'),
  onGithubAuthComplete: createContractEventSub(getBridge, 'onGithubAuthComplete'),
  githubAuthDeviceStart: createContractApiCall(getBridge, 'githubAuthDeviceStart'),
  githubAuthDeviceCancel: createContractApiCall(getBridge, 'githubAuthDeviceCancel', {
    onError: () => ({ success: false }),
  }),
  githubAuthDeviceOpen: createContractApiCall(getBridge, 'githubAuthDeviceOpen', {
    onError: () => ({ success: false }),
  }),
  onGithubAuthDeviceEvent: createContractEventSub(getBridge, 'onGithubAuthDeviceEvent'),
  gitSetGithubToken: createContractApiCall(getBridge, 'gitSetGithubToken'),
  gitPrStatus: createContractApiCall(getBridge, 'gitPrStatus'),
  onAgentSessionRootChanged: createContractEventSub(getBridge, 'onAgentSessionRootChanged'),

  // Terminal
  terminalCreate: createContractApiCall(getBridge, 'terminalCreate'),
  terminalWrite: createContractApiCall(getBridge, 'terminalWrite'),
  terminalResize: createContractApiCall(getBridge, 'terminalResize'),
  terminalClose: createContractApiCall(getBridge, 'terminalClose'),
  terminalFlush: createContractApiCall(getBridge, 'terminalFlush'),
  onTerminalData: createContractEventSub(getBridge, 'onTerminalData'),
  onTerminalExit: createContractEventSub(getBridge, 'onTerminalExit'),
}
