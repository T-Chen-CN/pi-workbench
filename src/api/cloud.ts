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
  CloudDeviceResult,
  CloudGatewayRegisterResult,
  CloudGatewayStatusResult,
  CloudDeviceSummary,
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

const FALLBACK_DASHBOARD_URL = 'https://dash.tchen-xiaoxiao.com'
/**
 * 纯浏览器预览（没有 preload）用的假设备身份。
 *
 * 用固定 id 而不是随机：页面每次刷新都该是同一台「设备」，否则看起来像在跳。
 * 名字刻意写明是预览 —— 真机上看到它，说明 preload 没接上，不是真的设备名。
 */
const PREVIEW_DEVICE: CloudDeviceSummary = {
  id: 'web-preview-0000-0000-000000000000',
  name: '浏览器预览（无主进程）',
  defaultName: '浏览器预览（无主进程）',
}

/** 主进程已更新、preload 还是旧的：面板打不开就先重启应用 */
const BRIDGE_STALE = '主进程接口未就绪，请重启应用后重试'

const NO_BRIDGE = '云端通道不可用（缺少应用内 IPC）'

function api() {
  return typeof window === 'undefined' ? undefined : window.electronAPI
}

/**
 * `ipcRenderer.invoke` 在线路缺失时会直接 reject（「No handler registered …」）：
 * 渲染层拿到的不是 `{success:false}` 而是异常。折成结果对象，避免调用方卡在
 * loading 里（主进程还是上一版构建时最容易踩到）。
 */
function invokeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/No handler registered|not been registered/i.test(message)) {
    return '主进程还没更新：重启 npm run dev'
  }
  return message || '云端调用失败'
}

/** 统一包一层：异常 → `{success:false, error}`，且不吞掉空返回 */
async function invoke<T extends { success: boolean; error?: string }>(
  call: () => Promise<T> | undefined,
  fallback: (error: string) => T
): Promise<T> {
  try {
    const result = await call()
    return result ?? fallback(NO_BRIDGE)
  } catch (error) {
    return fallback(invokeError(error))
  }
}

/** 通道是否真的存在（浏览器 / 旧 preload 时都返回 false） */
export function hasCloudBridge(): boolean {
  const bridge = api()
  return Boolean(bridge && typeof bridge.cloudConfigGet === 'function')
}

/** 没有主进程时的网关地址（只用于界面展示占位） */
const FALLBACK_GATEWAY_URL = 'https://hub.tchen-xiaoxiao.com'

export const UNCONFIGURED_CONNECTION: CloudConnectionInfo = {
  gatewayUrl: FALLBACK_GATEWAY_URL,
  dashboardUrl: FALLBACK_DASHBOARD_URL,
  hasDeviceToken: false,
  deviceScopes: [],
  deviceId: '',
  hasDashboardToken: false,
  dashboardUser: '',
  hasDashboardPassword: false,
}

