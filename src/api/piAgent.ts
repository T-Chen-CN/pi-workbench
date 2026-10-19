/**
 * Pi Agent API
 *
 * 前端调用 Pi Agent 的封装层
 * 通过 IPC 与主进程中的 Agent Manager 通信
 */

import type { AgentInitConfig } from '../types/electron'

/**
 * 初始化 Pi Agent
 *
 * @param config Agent 配置
 * @returns 初始化结果
 */
export async function initializeAgent(config: AgentInitConfig) {
  const result = await window.electronAPI.agentInitialize(config)
  if (!result.success) {
    throw new Error(result.error || 'Failed to initialize agent')
  }
  return result
}

/**
 * 发送消息给 Agent
 *
 * @param message 用户消息
 * @returns Agent 响应
 */
export async function sendMessageToAgent(message: string) {
  const result = await window.electronAPI.agentChat(message)
  if (!result.success) {
    throw new Error(result.error || 'Agent chat failed')
  }
  return {
    role: 'assistant' as const,
    content: result.response || '',
    timestamp: Date.now()
  }
}

/**
 * 检查 Agent 是否已初始化
 */
export async function isAgentInitialized(): Promise<boolean> {
  const result = await window.electronAPI.agentIsInitialized()
  return result.success && result.initialized === true
}

/**
 * 获取 Agent 消息历史
 */
export async function getAgentHistory() {
  const result = await window.electronAPI.agentGetHistory()
  if (!result.success) {
    throw new Error(result.error || 'Failed to get agent history')
  }
  return result.history || []
}

/**
 * 释放 Agent 资源
 */
export async function disposeAgent() {
  const result = await window.electronAPI.agentDispose()
  if (!result.success) {
    throw new Error(result.error || 'Failed to dispose agent')
  }
}

/**
 * 保存 API Key
 *
 * @param provider Provider 名称 (anthropic/openai/google)
 * @param apiKey API Key
 */
export async function saveApiKey(provider: string, apiKey: string) {
  const result = await window.electronAPI.apiKeySave(provider, apiKey)
  if (!result.success) {
    throw new Error(result.error || 'Failed to save API key')
  }
}

/**
 * 加载 API Key
 *
 * @param provider Provider 名称
 * @returns API Key 或 null
 */
export async function loadApiKey(provider: string): Promise<string | null> {
  const result = await window.electronAPI.apiKeyLoad(provider)
  if (!result.success) {
    throw new Error(result.error || 'Failed to load API key')
  }
  return result.apiKey || null
}
