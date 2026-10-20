/**
 * Agent Manager
 *
 * 管理 Pi Coding Agent 实例的创建、配置和消息处理
 * Agent 运行在 Electron 主进程中，与 main.ts 同进程
 */

import {
  createAgentSession,
  ModelRuntime,
  type AgentSession,
  type CreateAgentSessionResult,
} from '@earendil-works/pi-coding-agent'
import * as path from 'path'
import * as fs from 'fs/promises'

/** 写入 models.json 的自定义供应商 ID */
const WORKBENCH_PROVIDER_ID = 'pi-workbench'
/** models.json 中引用的环境变量名（避免把 API Key 写进磁盘） */
const API_KEY_ENV = 'PI_WORKBENCH_API_KEY'

export interface AgentConfig {
  workspaceDir: string
  /** Agent 数据目录（默认为 {workspace}/.pi-workbench/agent） */
  agentDir?: string
  apiConfig: {
    provider: string
    apiUrl: string
    apiKey: string
    selectedModel: string
  }
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

/**
 * Agent Manager 类
 *
 * 负责：
 * 1. 创建和初始化 Pi Agent 会话
 * 2. 处理用户消息和 Agent 响应
 * 3. 管理会话状态
 */
export class AgentManager {
  private session: AgentSession | null = null
  private config: AgentConfig | null = null
  private messageHistory: AgentMessage[] = []
  private isProcessing = false

  /**
   * 将用户配置的 URL / 模型写入 Pi 的 models.json，
   * 这样任何 OpenAI 兼容端点（DeepSeek、中转站等）都能被 Pi Agent 使用。
   * API Key 通过环境变量引用，不落盘。
   */
  private async writeModelsConfig(agentDir: string, config: AgentConfig): Promise<string> {
    const { provider, apiUrl, selectedModel } = config.apiConfig

    const modelsPath = path.join(agentDir, 'models.json')
    const modelsConfig = {
      $schema: 'https://pi.dev/schemas/models.schema.json',
      providers: {
        [WORKBENCH_PROVIDER_ID]: {
          baseUrl: apiUrl.replace(/\/+$/, ''),
          api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
          apiKey: `$${API_KEY_ENV}`,
          models: [{ id: selectedModel }],
        },
      },
    }

    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(modelsPath, JSON.stringify(modelsConfig, null, 2), 'utf-8')
    return modelsPath
  }

  /**
   * 初始化 Agent 会话
   *
   * @param config Agent 配置
   * @returns 初始化结果
   */
  async initialize(config: AgentConfig): Promise<{ success: boolean; error?: string }> {
    try {
      const { provider, apiUrl, apiKey, selectedModel } = config.apiConfig

      console.log('[Agent Manager] Initializing agent...')
      console.log('[Agent Manager] Workspace:', config.workspaceDir)
      console.log('[Agent Manager] Provider:', provider)
      console.log('[Agent Manager] API URL:', apiUrl)
      console.log('[Agent Manager] Model:', selectedModel)

      this.config = config

      // 重新初始化时释放旧会话
      if (this.session) {
        try {
          this.session.dispose()
        } catch (error) {
          console.warn('[Agent Manager] Failed to dispose previous session:', error)
        }
        this.session = null
      }

      const agentDir = config.agentDir || path.join(config.workspaceDir, '.pi-workbench', 'agent')
      const modelsPath = await this.writeModelsConfig(agentDir, config)

      // API Key 通过环境变量提供给 models.json（不写入磁盘）
      process.env[API_KEY_ENV] = apiKey
      // 原生供应商的环境变量兜底（custom 走 models.json）
      if (provider === 'anthropic') {
        process.env.ANTHROPIC_API_KEY = apiKey
      } else if (provider === 'openai') {
        process.env.OPENAI_API_KEY = apiKey
      }

      // 使用 models.json 构建运行时，并显式选中用户配置的模型
      const modelRuntime = await ModelRuntime.create({
        modelsPath,
        authPath: path.join(agentDir, 'auth.json'),
        refreshOnCreate: false,
      })

      const model = modelRuntime.getModel(WORKBENCH_PROVIDER_ID, selectedModel)
      if (!model) {
        return {
          success: false,
          error: `Model "${selectedModel}" not found. Please fetch models again in Settings.`,
        }
      }

      // 创建 Pi Coding Agent 会话（自带 read/write/edit/bash 工具）
      const result: CreateAgentSessionResult = await createAgentSession({
        cwd: config.workspaceDir,
        agentDir,
        modelRuntime,
        model,
      })

      this.session = result.session

      console.log('[Agent Manager] Agent initialized successfully')
      console.log('[Agent Manager] Using model:', `${model.provider}/${model.id}`)

      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[Agent Manager] Initialization failed:', errorMessage)
      console.error('[Agent Manager] Stack:', error instanceof Error ? error.stack : '')
      return {
        success: false,
        error: `Failed to initialize agent: ${errorMessage}`
      }
    }
  }

