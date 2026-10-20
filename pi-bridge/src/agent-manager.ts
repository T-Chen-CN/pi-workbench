/**
 * Agent Manager
 *
 * 管理 Pi Coding Agent 实例的创建、配置和消息处理
 * Agent 运行在 Electron 主进程中，与 main.ts 同进程
 */

import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionResult,
} from '@earendil-works/pi-coding-agent'
import * as path from 'path'
import * as fs from 'fs/promises'
import { existsSync, readFileSync } from 'fs'

/** 写入 models.json 的自定义供应商 ID */
const WORKBENCH_PROVIDER_ID = 'pi-workbench'
/** models.json 中引用的环境变量名（避免把 API Key 写进磁盘） */
const API_KEY_ENV = 'PI_WORKBENCH_API_KEY'
/** 单轮请求的默认超时（毫秒）；超时后自动中止，避免 Agent 永远处于忙碌状态 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000
/** 与 src/api/chatContext.ts 的标记保持一致 */
const CONTEXT_BLOCK_START = '<pi-workbench-context>'
const CONTEXT_BLOCK_END = '</pi-workbench-context>'

/** 恢复历史时去掉附件上下文块，避免聊天面板展示整段文件内容 */
function stripContextBlock(content: string): string {
  const start = content.indexOf(CONTEXT_BLOCK_START)
  const end = content.indexOf(CONTEXT_BLOCK_END)
  if (start === -1 || end <= start) return content

  const before = content.slice(0, start).trim()
  const after = content.slice(end + CONTEXT_BLOCK_END.length).trim()
  return [before, after].filter(Boolean).join('\n\n') || '(attached files)'
}

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

export interface FileEdit {
  path: string
  oldContent: string
  newContent: string
}

export interface AgentChatResult {
  success: boolean
  response?: string
  error?: string
  /** Agent 在本轮对话中修改过的文件（用于 Diff 展示） */
  edits?: FileEdit[]
}

export interface AgentChatOptions {
  /** 接收流式文本增量（模型逐段输出时调用） */
  onTextDelta?: (delta: string) => void
  /** 单轮请求超时（毫秒），0 表示不超时；默认 10 分钟 */
  timeoutMs?: number
}

/**
 * Agent Manager 类
 *
 * 负责：
 * 1. 创建和初始化 Pi Agent 会话（自动恢复同一工作区的最近会话）
 * 2. 处理用户消息和 Agent 响应
 * 3. 捕获 Agent 的文件修改，供 Diff 查看器展示
 */
export class AgentManager {
  private session: AgentSession | null = null
  private config: AgentConfig | null = null
  private messageHistory: AgentMessage[] = []
  private isProcessing = false
  private unsubscribe: (() => void) | null = null

  /** toolCallId -> 执行前的文件快照 */
  private editSnapshots = new Map<string, { path: string; oldContent: string }>()
  /** 本轮对话产生的文件修改 */
  private pendingEdits: FileEdit[] = []
  /** 本轮对话的流式回调（chat 期间有效） */
  private onTextDelta: ((delta: string) => void) | null = null

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
   * Windows 上 Pi 的 bash 工具需要 Git Bash：它只查 Program Files 和 PATH。
   * 若 Git 安装在用户目录（常见于 per-user 安装），这里把 bash.exe 所在目录补进 PATH。
   */
  private ensureBashOnPath(): void {
    if (process.platform !== 'win32') return

    const localAppData = process.env.LOCALAPPDATA ?? ''
    const programFiles = process.env.ProgramFiles ?? ''
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? ''

    const candidates = [
      path.join(localAppData, 'Programs', 'Git', 'bin'),
      path.join(localAppData, 'Programs', 'Git', 'usr', 'bin'),
      path.join(programFiles, 'Git', 'bin'),
      path.join(programFilesX86, 'Git', 'bin'),
      'C:\\Program Files\\Git\\bin',
    ].filter((dir) => dir && existsSync(path.join(dir, 'bash.exe')))

    if (candidates.length === 0) {
      console.warn('[Agent Manager] Git Bash not found; the bash tool will be unavailable')
      return
    }

    const currentPath = process.env.PATH ?? ''
    const existing = currentPath
      .split(path.delimiter)
      .map((entry) => entry.toLowerCase())
      .filter(Boolean)
    const missing = candidates.filter((dir) => !existing.includes(dir.toLowerCase()))

    if (missing.length > 0) {
      process.env.PATH = [...missing, currentPath].join(path.delimiter)
      console.log('[Agent Manager] Added Git Bash to PATH:', missing.join(', '))
    }
  }

