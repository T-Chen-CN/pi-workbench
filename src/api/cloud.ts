/**
 * 云端 Agent 的 IPC 封装。
 *
 * 渲染层只与主进程通信：密钥、HTTP、SSE 全在主进程（Node 的 fetch 在这里
 * 会因为系统代理而失败，主进程走 Electron 的 net 栈）。浏览器里跑 `npm run dev`
 * 时没有 IPC，所有调用返回「未配置」，页面显示空态而不是报错。
 */

import type {
  CloudApprovalChoice,
  CloudApprovalMode,
  CloudCapabilities,
  CloudConfigGetResult,
  CloudConfigSetResult,
  CloudConnectResult,
  CloudHandoffApplyResult,
  CloudHandoffPickResult,
  CloudDashboardBounds,
  CloudFrame,
  CloudMessagesResult,
  CloudPolicyGetResult,
  CloudPolicySetResult,
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
  CloudApprovalChoice,
  CloudApprovalMode,
  CloudCapabilities,
  CloudConfigGetResult,
  CloudConfigSetResult,
  CloudConnectResult,
  CloudHandoffApplyResult,
  CloudHandoffPickResult,
  CloudDashboardBounds,
  CloudFrame,
  CloudMessagesResult,
  CloudPolicyGetResult,
  CloudPolicySetResult,
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
  dashboardUser: '',
  hasDashboardPassword: false,
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

  /** 选交接文件并解析：只回脱敏预览，明文留在主进程 */
  async pickHandoff(): Promise<CloudHandoffPickResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudHandoffPick !== 'function') {
      return { success: false, canceled: false, error: NO_BRIDGE }
    }
    return bridge.cloudHandoffPick()
  },

  /** 应用上一次 pick 的结果：只传一次性 nonce */
  async applyHandoff(applyNonce: string): Promise<CloudHandoffApplyResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudHandoffApply !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudHandoffApply({ applyNonce })
  },

  /** 把保存的控制台口令写进剪贴板（明文不回渲染层） */
  async copyHandoffSecret(field: 'password'): Promise<{ success: boolean; error?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudHandoffCopy !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudHandoffCopy({ field })
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

  async respondClarify(input: {
    requestId: string
    generation: number
    answer: string
  }): Promise<{ success: boolean; error?: string }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudClarifyRespond !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return bridge.cloudClarifyRespond(input)
  },

  /**
   * 提交审批决定。`once / session / deny` 之外的值主进程会拒掉（含 `always`）。
   * 命令与命中规则只用于审计，审批本身不依赖它们。
   */
  async respondApproval(input: {
    runId: string
    requestId?: string
    generation?: number
    choice: CloudApprovalChoice
    command?: string
    patternKeys?: string[]
    sessionId?: string
  }): Promise<{ success: boolean; error?: string; choice?: CloudApprovalChoice }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudApprovalRespond !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return (await bridge.cloudApprovalRespond(input)) ?? { success: false, error: NO_BRIDGE }
  },

  /** 读服务端当前生效的审批策略（白名单子集） */
  async getPolicy(): Promise<CloudPolicyGetResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudPolicyGet !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return (await bridge.cloudPolicyGet()) ?? { success: false, error: NO_BRIDGE }
  },

  /** 切换原生审批档位（只写 `approvals.mode` 一个键） */
  async setPolicy(mode: CloudApprovalMode): Promise<CloudPolicySetResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudPolicySet !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return (await bridge.cloudPolicySet({ mode })) ?? { success: false, error: NO_BRIDGE }
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
    // 桥接层可能什么都不回（Web 调试 mock / 半成品替身）：不能在这里抛
    return { success: result?.success ?? false, error: result?.error, diagnostics: result?.diagnostics ?? null }
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