  /**
   * 发送消息给 Agent
   *
   * @param message 用户消息
   * @returns Agent 响应
   */
  async chat(message: string): Promise<{ success: boolean; response?: string; error?: string }> {
    if (!this.session) {
      return {
        success: false,
        error: 'Agent not initialized. Please initialize first.',
      }
    }

    if (this.isProcessing) {
      return {
        success: false,
        error: 'Agent is currently processing another request.',
      }
    }

    try {
      this.isProcessing = true
      console.log('[Agent Manager] Sending message to agent:', message.substring(0, 100))

      // 记录用户消息
      this.messageHistory.push({
        role: 'user',
        content: message,
        timestamp: Date.now(),
      })

      // 发送用户消息并等待 Agent 完成
      await this.session.prompt(message)

      // 获取 Agent 的最新消息
      const messages = this.session.messages

      // 从后往前查找最后一条 assistant 消息
      let lastAssistant: any = null
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
          lastAssistant = messages[i]
          break
        }
      }

      if (!lastAssistant) {
        return { success: false, error: 'Agent did not produce a response.' }
      }

      // Pi 在请求失败时不会抛异常，而是把错误放在 stopReason/errorMessage 中
      if (lastAssistant.stopReason === 'error') {
        const detail = lastAssistant.errorMessage || 'Agent request failed'
        console.error('[Agent Manager] Provider error:', detail)
        return { success: false, error: detail }
      }
      if (lastAssistant.stopReason === 'aborted') {
        return { success: false, error: 'Agent request was aborted.' }
      }

      let assistantResponse = ''
      if (typeof lastAssistant.content === 'string') {
        assistantResponse = lastAssistant.content
      } else if (Array.isArray(lastAssistant.content)) {
        assistantResponse = lastAssistant.content
          .filter((part: any) => part.type === 'text')
          .map((part: any) => part.text)
          .join('\n')
      }

      if (!assistantResponse) {
        assistantResponse = 'Agent completed but returned no text response.'
      }

      // 记录 Assistant 响应
      this.messageHistory.push({
        role: 'assistant',
        content: assistantResponse,
        timestamp: Date.now(),
      })

      console.log('[Agent Manager] Agent response received')
      console.log('[Agent Manager] Response preview:', assistantResponse.substring(0, 200))

      return {
        success: true,
        response: assistantResponse,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[Agent Manager] Chat error:', errorMessage)
      console.error('[Agent Manager] Stack:', error instanceof Error ? error.stack : '')

      return {
        success: false,
        error: `Agent error: ${errorMessage}`,
      }
    } finally {
      this.isProcessing = false
    }
  }

  /**
   * 获取消息历史
   */
  getMessageHistory(): AgentMessage[] {
    return this.messageHistory
  }

  /**
   * 清理资源
   */
  async dispose() {
    if (this.session) {
      this.session.dispose()
      this.session = null
    }
    this.config = null
    this.messageHistory = []
  }

  /**
   * 检查 Agent 是否已初始化
   */
  isInitialized(): boolean {
    return this.session !== null
  }

  /**
   * 获取当前配置
   */
  getConfig(): AgentConfig | null {
    return this.config
  }
}