  /** 把工具参数里的路径解析为绝对路径 */
  private resolveToolPath(toolPath: unknown): string | null {
    if (typeof toolPath !== 'string' || !toolPath) return null
    return path.isAbsolute(toolPath)
      ? toolPath
      : path.resolve(this.config?.workspaceDir ?? process.cwd(), toolPath)
  }

  /**
   * 订阅工具执行事件，记录 write/edit 前后的文件内容。
   * Pi 的 write / edit 工具参数分别为 { path, content } 和 { path, edits }。
   */
  private subscribeToToolEdits(): void {
    if (!this.session) return

    this.unsubscribe = this.session.subscribe((event: any) => {
      try {
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent
          if (update?.type === 'text_delta' && typeof update.delta === 'string') {
            this.onTextDelta?.(update.delta)
          }
          return
        }

        if (event.type === 'tool_execution_start') {
          if (event.toolName !== 'write' && event.toolName !== 'edit') return
          const target = this.resolveToolPath(event.args?.path)
          if (!target) return
          const oldContent = existsSync(target) ? readFileSync(target, 'utf-8') : ''
          this.editSnapshots.set(event.toolCallId, { path: target, oldContent })
          return
        }

        if (event.type === 'tool_execution_end') {
          const snapshot = this.editSnapshots.get(event.toolCallId)
          if (!snapshot) return
          this.editSnapshots.delete(event.toolCallId)

          const newContent = existsSync(snapshot.path) ? readFileSync(snapshot.path, 'utf-8') : ''
          if (newContent !== snapshot.oldContent) {
            this.pendingEdits.push({
              path: snapshot.path,
              oldContent: snapshot.oldContent,
              newContent,
            })
          }
        }
      } catch (error) {
        console.warn('[Agent Manager] Failed to capture tool edit:', error)
      }
    })
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
          this.unsubscribe?.()
          this.unsubscribe = null
          this.session.dispose()
        } catch (error) {
          console.warn('[Agent Manager] Failed to dispose previous session:', error)
        }
        this.session = null
      }

      const agentDir = config.agentDir || path.join(config.workspaceDir, '.pi-workbench', 'agent')
      const modelsPath = await this.writeModelsConfig(agentDir, config)

      // Windows: 确保 bash 工具能找到 Git Bash
      this.ensureBashOnPath()

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

      // 同一工作区恢复最近的会话（跨重启保留上下文）
      const sessionDir = path.join(agentDir, 'sessions')
      const sessionManager = SessionManager.continueRecent(config.workspaceDir, sessionDir)

      // 创建 Pi Coding Agent 会话（自带 read/write/edit/bash 工具）
      const result: CreateAgentSessionResult = await createAgentSession({
        cwd: config.workspaceDir,
        agentDir,
        modelRuntime,
        model,
        sessionManager,
      })

      this.session = result.session
      this.subscribeToToolEdits()

      console.log('[Agent Manager] Agent initialized successfully')
      console.log('[Agent Manager] Using model:', `${model.provider}/${model.id}`)
      console.log('[Agent Manager] Session file:', sessionManager.getSessionFile() ?? '(new, not persisted yet)')

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
   * @returns Agent 响应（含本轮文件修改）
   */
  async chat(message: string, options?: AgentChatOptions): Promise<AgentChatResult> {
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

    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    let timeoutTimer: NodeJS.Timeout | null = null
    let timedOut = false

    try {
      this.isProcessing = true
      this.onTextDelta = options?.onTextDelta ?? null
      this.pendingEdits = []
      console.log('[Agent Manager] Sending message to agent:', message.substring(0, 100))

      // 记录用户消息
      this.messageHistory.push({
        role: 'user',
        content: message,
        timestamp: Date.now(),
      })

      // 发送用户消息并等待 Agent 完成；超时后中止，避免永久阻塞后续请求
      const promptPromise = this.session.prompt(message)
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true
          const session = this.session
          console.warn(`[Agent Manager] Request timed out after ${timeoutMs}ms; aborting`)
          if (session) {
            void session.abort().catch((error) => {
              console.warn('[Agent Manager] Failed to abort timed-out request:', error)
            })
          }
        }, timeoutMs)
        timeoutTimer.unref?.()
      }
      await promptPromise

      // 收集本轮文件修改（在读取回复前取出，确保不串到下一轮）
      const edits = this.pendingEdits.splice(0)

      if (timedOut) {
        return {
          success: false,
          error: `Agent request timed out after ${Math.round(timeoutMs / 1000)}s`,
          edits,
        }
      }

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
        return { success: false, error: 'Agent did not produce a response.', edits }
      }

      // Pi 在请求失败时不会抛异常，而是把错误放在 stopReason/errorMessage 中
      if (lastAssistant.stopReason === 'error') {
        const detail = lastAssistant.errorMessage || 'Agent request failed'
        console.error('[Agent Manager] Provider error:', detail)
        return { success: false, error: detail, edits }
      }
      if (lastAssistant.stopReason === 'aborted') {
        return { success: false, error: 'Agent request was aborted.', edits }
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
      if (edits.length > 0) {
        console.log('[Agent Manager] Files edited:', edits.map(e => e.path).join(', '))
      }

      return {
        success: true,
        response: assistantResponse,
        edits,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[Agent Manager] Chat error:', errorMessage)
      console.error('[Agent Manager] Stack:', error instanceof Error ? error.stack : '')

      return {
        success: false,
        error: `Agent error: ${errorMessage}`,
        edits: this.pendingEdits.splice(0),
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      this.isProcessing = false
      this.onTextDelta = null
    }
  }

  /** 中止当前请求（用户手动停止或超时） */
  async abort(): Promise<void> {
    if (!this.session) return
    try {
      await this.session.abort()
    } catch (error) {
      console.warn('[Agent Manager] Failed to abort request:', error)
    }
  }

  /**
   * 获取消息历史（本轮进程内的增量）
   */
  getMessageHistory(): AgentMessage[] {
    return this.messageHistory
  }

  /**
   * 从持久化的 Pi 会话中恢复可展示的对话历史
   */
  getSessionMessages(): AgentMessage[] {
    const messages = this.session?.messages ?? []
    const result: AgentMessage[] = []

    for (const msg of messages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') continue

      let content = ''
      if (typeof msg.content === 'string') {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter((part: any) => part.type === 'text')
          .map((part: any) => part.text)
          .join('\n')
      }
      if (!content) continue

      if (msg.role === 'user') {
        content = stripContextBlock(content)
      }

      result.push({
        role: msg.role,
        content,
        timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
      })
    }

    return result
  }

  /**
   * 清理资源
   */
  async dispose() {
    if (this.unsubscribe) {
      try {
        this.unsubscribe()
      } catch {
        // ignore
      }
      this.unsubscribe = null
    }
    if (this.session) {
      this.session.dispose()
      this.session = null
    }
    this.config = null
    this.messageHistory = []
    this.pendingEdits = []
    this.editSnapshots.clear()
    this.onTextDelta = null
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