export const cloudApi = {
  /**
   * 本机设备身份。没有 bridge（浏览器预览）时给一份稳定的假身份，
   * 让连接页的设备卡在 `npm run dev` 里也能看。
   */
  async getDevice(): Promise<CloudDeviceResult> {
    const bridge = api()
    // 完全没有 preload = 浏览器里跑 Vite，给预览用的假身份
    if (!bridge) return { success: true, device: PREVIEW_DEVICE }
    // 有 preload 却没有这个方法 = 跑的是旧构建（改了主进程没重启）：
    // 这时绝不能假装成功，否则界面上出现的是假设备名，比报错更难查
    if (typeof bridge.cloudDeviceGet !== 'function') return { success: false, error: BRIDGE_STALE }
    return invoke(
      () => bridge.cloudDeviceGet(),
      (error) => ({ success: false, error })
    )
  },

  /** 改设备名；空串 = 恢复系统默认名 */
  async setDeviceName(name: string): Promise<CloudDeviceResult> {
    const bridge = api()
    if (!bridge) {
      return {
        success: true,
        device: { ...PREVIEW_DEVICE, name: name.trim() || PREVIEW_DEVICE.defaultName },
      }
    }
    if (typeof bridge.cloudDeviceSet !== 'function') return { success: false, error: BRIDGE_STALE }
    return invoke(
      () => bridge.cloudDeviceSet({ name }),
      (error) => ({ success: false, error })
    )
  },

  /** 重新读取系统设备名（自动探测只做一次，跟随系统改名要靠这一下） */
  async reprobeDeviceName(): Promise<CloudDeviceResult> {
    const bridge = api()
    if (!bridge) return { success: true, device: PREVIEW_DEVICE }
    if (typeof bridge.cloudDeviceReprobe !== 'function') {
      return { success: false, error: BRIDGE_STALE }
    }
    return invoke(
      () => bridge.cloudDeviceReprobe(),
      (error) => ({ success: false, error })
    )
  },

  /**
   * 网关状态：这台设备登记了没有、有哪些 scope、云端 Hermes 在不在。
   * 没有 bridge（浏览器预览）时给一份「未登记」的稳定结果。
   */
  async gatewayStatus(): Promise<CloudGatewayStatusResult> {
    const bridge = api()
    if (!bridge) {
      return {
        success: true,
        registered: false,
        gatewayUrl: 'https://hub.tchen-xiaoxiao.com',
        device: PREVIEW_DEVICE,
        error: '浏览器预览里没有主进程，无法登记',
      }
    }
    if (typeof bridge.cloudGatewayStatus !== 'function') {
      return {
        success: false,
        registered: false,
        gatewayUrl: '',
        error: BRIDGE_STALE,
      }
    }
    return invoke(
      () => bridge.cloudGatewayStatus(),
      (error) => ({ success: false, registered: false, gatewayUrl: '', error })
    )
  },

  /** 登记这台设备：管理密钥只在这一刻用，成功后本地只留设备 token */
  async gatewayRegister(input: {
    adminKey: string
    name?: string
    gatewayUrl?: string
    scopes?: string[]
  }): Promise<CloudGatewayRegisterResult> {
    const bridge = api()
    if (!bridge) {
      return { success: false, error: '浏览器预览里无法登记设备（需要主进程）' }
    }
    if (typeof bridge.cloudGatewayRegister !== 'function') {
      return { success: false, error: BRIDGE_STALE }
    }
    return invoke(
      () => bridge.cloudGatewayRegister(input),
      (error) => ({ success: false, error })
    )
  },

  /** 注销这台设备（token 立即失效，要重新登记才能用） */
  async gatewayRevoke(adminKey?: string): Promise<{ success: boolean; error?: string }> {
    const bridge = api()
    if (!bridge) return { success: false, error: '浏览器预览里无法注销设备' }
    if (typeof bridge.cloudGatewayRevoke !== 'function') {
      return { success: false, error: BRIDGE_STALE }
    }
    return invoke(
      () => bridge.cloudGatewayRevoke({ adminKey }),
      (error) => ({ success: false, error })
    )
  },

  async getConfig(): Promise<CloudConfigGetResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudConfigGet !== 'function') {
      return { success: false, config: UNCONFIGURED_CONNECTION, error: NO_BRIDGE }
    }
    return bridge.cloudConfigGet()
  },

  async setConfig(input: { gatewayUrl?: string; dashboardToken?: string }): Promise<CloudConfigSetResult> {
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
    return invoke(
      () => bridge.cloudApprovalRespond(input),
      (error) => ({ success: false, error })
    )
  },

  /** 读服务端当前生效的审批策略（白名单子集） */
  async getPolicy(): Promise<CloudPolicyGetResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudPolicyGet !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return invoke(
      () => bridge.cloudPolicyGet(),
      (error) => ({ success: false, error })
    )
  },

  /** 切换原生审批档位（只写 `approvals.mode` 一个键） */
  async setPolicy(mode: CloudApprovalMode): Promise<CloudPolicySetResult> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudPolicySet !== 'function') {
      return { success: false, error: NO_BRIDGE }
    }
    return invoke(
      () => bridge.cloudPolicySet({ mode }),
      (error) => ({ success: false, error })
    )
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

  /** 接回上一轮还在跑的 run（重启 / 断线后）；没有就返回 `attached: false` */
  async attachRun(input: { sessionId?: string } = {}): Promise<{
    success: boolean
    attached: boolean
    runId?: string
    sessionId?: string
    state?: CloudRunStatus
    error?: string
  }> {
    const bridge = api()
    if (!bridge || typeof bridge.cloudRunAttach !== 'function') {
      return { success: false, attached: false, error: NO_BRIDGE }
    }
    return bridge.cloudRunAttach(input)
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
