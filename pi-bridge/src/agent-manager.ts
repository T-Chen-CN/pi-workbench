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
import { writeJsonAtomicSync } from './atomic-json.js'

/** 写入 models.json 的自定义供应商 ID */
const WORKBENCH_PROVIDER_ID = 'pi-workbench'
/** models.json 中引用的环境变量名（避免把 API Key 写进磁盘） */
const API_KEY_ENV = 'PI_WORKBENCH_API_KEY'
/** 单轮请求的默认超时（毫秒）；超时后自动中止，避免 Agent 永远处于忙碌状态 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000
/** abort 之后等待 SDK 收尾的宽限期；超过后强制结束本轮，防止永久挂起 */
const ABORT_GRACE_MS = 10_000
/** 调用 session.abort() 本身的等待上限，避免 dispose / 重启被卡住 */
const ABORT_TIMEOUT_MS = 5_000
/** 初始化（模型运行时 + 会话创建）超时 */
const INIT_TIMEOUT_MS = 30_000
/** 与 src/api/chatContext.ts 的标记保持一致 */
const CONTEXT_BLOCK_START = '<pi-workbench-context>'
const CONTEXT_BLOCK_END = '</pi-workbench-context>'

/**
 * 供应商密钥通过 process.env 提供给 Pi SDK（models.json 只存变量名）。
 * 多个 Agent 实例共享进程环境，用引用计数保证最后一个实例释放后才清理。
 */
