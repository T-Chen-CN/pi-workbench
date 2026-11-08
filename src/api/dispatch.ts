/**
 * 工作区派活的 IPC 封装。
 *
 * 与 `cloud.ts` 同一套约定：渲染层不碰 Node，所有读写都过主进程。
 * 浏览器里跑（没有 IPC）时返回「未启用」，界面显示空态而不是报错。
 */

import type {
  DispatchConfigResult,
  DispatchLedgerEntry,
  DispatchPublicConfig,
  DispatchWorkerState,
} from '../types/electron'

export type DispatchRecentTask = DispatchLedgerEntry

export type DispatchWorkspace = DispatchPublicConfig['workspaces'][number]

const NO_BRIDGE = '浏览器预览模式没有主进程，派活不可用'

function bridge(): any {
  const candidate = (globalThis as unknown as { electronAPI?: any }).electronAPI
  return candidate && typeof candidate.dispatchConfigGet === 'function' ? candidate : null
}

const DISABLED_STATE: DispatchWorkerState = {
  enabled: false,
  connected: false,
  lastFrameAt: null,
  lastError: null,
  runningTaskId: null,
  runningWorkspace: null,
  question: null,
  queued: 0,
  publishedAt: null,
  recent: [],
}

export const EMPTY_DISPATCH_CONFIG: DispatchPublicConfig = {
  enabled: false,
  workspaces: [],
  state: DISABLED_STATE,
}

export const dispatchApi = {
  async get(): Promise<DispatchConfigResult> {
    const api = bridge()
    if (!api) return { success: false, config: EMPTY_DISPATCH_CONFIG, error: NO_BRIDGE }
    return api.dispatchConfigGet()
  },

  async setEnabled(enabled: boolean): Promise<DispatchConfigResult> {
    const api = bridge()
    if (!api) return { success: false, config: EMPTY_DISPATCH_CONFIG, error: NO_BRIDGE }
    return api.dispatchConfigSet({ enabled })
  },

  async addWorkspace(): Promise<DispatchConfigResult & { canceled?: boolean }> {
    const api = bridge()
    if (!api) return { success: false, config: EMPTY_DISPATCH_CONFIG, error: NO_BRIDGE }
    return api.dispatchWorkspaceAdd()
  },

  async updateWorkspace(input: {
    id: string
    label?: string
    description?: string
  }): Promise<DispatchConfigResult> {
    const api = bridge()
    if (!api) return { success: false, config: EMPTY_DISPATCH_CONFIG, error: NO_BRIDGE }
    return api.dispatchWorkspaceUpdate(input)
  },

  async removeWorkspace(id: string): Promise<DispatchConfigResult> {
    const api = bridge()
    if (!api) return { success: false, config: EMPTY_DISPATCH_CONFIG, error: NO_BRIDGE }
    return api.dispatchWorkspaceRemove(id)
  },

  async state(): Promise<DispatchConfigResult> {
    const api = bridge()
    if (!api) return { success: false, config: EMPTY_DISPATCH_CONFIG, error: NO_BRIDGE }
    return api.dispatchState()
  },

  /** 急停：断中继 + 取消正在跑的本地任务 */
  async stop(): Promise<DispatchConfigResult> {
    const api = bridge()
    if (!api) return { success: false, config: EMPTY_DISPATCH_CONFIG, error: NO_BRIDGE }
    return api.dispatchStop()
  },

  /** 主进程推送的运行态；浏览器预览里返回一个空取消函数 */
  onState(callback: (state: DispatchWorkerState) => void): () => void {
    const api = bridge()
    if (!api || typeof api.onDispatchState !== 'function') return () => undefined
    return api.onDispatchState(callback)
  },

  hasBridge(): boolean {
    return Boolean(bridge())
  },
}
