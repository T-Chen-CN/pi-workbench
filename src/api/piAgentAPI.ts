/**
 * Pi Agent API wrapper
 *
 * - Electron: goes through preload IPC to the main process
 * - Web dev: goes through the Vite dev-server Agent bridge (/__pi/agent/*)
 */

import type {
  AgentStreamEvent,
  ApiConfig,
  ApprovalDecision,
  ApprovalRequestPayload,
  CheckpointSummary,
  ContextUsageInfo,
  FileEdit,
  SessionListResult,
  SessionOpenResult,
  SessionMode,
  SessionTabs,
  SessionTabsResult,
} from '../types/electron'

export interface AgentChatStreamHandlers {
  /** 仅接收文本增量（兼容旧调用方） */
  onTextDelta?: (delta: string) => void
  /** 接收按顺序排列的文本 / 思考 / 工具事件 */
  onTrace?: (event: AgentStreamEvent) => void
}

interface AgentInitConfig {
  workspaceDir: string
  apiConfig: ApiConfig
}

interface AgentResponse {
  success: boolean
  message?: string
  error?: string
}

interface AgentUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}

interface AgentChatResponse {
  success: boolean
  response?: string
  error?: string
  edits?: FileEdit[]
  usage?: AgentUsage
}

interface AgentHistoryResponse {
  success: boolean
  history?: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: number
  }>
  error?: string
}

interface AgentStatusResponse {
  success: boolean
  initialized?: boolean
  error?: string
}

/** Web 开发模式下由 Vite dev server 提供的 Agent 桥接 */
const DEV_AGENT_INIT = '/__pi/agent/init'
const DEV_AGENT_CHAT = '/__pi/agent/chat'
const DEV_AGENT_CHAT_STREAM = '/__pi/agent/chat-stream'
const DEV_AGENT_ABORT = '/__pi/agent/abort'
const DEV_AGENT_DISPOSE = '/__pi/agent/dispose'
const DEV_AGENT_HISTORY = '/__pi/agent/history'
const DEV_AGENT_IS_INITIALIZED = '/__pi/agent/isInitialized'
const DEV_AGENT_SESSIONS_LIST = '/__pi/agent/sessions/list'
const DEV_AGENT_SESSIONS_OPEN = '/__pi/agent/sessions/open'
const DEV_AGENT_SESSIONS_CREATE = '/__pi/agent/sessions/create'
const DEV_AGENT_SESSIONS_CLOSE = '/__pi/agent/sessions/close'
const DEV_AGENT_SESSIONS_RENAME = '/__pi/agent/sessions/rename'
const DEV_AGENT_SESSIONS_DELETE = '/__pi/agent/sessions/delete'
const DEV_AGENT_SESSIONS_TABS_GET = '/__pi/agent/sessions/tabs/get'
const DEV_AGENT_SESSIONS_TABS_SET = '/__pi/agent/sessions/tabs/set'

function hasElectronAgent(): boolean {
  return Boolean(window.electronAPI?.agentInitialize)
}

async function callDevBridge<T>(endpoint: string, body: unknown): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`Dev agent bridge returned HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

function bridgeUnavailableError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Agent is unavailable in this environment (${detail}). ` +
    'Run the Electron app (npm run dev) or the Vite dev server to use the agent.'
}

