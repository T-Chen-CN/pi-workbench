/**
 * Agent Manager
 *
 * 管理 Pi Coding Agent 实例的创建、配置和消息处理
 * Agent 运行在 Electron 主进程中，与 main.ts 同进程
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent'
import * as path from 'path'
import * as fs from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { writeJsonAtomicSync } from './atomic-json.js'
import {
  buildApprovalDetails,
  categorizeTool,
  normalizePermissionPolicy,
  type ApprovalDecision,
  type ApprovalRequestPayload,
  type PermissionPolicy,
} from './approval-policy.js'
import {
  CheckpointStore,
  type CheckpointRecord,
  type CheckpointSummary,
} from './checkpoint-store.js'

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
/** 单次工具审批的等待上限；超时按拒绝处理（fail-closed） */
const APPROVAL_TIMEOUT_MS = 120_000
/** 会话标题生成超时 */
const TITLE_TIMEOUT_MS = 15_000
/** 与 src/api/chatContext.ts 的标记保持一致 */
const CONTEXT_BLOCK_START = '<pi-workbench-context>'
const CONTEXT_BLOCK_END = '</pi-workbench-context>'
/** Plan 模式的提示块；历史恢复时整块剥离，不展示给用户 */
const PLAN_BLOCK_START = '<pi-workbench-plan-mode>'
const PLAN_BLOCK_END = '</pi-workbench-plan-mode>'
/** Plan 模式可用的只读工具 */
const PLAN_MODE_TOOLS = ['read', 'grep', 'find', 'ls']
/** Act 模式在无法恢复原工具集时使用的内置工具 */
const DEFAULT_MODE_TOOLS = ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash', 'powershell']
const PLAN_MODE_INSTRUCTION = [
  'You are in Plan mode. Only read-only tools (read, grep, find, ls) are available;',
  'you cannot modify files or run commands.',
  'Explore the repository as needed, then reply with a concise, numbered implementation plan:',
  'what you will change, which files are involved, and any risks or side effects.',
  'Do not claim that changes were made.',
].join(' ')

/** 会话运行模式：plan 仅只读探索并给出计划，act 可修改文件与执行命令 */
export type SessionMode = 'plan' | 'act'

function wrapPlanPrompt(message: string): string {
  return `${PLAN_BLOCK_START}\n${PLAN_MODE_INSTRUCTION}\n${PLAN_BLOCK_END}\n\n${message}`
}

export interface AgentLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

/** 未注入 logger 时保持原有 console 行为 */
const consoleAgentLogger: AgentLogger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: (...args) => console.debug(...args),
}

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
  label: string,
  logger: AgentLogger
): Promise<{ value: T } | null> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(`[Agent Manager] ${label} timed out after ${timeoutMs}ms`)
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

/** 恢复历史时去掉附件上下文块与 Plan 模式提示块，避免聊天面板展示内部指令 */
function stripContextBlock(content: string): string {
  let text = content
  const planStart = text.indexOf(PLAN_BLOCK_START)
  const planEnd = text.indexOf(PLAN_BLOCK_END)
  if (planStart !== -1 && planEnd > planStart) {
    const before = text.slice(0, planStart).trim()
    const after = text.slice(planEnd + PLAN_BLOCK_END.length).trim()
    text = [before, after].filter(Boolean).join('\n\n')
  }

  const start = text.indexOf(CONTEXT_BLOCK_START)
  const end = text.indexOf(CONTEXT_BLOCK_END)
  if (start === -1 || end <= start) return text

  const before = text.slice(0, start).trim()
  const after = text.slice(end + CONTEXT_BLOCK_END.length).trim()
  return [before, after].filter(Boolean).join('\n\n') || '(attached files)'
}

/** 工具步骤展示限额；完整结果仍保留在 Pi JSONL 中 */
const TOOL_ARGS_LIMIT = 1_000
const TOOL_RESULT_LIMIT = 2_000

function truncateText(text: string, max: number, preferTail = false): string {
  if (text.length <= max) return text
  return preferTail ? `…${text.slice(-max)}` : `${text.slice(0, max)}…`
}

function stringifyToolArgs(args: unknown): string {
  try {
    return truncateText(JSON.stringify(args ?? {}), 500)
  } catch {
    return ''
  }
}

/** 生成不包含大字段（尤其 write.content）的参数摘要 */
function summarizeToolArgs(toolName: string, args: any): string {
  const value = args ?? {}
  switch (toolName) {
    case 'read':
    case 'ls':
      return typeof value.path === 'string' ? value.path : stringifyToolArgs(value)
    case 'write': {
      const size = typeof value.content === 'string' ? value.content.length : 0
      return `${value.path ?? ''}${size > 0 ? ` · ${size} 字符` : ''}`
    }
    case 'edit': {
      const count = Array.isArray(value.edits) ? value.edits.length : 0
      return `${value.path ?? ''}${count > 0 ? ` · ${count} 处` : ''}`
    }
    case 'bash':
    case 'powershell':
      return truncateText(String(value.command ?? ''), TOOL_ARGS_LIMIT)
    case 'grep':
    case 'find':
      return [value.pattern, value.path ?? value.glob]
        .filter((part) => typeof part === 'string' && part.length > 0)
        .join(' · ')
    default:
      return stringifyToolArgs(value)
  }
}

