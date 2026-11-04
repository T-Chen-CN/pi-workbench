/**
 * 云端 Agent 的 IPC 封装。
 *
 * 渲染层只与主进程通信：密钥、HTTP、SSE 全在主进程（Node 的 fetch 在这里
 * 会因为系统代理而失败，主进程走 Electron 的 net 栈）。浏览器里跑 `npm run dev`
 * 时没有 IPC，所有调用返回「未配置」，页面显示空态而不是报错。
 */

import type {
  CloudCapabilities,
  CloudConfigGetResult,
  CloudConfigSetResult,
  CloudConnectResult,
  CloudDashboardBounds,
  CloudFrame,
  CloudMessagesResult,
  CloudRunResult,
  CloudRunStartResult,
  CloudDiagnostics,
  CloudJob,
  CloudPendingWrite,
  CloudRunStatus,
  CloudSessionsResult,
  CloudSession,
  CloudConnectionInfo,
} from '../types/cloud'

export type {
  CloudCapabilities,
  CloudConfigGetResult,
  CloudConfigSetResult,
  CloudConnectResult,
  CloudDashboardBounds,
  CloudFrame,
  CloudMessagesResult,
  CloudRunResult,
  CloudRunStartResult,
  CloudSessionsResult,
  CloudConnectionInfo,
} from '../types/cloud'

const FALLBACK_BASE_URL = 'https://api.tchen-xiaoxiao.com'
const FALLBACK_DASHBOARD_URL = 'https://dash.tchen-xiaoxiao.com'
const NO_BRIDGE = '云端通道不可用（缺少应用内 IPC）'

function api() {
  return typeof window === 'undefined' ? undefined : window.electronAPI
}

/** 通道是否真的存在（浏览器 / 旧 preload 时都返回 false） */
export function hasCloudBridge(): boolean {
  const bridge = api()
  return Boolean(bridge && typeof bridge.cloudConfigGet === 'function')
}

export const UNCONFIGURED_CONNECTION: CloudConnectionInfo = {
  baseUrl: FALLBACK_BASE_URL,
  dashboardUrl: FALLBACK_DASHBOARD_URL,
  hasToken: false,
  hasDashboardToken: false,
}

