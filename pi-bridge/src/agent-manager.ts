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
  type ResourceLoader,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent'
import * as path from 'path'
import * as fs from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import {
  DEFAULT_PERMISSION_LEVEL,
  isPermissionLevel,
  normalizeSessionPermission,
  type ApprovalDecision,
  type ApprovalRequestPayload,
  type PermissionLevel,
  type SessionMode,
  type SessionPermission,
} from './approval-policy.js'
import { resolveModeTools } from './tool-policy.js'
import {
  type PlanStep,
  type PlanStepStatus,
  type PlanStatus,
  type StructuredPlan,
} from './plan.js'

export type { PlanStep, PlanStepStatus, PlanStatus, StructuredPlan }
import {
  SessionExtrasStore,
  emptyExtras,
  isSafeSessionId,
  type SessionExtras,
} from './session-extras.js'
import {
  CONTEXT_BLOCK_END,
  CONTEXT_BLOCK_START,
  messageText as toMessageText,
  stripContextBlock,
  summarizeToolArgs,
  summarizeToolResult,
  wrapPlanPrompt,
} from './text-utils.js'
import {
  buildHtmlExport,
  buildMarkdownExport,
  type ExportLanguage,
  type ExportTurn,
} from './session-export.js'
import { validateChatImages } from './chat-images.js'
import {
  KNOWN_MODEL_METADATA,
  THINKING_LEVELS,
  WORKBENCH_PROVIDER_ID,
  writeModelsConfig,
} from './model-config.js'
import {
  acquireProviderEnv,
  ensureBashOnPath,
  releaseProviderEnv,
} from './environment.js'
import {
  buildTitlePrompt,
  normalizeSessionTitle,
  requestSessionTitle,
} from './session-title.js'
import { buildSessionMessages } from './session-history.js'
import {
  describeToolResult,
  findToolResultPayload,
  readToolResultChunk as sliceToolResult,
} from './tool-results.js'
import {
  buildBranchGroups,
  deepestLeaf,
  isAncestorOrSelf,
  sessionTreeNodes,
} from './session-branch.js'
import { createApprovalExtension } from './approval-extension.js'
import { createPlanExtension } from './plan-extension.js'
import { createWorktreeExtension } from './worktree-extension.js'
import type {
  AgentChatOptions,
  AgentChatResult,
  AgentConfig,
  AgentLogger,
  AgentMessage,
  AgentTraceEvent,
  AgentUsage,
  ConversationBranchGroup,
  FileEdit,
  ModelCapabilityInfo,
  PromptTemplateInfo,
  SessionOpenResult,
  SessionSummary,
  SkillInfo,
  ToolResultMeta,
} from './types.js'
import { withTimeout, withTimeoutResult } from './async-utils.js'
import { StallWatchdog } from './stall-watchdog.js'

/** 未注入 logger 时保持原有 console 行为 */
const consoleAgentLogger: AgentLogger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: (...args) => console.debug(...args),
}

export type {
  AgentChatOptions,
  AgentChatResult,
  AgentConfig,
  AgentLogger,
  AgentMessage,
  AgentTraceEvent,
  AgentTracePart,
  AgentUsage,
  ConversationBranchGroup,
  FileEdit,
  ModelCapabilityInfo,
  PromptTemplateInfo,
  SessionOpenResult,
  SessionSummary,
  SkillInfo,
  ToolResultMeta,
} from './types.js'

/** 模型响应空闲超时（毫秒）：连续这么久没有任何模型增量才判定卡死；不设整轮上限 */
export const STALL_TIMEOUT_MS = 120_000
/** abort 之后等待 SDK 收尾的宽限期；超过后强制结束本轮，防止永久挂起 */
export const ABORT_GRACE_MS = 10_000
/** 调用 session.abort() 本身的等待上限，避免 dispose / 重启被卡住 */
const ABORT_TIMEOUT_MS = 5_000
/** 初始化（模型运行时 + 会话创建）超时 */
const INIT_TIMEOUT_MS = 30_000
/** 单次工具审批的等待上限；超时按拒绝处理（fail-closed） */
export const APPROVAL_TIMEOUT_MS = 120_000

/** 空闲超时的统一错误文案（渲染层直接展示） */
function stallErrorMessage(): string {
  return `Agent response stalled: no output for ${Math.round(STALL_TIMEOUT_MS / 1000)}s.`
}

export type { SessionMode }

interface SessionRuntime {
  id: string
  sessionManager: SessionManager
  session: AgentSession
  /** 提示模板 / 技能等资源的加载器（R-13） */
  resourceLoader: ResourceLoader | null
  unsubscribe: (() => void) | null
  isProcessing: boolean
  onTextDelta: ((delta: string) => void) | null
  onTrace: ((event: AgentTraceEvent) => void) | null
  /** 本轮的空闲超时看门狗；工具执行与审批等待期间自动挂起 */
  watchdog: StallWatchdog | null
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
  /** 会话注册的全部工具；模式在此之上计算激活集，不受历史影响 */
  registeredTools: string[]
  /** 会话附加数据（思考时长 / 历史工具 Diff） */
  extras: SessionExtras
  extrasSave: Promise<void>
  thinkingStart: number | null
  thinkingDurationsThisMessage: number[]
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
  private extrasStore: SessionExtrasStore | null = null
  private sessionDir = ''
  private envLease = false
  private runtimes = new Map<string, SessionRuntime>()
  private lastSessionId: string | null = null
  /** 轮次边界待应用的工作树切换 */
  private pendingRoots = new Map<string, { root: string; branch?: string }>()
  private rebinding = new Set<string>()
  /** 上一次创建会话时使用的联网配置版本 */
  private lastWebAccessVersion: string | null = null

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
  private resolveToolPath(toolPath: unknown, root?: string): string | null {
    if (typeof toolPath !== 'string' || !toolPath) return null
    return path.isAbsolute(toolPath)
      ? toolPath
      : path.resolve(root ?? this.config?.workspaceDir ?? process.cwd(), toolPath)
  }