const providerEnvState = {
  users: 0,
  saved: new Map<string, string | undefined>(),
}
const PROVIDER_ENV_KEYS = ['PI_WORKBENCH_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const

function acquireProviderEnv(apiKey: string, provider: string): void {
  if (providerEnvState.users === 0) {
    providerEnvState.saved.clear()
    for (const key of PROVIDER_ENV_KEYS) {
      providerEnvState.saved.set(key, process.env[key])
      delete process.env[key]
    }
  }
  providerEnvState.users++

  process.env[API_KEY_ENV] = apiKey
  if (provider === 'anthropic') {
    process.env.ANTHROPIC_API_KEY = apiKey
  } else if (provider === 'openai') {
    process.env.OPENAI_API_KEY = apiKey
  }
}

function releaseProviderEnv(): void {
  if (providerEnvState.users === 0) return
  providerEnvState.users--
  if (providerEnvState.users > 0) return

  for (const [key, value] of providerEnvState.saved) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  providerEnvState.saved.clear()
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 超时返回 null，便于调用方处理“迟到的成功结果” */
async function withTimeoutResult<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<{ value: T } | null> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[Agent Manager] ${label} timed out after ${timeoutMs}ms`)
      resolve(null)
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise.then((value) => ({ value })), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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

export interface AgentUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  /** 供应商回报的累计费用（可能为 0） */
  cost: number
}

export interface AgentChatResult {
  success: boolean
  response?: string
  error?: string
  /** Agent 在本轮对话中修改过的文件（用于 Diff 展示） */
  edits?: FileEdit[]
  /** 本轮模型调用的 token 用量 */
  usage?: AgentUsage
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
  /** 是否持有 process.env 中的供应商密钥租约 */
  private envLease = false

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
    writeJsonAtomicSync(modelsPath, modelsConfig)
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

  /** 从 assistant 消息中提取 usage（Pi 保证 assistant 消息带 usage） */
  private readUsage(message: any): AgentUsage | undefined {
    const raw = message?.usage
    if (!raw || typeof raw !== 'object') return undefined
    const value = (input: unknown): number =>
      typeof input === 'number' && Number.isFinite(input) ? input : 0
    return {
      input: value(raw.input),
      output: value(raw.output),
      cacheRead: value(raw.cacheRead),
      cacheWrite: value(raw.cacheWrite),
      totalTokens: value(raw.totalTokens),
      cost: value(raw.cost?.total),
    }
  }

  /** 把工具参数里的路径解析为绝对路径 */
  private resolveToolPath(toolPath: unknown): string | null {
    if (typeof toolPath !== 'string' || !toolPath) return null
    return path.isAbsolute(toolPath)
      ? toolPath
      : path.resolve(this.config?.workspaceDir ?? process.cwd(), toolPath)
  }

  /** 工具路径是否位于工作区内（快照只关心工作区文件） */
  private isInsideWorkspace(targetPath: string): boolean {
    const root = this.config?.workspaceDir
    if (!root) return false
    const relative = path.relative(path.resolve(root), path.resolve(targetPath))
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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

        // Pi SDK 自带自动重试（429 / 5xx / 网络抖动），这里只记录，便于诊断
        if (event.type === 'auto_retry_start') {
          console.warn(
            `[Agent Manager] Provider retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.errorMessage ?? ''}`
          )
          return
        }
        if (event.type === 'auto_retry_end') {
          console.log(`[Agent Manager] Provider retry ${event.success ? 'succeeded' : 'failed'}`)
          return
        }

        // 一轮结束：丢弃本轮未闭合的工具快照，避免 Map 无限增长
        if (event.type === 'turn_end' || event.type === 'agent_end') {
          this.editSnapshots.clear()
          return
        }

        if (event.type === 'tool_execution_start') {
          if (event.toolName !== 'write' && event.toolName !== 'edit') return
          const target = this.resolveToolPath(event.args?.path)
          if (!target || !this.isInsideWorkspace(target)) return
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
    let initialized = false
    try {
      const { provider, apiUrl, apiKey, selectedModel } = config.apiConfig

      console.log('[Agent Manager] Initializing agent...')
      console.log('[Agent Manager] Workspace:', config.workspaceDir)
      console.log('[Agent Manager] Provider:', provider)
      console.log('[Agent Manager] API URL:', apiUrl)
      console.log('[Agent Manager] Model:', selectedModel)

      this.config = config

      // 重新初始化时释放旧会话：先中止进行中的请求，再释放会话与环境租约
      if (this.session) {
        if (this.isProcessing) {
          try {
            await withTimeout(this.session.abort(), ABORT_TIMEOUT_MS, 'Agent abort')
          } catch (error) {
            console.warn('[Agent Manager] Failed to abort previous request:', error)
          }
        }
        try {
          this.unsubscribe?.()
          this.unsubscribe = null
          this.session.dispose()
        } catch (error) {
          console.warn('[Agent Manager] Failed to dispose previous session:', error)
        }
        this.session = null
        this.isProcessing = false
      }
      if (this.envLease) {
        releaseProviderEnv()
        this.envLease = false
      }

      const agentDir = config.agentDir || path.join(config.workspaceDir, '.pi-workbench', 'agent')
      const modelsPath = await this.writeModelsConfig(agentDir, config)

      // Windows: 确保 bash 工具能找到 Git Bash
      this.ensureBashOnPath()

      // API Key 通过环境变量提供给 models.json（不写入磁盘）；多实例共享，引用计数释放
      acquireProviderEnv(apiKey, provider)
      this.envLease = true

      // 使用 models.json 构建运行时，并显式选中用户配置的模型
      const modelRuntime = await withTimeout(
        ModelRuntime.create({
          modelsPath,
          authPath: path.join(agentDir, 'auth.json'),
          refreshOnCreate: false,
        }),
        INIT_TIMEOUT_MS,
        'Agent model runtime'
      )

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
      const sessionPromise = createAgentSession({
        cwd: config.workspaceDir,
        agentDir,
        modelRuntime,
        model,
        sessionManager,
      })
      const sessionOutcome = await withTimeoutResult(
        sessionPromise,
        INIT_TIMEOUT_MS,
        'Agent session creation'
      )
      if (!sessionOutcome) {
        // 超时后底层创建仍可能晚到成功：等它落地并释放，避免会话/句柄泄漏
        void sessionPromise
          .then((late) => {
            try {
              late.session?.dispose()
            } catch {
              // ignore
            }
          })
          .catch(() => undefined)
        throw new Error(`Agent session creation timed out after ${INIT_TIMEOUT_MS}ms`)
      }
      const result: CreateAgentSessionResult = sessionOutcome.value

      this.session = result.session
      this.subscribeToToolEdits()

      console.log('[Agent Manager] Agent initialized successfully')
      console.log('[Agent Manager] Using model:', `${model.provider}/${model.id}`)
      console.log('[Agent Manager] Session file:', sessionManager.getSessionFile() ?? '(new, not persisted yet)')

      initialized = true
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[Agent Manager] Initialization failed:', errorMessage)
      console.error('[Agent Manager] Stack:', error instanceof Error ? error.stack : '')
      return {
        success: false,
        error: `Failed to initialize agent: ${errorMessage}`
      }
    } finally {
      // 初始化失败（含模型不存在等提前返回）时立即归还环境租约
      if (!initialized && this.envLease) {
        releaseProviderEnv()
        this.envLease = false
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
    let hardStopTimer: NodeJS.Timeout | null = null
    let timedOut = false
    let hardStopped = false

    try {
      this.isProcessing = true
      this.onTextDelta = options?.onTextDelta ?? null
      this.pendingEdits = []
      this.editSnapshots.clear()
      // 只认本轮新增的 assistant 消息，避免请求失败时把上一轮回复当成本轮结果
      const messageStartIndex = this.session.messages.length
      console.log('[Agent Manager] Sending message to agent:', message.substring(0, 100))

      // 记录用户消息
      this.messageHistory.push({
        role: 'user',
        content: message,
        timestamp: Date.now(),
      })

      // 发送用户消息并等待 Agent 完成；超时先 abort，宽限期后仍未结束则强制收尾
      const session = this.session
      const promptPromise = session.prompt(message)
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        if (timeoutMs <= 0) return
        timeoutTimer = setTimeout(() => {
          timedOut = true
          console.warn(`[Agent Manager] Request timed out after ${timeoutMs}ms; aborting`)
          void session.abort().catch((error) => {
            console.warn('[Agent Manager] Failed to abort timed-out request:', error)
          })
          hardStopTimer = setTimeout(() => {
            hardStopped = true
            reject(new Error(`Agent request did not stop within ${ABORT_GRACE_MS}ms after abort`))
          }, ABORT_GRACE_MS)
          hardStopTimer.unref?.()
        }, timeoutMs)
        timeoutTimer.unref?.()
      })
      await Promise.race([promptPromise, timeoutPromise])

      // 正常完成时清掉计时器；超时路径由 finally 统一清理
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (hardStopTimer) clearTimeout(hardStopTimer)

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

      // 只从本轮开始的位置往后找最后一条 assistant 消息
      let lastAssistant: any = null
      for (let i = messages.length - 1; i >= messageStartIndex; i--) {
        if (messages[i].role === 'assistant') {
          lastAssistant = messages[i]
          break
        }
      }

      if (!lastAssistant) {
        return { success: false, error: 'Agent did not produce a response.', edits }
      }

      const usage = this.readUsage(lastAssistant)

      // Pi 在请求失败时不会抛异常，而是把错误放在 stopReason/errorMessage 中
      if (lastAssistant.stopReason === 'error') {
        const detail = lastAssistant.errorMessage || 'Agent request failed'
        console.error('[Agent Manager] Provider error:', detail)
        return { success: false, error: detail, edits, usage }
      }
      if (lastAssistant.stopReason === 'aborted') {
        return { success: false, error: 'Agent request was aborted.', edits, usage }
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
        usage,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (timedOut) {
        console.error('[Agent Manager] Request timed out:', errorMessage)
        const edits = this.pendingEdits.splice(0)
        // SDK 没有响应 abort：销毁旧会话，避免迟到的流式/工具事件污染下一轮
        if (hardStopped) {
          await this.resetSessionAfterHardStop()
        }
        return {
          success: false,
          error: `Agent request timed out after ${Math.round(timeoutMs / 1000)}s`,
          edits,
        }
      }
      console.error('[Agent Manager] Chat error:', errorMessage)
      console.error('[Agent Manager] Stack:', error instanceof Error ? error.stack : '')

      return {
        success: false,
        error: `Agent error: ${errorMessage}`,
        edits: this.pendingEdits.splice(0),
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (hardStopTimer) clearTimeout(hardStopTimer)
      this.isProcessing = false
      this.onTextDelta = null
    }
  }

  /** 中止当前请求（用户手动停止或超时） */
  async abort(): Promise<void> {
    if (!this.session) return
    try {
      await withTimeout(this.session.abort(), ABORT_TIMEOUT_MS, 'Agent abort')
    } catch (error) {
      console.warn('[Agent Manager] Failed to abort request:', error)
    }
  }

  /**
   * 硬超时后销毁旧会话并重建：迟到的流式/工具事件随订阅一起消失，
   * 下一轮不会继承上一轮的输出或文件修改。
   */
  private async resetSessionAfterHardStop(): Promise<void> {
    const config = this.config
    try {
      this.unsubscribe?.()
    } catch {
      // ignore
    }
    this.unsubscribe = null
    if (this.session) {
      try {
        this.session.dispose()
      } catch (error) {
        console.warn('[Agent Manager] Failed to dispose stuck session:', error)
      }
      this.session = null
    }
    this.editSnapshots.clear()

    if (!config) return
    try {
      const result = await this.initialize(config)
      if (!result.success) {
        console.error('[Agent Manager] Failed to reinitialize after hard stop:', result.error)
      }
    } catch (error) {
      console.error('[Agent Manager] Failed to reinitialize after hard stop:', error)
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
    if (this.session && this.isProcessing) {
      try {
        await withTimeout(this.session.abort(), ABORT_TIMEOUT_MS, 'Agent abort')
      } catch (error) {
        console.warn('[Agent Manager] Failed to abort before dispose:', error)
      }
    }
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
    if (this.envLease) {
      releaseProviderEnv()
      this.envLease = false
    }
    this.config = null
    this.messageHistory = []
    this.pendingEdits = []
    this.editSnapshots.clear()
    this.onTextDelta = null
    this.isProcessing = false
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