export const cloudApi = {
  async getConfig(): Promise<CloudConfigGetResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudConfigGet !== 'function') {
      return { success: false, config: UNCONFIGURED_CONNECTION, error: NO_BRIDGE }
    }
    return bridge.cloudConfigGet()
  },

  async setConfig(input: { baseUrl: string; apiKey?: string }): Promise<CloudConfigSetResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudConfigSet !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudConfigSet(input)
  },

  async connect(): Promise<CloudConnectResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudConnect !== 'function') {
      return { success: false, state: 'unconfigured', error: NO_BRIDGE }
    }
    return bridge.cloudConnect()
  },

  async disconnect(): Promise<{ success: boolean; error?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudDisconnect !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudDisconnect()
  },

  async listSessions(input?: { limit?: number; offset?: number }): Promise<CloudSessionsResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudSessionsList !== 'function') {
      return { success: false, sessions: [], error: NO_BRIDGE }
    }
    return bridge.cloudSessionsList(input ?? {})
  },

  async updateSession(input: {
    sessionId: string
    title?: string
    pinned?: boolean
  }): Promise<{ success: boolean; session?: CloudSession; error?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudSessionsUpdate !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudSessionsUpdate(input)
  },

  async deleteSession(
    sessionId: string
  ): Promise<{ success: boolean; deleted?: boolean; error?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudSessionsDelete !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudSessionsDelete({ sessionId })
  },

  async diagnostics(): Promise<{
    success: boolean
    error?: string
    diagnostics: CloudDiagnostics | null
  }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudDiagnostics !== 'function') {
      return { success: false, error: NO_BRIDGE, diagnostics: null }
    }
    const result = await bridge.cloudDiagnostics()
    return { ...result, diagnostics: result.diagnostics ?? null }
  },

  async listJobs(): Promise<{ success: boolean; error?: string; jobs: CloudJob[] }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudJobsList !== 'function') {
      return { success: false, error: NO_BRIDGE, jobs: [] }
    }
    const result = await bridge.cloudJobsList()
    return { ...result, jobs: result.jobs ?? [] }
  },

  async runJob(jobId: string): Promise<{ success: boolean; error?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudJobsRun !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudJobsRun({ jobId })
  },

  async pauseJob(jobId: string): Promise<{ success: boolean; error?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudJobsPause !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudJobsPause({ jobId })
  },

  async resumeJob(jobId: string): Promise<{ success: boolean; error?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudJobsResume !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudJobsResume({ jobId })
  },

  async listLedger(): Promise<{
    success: boolean
    error?: string
    entries: CloudPendingWrite[]
  }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudLedgerList !== 'function') {
      return { success: false, error: NO_BRIDGE, entries: [] }
    }
    const result = await bridge.cloudLedgerList()
    return { ...result, entries: result.entries ?? [] }
  },

  async resolveLedger(input: {
    id: string
    verdict: 'done' | 'missing' | 'ignored'
  }): Promise<{ success: boolean; error?: string; entries: CloudPendingWrite[] }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudLedgerResolve !== 'function') {
      return { success: false, error: NO_BRIDGE, entries: [] }
    }
    const result = await bridge.cloudLedgerResolve(input)
    return { ...result, entries: result.entries ?? [] }
  },

  async noteLedger(input: {
    summary: string
    writeClass?: 'external' | 'system' | 'irreversible'
    sessionId?: string
  }): Promise<{ success: boolean; error?: string; entries: CloudPendingWrite[] }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudLedgerNote !== 'function') {
      return { success: false, error: NO_BRIDGE, entries: [] }
    }
    const result = await bridge.cloudLedgerNote(input)
    return { ...result, entries: result.entries ?? [] }
  },

  async uploadImage(input: {
    dataUrl: string
    filename?: string
  }): Promise<{
    success: boolean
    error?: string
    image?: { path: string; name: string; bytes: number; mimeType: string }
  }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudMediaUpload !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudMediaUpload(input)
  },

  async readImage(path: string): Promise<{ success: boolean; error?: string; dataUrl?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudMediaRead !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudMediaRead({ path })
  },

  async listMessages(input: {
    sessionId: string
    limit?: number
    offset?: number
  }): Promise<CloudMessagesResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudMessagesList !== 'function') {
      return { success: false, parts: [], error: NO_BRIDGE }
    }
    return bridge.cloudMessagesList(input)
  },

  async startRun(input: {
    input: string
    sessionId?: string
    idempotencyKey: string
  }): Promise<CloudRunStartResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudRunStart !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudRunStart(input)
  },

  async stopRun(runId: string): Promise<CloudRunResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudRunStop !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudRunStop({ runId })
  },

  async resolveUnknownRun(runId: string): Promise<{
    success: boolean
    error?: string
    state?: CloudRunStatus
  }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudRunResolveUnknown !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudRunResolveUnknown({ runId })
  },

  async steerRun(text: string): Promise<{ success: boolean; error?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudRunSteer !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudRunSteer({ text })
  },

  async runStatus(runId: string): Promise<CloudRunResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudRunStatus !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudRunStatus({ runId })
  },

  async openDashboard(): Promise<{ success: boolean; error?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudDashboardOpen !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudDashboardOpen()
  },

  async closeDashboard(): Promise<{ success: boolean; error?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudDashboardClose !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudDashboardClose()
  },

  async setDashboardBounds(bounds: CloudDashboardBounds): Promise<{ success: boolean }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudDashboardBounds !== 'function') {
      return { success: false }
    }
    return bridge.cloudDashboardBounds(bounds)
  },

  async reloadDashboard(): Promise<{ success: boolean; error?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudDashboardReload !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudDashboardReload()
  },

  onEvent(callback: (frame: CloudFrame) => void): () => void {
    const bridge = api()
    if (!bridge || typeof bridge.onCloudEvent !== 'function') return () => {}
    return bridge.onCloudEvent(callback)
  },

  onStatus(
    callback: (payload: {
      state: 'unconfigured' | 'connecting' | 'connected' | 'error'
      error: string | null
      capabilities?: CloudCapabilities | null
    }) => void
  ): () => void {
    const bridge = api()
    if (!bridge || typeof bridge.onCloudStatus !== 'function') return () => {}
    return bridge.onCloudStatus(callback)
  },

  onDashboardClosed(callback: (payload: { reason?: string }) => void): () => void {
    const bridge = api()
    if (!bridge || typeof bridge.onCloudDashboardClosed !== 'function') return () => {}
    return bridge.onCloudDashboardClosed(callback)
  },

  onDashboardLoaded(callback: () => void): () => void {
    const bridge = api()
    if (!bridge || typeof bridge.onCloudDashboardLoaded !== 'function') return () => {}
    return bridge.onCloudDashboardLoaded(callback)
  },

  onDashboardLoadFailed(
    callback: (payload: { code: number; description: string }) => void
  ): () => void {
    const bridge = api()
    if (!bridge || typeof bridge.onCloudDashboardLoadFailed !== 'function') return () => {}
    return bridge.onCloudDashboardLoadFailed(callback)
  },
}