/** 读取 Web dev 桥的 SSE 流：trace 事件回调，done 事件返回最终结果 */
async function streamDevChat(
  message: string,
  handlers: AgentChatStreamHandlers,
  workspaceDir?: string,
  sessionId?: string
): Promise<AgentChatResponse> {
  const response = await fetch(DEV_AGENT_CHAT_STREAM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, workspaceDir, sessionId }),
  })
  if (!response.ok || !response.body) {
    throw new Error(`Dev agent stream returned HTTP ${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final: AgentChatResponse | null = null

  const emitTrace = (event: AgentStreamEvent): void => {
    handlers.onTrace?.(event)
    if (event.type === 'text_delta') handlers.onTextDelta?.(event.delta)
  }

  const consume = (chunk: string): void => {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) return
    const payload = JSON.parse(dataLines.join('\n'))
    if (event === 'trace' && typeof payload?.type === 'string') {
      emitTrace(payload as AgentStreamEvent)
    } else if (event === 'delta' && typeof payload.delta === 'string') {
      // 兼容旧版 Web dev 桥
      emitTrace({ type: 'text_delta', delta: payload.delta })
    } else if (event === 'done') {
      final = payload as AgentChatResponse
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
      consume(chunk)
    }
  }

  if (!final) throw new Error('Dev agent stream ended without a result')
  return final
}

export const piAgentAPI = {
  /**
   * Initialize Pi Agent with API configuration
   */
  async initialize(config: AgentInitConfig): Promise<AgentResponse> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentInitialize(config)
      }
      return await callDevBridge<AgentResponse>(DEV_AGENT_INIT, config)
    } catch (error) {
      console.error('[Pi Agent] Initialize error:', error)
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  /**
   * Send a chat message to the agent.
   * In Electron, trace events（文本 / 思考 / 工具）are forwarded while the run streams.
   * 第二参数既可以是旧的文本回调，也可以是完整的 handlers 对象。
   */
  async chat(
    message: string,
    handlersOrDelta?: AgentChatStreamHandlers | ((delta: string) => void),
    workspaceDir?: string,
    sessionId?: string
  ): Promise<AgentChatResponse> {
    const handlers: AgentChatStreamHandlers =
      typeof handlersOrDelta === 'function'
        ? { onTextDelta: handlersOrDelta }
        : handlersOrDelta ?? {}
    const wantsStream = Boolean(handlers.onTextDelta || handlers.onTrace)

    try {
      if (hasElectronAgent()) {
        const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`
        let unsubscribe: (() => void) | null = null

        if (wantsStream && typeof window.electronAPI.onAgentStream === 'function') {
          unsubscribe = window.electronAPI.onAgentStream((payload) => {
            if (payload.requestId !== requestId) return
            if (sessionId && payload.sessionId && payload.sessionId !== sessionId) return
            const { requestId: _requestId, workspaceDir: _workspaceDir, sessionId: _sessionId, ...event } =
              payload
            handlers.onTrace?.(event)
            if (event.type === 'text_delta') handlers.onTextDelta?.(event.delta)
          })
        }

        try {
          return await window.electronAPI.agentChat(message, requestId, workspaceDir, sessionId)
        } finally {
          unsubscribe?.()
        }
      }
      if (wantsStream) {
        return await streamDevChat(message, handlers, workspaceDir, sessionId)
      }
      return await callDevBridge<AgentChatResponse>(DEV_AGENT_CHAT, {
        message,
        workspaceDir,
        sessionId,
      })
    } catch (error) {
      console.error('[Pi Agent] Chat error:', error)
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  /**
   * Whether the main process currently holds an initialized agent for this workspace
   */
  async isInitialized(workspaceDir?: string): Promise<AgentStatusResponse> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentIsInitialized(workspaceDir)
      }
      return await callDevBridge<AgentStatusResponse>(DEV_AGENT_IS_INITIALIZED, { workspaceDir })
    } catch (error) {
      console.error('[Pi Agent] Status error:', error)
      return { success: false, initialized: false, error: bridgeUnavailableError(error) }
    }
  },

  /**
   * Restore the conversation history persisted by the agent session
   */
  async getHistory(workspaceDir?: string, sessionId?: string): Promise<AgentHistoryResponse> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentGetHistory(workspaceDir, sessionId)
      }
      return await callDevBridge<AgentHistoryResponse>(DEV_AGENT_HISTORY, {
        workspaceDir,
        sessionId,
      })
    } catch (error) {
      console.error('[Pi Agent] History error:', error)
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  /**
   * Abort the request currently in flight for a session
   */
  async abort(workspaceDir?: string, sessionId?: string): Promise<AgentResponse> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentAbort(workspaceDir, sessionId)
      }
      return await callDevBridge<AgentResponse>(DEV_AGENT_ABORT, { workspaceDir, sessionId })
    } catch (error) {
      console.error('[Pi Agent] Abort error:', error)
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  /** 监听模型生成的会话标题 */
  onSessionTitle(
    callback: (payload: { workspaceDir: string; sessionId: string; title: string }) => void
  ): () => void {
    if (!hasElectronAgent() || typeof window.electronAPI.onAgentSessionTitle !== 'function') {
      return () => {}
    }
    return window.electronAPI.onAgentSessionTitle(callback)
  },

  async sessionsList(workspaceDir: string): Promise<SessionListResult> {
    try {
      if (hasElectronAgent()) return await window.electronAPI.agentSessionsList(workspaceDir)
      return await callDevBridge<SessionListResult>(DEV_AGENT_SESSIONS_LIST, { workspaceDir })
    } catch (error) {
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  async sessionsOpen(workspaceDir: string, sessionId?: string): Promise<SessionOpenResult> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentSessionsOpen(workspaceDir, sessionId)
      }
      return await callDevBridge<SessionOpenResult>(DEV_AGENT_SESSIONS_OPEN, {
        workspaceDir,
        sessionId,
      })
    } catch (error) {
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  async sessionsCreate(workspaceDir: string): Promise<SessionOpenResult> {
    try {
      if (hasElectronAgent()) return await window.electronAPI.agentSessionsCreate(workspaceDir)
      return await callDevBridge<SessionOpenResult>(DEV_AGENT_SESSIONS_CREATE, { workspaceDir })
    } catch (error) {
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  async sessionsClose(workspaceDir: string, sessionId: string): Promise<AgentResponse> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentSessionsClose(workspaceDir, sessionId)
      }
      return await callDevBridge<AgentResponse>(DEV_AGENT_SESSIONS_CLOSE, {
        workspaceDir,
        sessionId,
      })
    } catch (error) {
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  async sessionsRename(
    workspaceDir: string,
    sessionId: string,
    name: string
  ): Promise<AgentResponse> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentSessionsRename(workspaceDir, sessionId, name)
      }
      return await callDevBridge<AgentResponse>(DEV_AGENT_SESSIONS_RENAME, {
        workspaceDir,
        sessionId,
        name,
      })
    } catch (error) {
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  async sessionsDelete(workspaceDir: string, sessionId: string): Promise<AgentResponse> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentSessionsDelete(workspaceDir, sessionId)
      }
      return await callDevBridge<AgentResponse>(DEV_AGENT_SESSIONS_DELETE, {
        workspaceDir,
        sessionId,
      })
    } catch (error) {
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  async sessionsGetTabs(workspaceDir: string): Promise<SessionTabsResult> {
    try {
      if (hasElectronAgent()) return await window.electronAPI.agentSessionsGetTabs(workspaceDir)
      return await callDevBridge<SessionTabsResult>(DEV_AGENT_SESSIONS_TABS_GET, { workspaceDir })
    } catch (error) {
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  async sessionsSetTabs(workspaceDir: string, tabs: SessionTabs): Promise<AgentResponse> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentSessionsSetTabs(workspaceDir, tabs)
      }
      return await callDevBridge<AgentResponse>(DEV_AGENT_SESSIONS_TABS_SET, {
        workspaceDir,
        tabs,
      })
    } catch (error) {
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  async sessionsSetMode(
    workspaceDir: string,
    sessionId: string,
    mode: SessionMode
  ): Promise<AgentResponse> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentSessionsSetMode(workspaceDir, sessionId, mode)
      }
      return { success: false, error: 'Session modes are not available in this environment' }
    } catch (error) {
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  /** 桌面通知点击：定位到对应工作区与会话 */
  onNotifyClick(
    callback: (payload: { workspaceDir: string; sessionId: string }) => void
  ): () => void {
    if (typeof window.electronAPI?.onNotifyClick !== 'function') return () => {}
    return window.electronAPI.onNotifyClick(callback)
  },

  /** 运行中插话：把消息注入当前轮 */
  async steer(
    workspaceDir: string,
    sessionId: string,
    message: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!hasElectronAgent()) {
      return { success: false, error: 'Steering is not available in this environment' }
    }
    try {
      return await window.electronAPI.agentSteer(workspaceDir, sessionId, message)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 读取上下文窗口占用 */
  async getContextUsage(
    workspaceDir: string,
    sessionId: string
  ): Promise<{ success: boolean; usage?: ContextUsageInfo; error?: string }> {
    if (!hasElectronAgent()) {
      return { success: false, error: 'Context usage is not available in this environment' }
    }
    try {
      return await window.electronAPI.agentContextUsage(workspaceDir, sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 手动压缩上下文 */
  async compactContext(
    workspaceDir: string,
    sessionId: string
  ): Promise<{
    success: boolean
    tokensBefore?: number
    estimatedTokensAfter?: number
    error?: string
  }> {
    if (!hasElectronAgent()) {
      return { success: false, error: 'Compaction is not available in this environment' }
    }
    try {
      return await window.electronAPI.agentCompactContext(workspaceDir, sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 回退到最后一条用户消息（重试 / 编辑重发） */
  async rewindLastUser(
    workspaceDir: string,
    sessionId: string,
    newText?: string
  ): Promise<{ success: boolean; text?: string; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentRewind !== 'function') {
      return { success: false, error: 'Retry is not available in this environment' }
    }
    try {
      return await window.electronAPI.agentRewind(workspaceDir, sessionId, newText)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 检查点列表 */
  async listCheckpoints(
    workspaceDir: string,
    sessionId?: string
  ): Promise<{ success: boolean; checkpoints?: CheckpointSummary[]; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentCheckpointsList !== 'function') {
      return { success: true, checkpoints: [] }
    }
    try {
      return await window.electronAPI.agentCheckpointsList(workspaceDir, sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 回退到检查点 */
  async restoreCheckpoint(
    workspaceDir: string,
    sessionId: string,
    checkpointId: string,
    options: { files?: boolean; conversation?: boolean }
  ): Promise<{ success: boolean; restoredFiles?: number; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentCheckpointsRestore !== 'function') {
      return { success: false, error: 'Checkpoints are not available in this environment' }
    }
    try {
      return await window.electronAPI.agentCheckpointsRestore(
        workspaceDir,
        sessionId,
        checkpointId,
        options
      )
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /**
   * 监听工具审批请求（仅 Electron；Web dev 桥没有审批通道）
   */
  onApprovalRequest(callback: (payload: ApprovalRequestPayload) => void): () => void {
    if (!hasElectronAgent() || typeof window.electronAPI.onAgentApprovalRequest !== 'function') {
      return () => {}
    }
    return window.electronAPI.onAgentApprovalRequest(callback)
  },

  async respondApproval(
    requestId: string,
    decision: ApprovalDecision
  ): Promise<{ success: boolean; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentRespondApproval !== 'function') {
      return { success: false, error: 'Approvals are not available in this environment' }
    }
    try {
      return await window.electronAPI.agentRespondApproval(requestId, decision)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /**
   * Dispose the agent instance
   */
  async dispose(workspaceDir?: string): Promise<AgentResponse> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentDispose(workspaceDir)
      }
      return await callDevBridge<AgentResponse>(DEV_AGENT_DISPOSE, { workspaceDir })
    } catch (error) {
      console.error('[Pi Agent] Dispose error:', error)
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },
}
