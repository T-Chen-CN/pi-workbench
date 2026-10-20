/**
 * Pi Agent API wrapper
 *
 * - Electron: goes through preload IPC to the main process
 * - Web dev: goes through the Vite dev-server Agent bridge (/__pi/agent/*)
 */

import type { ApiConfig, FileEdit } from '../types/electron'

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

/** 读取 Web dev 桥的 SSE 流：delta 事件增量回调，done 事件返回最终结果 */
async function streamDevChat(
  message: string,
  onDelta: (delta: string) => void,
  workspaceDir?: string
): Promise<AgentChatResponse> {
  const response = await fetch(DEV_AGENT_CHAT_STREAM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, workspaceDir }),
  })
  if (!response.ok || !response.body) {
    throw new Error(`Dev agent stream returned HTTP ${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let final: AgentChatResponse | null = null

  const consume = (chunk: string): void => {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) return
    const payload = JSON.parse(dataLines.join('\n'))
    if (event === 'delta' && typeof payload.delta === 'string') {
      onDelta(payload.delta)
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
   * In Electron, text deltas are forwarded to `onDelta` while the run streams.
   */
  async chat(
    message: string,
    onDelta?: (delta: string) => void,
    workspaceDir?: string
  ): Promise<AgentChatResponse> {
    try {
      if (hasElectronAgent()) {
        const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`
        let unsubscribe: (() => void) | null = null

        if (onDelta && typeof window.electronAPI.onAgentStream === 'function') {
          unsubscribe = window.electronAPI.onAgentStream((payload) => {
            if (payload.requestId === requestId) onDelta(payload.delta)
          })
        }

        try {
          return await window.electronAPI.agentChat(message, requestId, workspaceDir)
        } finally {
          unsubscribe?.()
        }
      }
      if (onDelta) {
        return await streamDevChat(message, onDelta, workspaceDir)
      }
      return await callDevBridge<AgentChatResponse>(DEV_AGENT_CHAT, { message, workspaceDir })
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
  async getHistory(workspaceDir?: string): Promise<AgentHistoryResponse> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentGetHistory(workspaceDir)
      }
      return await callDevBridge<AgentHistoryResponse>(DEV_AGENT_HISTORY, { workspaceDir })
    } catch (error) {
      console.error('[Pi Agent] History error:', error)
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },

  /**
   * Abort the request currently in flight
   */
  async abort(workspaceDir?: string): Promise<AgentResponse> {
    try {
      if (hasElectronAgent()) {
        return await window.electronAPI.agentAbort(workspaceDir)
      }
      return await callDevBridge<AgentResponse>(DEV_AGENT_ABORT, { workspaceDir })
    } catch (error) {
      console.error('[Pi Agent] Abort error:', error)
      return { success: false, error: bridgeUnavailableError(error) }
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