/** 从工具结果中提取可展示的文本预览，图片只显示占位 */
function summarizeToolResult(result: any, preferTail = false): string {
  if (!result) return ''
  if (typeof result === 'string') {
    return truncateText(result, TOOL_RESULT_LIMIT, preferTail)
  }
  const content = Array.isArray(result.content) ? result.content : []
  const text = content
    .map((part: any) => {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text
      if (part?.type === 'image') return '[图片]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
  if (text) return truncateText(text, TOOL_RESULT_LIMIT, preferTail)
  if (result.details != null) {
    try {
      return truncateText(JSON.stringify(result.details), TOOL_RESULT_LIMIT, preferTail)
    } catch {
      return ''
    }
  }
  return ''
}

/** 可展示的工具步骤 */
export type AgentTracePart =
  | { type: 'text'; id: string; text: string }
  | {
      type: 'thinking'
      id: string
      text: string
      redacted?: boolean
      durationMs?: number
    }
  | {
      type: 'tool'
      id: string
      toolCallId: string
      toolName: string
      argsSummary: string
      status: 'running' | 'success' | 'error'
      isError?: boolean
      durationMs?: number
      resultPreview?: string
      filePath?: string
    }

/** 主进程归一化后的流式事件；文本、思考和工具共用同一条有序通道 */
export type AgentTraceEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_redacted' }
  | {
      type: 'tool_start'
      toolCallId: string
      toolName: string
      argsSummary: string
      startedAt: number
    }
  | { type: 'tool_update'; toolCallId: string; resultPreview?: string }
  | {
      type: 'tool_end'
      toolCallId: string
      toolName: string
      status: 'success' | 'error'
      durationMs?: number
      resultPreview?: string
      filePath?: string
    }
  | {
      type: 'retry_start'
      attempt: number
      maxAttempts: number
      delayMs: number
      message?: string
    }
  | { type: 'retry_end'; success: boolean }


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
  /** 日志出口；主进程注入 agent.log，未注入时退回 console */
  logger?: AgentLogger
  /** 模型生成会话标题后回调（主进程转发给渲染层） */
  onSessionTitle?: (sessionId: string, title: string) => void
  /** 当前权限策略（每次工具调用时读取，改设置后无需重建 Agent） */
  getPermissionPolicy?: () => unknown
  /** 请求用户审批；未提供时按拒绝处理（fail-closed） */
  requestApproval?: (request: ApprovalRequestPayload) => Promise<ApprovalDecision>
  /** 用户选择“始终允许”时回调，由主进程持久化策略 */
  onPermissionAlwaysAllow?: (category: ApprovalRequestPayload['category']) => void
  /** 检查点存储目录；未提供时不记录检查点（例如 Fleet 任务） */
  checkpointDir?: string
}

export interface SessionSummary {
  id: string
  title: string
  messageCount: number
  createdAt: number
  updatedAt: number
}

export interface SessionOpenResult {
  success: boolean
  session?: SessionSummary
  history?: AgentMessage[]
  error?: string
}

interface SessionRuntime {
  id: string
  sessionManager: SessionManager
  session: AgentSession
  unsubscribe: (() => void) | null
  isProcessing: boolean
  onTextDelta: ((delta: string) => void) | null
  onTrace: ((event: AgentTraceEvent) => void) | null
  /** 当前 assistant 消息中已经收到过增量的 thinking 块 */
  thinkingDeltaSeen: Set<number>
  /** write/edit 工具开始时的目标路径，供 tool_end 附带 */
  toolFiles: Map<string, string>
  editSnapshots: Map<string, { path: string; oldContent: string; existed: boolean }>
  pendingEdits: FileEdit[]
  messageHistory: AgentMessage[]
  createdAt: number
  updatedAt: number
  /** 自动标题只尝试一次 */
  titleAttempted: boolean
  /** 未落盘新会话的临时标题 */
  pendingTitle: string | null
  /** 本会话内已获准的类别（“本会话允许”） */
  sessionAllow: Set<string>
  /** 当前模式；审批钩子与 chat 都会读取 */
  modeState: { current: SessionMode }
  /** 进入 Plan 前的工具集，切回 Act 时恢复 */
  activeToolsBeforePlan: string[] | null
  /** 本轮检查点；轮次结束后落盘 */
  currentCheckpoint: CheckpointRecord | null
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string
  parts?: AgentTracePart[]
  timestamp: number
}

export interface FileEdit {
  path: string
  oldContent: string
  newContent: string
  /** 触发该修改的工具调用；用于在工具步骤里打开对应 Diff */
  toolCallId?: string
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
  /** 接收流式文本增量（兼容 Fleet 等只关心文本的调用方） */
  onTextDelta?: (delta: string) => void
  /** 接收归一化的文本 / 思考 / 工具事件；与 onTextDelta 可同时使用 */
  onTrace?: (event: AgentTraceEvent) => void
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
  private config: AgentConfig | null = null
  private logger: AgentLogger = consoleAgentLogger
  private modelRuntime: ModelRuntime | null = null
  private agentDir = ''
  private checkpointStore: CheckpointStore | null = null
  private sessionDir = ''
  private envLease = false
  private runtimes = new Map<string, SessionRuntime>()
  private lastSessionId: string | null = null

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
      this.logger.warn('[Agent Manager] Git Bash not found; the bash tool will be unavailable')
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
      this.logger.info('[Agent Manager] Added Git Bash to PATH:', missing.join(', '))
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

  /** write/edit 的工具行可附带文件路径；其他工具不暴露文件 */
  private toolFilePath(toolName: string, args: any): string | undefined {
    if (toolName !== 'write' && toolName !== 'edit') return undefined
    const target = this.resolveToolPath(args?.path)
    if (!target || !this.isInsideWorkspace(target)) return undefined
    return target
  }

  /**
   * 订阅会话事件：转发文本 / 思考 / 工具步骤，并记录 write/edit 前后内容。
   * Pi 的 write / edit 工具参数分别为 { path, content } 和 { path, edits }。
   */
  private subscribeToSessionEvents(runtime: SessionRuntime): () => void {
    return runtime.session.subscribe((event: any) => {
      try {
        if (event.type === 'message_start' && event.message?.role === 'assistant') {
          runtime.thinkingDeltaSeen.clear()
          return
        }

        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent
          if (update?.type === 'text_delta' && typeof update.delta === 'string') {
            runtime.onTextDelta?.(update.delta)
            runtime.onTrace?.({ type: 'text_delta', delta: update.delta })
          } else if (update?.type === 'thinking_start') {
            if (typeof update.contentIndex === 'number') {
              runtime.thinkingDeltaSeen.delete(update.contentIndex)
            }
          } else if (update?.type === 'thinking_delta' && typeof update.delta === 'string') {
            if (typeof update.contentIndex === 'number') {
              runtime.thinkingDeltaSeen.add(update.contentIndex)
            }
            runtime.onTrace?.({ type: 'thinking_delta', delta: update.delta })
          } else if (update?.type === 'thinking_end') {
            const index = typeof update.contentIndex === 'number' ? update.contentIndex : -1
            // 部分供应商只在 end 给出完整内容，或返回脱敏后的空内容
            if (!runtime.thinkingDeltaSeen.has(index)) {
              const content = typeof update.content === 'string' ? update.content : ''
              if (content) runtime.onTrace?.({ type: 'thinking_delta', delta: content })
              else runtime.onTrace?.({ type: 'thinking_redacted' })
            }
          }
          return
        }

        // Pi SDK 自带自动重试（429 / 5xx / 网络抖动），记录并转发给渲染层
        if (event.type === 'auto_retry_start') {
          this.logger.warn(
            `[Agent Manager] Provider retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.errorMessage ?? ''}`
          )
          runtime.onTrace?.({
            type: 'retry_start',
            attempt: Number(event.attempt) || 0,
            maxAttempts: Number(event.maxAttempts) || 0,
            delayMs: Number(event.delayMs) || 0,
            message: typeof event.errorMessage === 'string' ? event.errorMessage : undefined,
          })
          return
        }
        if (event.type === 'auto_retry_end') {
          this.logger.info(`[Agent Manager] Auto retry ${event.success ? 'succeeded' : 'failed'}`)
          runtime.onTrace?.({ type: 'retry_end', success: Boolean(event.success) })
          return
        }

        // 一轮结束：丢弃本轮未闭合的工具快照，避免 Map 无限增长
        if (event.type === 'turn_end' || event.type === 'agent_end') {
          runtime.editSnapshots.clear()
          runtime.toolFiles.clear()
          runtime.thinkingDeltaSeen.clear()
          return
        }

        if (event.type === 'tool_execution_start') {
          const args = event.args ?? {}
          const filePath = this.toolFilePath(event.toolName, args)
          if (filePath) runtime.toolFiles.set(event.toolCallId, filePath)
          runtime.onTrace?.({
            type: 'tool_start',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            argsSummary: summarizeToolArgs(event.toolName, args),
            startedAt: Date.now(),
          })

          if (event.toolName !== 'write' && event.toolName !== 'edit') return
          const target = this.resolveToolPath(args.path)
          if (!target || !this.isInsideWorkspace(target)) return
          const existed = existsSync(target)
          const oldContent = existed ? readFileSync(target, 'utf-8') : ''
          runtime.editSnapshots.set(event.toolCallId, { path: target, oldContent, existed })
          return
        }

        if (event.type === 'tool_execution_end') {
          const snapshot = runtime.editSnapshots.get(event.toolCallId)
          const filePath = snapshot?.path ?? runtime.toolFiles.get(event.toolCallId)
          runtime.editSnapshots.delete(event.toolCallId)
          runtime.toolFiles.delete(event.toolCallId)

          if (snapshot) {
            const newContent = existsSync(snapshot.path)
              ? readFileSync(snapshot.path, 'utf-8')
              : ''
            if (newContent !== snapshot.oldContent) {
              runtime.pendingEdits.push({
                path: snapshot.path,
                oldContent: snapshot.oldContent,
                newContent,
                toolCallId: event.toolCallId,
              })
              if (
                runtime.currentCheckpoint &&
                !runtime.currentCheckpoint.files.some((file) => file.path === snapshot.path)
              ) {
                runtime.currentCheckpoint.files.push({
                  path: snapshot.path,
                  oldContent: snapshot.existed ? snapshot.oldContent : null,
                })
              }
            }
          }

          runtime.onTrace?.({
            type: 'tool_end',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: event.isError ? 'error' : 'success',
            durationMs: event.durationMs,
            resultPreview: summarizeToolResult(
              event.result,
              event.toolName === 'bash' || event.toolName === 'powershell'
            ),
            filePath,
          })
        }
      } catch (error) {
        this.logger.warn('[Agent Manager] Failed to process session event:', error)
      }
    })
  }

  /**
   * 初始化共享运行时（models.json / ModelRuntime / 环境租约），并打开最近会话。
   * 多会话共用同一模型运行时；每个会话是独立的 SessionRuntime。
   */
  async initialize(config: AgentConfig): Promise<{ success: boolean; error?: string }> {
    let initialized = false
    this.logger = config.logger ?? consoleAgentLogger
    try {
      await this.disposeAllRuntimes()
      if (this.envLease) {
        releaseProviderEnv()
        this.envLease = false
      }

      this.config = config
      const { provider, apiUrl, apiKey, selectedModel } = config.apiConfig

      this.logger.info('[Agent Manager] Initializing agent...')
      this.logger.info('[Agent Manager] Workspace:', config.workspaceDir)
      this.logger.info('[Agent Manager] Provider:', provider)
      this.logger.info('[Agent Manager] API URL:', apiUrl)
      this.logger.info('[Agent Manager] Model:', selectedModel)

      this.agentDir =
        config.agentDir || path.join(config.workspaceDir, '.pi-workbench', 'agent')
      this.checkpointStore = config.checkpointDir
        ? new CheckpointStore(config.checkpointDir, config.workspaceDir)
        : null
      const modelsPath = await this.writeModelsConfig(this.agentDir, config)
      this.ensureBashOnPath()

      acquireProviderEnv(apiKey, provider)
      this.envLease = true

      this.modelRuntime = await withTimeout(
        ModelRuntime.create({
          modelsPath,
          authPath: path.join(this.agentDir, 'auth.json'),
          refreshOnCreate: false,
        }),
        INIT_TIMEOUT_MS,
        'Agent model runtime'
      )

      const model = this.modelRuntime.getModel(WORKBENCH_PROVIDER_ID, selectedModel)
      if (!model) {
        throw new Error(`Model "${selectedModel}" not found. Please fetch models again in Settings.`)
      }

      this.sessionDir = path.join(this.agentDir, 'sessions')
      const sessionManager = SessionManager.continueRecent(config.workspaceDir, this.sessionDir)
      const runtime = await this.createRuntime(sessionManager)
      this.lastSessionId = runtime.id

      this.logger.info('[Agent Manager] Agent initialized successfully')
      this.logger.info('[Agent Manager] Using model:', `${model.provider}/${model.id}`)
      this.logger.info(
        '[Agent Manager] Session file:',
        sessionManager.getSessionFile() ?? '(new, not persisted yet)'
      )

      initialized = true
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error('[Agent Manager] Initialization failed:', errorMessage)
      this.logger.error('[Agent Manager] Stack:', error instanceof Error ? error.stack : '')
      return {
        success: false,
        error: `Failed to initialize agent: ${errorMessage}`,
      }
    } finally {
      if (!initialized) {
        this.runtimes.clear()
        this.modelRuntime = null
        if (this.envLease) {
          releaseProviderEnv()
          this.envLease = false
        }
      }
    }
  }

  /**
   * 工具审批扩展：在工具执行前按策略放行、拒绝或挂起等待用户。
   * 以 inline extension 的方式注册 tool_call 钩子，不落盘，也不属于工作台插件系统。
   */
  private createApprovalExtension(
    sessionId: string,
    sessionAllow: Set<string>,
    getMode: () => SessionMode
  ): ExtensionFactory {
    return (pi) => {
      pi.on('tool_call', async (event: any) => {
        const toolName = String(event?.toolName ?? '')
        const args = event?.input ?? event?.args ?? {}
        const category = categorizeTool(toolName)

        // Plan 模式只允许只读工具；即使工具集被意外放宽也要拦住
        if (getMode() === 'plan' && category !== 'read') {
          return {
            block: true,
            reason:
              'Plan mode is read-only. Switch to Act mode before modifying files or running commands.',
          }
        }

        const policy: PermissionPolicy = normalizePermissionPolicy(this.config?.getPermissionPolicy?.())
        let action = policy[category]
        if (sessionAllow.has(category) && action !== 'deny') action = 'allow'

        if (action === 'allow') return undefined
        if (action === 'deny') {
          this.logger.info(`[Agent Manager] Blocked tool ${toolName} by policy (${category})`)
          return {
            block: true,
            reason: `Tool "${toolName}" is blocked by the current permission policy.`,
          }
        }

        const request: ApprovalRequestPayload = {
          requestId: `approval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          workspaceDir: this.config?.workspaceDir ?? '',
          sessionId,
          toolCallId: String(event?.toolCallId ?? ''),
          toolName,
          category,
          summary: summarizeToolArgs(toolName, args),
          details: buildApprovalDetails(toolName, args),
          createdAt: Date.now(),
          expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
        }

        const decision = await this.requestToolApproval(request)
        this.logger.info(`[Agent Manager] Tool approval for ${toolName}: ${decision.action}`)

        if (decision.action === 'allow-once') return undefined
        if (decision.action === 'allow-session') {
          sessionAllow.add(category)
          return undefined
        }
        if (decision.action === 'allow-always') {
          sessionAllow.add(category)
          try {
            this.config?.onPermissionAlwaysAllow?.(category)
          } catch (error) {
            this.logger.warn('[Agent Manager] Failed to persist always-allow:', error)
          }
          return undefined
        }

        const reason = decision.reason?.trim()
        return {
          block: true,
          reason: reason
            ? `The user denied this tool call: ${reason}`
            : 'The user denied this tool call.',
        }
      })
    }
  }

  /** 向宿主请求审批；没有审批通道或超时都按拒绝处理 */
  private async requestToolApproval(request: ApprovalRequestPayload): Promise<ApprovalDecision> {
    const handler = this.config?.requestApproval
    if (!handler) {
      return { action: 'deny', reason: 'No approval channel is available in this environment.' }
    }
    try {
      return await withTimeout(handler(request), APPROVAL_TIMEOUT_MS, 'Tool approval')
    } catch (error) {
      this.logger.warn('[Agent Manager] Approval failed or timed out:', error)
      return { action: 'deny', reason: 'The approval request timed out.' }
    }
  }

  /**
   * 回退到最后一条用户消息之前，用于重试 / 编辑重发。
   * 返回重新发送的文本（编辑时用 newText 覆盖）。
   */
  async rewindToLastUser(
    sessionId: string,
    newText?: string
  ): Promise<{ success: boolean; text?: string; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      if (runtime.isProcessing) {
        return { success: false, error: 'Session is running; stop it before retrying.' }
      }
      const users = runtime.session.getUserMessagesForForking()
      const last = users[users.length - 1]
      if (!last) return { success: false, error: 'No user message to retry.' }
      const result = await runtime.session.navigateTree(last.entryId, { summarize: false })
      if (result.cancelled) {
        return { success: false, error: 'Rewind was cancelled.' }
      }
      const text = (newText ?? last.text).trim()
      return { success: true, text }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 列出检查点（最近的在前） */
  async listCheckpoints(
    sessionId?: string
  ): Promise<{ success: boolean; checkpoints?: CheckpointSummary[]; error?: string }> {
    if (!this.checkpointStore) return { success: true, checkpoints: [] }
    try {
      return { success: true, checkpoints: await this.checkpointStore.list(sessionId) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 回退到检查点：可只恢复文件、只恢复对话，或两者都恢复。
   * 只覆盖 write/edit 造成的修改；bash 等外部副作用不在检查点范围内。
   */
  async restoreCheckpoint(
    sessionId: string,
    checkpointId: string,
    options: { files?: boolean; conversation?: boolean }
  ): Promise<{ success: boolean; restoredFiles?: number; error?: string }> {
    if (!this.checkpointStore) {
      return { success: false, error: 'Checkpoints are not enabled for this workspace.' }
    }
    try {
      const record = await this.checkpointStore.load(checkpointId)
      if (!record || record.sessionId !== sessionId) {
        return { success: false, error: 'Checkpoint not found.' }
      }
      const runtime = await this.ensureRuntime(sessionId)
      if (runtime.isProcessing) {
        return { success: false, error: 'Session is running; stop it before restoring.' }
      }

      let restoredFiles = 0
      if (options.files) {
        for (const file of record.files) {
          const target = this.resolveToolPath(file.path)
          if (!target || !this.isInsideWorkspace(target)) {
            this.logger.warn('[Agent Manager] Skipped checkpoint file outside workspace:', file.path)
            continue
          }
          if (file.oldContent === null) {
            await fs.rm(target, { force: true })
          } else {
            await fs.mkdir(path.dirname(target), { recursive: true })
            await fs.writeFile(target, file.oldContent, 'utf-8')
          }
          restoredFiles++
        }
      }

      if (options.conversation && record.leafId) {
        const result = await runtime.session.navigateTree(record.leafId, { summarize: false })
        if (result.cancelled) {
          return { success: false, error: 'Conversation restore was cancelled.' }
        }
      }

      return { success: true, restoredFiles }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 读取会话当前的模型与思考级别 */
  async getSessionSettings(sessionId: string): Promise<{
    success: boolean
    modelId?: string
    thinkingLevel?: string
    error?: string
  }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      return {
        success: true,
        modelId: runtime.session.model?.id,
        thinkingLevel: runtime.session.thinkingLevel,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 切换当前会话的模型（写入 model_change，重开会话后保留） */
  async setSessionModel(
    sessionId: string,
    modelId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.modelRuntime) return { success: false, error: 'Agent not initialized.' }
      const model = this.modelRuntime.getModel(WORKBENCH_PROVIDER_ID, modelId)
      if (!model) return { success: false, error: `Model "${modelId}" is unavailable.` }
      const runtime = await this.ensureRuntime(sessionId)
      await runtime.session.setModel(model)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 切换思考级别 */
  async setSessionThinking(
    sessionId: string,
    level: string
  ): Promise<{ success: boolean; error?: string }> {
    const allowed = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    if (!allowed.includes(level)) {
      return { success: false, error: `Unknown thinking level "${level}".` }
    }
    try {
      const runtime = await this.ensureRuntime(sessionId)
      runtime.session.setThinkingLevel(level as any)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 读取当前上下文占用（会话空闲时也有效） */
  async getContextUsage(
    sessionId: string
  ): Promise<{ success: boolean; usage?: { tokens: number | null; contextWindow: number; percent: number | null }; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const usage = runtime.session.getContextUsage()
      return {
        success: true,
        usage: usage
          ? {
              tokens: usage.tokens ?? null,
              contextWindow: usage.contextWindow,
              percent: usage.percent ?? null,
            }
          : undefined,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 手动压缩上下文；运行中不压缩，避免打断当前轮 */
  async compactContext(
    sessionId: string
  ): Promise<{
    success: boolean
    tokensBefore?: number
    estimatedTokensAfter?: number
    error?: string
  }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      if (runtime.isProcessing) {
        return { success: false, error: 'Session is running; wait for it to finish before compacting.' }
      }
      const result = await runtime.session.compact()
      return {
        success: true,
        tokensBefore: result.tokensBefore,
        estimatedTokensAfter: result.estimatedTokensAfter,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 运行中插话：把消息注入当前轮（steer），不等待本轮结束 */
  async steer(sessionId: string, message: string): Promise<{ success: boolean; error?: string }> {
    const text = message.trim()
    if (!text) return { success: false, error: 'Message is empty.' }
    try {
      const runtime = await this.ensureRuntime(sessionId)
      if (!runtime.isProcessing) {
        return { success: false, error: 'Session is not running.' }
      }
      await runtime.session.prompt(text, { streamingBehavior: 'steer' })
      this.logger.info(`[Agent Manager] Steered session ${sessionId}`)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 切换会话模式；Plan 期间只保留只读工具 */
  async setSessionMode(
    sessionId: string,
    mode: SessionMode
  ): Promise<{ success: boolean; error?: string }> {
    if (mode !== 'plan' && mode !== 'act') {
      return { success: false, error: 'Invalid session mode.' }
    }
    try {
      const runtime = await this.ensureRuntime(sessionId)
      if (runtime.modeState.current === mode) return { success: true }

      if (mode === 'plan') {
        runtime.activeToolsBeforePlan = runtime.session.getActiveToolNames()
        runtime.session.setActiveToolsByName(PLAN_MODE_TOOLS)
      } else {
        const restore =
          runtime.activeToolsBeforePlan && runtime.activeToolsBeforePlan.length > 0
            ? runtime.activeToolsBeforePlan
            : DEFAULT_MODE_TOOLS
        runtime.session.setActiveToolsByName(restore)
        runtime.activeToolsBeforePlan = null
      }

      runtime.modeState.current = mode
      this.logger.info(`[Agent Manager] Session ${sessionId} mode -> ${mode}`)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 创建（或复用）一个会话运行时 */
  private async createRuntime(sessionManager: SessionManager): Promise<SessionRuntime> {
    const config = this.config
    const modelRuntime = this.modelRuntime
    if (!config || !modelRuntime) throw new Error('Agent not initialized.')

    const id = sessionManager.getSessionId()
    const existing = this.runtimes.get(id)
    if (existing) return existing

    const model = modelRuntime.getModel(WORKBENCH_PROVIDER_ID, config.apiConfig.selectedModel)
    if (!model) throw new Error('Selected model is unavailable.')

    const sessionAllow = new Set<string>()
    const modeState = { current: 'act' as SessionMode }
    const settingsManager = SettingsManager.create(config.workspaceDir, this.agentDir)
    const resourceLoader = new DefaultResourceLoader({
      cwd: config.workspaceDir,
      agentDir: this.agentDir,
      settingsManager,
      extensionFactories: [
        this.createApprovalExtension(id, sessionAllow, () => modeState.current),
      ],
    })
    await resourceLoader.reload()

    const sessionPromise = createAgentSession({
      cwd: config.workspaceDir,
      agentDir: this.agentDir,
      modelRuntime,
      model,
      sessionManager,
      settingsManager,
      resourceLoader,
    })
    const sessionOutcome = await withTimeoutResult(
      sessionPromise,
      INIT_TIMEOUT_MS,
      'Agent session creation',
      this.logger
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

    const header = sessionManager.getHeader()
    const createdAt = header?.timestamp ? Date.parse(header.timestamp) : Date.now()
    const runtime: SessionRuntime = {
      id,
      sessionManager,
      session: sessionOutcome.value.session,
      unsubscribe: null,
      isProcessing: false,
      onTextDelta: null,
      onTrace: null,
      thinkingDeltaSeen: new Set(),
      toolFiles: new Map(),
      editSnapshots: new Map(),
      pendingEdits: [],
      messageHistory: [],
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      updatedAt: Date.now(),
      titleAttempted: false,
      pendingTitle: null,
      sessionAllow,
      modeState,
      activeToolsBeforePlan: null,
      currentCheckpoint: null,
    }
    runtime.unsubscribe = this.subscribeToSessionEvents(runtime)
    this.runtimes.set(id, runtime)
    return runtime
  }

  private async disposeRuntime(runtime: SessionRuntime): Promise<void> {
    if (runtime.isProcessing) {
      try {
        await withTimeout(runtime.session.abort(), ABORT_TIMEOUT_MS, 'Agent abort')
      } catch (error) {
        this.logger.warn('[Agent Manager] Failed to abort before dispose:', error)
      }
    }
    try {
      runtime.unsubscribe?.()
    } catch {
      // ignore
    }
    runtime.unsubscribe = null
    try {
      runtime.session.dispose()
    } catch (error) {
      this.logger.warn('[Agent Manager] Failed to dispose session:', error)
    }
    this.runtimes.delete(runtime.id)
    if (this.lastSessionId === runtime.id) this.lastSessionId = null
  }

  private async disposeAllRuntimes(): Promise<void> {
    for (const runtime of [...this.runtimes.values()]) {
      await this.disposeRuntime(runtime)
    }
    this.runtimes.clear()
    this.lastSessionId = null
  }

  /** 确保某个会话已有运行时（不存在则从磁盘打开） */
  private async ensureRuntime(sessionId: string): Promise<SessionRuntime> {
    const existing = this.runtimes.get(sessionId)
    if (existing) return existing

    const config = this.config
    if (!config) throw new Error('Agent not initialized.')
    const file = SessionManager.findById(config.workspaceDir, sessionId, this.sessionDir)
    if (!file) throw new Error('Session not found.')
    const manager = SessionManager.open(file, this.sessionDir, config.workspaceDir)
    return this.createRuntime(manager)
  }

  /**
   * 把一个用户轮次内的 assistant / toolResult 消息聚合成一条带 parts 的 assistant 消息。
   * parts 保留 thinking、text、tool 的真实顺序，供前端时间线渲染。
   */
  private sessionMessages(runtime: SessionRuntime): AgentMessage[] {
    const messages = runtime.session.messages ?? []
    const result: AgentMessage[] = []
    let turn: { parts: AgentTracePart[]; timestamp?: number } | null = null
    let partSeq = 0

    const nextId = (prefix: string) => `${prefix}-${++partSeq}`

    const flushTurn = () => {
      if (!turn || turn.parts.length === 0) {
        turn = null
        partSeq = 0
        return
      }
      const content = turn.parts
        .filter((part): part is Extract<AgentTracePart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
      result.push({
        role: 'assistant',
        content,
        parts: turn.parts,
        timestamp: turn.timestamp ?? Date.now(),
      })
      turn = null
      partSeq = 0
    }

    for (const msg of messages as any[]) {
      if (msg.role === 'user') {
        flushTurn()
        const raw =
          typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .filter((part: any) => part?.type === 'text')
                  .map((part: any) => part.text)
                  .join('\n')
              : ''
        result.push({
          role: 'user',
          content: stripContextBlock(raw),
          timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
        })
        continue
      }

      if (msg.role === 'assistant') {
        if (!turn) turn = { parts: [] }
        if (turn.timestamp === undefined) {
          turn.timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Date.now()
        }

        if (typeof msg.content === 'string') {
          if (msg.content) {
            turn.parts.push({ type: 'text', id: nextId('text'), text: msg.content })
          }
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (!part) continue
            if (part.type === 'text' && typeof part.text === 'string') {
              turn.parts.push({ type: 'text', id: nextId('text'), text: part.text })
            } else if (part.type === 'thinking') {
              turn.parts.push({
                type: 'thinking',
                id: nextId('thinking'),
                text: typeof part.thinking === 'string' ? part.thinking : '',
                redacted: part.redacted === true,
              })
            } else if (part.type === 'toolCall') {
              const toolName = String(part.name ?? 'tool')
              const toolCallId = String(part.id ?? nextId('tool'))
              turn.parts.push({
                type: 'tool',
                id: toolCallId,
                toolCallId,
                toolName,
                argsSummary: summarizeToolArgs(toolName, part.arguments ?? {}),
                status: 'running',
                filePath: this.toolFilePath(toolName, part.arguments ?? {}),
              })
            }
          }
        }
        continue
      }

      if (msg.role === 'toolResult') {
        if (!turn) continue
        const toolPart = turn.parts.find(
          (part): part is Extract<AgentTracePart, { type: 'tool' }> =>
            part.type === 'tool' && part.toolCallId === msg.toolCallId
        )
        if (!toolPart) continue
        toolPart.status = msg.isError ? 'error' : 'success'
        toolPart.isError = Boolean(msg.isError)
        if (typeof msg.durationMs === 'number') toolPart.durationMs = msg.durationMs
        toolPart.resultPreview = summarizeToolResult(
          { content: msg.content, details: msg.details },
          msg.toolName === 'bash' || msg.toolName === 'powershell'
        )
      }
    }

    flushTurn()
    return result
  }

  private runtimeSummary(runtime: SessionRuntime): SessionSummary {
    const messages = runtime.session.messages ?? []
    const name = runtime.pendingTitle ?? runtime.sessionManager.getSessionName()
    let firstUser = ''
    let messageCount = 0
    for (const msg of messages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') continue
      messageCount += 1
      if (!firstUser && msg.role === 'user') {
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .filter((part: any) => part.type === 'text')
                  .map((part: any) => part.text)
                  .join('\n')
              : ''
        firstUser = stripContextBlock(content)
      }
    }

    return {
      id: runtime.id,
      title: (name?.trim() || firstUser.trim()).slice(0, 60),
      messageCount,
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt,
    }
  }

  /** 打开指定会话；不传则继续最近会话 */
  async openSession(sessionId?: string): Promise<SessionOpenResult> {
    try {
      if (!this.modelRuntime || !this.config) {
        return { success: false, error: 'Agent not initialized.' }
      }

      let runtime: SessionRuntime
      if (sessionId) {
        runtime = await this.ensureRuntime(sessionId)
      } else if (this.lastSessionId && this.runtimes.has(this.lastSessionId)) {
        runtime = this.runtimes.get(this.lastSessionId)!
      } else {
        const manager = SessionManager.continueRecent(
          this.config.workspaceDir,
          this.sessionDir
        )
        runtime = await this.createRuntime(manager)
      }

      this.lastSessionId = runtime.id
      return {
        success: true,
        session: this.runtimeSummary(runtime),
        history: this.sessionMessages(runtime),
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 新建会话（第一条消息前不落盘） */
  async createSession(): Promise<SessionOpenResult> {
    try {
      if (!this.modelRuntime || !this.config) {
        return { success: false, error: 'Agent not initialized.' }
      }
      const manager = SessionManager.create(this.config.workspaceDir, this.sessionDir)
      const runtime = await this.createRuntime(manager)
      this.lastSessionId = runtime.id
      return {
        success: true,
        session: this.runtimeSummary(runtime),
        history: [],
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 列出当前工作区的全部会话（合并内存中尚未落盘的新会话） */
  async listSessions(): Promise<SessionSummary[]> {
    const config = this.config
    if (!config) return []

    const sessions = new Map<string, SessionSummary>()
    try {
      const infos = await SessionManager.list(config.workspaceDir, this.sessionDir)
      for (const info of infos) {
        sessions.set(info.id, {
          id: info.id,
          title: (info.name?.trim() || stripContextBlock(info.firstMessage ?? '').trim()).slice(
            0,
            60
          ),
          messageCount: info.messageCount,
          createdAt: info.created.getTime(),
          updatedAt: info.modified.getTime(),
        })
      }
    } catch (error) {
      this.logger.warn('[Agent Manager] Failed to list sessions:', error)
    }

    for (const runtime of this.runtimes.values()) {
      const summary = this.runtimeSummary(runtime)
      const existing = sessions.get(summary.id)
      if (!existing || summary.updatedAt >= existing.updatedAt) {
        sessions.set(summary.id, summary)
      }
    }

    return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 关闭会话运行时（保留会话文件） */
  async closeSession(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    await this.disposeRuntime(runtime)
  }

  /** 重命名会话；新会话尚未落盘时先保存为待写入标题 */
  async renameSession(sessionId: string, name: string): Promise<{ success: boolean; error?: string }> {
    const title = name.trim().slice(0, 80)
    if (!title) return { success: false, error: 'Session name cannot be empty.' }
    try {
      const runtime = this.runtimes.get(sessionId)
      if (runtime) {
        runtime.pendingTitle = title
        if (runtime.sessionManager.isPersisted()) {
          runtime.sessionManager.appendSessionInfo(title)
          runtime.pendingTitle = null
        }
        runtime.updatedAt = Date.now()
        return { success: true }
      }
      const config = this.config
      if (!config) return { success: false, error: 'Agent not initialized.' }
      const file = SessionManager.findById(config.workspaceDir, sessionId, this.sessionDir)
      if (!file) return { success: false, error: 'Session not found.' }
      const manager = SessionManager.open(file, this.sessionDir, config.workspaceDir)
      manager.appendSessionInfo(title)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 删除会话（先释放运行时，再删除会话文件） */
  async deleteSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const config = this.config
      if (!config) return { success: false, error: 'Agent not initialized.' }
      const file = SessionManager.findById(config.workspaceDir, sessionId, this.sessionDir)
      await this.closeSession(sessionId)
      if (!file) return { success: true }

      const resolved = path.resolve(file)
      const root = path.resolve(this.sessionDir)
      if (!resolved.startsWith(root + path.sep)) {
        return { success: false, error: 'Refusing to delete a session outside the session directory.' }
      }
      await fs.unlink(resolved).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  getCurrentSessionId(): string | null {
    return this.lastSessionId
  }

  /**
   * 发送消息给 Agent。
   *
   * 支持两种调用方式：
   * - chat(message, options)               默认使用最近打开/创建的会话（Fleet 等兼容路径）
   * - chat(sessionId, message, options)    指定会话；不同会话可以并行
   */
  async chat(message: string, options?: AgentChatOptions): Promise<AgentChatResult>
  async chat(
    sessionId: string,
    message: string,
    options?: AgentChatOptions
  ): Promise<AgentChatResult>
  async chat(
    sessionIdOrMessage: string,
    messageOrOptions?: string | AgentChatOptions,
    maybeOptions?: AgentChatOptions
  ): Promise<AgentChatResult> {
    const hasSessionId = typeof messageOrOptions === 'string'
    const sessionId = hasSessionId ? sessionIdOrMessage : this.lastSessionId
    const message = hasSessionId ? (messageOrOptions as string) : sessionIdOrMessage
    const options = hasSessionId
      ? maybeOptions
      : (messageOrOptions as AgentChatOptions | undefined)

    // 已有运行时时同步置位，避免 dispose 在 await 间隙漏掉正在启动的请求
    let runtime: SessionRuntime | null = sessionId
      ? this.runtimes.get(sessionId) ?? null
      : this.lastSessionId
        ? this.runtimes.get(this.lastSessionId) ?? null
        : null

    if (runtime) {
      if (runtime.isProcessing) {
        return {
          success: false,
          error: 'This session is currently processing another request.',
        }
      }
      runtime.isProcessing = true
    } else {
      try {
        if (sessionId) {
          runtime = await this.ensureRuntime(sessionId)
        } else {
          const opened = await this.openSession()
          if (!opened.success) {
            return { success: false, error: opened.error || 'Agent not initialized.' }
          }
          runtime = this.runtimes.get(this.lastSessionId ?? '') ?? null
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }

      if (!runtime) {
        return {
          success: false,
          error: 'Agent not initialized. Please initialize first.',
        }
      }
      if (runtime.isProcessing) {
        return {
          success: false,
          error: 'This session is currently processing another request.',
        }
      }
      runtime.isProcessing = true
    }

    this.lastSessionId = runtime.id
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    let timeoutTimer: NodeJS.Timeout | null = null
    let hardStopTimer: NodeJS.Timeout | null = null
    let timedOut = false
    let hardStopped = false

    try {
      runtime.onTextDelta = options?.onTextDelta ?? null
      runtime.onTrace = options?.onTrace ?? null
      runtime.pendingEdits = []
      runtime.editSnapshots.clear()
      // 检查点：记录本轮开始时的会话位置；文件旧内容在 write/edit 执行时补充
      runtime.currentCheckpoint = this.checkpointStore
        ? {
            version: 1,
            id: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sessionId: runtime.id,
            workspaceDir: runtime.sessionManager.getCwd(),
            createdAt: Date.now(),
            leafId: runtime.sessionManager.getLeafId(),
            files: [],
          }
        : null
      // 只认本轮新增的 assistant 消息，避免请求失败时把上一轮回复当成本轮结果
      const messageStartIndex = runtime.session.messages.length
      this.logger.info(
        `[Agent Manager] Sending message to session ${runtime.id}:`,
        message.substring(0, 100)
      )

      runtime.messageHistory.push({
        role: 'user',
        content: message,
        timestamp: Date.now(),
      })

      // 发送用户消息并等待 Agent 完成；超时先 abort，宽限期后仍未结束则强制收尾
      const session = runtime.session
      const promptText = runtime.modeState.current === 'plan' ? wrapPlanPrompt(message) : message
      const promptPromise = session.prompt(promptText)
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        if (timeoutMs <= 0) return
        timeoutTimer = setTimeout(() => {
          timedOut = true
          this.logger.warn(`[Agent Manager] Request timed out after ${timeoutMs}ms; aborting`)
          void session.abort().catch((error) => {
            this.logger.warn('[Agent Manager] Failed to abort timed-out request:', error)
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

      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (hardStopTimer) clearTimeout(hardStopTimer)

      // 收集本轮文件修改（在读取回复前取出，确保不串到下一轮）
      const edits = runtime.pendingEdits.splice(0)

      if (timedOut) {
        return {
          success: false,
          error: `Agent request timed out after ${Math.round(timeoutMs / 1000)}s`,
          edits,
        }
      }

      const messages = runtime.session.messages

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

      if (lastAssistant.stopReason === 'error') {
        const detail = lastAssistant.errorMessage || 'Agent request failed'
        this.logger.error('[Agent Manager] Provider error:', detail)
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

      const aggregated = this.sessionMessages(runtime)
      const lastTurn = [...aggregated].reverse().find((entry) => entry.role === 'assistant')
      runtime.messageHistory.push(
        lastTurn ?? {
          role: 'assistant',
          content: assistantResponse,
          timestamp: Date.now(),
        }
      )
      runtime.updatedAt = Date.now()

      // 未落盘的临时标题在会话首次落盘后写入
      if (runtime.pendingTitle && runtime.sessionManager.isPersisted()) {
        try {
          runtime.sessionManager.appendSessionInfo(runtime.pendingTitle)
          runtime.pendingTitle = null
        } catch (error) {
          this.logger.warn('[Agent Manager] Failed to persist pending session title:', error)
        }
      }

      // 第一轮成功后异步生成标题，不阻塞聊天
      void this.maybeGenerateTitle(runtime)

      this.logger.info('[Agent Manager] Agent response received')
      this.logger.info('[Agent Manager] Response preview:', assistantResponse.substring(0, 200))
      if (edits.length > 0) {
        this.logger.info('[Agent Manager] Files edited:', edits.map((e) => e.path).join(', '))
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
        this.logger.error('[Agent Manager] Request timed out:', errorMessage)
        const edits = runtime.pendingEdits.splice(0)
        if (hardStopped) {
          await this.resetRuntimeAfterHardStop(runtime)
        }
        return {
          success: false,
          error: `Agent request timed out after ${Math.round(timeoutMs / 1000)}s`,
          edits,
        }
      }
      this.logger.error('[Agent Manager] Chat error:', errorMessage)
      this.logger.error('[Agent Manager] Stack:', error instanceof Error ? error.stack : '')

      return {
        success: false,
        error: `Agent error: ${errorMessage}`,
        edits: runtime.pendingEdits.splice(0),
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (hardStopTimer) clearTimeout(hardStopTimer)
      if (this.runtimes.get(runtime.id) === runtime) {
        runtime.isProcessing = false
        runtime.onTextDelta = null
        runtime.onTrace = null

        // 检查点落盘：只保存本轮确实修改过的文件
        const checkpoint = runtime.currentCheckpoint
        runtime.currentCheckpoint = null
        if (checkpoint && checkpoint.files.length > 0 && this.checkpointStore) {
          try {
            await this.checkpointStore.save(checkpoint)
            await this.checkpointStore.prune()
          } catch (error) {
            this.logger.warn('[Agent Manager] Failed to save checkpoint:', error)
          }
        }
      }
    }
  }

  /** 中止某个会话的请求；不传 sessionId 时中止全部会话 */
  async abort(sessionId?: string): Promise<void> {
    const runtimes = sessionId
      ? [this.runtimes.get(sessionId)].filter((runtime): runtime is SessionRuntime => Boolean(runtime))
      : [...this.runtimes.values()]

    for (const runtime of runtimes) {
      try {
        await withTimeout(runtime.session.abort(), ABORT_TIMEOUT_MS, 'Agent abort')
      } catch (error) {
        this.logger.warn('[Agent Manager] Failed to abort request:', error)
      }
    }
  }

  /**
   * 硬超时后销毁该会话的旧运行时并重建：迟到的流式/工具事件随订阅一起消失，
   * 下一轮不会继承上一轮的输出或文件修改。其他会话不受影响。
   */
  private async resetRuntimeAfterHardStop(runtime: SessionRuntime): Promise<void> {
    const id = runtime.id
    await this.disposeRuntime(runtime)
    const config = this.config
    if (!config) return

    try {
      const file = SessionManager.findById(config.workspaceDir, id, this.sessionDir)
      const manager = file
        ? SessionManager.open(file, this.sessionDir, config.workspaceDir)
        : SessionManager.create(config.workspaceDir, this.sessionDir)
      const next = await this.createRuntime(manager)
      this.lastSessionId = next.id
    } catch (error) {
      this.logger.error('[Agent Manager] Failed to reinitialize after hard stop:', error)
    }
  }

  /** 获取某个会话在进程内的增量历史 */
  getMessageHistory(sessionId?: string): AgentMessage[] {
    const runtime = sessionId
      ? this.runtimes.get(sessionId)
      : this.lastSessionId
        ? this.runtimes.get(this.lastSessionId)
        : undefined
    return runtime?.messageHistory ?? []
  }

  /** 从持久化的 Pi 会话中恢复可展示的对话历史 */
  getSessionMessages(sessionId?: string): AgentMessage[] {
    const runtime = sessionId
      ? this.runtimes.get(sessionId)
      : this.lastSessionId
        ? this.runtimes.get(this.lastSessionId)
        : undefined
    return runtime ? this.sessionMessages(runtime) : []
  }

  private messageText(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .join('\n')
    }
    return ''
  }

  /** 第一轮成功后生成会话标题；每个会话只尝试一次，不阻塞聊天 */
  private async maybeGenerateTitle(runtime: SessionRuntime): Promise<void> {
    if (runtime.titleAttempted) return
    runtime.titleAttempted = true

    const config = this.config
    if (!config?.onSessionTitle) return
    if (runtime.sessionManager.getSessionName() || runtime.pendingTitle) return

    const messages = runtime.session.messages ?? []
    const firstUser = messages.find((msg: any) => msg.role === 'user') as any
    const firstAssistant = messages.find((msg: any) => msg.role === 'assistant') as any
    if (!firstUser || !firstAssistant) return

    const userText = stripContextBlock(this.messageText(firstUser.content)).trim()
    const assistantText = this.messageText(firstAssistant.content).trim()
    if (!userText || !assistantText) return

    const prompt = [
      '你是一个会话命名器。根据下面的对话生成一个简短标题。',
      '要求：只输出标题本身，不加引号、不加标点、不要解释；使用对话的主要语言；中文不超过 16 个字，英文不超过 8 个词。',
      '',
      `用户：${userText.slice(0, 800)}`,
      `助手：${assistantText.slice(0, 800)}`,
    ].join('\n')

    const raw = await this.requestTitle(prompt)
    if (!raw) return

    const title = raw
      .split(/\r?\n/)[0]
      .replace(/^(标题|title)\s*[:：]\s*/i, '')
      .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
      .trim()
      .slice(0, 40)
    if (!title) return

    // 生成期间用户可能已手动重命名、删除会话或切换走
    if (!this.runtimes.has(runtime.id)) return
    if (runtime.sessionManager.getSessionName() || runtime.pendingTitle) return

    try {
      runtime.sessionManager.appendSessionInfo(title)
      runtime.updatedAt = Date.now()
      config.onSessionTitle?.(runtime.id, title)
      this.logger.info('[Agent Manager] Generated session title:', title)
    } catch (error) {
      this.logger.warn('[Agent Manager] Failed to persist session title:', error)
    }
  }

  /** 用配置的供应商生成一个短标题（OpenAI 兼容 / Anthropic） */
  private async requestTitle(prompt: string): Promise<string | null> {
    const config = this.config
    if (!config) return null
    const { provider, apiUrl, apiKey, selectedModel } = config.apiConfig
    const base = apiUrl.replace(/\/+$/, '')
    if (!base) return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
    try {
      if (provider === 'anthropic') {
        const response = await fetch(`${base}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: selectedModel,
            max_tokens: 64,
            temperature: 0.2,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = (await response.json()) as any
        return typeof data?.content?.[0]?.text === 'string' ? data.content[0].text : null
      }

      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: selectedModel,
          max_tokens: 64,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as any
      const content = data?.choices?.[0]?.message?.content
      return typeof content === 'string' ? content : null
    } catch (error) {
      this.logger.warn('[Agent Manager] Title generation failed:', error)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 清理所有会话与共享资源
   */
  async dispose() {
    await this.disposeAllRuntimes()
    if (this.envLease) {
      releaseProviderEnv()
      this.envLease = false
    }
    this.config = null
    this.modelRuntime = null
    this.sessionDir = ''
    this.agentDir = ''
    this.lastSessionId = null
  }

  /**
   * 检查 Agent 是否已初始化
   */
  isInitialized(): boolean {
    return this.modelRuntime !== null
  }

  /**
   * 获取当前配置
   */
  getConfig(): AgentConfig | null {
    return this.config
  }
}
