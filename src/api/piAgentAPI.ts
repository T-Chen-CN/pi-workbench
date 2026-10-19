/**
 * Pi Agent API wrapper
 * Interfaces with Pi Agent running in Electron main process
 */

interface AgentInitConfig {
  workspaceDir: string
  provider?: 'anthropic' | 'openai' | 'google'
  model?: string
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
}

const electronAPI = window.electronAPI

export const piAgentAPI = {
  /**
   * Initialize Pi Agent
   * API Key will be loaded from secure storage
   */
  async initialize(config: AgentInitConfig): Promise<AgentResponse> {
    if (!electronAPI?.agentInitialize) {
      console.warn('[Pi Agent] electronAPI not available, using mock')
      return { success: true, message: 'Mock agent initialized' }
    }

    try {
      const result = await electronAPI.agentInitialize(config)
      return result
    } catch (error) {
      console.error('[Pi Agent] Initialize error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  },

  /**
   * Send a chat message to the agent
   */
  async chat(message: string): Promise<AgentChatResponse> {
    if (!electronAPI?.agentChat) {
      console.warn('[Pi Agent] electronAPI not available, using mock')
      return {
        success: true,
        response: `Mock response to: ${message}`
      }
    }

    try {
      const result = await electronAPI.agentChat(message)
      return result
    } catch (error) {
      console.error('[Pi Agent] Chat error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  },

  /**
   * Dispose the agent instance
   */
  async dispose(): Promise<AgentResponse> {
    if (!electronAPI?.agentDispose) {
      console.warn('[Pi Agent] electronAPI not available')
      return { success: true, message: 'Mock agent disposed' }
    }

    try {
      const result = await electronAPI.agentDispose()
      return result
    } catch (error) {
      console.error('[Pi Agent] Dispose error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}
