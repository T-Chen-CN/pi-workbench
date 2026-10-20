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

interface AgentChatResponse {
  success: boolean
  response?: string
  error?: string
  edits?: FileEdit[]
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

/** Web 开发模式下由 Vite dev server 提供的 Agent 桥接 */
const DEV_AGENT_INIT = '/__pi/agent/init'
const DEV_AGENT_CHAT = '/__pi/agent/chat'
const DEV_AGENT_DISPOSE = '/__pi/agent/dispose'
const DEV_AGENT_HISTORY = '/__pi/agent/history'

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
      // Web dev bridge 目前整轮返回，不做流式
      return await callDevBridge<AgentChatResponse>(DEV_AGENT_CHAT, { message })
    } catch (error) {
      console.error('[Pi Agent] Chat error:', error)
      return { success: false, error: bridgeUnavailableError(error) }
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
      return await callDevBridge<AgentHistoryResponse>(DEV_AGENT_HISTORY, {})
    } catch (error) {
      console.error('[Pi Agent] History error:', error)
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
      return await callDevBridge<AgentResponse>(DEV_AGENT_DISPOSE, {})
    } catch (error) {
      console.error('[Pi Agent] Dispose error:', error)
      return { success: false, error: bridgeUnavailableError(error) }
    }
  },
}