  /** 工具路径是否位于工作区内（快照只关心工作区文件） */
  private isInsideWorkspace(targetPath: string): boolean {
    const root = this.config?.workspaceDir
    if (!root) return false
    const relative = path.relative(path.resolve(root), path.resolve(targetPath))
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  /** write/edit 的工具行可附带文件路径；其他工具不暴露文件 */
  private toolFilePath(toolName: string, args: any, root?: string): string | undefined {
    if (toolName !== 'write' && toolName !== 'edit') return undefined
    const target = this.resolveToolPath(args?.path, root)
    if (!target || !this.isInsideWorkspace(target)) return undefined
    return target
  }

  /** 串行保存会话附加数据，避免并发覆盖 */
  private persistExtras(runtime: SessionRuntime): void {
    if (!this.extrasStore) return
    const store = this.extrasStore
    const id = runtime.id
    runtime.extrasSave = runtime.extrasSave
      .catch(() => undefined)
      .then(() => store.save(id, runtime.extras))
      .catch((error) => {
        this.logger.warn('[Agent Manager] Failed to save session extras:', error)
      })
  }

  /**
   * 订阅会话事件：转发文本 / 思考 / 工具步骤，并记录 write/edit 前后内容。
   * Pi 的 write / edit 工具参数分别为 { path, content } 和 { path, edits }。
   */
  private subscribeToSessionEvents(runtime: SessionRuntime): () => void {
    return runtime.session.subscribe((event: any) => {
      try {
        if (event.type === 'message_start' && event.message?.role === 'assistant') {
          runtime.watchdog?.touch()
          runtime.thinkingDeltaSeen.clear()
          runtime.thinkingDurationsThisMessage = []
          runtime.thinkingStart = null
          return
        }

        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const timestamp = event.message?.timestamp
          if (
            typeof timestamp === 'number' &&
            runtime.thinkingDurationsThisMessage.length > 0
          ) {
            runtime.extras.thinkingDurations[String(timestamp)] = [
              ...runtime.thinkingDurationsThisMessage,
            ]
            this.persistExtras(runtime)
          }
          return
        }

        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent
          if (update?.type === 'text_delta' && typeof update.delta === 'string') {
            runtime.watchdog?.touch()
            runtime.onTextDelta?.(update.delta)
            runtime.onTrace?.({ type: 'text_delta', delta: update.delta })
          } else if (update?.type === 'thinking_start') {
            if (typeof update.contentIndex === 'number') {
              runtime.thinkingDeltaSeen.delete(update.contentIndex)
            }
            runtime.thinkingStart = Date.now()
          } else if (update?.type === 'thinking_delta' && typeof update.delta === 'string') {
            runtime.watchdog?.touch()
            if (typeof update.contentIndex === 'number') {
              runtime.thinkingDeltaSeen.add(update.contentIndex)
            }
            runtime.onTrace?.({ type: 'thinking_delta', delta: update.delta })
          } else if (update?.type === 'thinking_end') {
            const index = typeof update.contentIndex === 'number' ? update.contentIndex : -1
            if (runtime.thinkingStart !== null) {
              runtime.thinkingDurationsThisMessage.push(
                Math.max(0, Date.now() - runtime.thinkingStart)
              )
              runtime.thinkingStart = null
            }
            // 部分供应商只在 end 给出完整内容，或返回脱敏后的空内容
            if (!runtime.thinkingDeltaSeen.has(index)) {
              const content = typeof update.content === 'string' ? update.content : ''
              if (content) runtime.onTrace?.({ type: 'thinking_delta', delta: content })
              else runtime.onTrace?.({ type: 'thinking_redacted' })
            }
          } else if (
            update?.type === 'toolcall_start' ||
            update?.type === 'toolcall_delta'
          ) {
            // 工具参数 JSON 增量：写大文件时可能持续几十秒，属于模型仍在产出
            runtime.watchdog?.touch()
          }
          return
        }

        // Pi SDK 自带自动重试（429 / 5xx / 网络抖动），记录并转发给渲染层
        if (event.type === 'auto_retry_start') {
          runtime.watchdog?.touch()
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
          runtime.watchdog?.touch()
          this.logger.info(`[Agent Manager] Auto retry ${event.success ? 'succeeded' : 'failed'}`)
          runtime.onTrace?.({ type: 'retry_end', success: Boolean(event.success) })
          return
        }

        // 上下文压缩：转发开始 / 结束，渲染层据此插入分隔线（R-05）
        if (event.type === 'compaction_start') {
          runtime.onTrace?.({ type: 'compaction_start', reason: event.reason })
          return
        }
        if (event.type === 'compaction_end') {
          runtime.onTrace?.({
            type: 'compaction_end',
            reason: event.reason,
            tokensBefore:
              typeof event.result?.tokensBefore === 'number'
                ? event.result.tokensBefore
                : undefined,
            error:
              typeof event.errorMessage === 'string' ? event.errorMessage : undefined,
          })
          return
        }

        if (event.type === 'agent_settled') {
          // 在事件回调外重建，避免销毁正在分发事件的会话
          setTimeout(() => {
            void this.applyPendingRoot(runtime)
          }, 0)
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
          runtime.watchdog?.beginTool(event.toolCallId)
          const args = event.args ?? {}
          const root = runtime.sessionManager.getCwd()
          const filePath = this.toolFilePath(event.toolName, args, root)
          if (filePath) runtime.toolFiles.set(event.toolCallId, filePath)
          runtime.onTrace?.({
            type: 'tool_start',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            argsSummary: summarizeToolArgs(event.toolName, args),
            startedAt: Date.now(),
            parentToolCallId: event.parentToolCallId,
          })

          if (event.toolName !== 'write' && event.toolName !== 'edit') return
          const target = this.resolveToolPath(args.path, root)
          if (!target || !this.isInsideWorkspace(target)) return
          const existed = existsSync(target)
          const oldContent = existed ? readFileSync(target, 'utf-8') : ''
          runtime.editSnapshots.set(event.toolCallId, { path: target, oldContent, existed })
          return
        }

        if (event.type === 'tool_execution_update') {
          runtime.watchdog?.touch()
          const preview = summarizeToolResult(
            event.partialResult,
            event.toolName === 'bash' || event.toolName === 'powershell'
          )
          if (preview) {
            runtime.onTrace?.({
              type: 'tool_update',
              toolCallId: event.toolCallId,
              resultPreview: preview,
              parentToolCallId: event.parentToolCallId,
            })
          }
          return
        }

        if (event.type === 'tool_execution_end') {
          runtime.watchdog?.endTool(event.toolCallId)
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
            parentToolCallId: event.parentToolCallId,
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
      this.lastWebAccessVersion = null
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
      this.extrasStore = new SessionExtrasStore(path.join(this.agentDir, 'session-extras'))
      const modelsPath = await writeModelsConfig(this.agentDir, config.apiConfig)
      ensureBashOnPath(this.logger)

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

  /** 新会话的默认权限档位；设置页只改这里对未来会话生效 */
  private defaultPermissionLevel(): PermissionLevel {
    const raw = this.config?.getDefaultPermissionLevel?.()
    return isPermissionLevel(raw) ? raw : DEFAULT_PERMISSION_LEVEL
  }

  /** 按会话模式切换可用工具集；模式是唯一事实源，不依赖会话历史 */
  private applySessionModeTools(runtime: SessionRuntime, mode: SessionMode): void {
    try {
      runtime.session.setActiveToolsByName(
        resolveModeTools(mode, runtime.registeredTools)
      )
    } catch (error) {
      this.logger.warn('[Agent Manager] Failed to apply session mode tools:', error)
    }
  }

  /** 向宿主请求审批；没有审批通道或超时都按拒绝处理 */
  private async requestToolApproval(request: ApprovalRequestPayload): Promise<ApprovalDecision> {
    const handler = this.config?.requestApproval
    if (!handler) {
      return { action: 'deny', reason: 'No approval channel is available in this environment.' }
    }
    // 审批是 tool_call 钩子，先于 tool_execution_start；这段静默由审批自己的 120s 上限兜底
    const watchdog = this.runtimes.get(request.sessionId)?.watchdog ?? null
    watchdog?.beginApproval()
    try {
      return await withTimeout(handler(request), APPROVAL_TIMEOUT_MS, 'Tool approval')
    } catch (error) {
      this.logger.warn('[Agent Manager] Approval failed or timed out:', error)
      return { action: 'deny', reason: 'The approval request timed out.' }
    } finally {
      watchdog?.endApproval()
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
      const branch = runtime.sessionManager.getBranch()
      let last: SessionEntry | undefined
      for (const entry of branch) {
        if (entry.type === 'message' && entry.message.role === 'user') last = entry
      }
      if (!last || last.type !== 'message') {
        return { success: false, error: 'No user message to retry.' }
      }
      const result = await runtime.session.navigateTree(last.id, { summarize: false })
      if (result.cancelled) {
        return { success: false, error: 'Rewind was cancelled.' }
      }
      const text = (newText ?? toMessageText(last.message)).trim()
      return { success: true, text }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 列出当前分支中拥有多个回复的轮次（R-03） */
  async listBranches(
    sessionId: string
  ): Promise<{ success: boolean; groups?: ConversationBranchGroup[]; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      return { success: true, groups: buildBranchGroups(runtime.sessionManager) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 切换到同一条用户消息下的另一条回复。
   * 只移动会话树的叶子，不触碰工作区文件；切回时优先回到该分支上次停留的位置。
   */
  async switchBranch(
    sessionId: string,
    entryId: string
  ): Promise<{ success: boolean; history?: AgentMessage[]; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      if (runtime.isProcessing) {
        return { success: false, error: 'Session is running; stop it before switching branches.' }
      }
      const manager = runtime.sessionManager
      const target = manager.getEntry(entryId)
      if (!target || target.type !== 'message' || target.message.role !== 'assistant') {
        return { success: false, error: 'Branch entry not found.' }
      }
      const parent = target.parentId ? manager.getEntry(target.parentId) : undefined
      if (!parent || parent.type !== 'message' || parent.message.role !== 'user') {
        return { success: false, error: 'Only replies to a user message can be switched.' }
      }

      const nodes = sessionTreeNodes(manager.getTree())
      const siblings = (nodes.get(parent.id)?.children ?? []).filter(
        (child) =>
          child.entry.type === 'message' && child.entry.message.role === 'assistant'
      )
      if (!siblings.some((child) => child.entry.id === entryId)) {
        return { success: false, error: 'Branch entry not found.' }
      }

      const branchIds = new Set(manager.getBranch().map((entry) => entry.id))
      const activeSibling = siblings.find((child) => branchIds.has(child.entry.id))
      const currentLeaf = manager.getLeafId()
      if (activeSibling && currentLeaf) {
        runtime.extras.branchLeaves[activeSibling.entry.id] = currentLeaf
      }

      const remembered = runtime.extras.branchLeaves[entryId]
      const targetLeaf =
        remembered && isAncestorOrSelf(manager, entryId, remembered)
          ? remembered
          : deepestLeaf(nodes.get(entryId))
      if (!targetLeaf) return { success: false, error: 'Branch entry not found.' }

      const result = await runtime.session.navigateTree(targetLeaf)
      if (result.cancelled) {
        return { success: false, error: 'Branch switch was cancelled.' }
      }
      this.persistExtras(runtime)
      return { success: true, history: this.sessionMessages(runtime) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 读取当前结构化计划（R-04） */
  async getPlan(
    sessionId: string
  ): Promise<{ success: boolean; plan?: StructuredPlan | null; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      return { success: true, plan: runtime.extras.plan }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 批准计划并原子切换到目标执行模式（询问 / 完全），返回新会话模式 */
  async approvePlan(
    sessionId: string,
    planId: string,
    targetMode: PermissionLevel
  ): Promise<{
    success: boolean
    plan?: StructuredPlan
    permission?: SessionPermission
    error?: string
  }> {
    if (targetMode !== 'ask' && targetMode !== 'auto') {
      return { success: false, error: 'Invalid execute mode.' }
    }
    try {
      const runtime = await this.ensureRuntime(sessionId)
      if (runtime.isProcessing) {
        return { success: false, error: 'Session is running; stop it before approving the plan.' }
      }
      const plan = runtime.extras.plan
      if (!plan || plan.id !== planId) return { success: false, error: 'Plan not found.' }
      if (plan.status !== 'proposed') {
        return { success: false, error: 'This plan is no longer awaiting approval.' }
      }
      plan.status = 'approved'
      const first = plan.steps.find((step) => step.status === 'pending')
      if (first) first.status = 'in_progress'
      plan.updatedAt = Date.now()

      const permission: SessionPermission = { mode: targetMode, grants: [] }
      runtime.extras.permission = permission
      this.applySessionModeTools(runtime, targetMode)
      this.persistExtras(runtime)
      await runtime.extrasSave
      return { success: true, plan, permission }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 拒绝计划：保留展示但不可再执行，直到下一份计划提交 */
  async rejectPlan(
    sessionId: string,
    planId: string
  ): Promise<{ success: boolean; plan?: StructuredPlan; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const plan = runtime.extras.plan
      if (!plan || plan.id !== planId) return { success: false, error: 'Plan not found.' }
      if (plan.status !== 'proposed') {
        return { success: false, error: 'This plan is no longer awaiting approval.' }
      }
      plan.status = 'rejected'
      plan.updatedAt = Date.now()
      this.persistExtras(runtime)
      return { success: true, plan }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 工具结果元数据（R-20）；不复制内容，只统计大小 */
  async getToolResultMeta(
    sessionId: string,
    toolCallId: string
  ): Promise<{ success: boolean; meta?: ToolResultMeta; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const payload = findToolResultPayload(runtime.session.messages ?? [], toolCallId)
      if (!payload) return { success: false, error: 'No result recorded for this tool call.' }
      return { success: true, meta: describeToolResult(payload) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 分页读取工具结果文本；offset / nextOffset 以 UTF-16 字符计 */
  async readToolResultChunk(
    sessionId: string,
    toolCallId: string,
    offset = 0,
    limit = 65_536
  ): Promise<{
    success: boolean
    text?: string
    offset?: number
    nextOffset?: number
    chars?: number
    done?: boolean
    error?: string
  }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const payload = findToolResultPayload(runtime.session.messages ?? [], toolCallId)
      if (!payload) return { success: false, error: 'No result recorded for this tool call.' }
      return { success: true, ...sliceToolResult(payload.text, offset, limit) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 读取工具结果中的一张图片（base64，不含 data: 前缀） */
  async getToolResultImage(
    sessionId: string,
    toolCallId: string,
    index = 0
  ): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const payload = findToolResultPayload(runtime.session.messages ?? [], toolCallId)
      if (!payload || payload.images.length === 0) {
        return { success: false, error: 'No image result recorded for this tool call.' }
      }
      const image = payload.images[Math.max(0, Math.min(index, payload.images.length - 1))]
      return { success: true, data: image.data, mimeType: image.mimeType }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 导出用：读取完整结果（主进程内调用，不经过 IPC） */
  async getToolResultText(
    sessionId: string,
    toolCallId: string
  ): Promise<{ success: boolean; text?: string; toolName?: string; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const payload = findToolResultPayload(runtime.session.messages ?? [], toolCallId)
      if (!payload) return { success: false, error: 'No result recorded for this tool call.' }
      return { success: true, text: payload.text, toolName: payload.toolName }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 会话导出为 Markdown（R-10）：正文、思考与工具调用/完整结果，长过程默认收起 */
  async exportSessionMarkdown(
    sessionId: string,
    language: ExportLanguage = 'zh'
  ): Promise<{ success: boolean; title?: string; content?: string; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const exported = buildMarkdownExport(
        this.exportTitle(runtime),
        this.exportTurns(runtime),
        language === 'en' ? 'en' : 'zh'
      )
      return { success: true, ...exported }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 会话导出为自带样式的离线 HTML（R-10） */
  async exportSessionHtml(
    sessionId: string,
    language: ExportLanguage = 'zh'
  ): Promise<{ success: boolean; title?: string; content?: string; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const exported = buildHtmlExport(
        this.exportTitle(runtime),
        this.exportTurns(runtime),
        language === 'en' ? 'en' : 'zh'
      )
      return { success: true, ...exported }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 原始 JSONL 会话文件路径（R-10）；未落盘的新会话没有文件 */
  async getSessionJsonlPath(
    sessionId: string
  ): Promise<{ success: boolean; title?: string; path?: string; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const file = runtime.sessionManager.getSessionFile()
      if (!file) return { success: false, error: 'This session has not been saved yet.' }
      return { success: true, title: this.exportTitle(runtime), path: file }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private exportTitle(runtime: SessionRuntime): string {
    return this.runtimeSummary(runtime).title || runtime.id
  }

  private exportTurns(runtime: SessionRuntime): ExportTurn[] {
    const messages = (runtime.session.messages ?? []) as any[]
    const results = new Map<string, any>()
    for (const message of messages) {
      if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
        results.set(message.toolCallId, message)
      }
    }

    const turns: ExportTurn[] = []
    for (const message of messages) {
      if (message?.role === 'user') {
        turns.push({
          user: {
            text: stripContextBlock(toMessageText(message)),
            timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
          },
          parts: [],
        })
        continue
      }
      const turn = turns[turns.length - 1]
      if (!turn || message?.role !== 'assistant') continue
      const content: any[] =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : Array.isArray(message.content)
            ? message.content
            : []
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
          turn.parts.push({ type: 'text', text: part.text })
        } else if (
          part?.type === 'thinking' &&
          !part.redacted &&
          typeof part.thinking === 'string' &&
          part.thinking
        ) {
          turn.parts.push({ type: 'thinking', text: part.thinking })
        } else if (part?.type === 'toolCall') {
          const raw = typeof part.id === 'string' ? results.get(part.id) : undefined
          const payload = raw ? this.payloadFromMessage(raw) : null
          turn.parts.push({
            type: 'tool',
            name: String(part.name ?? 'tool'),
            args: this.serializeToolArgs(part.arguments),
            result: payload?.text ?? '',
            isError: Boolean(raw?.isError),
            images: payload?.images ?? [],
          })
        }
      }
    }
    return turns
  }

  private serializeToolArgs(args: unknown): string {
    try {
      return JSON.stringify(args ?? {}, null, 2)
    } catch {
      return String(args ?? '')
    }
  }

  private payloadFromMessage(message: any): {
    toolName: string
    text: string
    images: Array<{ data: string; mimeType: string }>
  } {
    const content: any[] = Array.isArray(message.content)
      ? message.content
      : typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : []
    const texts: string[] = []
    const images: Array<{ data: string; mimeType: string }> = []
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        texts.push(part.text)
      } else if (part?.type === 'image' && typeof part.data === 'string') {
        images.push({
          data: part.data,
          mimeType: typeof part.mimeType === 'string' ? part.mimeType : 'image/png',
        })
      }
    }
    return {
      toolName: typeof message.toolName === 'string' ? message.toolName : 'tool',
      text: texts.join('\n'),
      images,
    }
  }

  /** 会话累计用量与成本 */
  async getSessionStats(sessionId: string): Promise<{
    success: boolean
    stats?: {
      tokens: number
      input: number
      output: number
      cost: number
      toolCalls: number
      messages: number
    }
    error?: string
  }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const stats = runtime.session.getSessionStats()
      return {
        success: true,
        stats: {
          tokens: stats.tokens.total,
          input: stats.tokens.input,
          output: stats.tokens.output,
          cost: stats.cost,
          toolCalls: stats.toolCalls,
          messages: stats.totalMessages,
        },
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 读取会话当前的模型、思考级别与权限 */
  async getSessionSettings(sessionId: string): Promise<{
    success: boolean
    modelId?: string
    thinkingLevel?: string
    permission?: SessionPermission
    error?: string
  }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      return {
        success: true,
        modelId: runtime.session.model?.id,
        thinkingLevel: runtime.session.thinkingLevel,
        permission: normalizeSessionPermission(runtime.extras.permission),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 修改会话模式（模式 + 额外授权），立即落盘到会话 sidecar */
  async setSessionPermission(
    sessionId: string,
    permission: unknown
  ): Promise<{ success: boolean; permission?: SessionPermission; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const permissionBefore = normalizeSessionPermission(runtime.extras.permission)
      const nextPermission = normalizeSessionPermission(permission)
      runtime.extras.permission = nextPermission
      if (permissionBefore.mode !== nextPermission.mode) {
        this.applySessionModeTools(runtime, nextPermission.mode)
      }
      this.persistExtras(runtime)
      await runtime.extrasSave
      this.logger.info(
        `[Agent Manager] Session ${sessionId} mode -> ${nextPermission.mode}${
          nextPermission.grants.length > 0 ? ` (+${nextPermission.grants.join(',')})` : ''
        }`
      )
      return { success: true, permission: nextPermission }
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

  /** 模型能力提示（R-06）：上下文窗口、思考与图像输入 */
  async getModelCapabilities(): Promise<{
    success: boolean
    models?: ModelCapabilityInfo[]
    selected?: string
    error?: string
  }> {
    try {
      if (!this.modelRuntime || !this.config) {
        return { success: false, error: 'Agent not initialized.' }
      }
      const config = this.config
      const ids = [
        ...new Set(
          [config.apiConfig.selectedModel, ...(config.apiConfig.availableModels ?? [])].filter(
            (id): id is string => typeof id === 'string' && id.length > 0
          )
        ),
      ]

      const listed = config.apiConfig.availableModels ?? []
      const declaredImages = Array.isArray(config.apiConfig.imageModels)
        ? config.apiConfig.imageModels
        : ids.filter((id) => KNOWN_MODEL_METADATA[id]?.input?.includes('image'))
      const imageSet = new Set(declaredImages)
      const models = ids.map((id): ModelCapabilityInfo => {
        const model = this.modelRuntime!.getModel(WORKBENCH_PROVIDER_ID, id)
        const known = KNOWN_MODEL_METADATA[id]
        const source = known ? 'catalog' : 'default'
        // 供应商返回过模型列表时以它为准，避免把已下线的模型标成可用
        const available = Boolean(model) && (listed.length === 0 || listed.includes(id))
        if (!model || !available) {
          return {
            id,
            available: false,
            source,
            contextWindow: known?.contextWindow ?? null,
            maxTokens: known?.maxTokens ?? null,
            reasoning: known?.reasoning ?? null,
            vision: imageSet.has(id),
            thinkingLevels: [],
          }
        }
        const supportsThinking = Boolean(model.reasoning)
        return {
          id,
          available: true,
          source,
          contextWindow: known ? model.contextWindow : null,
          maxTokens: known ? model.maxTokens : null,
          reasoning: known ? supportsThinking : null,
          vision: imageSet.has(id),
          thinkingLevels:
            known && supportsThinking
              ? THINKING_LEVELS.filter(
                  (level) => model.thinkingLevelMap?.[level] !== null
                ).map((level) => String(level))
              : [],
        }
      })

      return { success: true, models, selected: config.apiConfig.selectedModel }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 列出提示模板与技能（R-13）；读取前重新扫描文件，新增模板无需重启 */
  async listPromptResources(sessionId: string): Promise<{
    success: boolean
    templates?: PromptTemplateInfo[]
    skills?: SkillInfo[]
    error?: string
  }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      if (runtime.resourceLoader) {
        try {
          await runtime.resourceLoader.reload()
        } catch (error) {
          this.logger.warn('[Agent Manager] Failed to reload prompt resources:', error)
        }
      }

      const loaderPrompts = runtime.resourceLoader?.getPrompts?.().prompts
      const prompts = loaderPrompts ?? runtime.session.promptTemplates ?? []
      const skills = runtime.resourceLoader?.getSkills?.().skills ?? []

      return {
        success: true,
        templates: prompts.map((template) => ({
          name: template.name,
          description: template.description ?? '',
          argumentHint: template.argumentHint,
          scope: template.sourceInfo?.scope ?? 'user',
        })),
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description ?? '',
          scope: skill.sourceInfo?.scope ?? 'user',
          disableModelInvocation: Boolean(skill.disableModelInvocation),
        })),
      }
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

    const planContext: { runtime: SessionRuntime | null } = { runtime: null }
    const runtimeRef: { current: SessionRuntime | null } = { current: null }
    const extras = this.extrasStore ? await this.extrasStore.load(id) : emptyExtras()
    // 模式只在会话诞生时从全局默认档取一次，此后会话自行持有并落盘
    const seededPermission = extras.permission === null
    if (seededPermission) {
      extras.permission = { mode: this.defaultPermissionLevel(), grants: [] }
    }
    const fallbackPermission = normalizeSessionPermission(extras.permission)
    const root = sessionManager.getCwd() || config.workspaceDir
    const settingsManager = SettingsManager.create(config.workspaceDir, this.agentDir)
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: this.agentDir,
      settingsManager,
      additionalExtensionPaths: config.webAccessExtensionPaths?.length
        ? config.webAccessExtensionPaths
        : undefined,
      extensionFactories: [
        createApprovalExtension(
          {
            workspaceDir: root,
            logger: this.logger,
            requestApproval: (request) => this.requestToolApproval(request),
            isSwitchPending: () => this.pendingRoots.has(id),
          },
          id,
          () =>
            runtimeRef.current
              ? normalizeSessionPermission(runtimeRef.current.extras.permission)
              : fallbackPermission,
          (category) => {
            const runtime = runtimeRef.current
            if (!runtime) return
            const current = normalizeSessionPermission(runtime.extras.permission)
            if (current.mode !== 'ask' || current.grants.includes(category)) return
            runtime.extras.permission = {
              mode: current.mode,
              grants: [...current.grants, category],
            }
            this.persistExtras(runtime)
            return runtime.extrasSave
          }
        ),
        createPlanExtension({
          getRuntime: () => planContext.runtime,
          persistExtras: (runtime) => this.persistExtras(runtime as SessionRuntime),
          getMode: () =>
            normalizeSessionPermission(runtimeRef.current?.extras.permission ?? fallbackPermission)
              .mode,
        }),
        createWorktreeExtension({
          sessionId: id,
          workspaceDir: config.workspaceDir,
          getRoot: () => sessionManager.getCwd() || config.workspaceDir,
          onSwitch: (target, base) => this.requestWorktreeSwitch(id, target, base),
          scheduleRoot: (nextRoot, branch) => this.scheduleRoot(id, nextRoot, branch),
        }),
      ],
    })
    await resourceLoader.reload()

    // Pi 按 cwd 缓存扩展工厂；联网配置变化后需要再 reload 一次才会重新读取扩展配置
    const webAccessVersion = config.getWebAccessConfigVersion?.() ?? ''
    if (
      webAccessVersion &&
      this.lastWebAccessVersion !== null &&
      this.lastWebAccessVersion !== webAccessVersion
    ) {
      await resourceLoader.reload()
    }
    if (webAccessVersion) this.lastWebAccessVersion = webAccessVersion

    const sessionPromise = createAgentSession({
      cwd: root,
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
    const registeredTools = sessionOutcome.value.session
      .getAllTools()
      .filter((tool) => tool.exposure !== 'hidden')
      .map((tool) => tool.name)
    const runtime: SessionRuntime = {
      id,
      sessionManager,
      session: sessionOutcome.value.session,
      resourceLoader,
      unsubscribe: null,
      isProcessing: false,
      onTextDelta: null,
      onTrace: null,
      watchdog: null,
      thinkingDeltaSeen: new Set(),
      toolFiles: new Map(),
      editSnapshots: new Map(),
      pendingEdits: [],
      messageHistory: [],
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      updatedAt: Date.now(),
      titleAttempted: false,
      pendingTitle: null,
      registeredTools,
      extras,
      extrasSave: Promise.resolve(),
      thinkingStart: null,
      thinkingDurationsThisMessage: [],
    }
    runtime.unsubscribe = this.subscribeToSessionEvents(runtime)
    planContext.runtime = runtime
    runtimeRef.current = runtime
    this.applySessionModeTools(runtime, fallbackPermission.mode)
    this.runtimes.set(id, runtime)
    if (seededPermission) this.persistExtras(runtime)
    return runtime
  }

  private async disposeRuntime(runtime: SessionRuntime): Promise<void> {
    runtime.watchdog?.stop()
    runtime.watchdog = null
    if (runtime.isProcessing) {
      try {
        await withTimeout(runtime.session.abort(), ABORT_TIMEOUT_MS, 'Agent abort')
      } catch (error) {
        this.logger.warn('[Agent Manager] Failed to abort before dispose:', error)
      }
    }
    // 等 sidecar 落盘完成，避免删除会话时与最后一次保存竞争
    try {
      await runtime.extrasSave
    } catch {
      // persistExtras 已记录失败
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
    this.pendingRoots.delete(runtime.id)
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
    const root = config.resolveSessionRoot?.(sessionId) ?? config.workspaceDir
    const file =
      (await this.findSessionFile(sessionId)) ??
      SessionManager.findById(root, sessionId, this.sessionDir)
    if (!file) throw new Error('Session not found.')
    const manager = SessionManager.open(file, this.sessionDir, root)
    return this.createRuntime(manager)
  }

  /** 会话文件按 id 查找；不依赖 header cwd（工作树会话的 header 可能仍是旧路径） */
  private async findSessionFile(sessionId: string): Promise<string | null> {
    try {
      const infos = await SessionManager.listAll(this.sessionDir)
      return infos.find((info) => info.id === sessionId)?.path ?? null
    } catch (error) {
      this.logger.warn('[Agent Manager] Failed to locate session file:', error)
      return null
    }
  }

  /** 请求主进程创建工作树/更新绑定，返回目标根 */
  private async requestWorktreeSwitch(
    sessionId: string,
    target: string,
    base?: string
  ): Promise<{ success: boolean; root?: string; branch?: string; sharedWith?: number; error?: string }> {
    if (!this.config?.onWorktreeSwitch) {
      return { success: false, error: 'Worktree switching is unavailable.' }
    }
    try {
      return await this.config.onWorktreeSwitch(sessionId, target, base)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 记录待切换目标；由 agent_settled 统一应用 */
  private scheduleRoot(sessionId: string, root: string, branch?: string): void {
    this.pendingRoots.set(sessionId, { root, branch })
  }

  /**
   * 在轮次边界应用待切换的工作树。
   * 先记录旧根与会话文件；重建失败时回退到旧根，避免会话直接消失。
   *
   * 重建前后必须保持会话 id 不变：id 同时是标签、工作树绑定与会话 extras 的键，
   * 换了 id 就等于换了一个会话。Pi 的 SessionManager 对新会话也会提前分配文件路径，
   * 文件要等第一条消息才写出，所以要按文件是否真的存在判断，而不是看路径。
   */
  private async applyPendingRoot(runtime: SessionRuntime): Promise<boolean> {
    const pending = this.pendingRoots.get(runtime.id)
    if (!pending) return false
    if (this.runtimes.get(runtime.id) !== runtime) return false
    if (this.rebinding.has(runtime.id)) return false
    if (runtime.isProcessing) return false

    const id = runtime.id
    const oldRoot = runtime.sessionManager.getCwd()
    if (path.resolve(oldRoot) === path.resolve(pending.root)) {
      this.pendingRoots.delete(id)
      return true
    }

    const file = await this.resolvePersistedSessionFile(runtime)
    const pendingTitle = runtime.pendingTitle
    const sessionName = runtime.sessionManager.getSessionName()

    this.rebinding.add(id)
    this.pendingRoots.delete(id)
    try {
      await this.disposeRuntime(runtime)
      const manager = this.openManagerForRoot(id, file, pending.root)
      if (manager.getSessionId() !== id) {
        throw new Error(
          `Session id changed while switching worktrees (${id} -> ${manager.getSessionId()}).`
        )
      }
      const next = await this.createRuntime(manager)
      this.carrySessionIdentity(next, file, pendingTitle, sessionName)
      this.lastSessionId = next.id
      this.config?.onSessionRootChanged?.(next.id, pending.root)
      this.logger.info(
        `[Agent Manager] Session ${next.id} switched to worktree: ${pending.root}`
      )
      return true
    } catch (error) {
      this.logger.error('[Agent Manager] Failed to apply worktree switch:', error)
      try {
        const manager = this.openManagerForRoot(id, file, oldRoot)
        const restored = await this.createRuntime(manager)
        this.carrySessionIdentity(restored, file, pendingTitle, sessionName)
        this.lastSessionId = restored.id
        this.config?.onSessionRootChanged?.(restored.id, oldRoot)
      } catch (restoreError) {
        this.logger.error('[Agent Manager] Failed to restore previous worktree:', restoreError)
      }
      return false
    } finally {
      this.rebinding.delete(id)
    }
  }

  /** 会话在磁盘上的文件；未落盘的新会话返回 null */
  private async resolvePersistedSessionFile(runtime: SessionRuntime): Promise<string | null> {
    const file = runtime.sessionManager.getSessionFile()
    if (file && existsSync(file)) return file
    return this.findSessionFile(runtime.id)
  }

  /**
   * 按会话文件重建管理器。文件还不存在（新会话尚未落盘）时用原 id 在目标根重新创建：
   * 直接 open 一个不存在的路径会让 SDK 生成新的会话 id。
   */
  private openManagerForRoot(
    sessionId: string,
    file: string | null,
    root: string
  ): SessionManager {
    return file
      ? SessionManager.open(file, this.sessionDir, root)
      : SessionManager.create(root, this.sessionDir, { id: sessionId })
  }

  /** 重建后恢复标题：未落盘的新会话，标题只存在于旧运行时的内存里 */
  private carrySessionIdentity(
    runtime: SessionRuntime,
    persistedFile: string | null,
    pendingTitle: string | null,
    sessionName: string | undefined
  ): void {
    if (pendingTitle) runtime.pendingTitle = pendingTitle
    // 已落盘的会话由文件本身恢复名称，重复追加会在 JSONL 里留下多余的 session_info
    else if (!persistedFile && sessionName) runtime.sessionManager.appendSessionInfo(sessionName)
  }

  /**
   * 用户显式切换工作树：空闲时立即重建；正在运行时排队到本轮结束。
   * 绑定本身由主进程先完成，这里只负责换 cwd。
   */
  async requestSessionRoot(
    sessionId: string,
    root: string
  ): Promise<{ success: boolean; scheduled?: boolean; error?: string }> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return { success: true }
    this.scheduleRoot(sessionId, root)
    if (runtime.isProcessing) return { success: true, scheduled: true }
    const applied = await this.applyPendingRoot(runtime)
    return applied
      ? { success: true }
      : { success: false, error: 'Failed to switch the session worktree.' }
  }

  /**
   * 把一个用户轮次内的 assistant / toolResult 消息聚合成一条带 parts 的 assistant 消息。
   * parts 保留 thinking、text、tool 的真实顺序，供前端时间线渲染。
   */
  private sessionMessages(runtime: SessionRuntime): AgentMessage[] {
    return buildSessionMessages(runtime.session.messages ?? [], {
      thinkingDurations: runtime.extras.thinkingDurations,
      toolFilePath: (toolName: string, args: any) =>
        this.toolFilePath(toolName, args, runtime.sessionManager.getCwd()),
    })
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

  /** 新建会话（第一条消息前不落盘）；root 为会话绑定工作树，默认工作区根 */
  async createSession(root?: string): Promise<SessionOpenResult> {
    try {
      if (!this.modelRuntime || !this.config) {
        return { success: false, error: 'Agent not initialized.' }
      }
      const targetRoot =
        typeof root === 'string' && root.trim()
          ? path.resolve(root)
          : this.config.workspaceDir
      const manager = SessionManager.create(targetRoot, this.sessionDir)
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
      let infos: any[] = []
      if (typeof SessionManager.listAll === 'function') {
        try {
          infos = await SessionManager.listAll(this.sessionDir)
        } catch {
          infos = []
        }
      }
      // 兼容测试/旧版 SDK：listAll 不可用或为空时退回按 cwd 过滤的 list
      if (!infos.length) {
        infos = await SessionManager.list(config.workspaceDir, this.sessionDir)
      }
      const belongs = config.isSessionOfWorkspace
      const workspaceRoot = path.resolve(config.workspaceDir)
      for (const info of infos) {
        if (belongs) {
          if (!belongs(info.id, info.cwd)) continue
        } else {
          const cwd = info.cwd ? path.resolve(info.cwd) : workspaceRoot
          if (cwd !== workspaceRoot) continue
        }
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
      const root = config.resolveSessionRoot?.(sessionId) ?? config.workspaceDir
      const file =
        (await this.findSessionFile(sessionId)) ??
        SessionManager.findById(root, sessionId, this.sessionDir)
      if (!file) return { success: false, error: 'Session not found.' }
      const manager = SessionManager.open(file, this.sessionDir, root)
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
      if (!isSafeSessionId(sessionId)) return { success: false, error: 'Invalid session id.' }
      // 会话 extras 以 id 为文件名，必须先确认 id 属于当前工作区，避免跨工作区删除
      const root = config.resolveSessionRoot?.(sessionId) ?? config.workspaceDir
      const file =
        (await this.findSessionFile(sessionId)) ??
        SessionManager.findById(root, sessionId, this.sessionDir)
      await this.closeSession(sessionId)
      if (!file) return { success: true }
      if (this.extrasStore) {
        await this.extrasStore.delete(sessionId).catch((error) => {
          this.logger.warn('[Agent Manager] Failed to delete session extras:', error)
        })
      }

      const resolved = path.resolve(file)
      const sessionDirRoot = path.resolve(this.sessionDir)
      if (!resolved.startsWith(sessionDirRoot + path.sep)) {
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
   * - chat(message, options)               默认使用最近打开/创建的会话（简化的兼容调用方式）
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

    const imageCheck = validateChatImages(options?.images)
    if (imageCheck.error) {
      return { success: false, error: imageCheck.error }
    }
    const chatImages = imageCheck.images

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
    let stalled = false
    let hardStopped = false
    let hardStopTimer: NodeJS.Timeout | null = null
    let rejectHardStop: ((error: Error) => void) | null = null
    const hardStopPromise = new Promise<never>((_resolve, reject) => {
      rejectHardStop = reject
    })

    try {
      runtime.onTextDelta = options?.onTextDelta ?? null
      runtime.onTrace = options?.onTrace ?? null
      runtime.pendingEdits = []
      runtime.editSnapshots.clear()
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

      // 工作树上下文放进用户消息前的隐藏上下文块；恢复历史时由 stripContextBlock 剥离
      let worktreeBlock = ''
      const contextProvider = this.config?.getWorktreeContext
      if (contextProvider) {
        try {
          const worktreeContext = await contextProvider(runtime.id)
          if (worktreeContext && worktreeContext.trim()) {
            worktreeBlock = `${CONTEXT_BLOCK_START}\n${worktreeContext.trim()}\n${CONTEXT_BLOCK_END}`
          }
        } catch (error) {
          this.logger.warn('[Agent Manager] Failed to build worktree context:', error)
        }
        if (this.runtimes.get(runtime.id) !== runtime) {
          runtime.isProcessing = false
          return { success: false, error: 'Agent request was aborted.' }
        }
      }

      // 发送用户消息并等待 Agent 完成；超时先 abort，宽限期后仍未结束则强制收尾
      const session = runtime.session
      const planBefore = runtime.extras.plan?.id ?? null
      const promptText =
        normalizeSessionPermission(runtime.extras.permission).mode === 'plan'
          ? wrapPlanPrompt(message)
          : message
      const finalPrompt = worktreeBlock ? `${worktreeBlock}\n\n${promptText}` : promptText
      const images = chatImages.map((image) => ({
        type: 'image' as const,
        data: image.data,
        mimeType: image.mimeType,
      }))
      const promptPromise = session.prompt(
        finalPrompt,
        images.length > 0 ? { images } : undefined
      )
      // 只监视“模型静默”：工具执行与审批等待期间看门狗自动挂起，不设整轮上限
      const watchdog = new StallWatchdog({
        timeoutMs: STALL_TIMEOUT_MS,
        logger: this.logger,
        onStall: (idleMs) => {
          stalled = true
          this.logger.warn(
            `[Agent Manager] No model output for ${Math.round(idleMs / 1000)}s; aborting session ${runtime.id}`
          )
          void session.abort().catch((error) => {
            this.logger.warn('[Agent Manager] Failed to abort stalled request:', error)
          })
          hardStopTimer = setTimeout(() => {
            hardStopped = true
            rejectHardStop?.(
              new Error(`Agent did not stop within ${ABORT_GRACE_MS}ms after abort`)
            )
          }, ABORT_GRACE_MS)
          hardStopTimer.unref?.()
        },
      })
      runtime.watchdog = watchdog
      watchdog.start()
      await Promise.race([promptPromise, hardStopPromise])

      if (hardStopTimer) clearTimeout(hardStopTimer)

      // 收集本轮文件修改（在读取回复前取出，确保不串到下一轮）
      const edits = runtime.pendingEdits.splice(0)

      if (stalled) {
        return { success: false, error: stallErrorMessage(), edits }
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
        // 本轮新提交的计划（R-04），保证 trace 丢失时前端也能拿到
        plan:
          runtime.extras.plan && runtime.extras.plan.id !== planBefore
            ? runtime.extras.plan
            : undefined,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (stalled) {
        this.logger.error('[Agent Manager] Response stalled:', errorMessage)
        const edits = runtime.pendingEdits.splice(0)
        if (hardStopped) {
          await this.resetRuntimeAfterHardStop(runtime)
        }
        return { success: false, error: stallErrorMessage(), edits }
      }
      this.logger.error('[Agent Manager] Chat error:', errorMessage)
      this.logger.error('[Agent Manager] Stack:', error instanceof Error ? error.stack : '')

      return {
        success: false,
        error: `Agent error: ${errorMessage}`,
        edits: runtime.pendingEdits.splice(0),
      }
    } finally {
      if (hardStopTimer) clearTimeout(hardStopTimer)
      runtime.watchdog?.stop()
      runtime.watchdog = null
      if (this.runtimes.get(runtime.id) === runtime) {
        runtime.isProcessing = false
        runtime.onTextDelta = null
        runtime.onTrace = null
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
    const root = runtime.sessionManager.getCwd()
    await this.disposeRuntime(runtime)
    const config = this.config
    if (!config) return

    try {
      const file =
        (await this.findSessionFile(id)) ??
        SessionManager.findById(root, id, this.sessionDir)
      const manager = file
        ? SessionManager.open(file, this.sessionDir, root)
        : SessionManager.create(root, this.sessionDir)
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

    const prompt = buildTitlePrompt(userText, assistantText)

    const raw = await requestSessionTitle(config.apiConfig, prompt, this.logger)
    if (!raw) return

    const title = normalizeSessionTitle(raw)
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
