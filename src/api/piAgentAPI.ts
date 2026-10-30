/**
 * Pi Agent API wrapper
 *
 * - Electron: goes through preload IPC to the main process
 * - Web dev: goes through the Vite dev-server Agent bridge (/__pi/agent/*)
 */

import type {
  AgentImagePayload,
  AgentStreamEvent,
  ApiConfig,
  ApprovalDecision,
  ApprovalRequestPayload,
  ContextUsageInfo,
  ConversationBranchGroup,
  ExportSessionFormat,
  ModelCapabilityInfo,
  PromptTemplateInfo,
  SessionStatsInfo,
  SkillInfo,
  FileEdit,
  SessionListResult,
  SessionOpenResult,
  SessionTabs,
  SessionTabsResult,
  StructuredPlan,
  ToolResultMeta,
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
  plan?: StructuredPlan
}

/** Web 开发模式下由 Vite dev server 提供的 Agent 桥接 */
const DEV_AGENT_INIT = '/__pi/agent/init'
const DEV_AGENT_CHAT = '/__pi/agent/chat'
const DEV_AGENT_CHAT_STREAM = '/__pi/agent/chat-stream'
const DEV_AGENT_ABORT = '/__pi/agent/abort'
const DEV_AGENT_DISPOSE = '/__pi/agent/dispose'
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
  sessionId?: string,
  images?: AgentImagePayload[]
): Promise<AgentChatResponse> {
  const response = await fetch(DEV_AGENT_CHAT_STREAM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, workspaceDir, sessionId, images }),
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
    sessionId?: string,
    images?: AgentImagePayload[]
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
          return await window.electronAPI.agentChat(
            message,
            requestId,
            workspaceDir,
            sessionId,
            images
          )
        } finally {
          unsubscribe?.()
        }
      }
      if (wantsStream) {
        return await streamDevChat(message, handlers, workspaceDir, sessionId, images)
      }
      return await callDevBridge<AgentChatResponse>(DEV_AGENT_CHAT, {
        message,
        workspaceDir,
        sessionId,
        images,
      })
    } catch (error) {
      console.error('[Pi Agent] Chat error:', error)
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
    message: string,
    images?: AgentImagePayload[]
  ): Promise<{ success: boolean; error?: string }> {
    if (!hasElectronAgent()) {
      return { success: false, error: 'Steering is not available in this environment' }
    }
    try {
      return await window.electronAPI.agentSteer(workspaceDir, sessionId, message, images)
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
  ): Promise<{
    success: boolean
    text?: string
    /** 被回退的那条用户消息随行的引用 / 附件；重发时重新打包 */
    context?: import('../types/electron').MessageContext
    error?: string
  }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentRewind !== 'function') {
      return { success: false, error: 'Retry is not available in this environment' }
    }
    try {
      return await window.electronAPI.agentRewind(workspaceDir, sessionId, newText)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 列出同一用户消息下的多条回复（R-03） */
  async listBranches(
    workspaceDir: string,
    sessionId: string
  ): Promise<{ success: boolean; groups?: ConversationBranchGroup[]; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentBranchesList !== 'function') {
      return { success: true, groups: [] }
    }
    try {
      return await window.electronAPI.agentBranchesList(workspaceDir, sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 切换到指定回复分支 */
  async switchBranch(
    workspaceDir: string,
    sessionId: string,
    entryId: string
  ): Promise<{
    success: boolean
    history?: import('../types/electron').AgentHistoryResult['history']
    error?: string
  }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentBranchesSwitch !== 'function') {
      return { success: false, error: 'Branch switching is not available in this environment' }
    }
    try {
      return await window.electronAPI.agentBranchesSwitch(workspaceDir, sessionId, entryId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 会话级模型、思考级别与权限 */
  async getSessionSettings(
    workspaceDir: string,
    sessionId: string
  ): Promise<{
    success: boolean
    modelId?: string
    thinkingLevel?: string
    permission?: import('../types/electron').SessionPermission
    error?: string
  }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentSessionSettings !== 'function') {
      return { success: false, error: 'Session settings are not available in this environment' }
    }
    try {
      return await window.electronAPI.agentSessionSettings(workspaceDir, sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 修改会话权限（档位 + 额外授权），立即落盘 */
  async setSessionPermission(
    workspaceDir: string,
    sessionId: string,
    permission: import('../types/electron').SessionPermission
  ): Promise<{
    success: boolean
    permission?: import('../types/electron').SessionPermission
    error?: string
  }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentSessionSetPermission !== 'function') {
      return { success: false, error: 'Session permissions are not available in this environment' }
    }
    try {
      return await window.electronAPI.agentSessionSetPermission(
        workspaceDir,
        sessionId,
        permission
      )
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async setSessionModel(
    workspaceDir: string,
    sessionId: string,
    modelId: string
  ): Promise<{ success: boolean; error?: string }> {    if (!hasElectronAgent() || typeof window.electronAPI.agentSessionSetModel !== 'function') {
      return { success: false, error: 'Model switching is not available in this environment' }
    }
    try {
      return await window.electronAPI.agentSessionSetModel(workspaceDir, sessionId, modelId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async setSessionThinking(
    workspaceDir: string,
    sessionId: string,
    level: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentSessionSetThinking !== 'function') {
      return { success: false, error: 'Thinking control is not available in this environment' }
    }
    try {
      return await window.electronAPI.agentSessionSetThinking(workspaceDir, sessionId, level)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 会话累计用量与成本 */
  async getSessionStats(
    workspaceDir: string,
    sessionId: string
  ): Promise<{ success: boolean; stats?: SessionStatsInfo; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentSessionStats !== 'function') {
      return { success: false, error: 'Session stats are not available in this environment' }
    }
    try {
      return await window.electronAPI.agentSessionStats(workspaceDir, sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 模型能力提示（R-06） */
  async getModelCapabilities(workspaceDir: string): Promise<{
    success: boolean
    models?: ModelCapabilityInfo[]
    selected?: string
    error?: string
  }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentModelCapabilities !== 'function') {
      return { success: true, models: [] }
    }
    try {
      return await window.electronAPI.agentModelCapabilities(workspaceDir)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 提示模板与技能（R-13） */
  async listPromptResources(
    workspaceDir: string,
    sessionId: string
  ): Promise<{
    success: boolean
    templates?: PromptTemplateInfo[]
    skills?: SkillInfo[]
    error?: string
  }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentPromptResources !== 'function') {
      return { success: true, templates: [], skills: [] }
    }
    try {
      return await window.electronAPI.agentPromptResources(workspaceDir, sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 结构化计划（R-04） */
  async getPlan(
    workspaceDir: string,
    sessionId: string
  ): Promise<{ success: boolean; plan?: StructuredPlan | null; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentPlanGet !== 'function') {
      return { success: true, plan: null }
    }
    try {
      return await window.electronAPI.agentPlanGet(workspaceDir, sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async approvePlan(
    workspaceDir: string,
    sessionId: string,
    planId: string,
    targetMode: 'ask' | 'auto'
  ): Promise<{
    success: boolean
    plan?: StructuredPlan
    permission?: import('../types/electron').SessionPermission
    error?: string
  }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentPlanApprove !== 'function') {
      return { success: false, error: 'Plans are not available in this environment' }
    }
    try {
      return await window.electronAPI.agentPlanApprove(
        workspaceDir,
        sessionId,
        planId,
        targetMode
      )
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  async rejectPlan(
    workspaceDir: string,
    sessionId: string,
    planId: string
  ): Promise<{ success: boolean; plan?: StructuredPlan; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentPlanReject !== 'function') {
      return { success: false, error: 'Plans are not available in this environment' }
    }
    try {
      return await window.electronAPI.agentPlanReject(workspaceDir, sessionId, planId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 工具结果元数据（R-20） */
  async getToolResultMeta(
    workspaceDir: string,
    sessionId: string,
    toolCallId: string
  ): Promise<{ success: boolean; meta?: ToolResultMeta; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentToolResultMeta !== 'function') {
      return { success: false, error: 'Tool results are not available in this environment' }
    }
    try {
      return await window.electronAPI.agentToolResultMeta(workspaceDir, sessionId, toolCallId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 分页读取工具结果文本 */
  async readToolResultChunk(
    workspaceDir: string,
    sessionId: string,
    toolCallId: string,
    offset: number,
    limit?: number
  ): Promise<{
    success: boolean
    text?: string
    offset?: number
    nextOffset?: number
    chars?: number
    done?: boolean
    error?: string
  }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentToolResultChunk !== 'function') {
      return { success: false, error: 'Tool results are not available in this environment' }
    }
    try {
      return await window.electronAPI.agentToolResultChunk(
        workspaceDir,
        sessionId,
        toolCallId,
        offset,
        limit
      )
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 读取工具结果中的图片 */
  async getToolResultImage(
    workspaceDir: string,
    sessionId: string,
    toolCallId: string,
    index = 0
  ): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentToolResultImage !== 'function') {
      return { success: false, error: 'Tool results are not available in this environment' }
    }
    try {
      return await window.electronAPI.agentToolResultImage(
        workspaceDir,
        sessionId,
        toolCallId,
        index
      )
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 完整结果导出到缓存并用系统编辑器打开 */
  async openToolResultExternally(
    workspaceDir: string,
    sessionId: string,
    toolCallId: string
  ): Promise<{ success: boolean; path?: string; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentToolResultOpen !== 'function') {
      return { success: false, error: 'Tool results are not available in this environment' }
    }
    try {
      return await window.electronAPI.agentToolResultOpen(workspaceDir, sessionId, toolCallId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  /** 导出会话（R-10）：Markdown / HTML / 原始 JSONL */
  async exportSession(
    workspaceDir: string,
    sessionId: string,
    format: ExportSessionFormat,
    language?: 'zh' | 'en'
  ): Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }> {
    if (!hasElectronAgent() || typeof window.electronAPI.agentExportSession !== 'function') {
      return { success: false, error: 'Session export is not available in this environment' }
    }
    try {
      return await window.electronAPI.agentExportSession(
        workspaceDir,
        sessionId,
        format,
        language
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

  /** 审批在用户操作之外结束时（超时 / 中止）通知渲染层 */
  onApprovalResolved(
    callback: (payload: {
      requestId: string
      workspaceDir: string
      sessionId: string
      decision: ApprovalDecision
    }) => void
  ): () => void {
    if (
      !hasElectronAgent() ||
      typeof window.electronAPI.onAgentApprovalResolved !== 'function'
    ) {
      return () => {}
    }
    return window.electronAPI.onAgentApprovalResolved(callback)
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
