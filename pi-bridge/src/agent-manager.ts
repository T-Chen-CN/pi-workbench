/**
 * Agent Manager
 *
 * 管理 Pi Coding Agent 实例的创建、配置和消息处理
 * Agent 运行在 Electron 主进程中，与 main.ts 同进程
 */

import {
  createAgentSession,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type SessionEntry,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { Api, Model, ThinkingLevel } from '@earendil-works/pi-ai'
import * as path from 'path'
import * as fs from 'fs/promises'
import { existsSync } from 'fs'
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
import {
  SessionExtrasStore,
  emptyExtras,
  isSafeSessionId,
} from './session-extras.js'
import {
  CONTEXT_BLOCK_END,
  CONTEXT_BLOCK_START,
  messageText as toMessageText,
  parseContextBlock,
  stripContextBlock,
  wrapPlanPrompt,
} from './text-utils.js'
import {
  buildHtmlExport,
  buildMarkdownExport,
  type ExportLanguage,
} from './session-export.js'
import {
  IMAGE_ONLY_PROMPTS,
  buildExportTurns,
} from './agent-projections.js'
import { validateChatImages } from './chat-images.js'
import {
  computeCompactionThresholds,
  writeCompactionSettings,
  writeModelsConfig,
} from './model-config.js'
import { ensureBashOnPath } from './environment.js'
import { type ModelLimits } from './provider-presets.js'
import { AgentCatalogService, isPiOffline, normalizePiOfflineEnv } from './agent-catalog.js'
import { deriveMessages } from './session-view.js'
import { activeTimeline } from './session-entries.js'
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
import { createCompactHookExtension } from './compact-hook-extension.js'
import type {
  AgentChatOptions,
  AgentChatResult,
  AgentConfig,
  AgentLogger,
  AgentMessage,
  AgentTraceEvent,
  ConversationBranchGroup,
  MessageContext,
  ModelCapabilityInfo,
  PromptTemplateInfo,
  SessionOpenResult,
  SessionSummary,
  SkillInfo,
  ToolResultMeta,
} from './types.js'
import { withTimeout, withTimeoutResult } from './async-utils.js'
import { StallWatchdog } from './stall-watchdog.js'
import { createReadWithDocumentsDefinition } from './read-with-documents.js'
import {
  ABORT_GRACE_MS,
  ABORT_TIMEOUT_MS,
  APPROVAL_TIMEOUT_MS,
  EXTRAS_SAVE_TIMEOUT_MS,
  INIT_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  aggregateTurnUsage,
  collectRunAssistants,
  consoleAgentLogger,
  effectiveLimits,
  normalizePathForCompare,
  resolveToolFilePath,
  sanitizeAgentShellEnv,
  stallErrorMessage,
  thinkingLevelsOf,
  type SessionRuntime,
} from './agent-runtime-types.js'
import {
  resolveCompactionEntry as resolveBranchCompactionEntry,
  subscribeSessionEvents,
} from './agent-session-events.js'
import { AgentTitleService } from './agent-title-service.js'

export type { PlanStep, PlanStepStatus, PlanStatus, StructuredPlan }
export {
  ABORT_GRACE_MS,
  APPROVAL_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  sanitizeAgentShellEnv,
}
export type {
  AgentChatOptions,
  AgentChatResult,
  AgentConfig,
  AgentExtensionToggles,
  AgentLogger,
  AgentMessage,
  AgentTraceEvent,
  AgentTracePart,
  AgentUsage,
  ConversationBranchGroup,
  FileEdit,
  MessageContext,
  MessageContextFile,
  MessageContextQuote,
  ModelCapabilityInfo,
  PromptTemplateInfo,
  SessionBeforeCompactInfo,
  SessionOpenResult,
  SessionSummary,
  SkillInfo,
  ToolResultMeta,
} from './types.js'
export type { SessionMode }

/** 读取会话文件首行 header 的 cwd（仅读前 16KB，避免扫描整份 JSONL 正文） */
async function readSessionHeaderInfo(
  filePath: string
): Promise<{ exists: false } | { exists: true; cwd?: string }> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(filePath, 'r')
    const buffer = Buffer.alloc(16 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead === 0) return { exists: true }
    const chunk = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = chunk.indexOf('\n')
    const firstLine = (newline >= 0 ? chunk.slice(0, newline) : chunk).trim()
    if (!firstLine) return { exists: true }
    const parsed = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown }
    if (parsed && typeof parsed === 'object' && parsed.type === 'session') {
      return {
        exists: true,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
      }
    }
    return { exists: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { exists: false }
    }
    return { exists: true }
  } finally {
    await handle?.close().catch(() => undefined)
  }
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
  private runtimes = new Map<string, SessionRuntime>()
  private lastSessionId: string | null = null
  /** 轮次边界待应用的工作树切换 */
  private pendingRoots = new Map<string, { root: string; branch?: string }>()
  private rebinding = new Set<string>()
  /** 正在重建（切工作树）中的会话 Promise：并发 ensureRuntime 必须等待重建完成 */
  private rebindingPromises = new Map<string, Promise<boolean>>()
  /** sessionId → 正在创建的运行时：并发打开同一个会话时共用一次创建 */
  private creatingRuntimes = new Map<string, Promise<SessionRuntime>>()
  /** 会话标题服务（生成、确定态、跨运行时补写） */
  private readonly titleService = new AgentTitleService({
    getConfig: () => this.config,
    getModelRuntime: () => this.modelRuntime,
    getLogger: () => this.logger,
    getSessionDir: () => this.sessionDir,
    getExtrasStore: () => this.extrasStore,
    getLiveRuntime: (id) => this.runtimes.get(id),
    isDeleted: (id) => this.deletedSessions.has(id),
    findSessionFile: (id) => this.findSessionFile(id),
    resolveSessionModel: (runtime) => this.resolveSessionModel(runtime),
    persistExtras: (runtime) => this.persistExtras(runtime),
  })
  /** 已删除的会话：在途的标题结果不得再把 sidecar / 记录写回来 */
  private deletedSessions = new Set<string>()
  /** 上一次创建会话时使用的联网配置版本 */
  private lastWebAccessVersion: string | null = null
  /** 新建会话的权限种子（G3）：只在 extras 还没有权限时生效，已有会话以落盘为准 */
  private seedPermissions = new Map<string, SessionPermission>()
  /** 模型目录与能力服务 */
  private readonly catalogService = new AgentCatalogService({
    getConfig: () => this.config,
    getModelRuntime: () => this.modelRuntime,
    getLogger: () => this.logger,
  })
  /** dispose 标记：防止在途 createRuntime 在 dispose() 后回插僵尸会话 */
  private disposed = false

  private syncRemoteCatalogSnapshot(providerId: string): Promise<void> {
    return this.catalogService.syncRemoteCatalogSnapshot(providerId)
  }

  private catalogModels(): Model<Api>[] {
    return this.catalogService.catalogModels()
  }

  private resolveSessionModel(runtime?: SessionRuntime): Model<Api> | undefined {
    return this.catalogService.resolveSessionModel(runtime)
  }

  private outputLimit(runtime?: SessionRuntime): number {
    return this.catalogService.outputLimit(runtime)
  }

  /** write/edit 的工具行可附带文件路径；其他工具不暴露文件 */
  private toolFilePath(toolName: string, args: any, root?: string): string | undefined {
    return resolveToolFilePath(toolName, args, root, this.config?.workspaceDir)
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
   * trace 统一分发：逐轮回调（chat 期间）+ 常驻订阅（事件唤醒的轮次）。
   * 任何一个 sink 抛错都不能掀掉本轮，因此逐个 try/catch。
   */
  private dispatchTrace(runtime: SessionRuntime, event: AgentTraceEvent): void {
    const turn = runtime.turnTrace
    if (turn) {
      try {
        turn(event)
      } catch (error) {
        this.logger.warn('[Agent Manager] Trace handler failed:', error)
      }
    }
    for (const sink of runtime.traceSinks) {
      try {
        sink(event)
      } catch (error) {
        this.logger.warn('[Agent Manager] Trace subscriber failed:', error)
      }
    }
  }

  private subscribeToSessionEvents(runtime: SessionRuntime): () => void {
    return subscribeSessionEvents(runtime, {
      getLogger: () => this.logger,
      getWorkspaceDir: () => this.config?.workspaceDir,
      persistExtras: (target) => this.persistExtras(target),
      onAgentSettled: (target) => {
        // 在事件回调外重建，避免销毁正在分发事件的会话
        setTimeout(() => {
          void this.applyPendingRoot(target)
        }, 0)
        try {
          this.config?.onAgentSettled?.(target.id)
        } catch (error) {
          this.logger.warn('[Agent Manager] onAgentSettled failed:', error)
        }
      },
    })
  }

  /**
   * 初始化共享运行时（models.json / ModelRuntime / 环境租约），并打开最近会话。
   * 多会话共用同一模型运行时；每个会话是独立的 SessionRuntime。
   */
  async initialize(config: AgentConfig): Promise<{ success: boolean; error?: string }> {
    let initialized = false
    this.disposed = false
    this.logger = config.logger ?? consoleAgentLogger
    try {
      await this.disposeAllRuntimes()
      this.lastWebAccessVersion = null

      this.config = config
      const { providerId, modelId, overrides } = config.apiConfig

      this.logger.info('[Agent Manager] Initializing agent...')
      this.logger.info('[Agent Manager] Workspace:', config.workspaceDir)
      this.logger.info('[Agent Manager] Provider:', providerId)
      this.logger.info('[Agent Manager] Model:', modelId)

      this.agentDir =
        config.agentDir || path.join(config.workspaceDir, '.pi-workbench', 'agent')
      this.extrasStore = new SessionExtrasStore(path.join(this.agentDir, 'session-extras'))
      // 覆盖写：旧版本的 pi-workbench 条目必须一起消失（D13/D25）
      const modelsPath = await writeModelsConfig(this.agentDir, { providerId, overrides })
      ensureBashOnPath(this.logger)

      this.catalogService.resetSnapshot()
      normalizePiOfflineEnv()
      this.modelRuntime = await withTimeout(
        ModelRuntime.create({
          modelsPath,
          // 凭证由宿主注入，不再写 process.env，也不再用 auth.json（D3）
          credentials: config.credentials,
          modelsStore: config.modelsStore,
          refreshOnCreate: false,
          allowModelNetwork: false,
        }),
        INIT_TIMEOUT_MS,
        'Agent model runtime'
      )

      // 只从本地 models-store.json 恢复已缓存的远端目录（不发网络），确保 resolveActiveModel
      // 能识别上游新增模型并按 D12/D26 过滤已下架模型（测试替身可能不实现 refresh）
      if (typeof this.modelRuntime.refresh === 'function') {
        await this.modelRuntime.refresh({ allowNetwork: false, providers: [providerId] })
      }
      await this.syncRemoteCatalogSnapshot(providerId)

      // 同步按生效容量计算自动压缩阈值到 settings.json，使各档位均在约 85%（小窗口保底）触发
      const providerModels = this.catalogModels()
        .map((entry) => ({ id: entry.id, contextWindow: effectiveLimits(entry).contextWindow }))
        .filter((entry) => entry.contextWindow > 0)
      if (providerModels.length > 0) {
        await writeCompactionSettings(this.agentDir, providerId, providerModels)
      }

      // 记录里的模型可能已经不在目录里（上游下架 / 切过供应商）：回落到目录首个（D22）
      const model = this.resolveActiveModel()
      if (!model) {
        throw new Error(
          `Provider "${providerId}" has no available model. Pick another provider in Settings.`
        )
      }

      // 目录刷新不阻塞启动：就绪后在后台跑（D6/D14）；PI_OFFLINE 下严格禁网
      if (config.allowModelNetwork && !isPiOffline()) void this.refreshCatalog()

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
        resolveModeTools(mode, runtime.registeredTools, process.platform, this.config?.toolAllowlist)
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
  ): Promise<{ success: boolean; text?: string; context?: MessageContext; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      if (this.isRuntimeBusy(runtime)) {
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
      const raw = toMessageText(last.message)
      const result = await runtime.session.navigateTree(last.id, { summarize: false })
      if (result.cancelled) {
        return { success: false, error: 'Rewind was cancelled.' }
      }
      // 正文去掉内部上下文块；引用 / 附件单独交回，由渲染层重新打包（重发不丢引用）
      const text = (newText ?? stripContextBlock(raw)).trim()
      const context = parseContextBlock(raw)
      return { success: true, text, ...(context ? { context } : {}) }
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
      if (this.isRuntimeBusy(runtime)) {
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
      if (this.isRuntimeBusy(runtime)) {
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
      if (this.isRuntimeBusy(runtime)) {
        return { success: false, error: 'Session is running; stop it before rejecting the plan.' }
      }
      const plan = runtime.extras.plan
      if (!plan || plan.id !== planId) return { success: false, error: 'Plan not found.' }
      if (plan.status !== 'proposed') {
        return { success: false, error: 'This plan is no longer awaiting approval.' }
      }
      plan.status = 'rejected'
      plan.updatedAt = Date.now()
      this.persistExtras(runtime)
      await runtime.extrasSave
      return { success: true, plan }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 按 ADR-003 从完整分支时间线查找工具结果（压缩前的历史也能读到），兼顾未落盘缓冲 */
  private findToolResult(runtime: SessionRuntime, toolCallId: string) {
    return (
      findToolResultPayload(this.timelineMessages(runtime), toolCallId) ??
      findToolResultPayload(runtime.session.messages ?? [], toolCallId)
    )
  }

  /** 工具结果元数据（R-20）；不复制内容，只统计大小 */
  async getToolResultMeta(
    sessionId: string,
    toolCallId: string
  ): Promise<{ success: boolean; meta?: ToolResultMeta; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const payload = this.findToolResult(runtime, toolCallId)
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
      const payload = this.findToolResult(runtime, toolCallId)
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
      const payload = this.findToolResult(runtime, toolCallId)
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
      const payload = this.findToolResult(runtime, toolCallId)
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

  private timelineMessages(runtime: SessionRuntime): any[] {
    return activeTimeline(runtime.sessionManager).flatMap((item) =>
      item.kind === 'message' ? [item.message] : []
    ) as any[]
  }

  private exportTurns(runtime: SessionRuntime) {
    return buildExportTurns(runtime.sessionManager)
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
      const providerId = this.config?.apiConfig.providerId
      if (!providerId) return { success: false, error: 'Agent not initialized.' }
      const model = this.modelRuntime.getModel(providerId, modelId)
      if (!model) return { success: false, error: `Model "${modelId}" is unavailable.` }
      const runtime = await this.ensureRuntime(sessionId)
      await runtime.session.setModel(model)
      // 换模型后思考档位可能不被支持：自动降级到最高可用档，都没有就关掉（D11）
      const supported = thinkingLevelsOf(model)
      const current = String(runtime.session.thinkingLevel ?? '')
      if (current && !supported.includes(current)) {
        const next = (supported[supported.length - 1] ?? 'off') as ThinkingLevel
        try {
          runtime.session.setThinkingLevel(next)
        } catch {
          // 极老模型没有思考档位接口：保持关闭即可
        }
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private isRuntimeBusy(runtime: SessionRuntime | undefined): boolean {
    if (!runtime) return false
    return Boolean(
      runtime.isProcessing ||
        runtime.sdkStreaming ||
        runtime.compactingPromise ||
        (runtime.session as any)?.isStreaming
    )
  }

  /** 运行中的会话 ID；配置保存前用于避免打断正在跑的轮次 */
  hasRunningSessions(): string[] {
    const ids: string[] = []
    for (const [id, runtime] of this.runtimes) {
      if (this.isRuntimeBusy(runtime)) ids.push(id)
    }
    return ids
  }

  /**
   * 当前会话要用的模型：active provider + 记录里的模型。
   *
   * 记录里的模型可能属于别的 provider（切过供应商 / 老会话），这时**静默回落**到
   * 该 provider 的目录首个模型（D22）；渲染层通过 `providers:list` 拿到回落结果
   * 并同步 chat store，所以这里不抛错。
   */
  private resolveActiveModel(): Model<Api> | undefined {
    return this.catalogService.resolveActiveModel()
  }

  async getModelCapabilities(): Promise<{
    success: boolean
    models?: ModelCapabilityInfo[]
    selected?: string
    error?: string
  }> {
    return this.catalogService.getModelCapabilities()
  }

  async getProviderCatalog(): Promise<{
    success: boolean
    providerId?: string
    models?: Array<{ id: string; name: string; limits: ModelLimits; reasoning: boolean }>
    error?: string
  }> {
    return this.catalogService.getProviderCatalog()
  }

  async refreshCatalog(options: { force?: boolean } = {}): Promise<{
    success: boolean
    added: number
    removed: number
    checkedAt?: number
    error?: string
  }> {
    return this.catalogService.refreshCatalog(options)
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
  ): Promise<{
    success: boolean
    usage?: {
      tokens: number | null
      contextWindow: number
      percent: number | null
      autoCompactPercent?: number
    }
    error?: string
  }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      const usage = runtime.session.getContextUsage()
      let autoCompactPercent: number | undefined
      if (usage && usage.contextWindow > 0) {
        const settingsManager = (
          runtime.session as {
            settingsManager?: {
              getCompactionSettings?: (model?: unknown) => {
                enabled?: boolean
                reserveTokens?: number
              }
            }
          }
        ).settingsManager
        const compactionSettings = settingsManager?.getCompactionSettings?.(runtime.session.model)
        if (compactionSettings) {
          if (compactionSettings.enabled !== false && typeof compactionSettings.reserveTokens === 'number') {
            autoCompactPercent = Math.max(
              1,
              Math.min(
                99,
                Math.round(
                  ((usage.contextWindow - compactionSettings.reserveTokens) / usage.contextWindow) *
                    100
                )
              )
            )
          }
        } else {
          autoCompactPercent = computeCompactionThresholds(usage.contextWindow).triggerPercent
        }
      }
      return {
        success: true,
        usage: usage
          ? {
              tokens: usage.tokens ?? null,
              contextWindow: usage.contextWindow,
              percent: usage.percent ?? null,
              ...(autoCompactPercent !== undefined ? { autoCompactPercent } : {}),
            }
          : undefined,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 手动压缩上下文；运行中或已在压缩中不重复触发 */
  async compactContext(
    sessionId: string
  ): Promise<{
    success: boolean
    tokensBefore?: number
    estimatedTokensAfter?: number
    entryId?: string
    timestamp?: number
    error?: string
  }> {
    try {
      const runtime = await this.ensureRuntime(sessionId)
      if (runtime.compactingPromise) {
        return { success: false, error: 'Context compaction is already in progress.' }
      }
      if (this.isRuntimeBusy(runtime)) {
        return { success: false, error: 'Session is running; wait for it to finish before compacting.' }
      }
      const prevEntryId = runtime.lastCompactionEntry?.id ?? runtime.lastCompactionEntryId
      const compactPromise = (async () => {
        try {
          const result = await runtime.session.compact()
          this.resolveCompactionEntry(runtime)
          const latestEntry =
            runtime.lastCompactionEntry && runtime.lastCompactionEntry.id !== prevEntryId
              ? runtime.lastCompactionEntry
              : null
          return {
            success: true as const,
            tokensBefore: result.tokensBefore,
            estimatedTokensAfter: result.estimatedTokensAfter,
            entryId: latestEntry?.id,
            timestamp: latestEntry?.timestamp,
          }
        } catch (error) {
          return {
            success: false as const,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      })()
      runtime.compactingPromise = compactPromise
      try {
        return await compactPromise
      } finally {
        if (runtime.compactingPromise === compactPromise) {
          runtime.compactingPromise = null
        }
        if (this.pendingRoots.has(runtime.id) && !this.isRuntimeBusy(runtime)) {
          setTimeout(() => {
            void this.applyPendingRoot(runtime)
          }, 0)
        }
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 运行中插话：把消息（可带图片、可为纯图片）注入当前轮（steer），不等待本轮结束 */
  async steer(
    sessionId: string,
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<{ success: boolean; error?: string }> {
    const text = message.trim()
    const imageCheck = validateChatImages(images)
    if (imageCheck.error) return { success: false, error: imageCheck.error }
    if (!text && imageCheck.images.length === 0) {
      return { success: false, error: 'Message is empty.' }
    }
    try {
      const runtime = await this.ensureRuntime(sessionId)
      if (runtime.compactingPromise) {
        return { success: false, error: 'Context compaction is in progress.' }
      }
      if (!runtime.isProcessing && !runtime.sdkStreaming && !(runtime.session as any)?.isStreaming) {
        return { success: false, error: 'Session is not running.' }
      }
      const promptText = this.withImagePlaceholder(text, imageCheck.images.length)
      await runtime.session.prompt(promptText, {
        streamingBehavior: 'steer',
        ...(imageCheck.images.length > 0
          ? {
              images: imageCheck.images.map((image) => ({
                type: 'image' as const,
                data: image.data,
                mimeType: image.mimeType,
              })),
            }
          : {}),
      })
      this.logger.info(`[Agent Manager] Steered session ${sessionId}`)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 常驻 trace 订阅，跨轮次有效。
   *
   * 事件唤醒（`sendCustomMessage({ triggerTurn })`）产生的轮次不经过 `chat()`，
   * 没有逐轮回调可用；云端/设备侧只能靠常驻订阅拿到流式事件。
   */
  async subscribeTrace(
    sessionId: string,
    sink: (event: AgentTraceEvent) => void
  ): Promise<() => void> {
    const runtime = await this.ensureRuntime(sessionId)
    runtime.traceSinks.add(sink)
    return () => {
      runtime.traceSinks.delete(sink)
    }
  }

  /** 会话是否正在跑一轮；调用方据此决定 `chat()` 还是 `steer`（`chat()` 并发会直接报错） */
  isSessionBusy(sessionId?: string): boolean {
    const id = sessionId ?? this.lastSessionId
    if (!id) return false
    return this.isRuntimeBusy(this.runtimes.get(id))
  }

  /**
   * 投一条 custom message（事件唤醒入口）。
   *
   * 落盘为 `CustomMessageEntry` 而不是 user 消息，所以「事件不冒充授权」是结构性的。
   * SDK 返回 `Promise<void>`，拿不到 entry id；回执/去重要由调用方把 `eventId`
   * 放进 `details` 自行对账。
   */
  async sendCustomMessage(
    sessionId: string,
    message: {
      customType: string
      content: string | Array<{ type: 'text'; text: string }>
      display?: boolean
      details?: unknown
    },
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }
  ): Promise<{ success: boolean; error?: string }> {
    const customType = message.customType.trim()
    if (!customType) return { success: false, error: 'customType is required.' }
    try {
      const runtime = await this.ensureRuntime(sessionId)
      await runtime.session.sendCustomMessage(
        {
          customType,
          content: message.content,
          display: message.display ?? false,
          details: message.details,
        },
        options
      )
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 装配会话的扩展工厂（G1）。
   *
   * 三个内置扩展可按 `builtinExtensions` 剔除：工单会话必须去掉 worktree，
   * 因为它把实例级 `workspaceDir` 写死成了 coordinator 的目标仓库。
   * 压缩钩子扩展始终注入——它是内核供给，不是可选开关。外部工厂最后追加，
   * 这样宿主守卫能看到内置扩展之后的注册表。
   */
  private buildExtensionFactories(input: {
    id: string
    config: AgentConfig
    sessionManager: SessionManager
    planContext: { runtime: SessionRuntime | null }
    runtimeRef: { current: SessionRuntime | null }
    fallbackPermission: SessionPermission
  }): ExtensionFactory[] {
    const { id, config, sessionManager, planContext, runtimeRef, fallbackPermission } = input
    const toggles = config.builtinExtensions ?? {}
    const factories: ExtensionFactory[] = []

    if (toggles.approval !== false) {
      factories.push(
        createApprovalExtension(
          {
            // 必须传主工作区根路径而非链接工作树路径：渲染层按主工作区路径路由审批卡与取消审批
            workspaceDir: config.workspaceDir,
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
        )
      )
    }

    if (toggles.plan !== false) {
      factories.push(
        createPlanExtension({
          getRuntime: () => planContext.runtime,
          persistExtras: (runtime) => this.persistExtras(runtime as SessionRuntime),
          getMode: () =>
            normalizeSessionPermission(runtimeRef.current?.extras.permission ?? fallbackPermission)
              .mode,
        })
      )
    }

    if (toggles.worktree !== false) {
      factories.push(
        createWorktreeExtension({
          sessionId: id,
          workspaceDir: config.workspaceDir,
          getRoot: () => sessionManager.getCwd() || config.workspaceDir,
          onSwitch: (target, base) => this.requestWorktreeSwitch(id, target, base),
          scheduleRoot: (nextRoot, branch) => this.scheduleRoot(id, nextRoot, branch),
        })
      )
    }

    factories.push(
      createCompactHookExtension({
        logger: this.logger,
        onBeforeCompact: (event) => {
          const handler = this.config?.onSessionBeforeCompact
          if (!handler) return
          try {
            handler(id, event)
          } catch (error) {
            this.logger.warn('[Agent Manager] onSessionBeforeCompact failed:', error)
          }
        },
      })
    )

    for (const factory of config.extensionFactories ?? []) factories.push(factory)
    return factories
  }

  /**
   * 为即将创建的会话运行时解析模型：
   * 若老会话分支里记录了当前供应商下仍可用的模型，优先保留它（同时取新 modelRuntime 里已应用最新 overrides 的对象），
   * 避免配置刷新重建 Agent 后把老会话强行重置回全局默认模型。
   */
  private resolveSessionInitialModel(sessionManager: SessionManager): Model<Api> | undefined {
    const providerId = this.config?.apiConfig.providerId
    if (providerId && this.modelRuntime) {
      try {
        const branch = sessionManager.getBranch() as Array<Record<string, any>>
        for (let index = branch.length - 1; index >= 0; index -= 1) {
          const entry = branch[index]
          let recordedProvider: string | undefined
          let recordedModelId: string | undefined
          if (entry?.type === 'model_change') {
            recordedProvider = typeof entry.provider === 'string' ? entry.provider : undefined
            recordedModelId = typeof entry.modelId === 'string' ? entry.modelId : undefined
          } else if (entry?.type === 'message' && entry.message?.role === 'assistant') {
            recordedProvider =
              typeof entry.message.provider === 'string' ? entry.message.provider : undefined
            recordedModelId =
              typeof entry.message.model === 'string' ? entry.message.model : undefined
          }
          if (!recordedProvider || !recordedModelId) continue
          if (recordedProvider !== providerId) break
          const found = this.modelRuntime.getModel(providerId, recordedModelId)
          if (found) {
            const allowed = this.catalogModels()
            if (allowed.length === 0 || allowed.some((item) => item.id === found.id)) {
              return found
            }
          }
          break
        }
      } catch {
        // 读取分支失败时回退工作区默认模型
      }
    }
    return this.resolveActiveModel()
  }

  /** 创建（或复用）一个会话运行时 */
  private async createRuntime(sessionManager: SessionManager): Promise<SessionRuntime> {
    const config = this.config
    const modelRuntime = this.modelRuntime
    if (!config || !modelRuntime) throw new Error('Agent not initialized.')

    const id = sessionManager.getSessionId()
    const existing = this.runtimes.get(id)
    if (existing) return existing

    const model = this.resolveSessionInitialModel(sessionManager)
    if (!model) throw new Error('Selected model is unavailable.')

    const planContext: { runtime: SessionRuntime | null } = { runtime: null }
    const runtimeRef: { current: SessionRuntime | null } = { current: null }
    const loadedExtras = this.extrasStore
      ? await this.extrasStore.loadWithStatus(id)
      : { extras: emptyExtras(), corrupted: false }
    const extras = loadedExtras.extras
    // 模式只在会话诞生时从全局默认档取一次，此后会话自行持有并落盘。
    // 若既有 sidecar 损坏导致权限丢失，fail-closed 降级到 readonly，绝不静默提权。
    const seededPermission = extras.permission === null
    if (seededPermission) {
      const seed = this.seedPermissions.get(id)
      this.seedPermissions.delete(id)
      extras.permission =
        seed ??
        (loadedExtras.corrupted
          ? { mode: 'readonly', grants: [] }
          : { mode: this.defaultPermissionLevel(), grants: [] })
    }
    const fallbackPermission = normalizeSessionPermission(extras.permission)
    const root = sessionManager.getCwd() || config.workspaceDir
    // 标题：会话记录里的 session_info 是权威来源，sidecar 只做备份与拦截
    const recordedTitle = (sessionManager.getSessionName() ?? '').trim()
    const sessionFile = sessionManager.getSessionFile()
    const persistedOnDisk = Boolean(sessionFile && existsSync(sessionFile))
    let titleBackfilled = false
    // 尚未落盘的会话先留成待写入标题，由首次落盘时一并写进记录
    let restoredPendingTitle: string | null = null
    if (recordedTitle) {
      this.titleService.setSettled(id, recordedTitle)
      if (extras.title !== recordedTitle) {
        extras.title = recordedTitle
        titleBackfilled = true
      }
    } else if (extras.title) {
      // 记录里丢了标题（分支裁剪 / 迁移 / 旧版本）：标题已确定，绝不重新生成
      this.titleService.setSettled(id, extras.title)
      if (persistedOnDisk) {
        try {
          sessionManager.appendSessionInfo(extras.title)
        } catch (error) {
          this.logger.warn('[Agent Manager] Failed to restore the session title:', error)
        }
      } else {
        restoredPendingTitle = extras.title
      }
    }
    // 禁止自动信任工作区内的 .pi/settings.json 与 .pi/extensions/*（防打开任意仓库即触发主进程 RCE）；
    // 应用内置扩展一律通过 additionalExtensionPaths 与 extensionFactories 显式白名单注入。
    const settingsManager = SettingsManager.create(config.workspaceDir, this.agentDir, {
      projectTrusted: false,
    })
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: config.webAccessExtensionPaths?.length
        ? config.webAccessExtensionPaths
        : undefined,
      extensionFactories: this.buildExtensionFactories({
        id,
        config,
        sessionManager,
        planContext,
        runtimeRef,
        fallbackPermission,
      }),
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

    // Agent 派生 shell 子进程必须清洗应用内部敏感环境变量（尤其是联网搜索 Key），防止模型读取 process.env 外泄
    const sanitizeShellSpawn = <T extends { env: NodeJS.ProcessEnv }>(ctx: T): T => ({
      ...ctx,
      env: sanitizeAgentShellEnv(ctx.env),
    })
    const customTools: ToolDefinition<any, any>[] = [
      createReadWithDocumentsDefinition({
        cwd: root,
        readDocument: config.readDocument,
      }),
      createBashToolDefinition(root, { spawnHook: sanitizeShellSpawn }) as unknown as ToolDefinition<any, any>,
      ...(process.platform === 'win32'
        ? [
            createPowerShellToolDefinition(root, {
              spawnHook: sanitizeShellSpawn,
            }) as unknown as ToolDefinition<any, any>,
          ]
        : []),
    ]

    const sessionPromise = createAgentSession({
      cwd: root,
      agentDir: this.agentDir,
      modelRuntime,
      model,
      sessionManager,
      settingsManager,
      resourceLoader,
      // 同名 `read` / `bash` / `powershell` 覆盖内置定义：文档抽取 + 子进程敏感环境变量清洗
      customTools,
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

    // 必须调用 bindExtensions 触发扩展生命周期（session_start / resources_discover / session_shutdown），
    // 否则链接工作树的技能/模板发现与 pi-web-access 临时目录清理均不会运行。
    if (typeof sessionOutcome.value.session.bindExtensions === 'function') {
      await sessionOutcome.value.session.bindExtensions({
        onError: (err) => {
          this.logger.warn(
            `[Agent Manager] Extension error (${err.extensionPath}/${err.event}):`,
            err.error
          )
        },
      })
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
      turnTrace: null,
      traceSinks: new Set(),
      onTrace: (event) => this.dispatchTrace(runtime, event),
      watchdog: null,
      sdkStreaming: false,
      bgWatchdog: null,
      thinkingDeltaSeen: new Set(),
      thinkingStarts: new Map(),
      toolFiles: new Map(),
      editSnapshots: new Map(),
      pendingEdits: [],
      messageHistory: [],
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      updatedAt: Date.now(),
      titleAttempted: false,
      titleFailures: 0,
      pendingTitle: restoredPendingTitle,
      registeredTools,
      extras,
      extrasSave: Promise.resolve(),
      thinkingDurationsThisMessage: [],
      lastCompactionEntryId: null,
      lastCompactionEntry: null,
      compactingPromise: null,
    }
    // 异步创建期间若 manager 已 dispose 或会话已被删除，立即释放防止回魂
    if (this.disposed || this.deletedSessions.has(id)) {
      try {
        runtime.session.dispose()
      } catch {
        // ignore
      }
      throw new Error(this.disposed ? 'Agent manager was disposed.' : 'Session was deleted.')
    }
    runtime.unsubscribe = this.subscribeToSessionEvents(runtime)
    planContext.runtime = runtime
    runtimeRef.current = runtime
    this.applySessionModeTools(runtime, fallbackPermission.mode)
    // 兜底防泄漏：若并发边界里已有同 id 运行时被挤入，先销毁被顶替的旧实例再写入
    const superseded = this.runtimes.get(id)
    if (superseded && superseded !== runtime) {
      superseded.watchdog?.stop()
      superseded.watchdog = null
      superseded.bgWatchdog?.stop()
      superseded.bgWatchdog = null
      try {
        superseded.unsubscribe?.()
      } catch {
        // ignore
      }
      superseded.unsubscribe = null
      try {
        superseded.session.dispose()
      } catch (error) {
        this.logger.warn('[Agent Manager] Failed to dispose superseded session:', error)
      }
    }
    this.runtimes.set(id, runtime)
    if (seededPermission || titleBackfilled) this.persistExtras(runtime)
    return runtime
  }

  private async disposeRuntime(
    runtime: SessionRuntime,
    options?: { skipAbort?: boolean }
  ): Promise<void> {
    runtime.watchdog?.stop()
    runtime.watchdog = null
    runtime.bgWatchdog?.stop()
    runtime.bgWatchdog = null
    if (!options?.skipAbort && this.isRuntimeBusy(runtime)) {
      try {
        await withTimeout(runtime.session.abort(), ABORT_TIMEOUT_MS, 'Agent abort')
      } catch (error) {
        this.logger.warn('[Agent Manager] Failed to abort before dispose:', error)
      }
    }
    // 等 sidecar 落盘完成，避免删除会话时与最后一次保存竞争。
    // 但必须有上界：退出时写盘卡住（磁盘慢 / 文件被占用）不能把清理拖进超时兜底。
    await withTimeoutResult(runtime.extrasSave, EXTRAS_SAVE_TIMEOUT_MS, 'extras save', this.logger)
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
    if (this.runtimes.get(runtime.id) === runtime) {
      this.runtimes.delete(runtime.id)
    }
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

  /** 按 sessionId 合并并发的运行时创建，避免同一会话同时建出两份 AgentSession 泄漏 */
  private trackRuntimeCreation(
    sessionId: string,
    factory: () => Promise<SessionRuntime>
  ): Promise<SessionRuntime> {
    const existing = this.runtimes.get(sessionId)
    if (existing) return Promise.resolve(existing)
    const inflight = this.creatingRuntimes.get(sessionId)
    if (inflight) return inflight

    const creation = factory()
    this.creatingRuntimes.set(sessionId, creation)
    const cleanup = () => {
      if (this.creatingRuntimes.get(sessionId) === creation) {
        this.creatingRuntimes.delete(sessionId)
      }
    }
    void creation.then(cleanup, cleanup)
    return creation
  }

  /**
   * 确保某个会话已有运行时（不存在则从磁盘打开）。
   * 打开是异步的：打开会话 / 读分支 / 读计划 / 读列表可能同时进来，必须共用同一次创建。
   * 否则同一个会话会存在两个 SessionManager，后写者看不到先写者写入的标题。
   */
  private async ensureRuntime(sessionId: string): Promise<SessionRuntime> {
    const rebinding = this.rebindingPromises.get(sessionId)
    if (rebinding) {
      await rebinding.catch(() => undefined)
    }
    return this.trackRuntimeCreation(sessionId, async () => {
      const config = this.config
      if (!config) throw new Error('Agent not initialized.')
      const root = config.resolveSessionRoot?.(sessionId) ?? config.workspaceDir
      const file = await this.findSessionFile(sessionId, root)
      if (!file) throw new Error('Session not found.')
      const manager = SessionManager.open(file, this.sessionDir, root)
      return await this.createRuntime(manager)
    })
  }

  /** 校验会话记录的 cwd 是否归属当前工作区（Windows 大小写不敏感） */
  private sessionBelongsToWorkspace(sessionId: string, cwd: string | undefined | null): boolean {
    const config = this.config
    if (!config) return false
    if (config.isSessionOfWorkspace) {
      return config.isSessionOfWorkspace(sessionId, cwd ?? '')
    }
    const workspaceRoot = normalizePathForCompare(config.workspaceDir)
    const infoCwd = cwd ? normalizePathForCompare(cwd) : workspaceRoot
    return infoCwd === workspaceRoot
  }

  /**
   * 会话文件按 id 查找，同时强制校验归属当前工作区（防跨工作区打开/改名/删除共享 sessionDir 下的他人会话）。
   * 优先走 O(1) 仅读首行 header 的 `SessionManager.findById`，避免每次打开/重命名/删除都全量扫盘读取所有 `.jsonl`；
   * 仅当按已知工作区根未命中（例如历史链接工作树已解绑）时才回退 `SessionManager.listAll`。
   */
  private async findSessionFile(sessionId: string, preferredRoot?: string): Promise<string | null> {
    const config = this.config
    if (!config) return null
    try {
      const resolvedRoot = preferredRoot ?? config.resolveSessionRoot?.(sessionId) ?? config.workspaceDir
      const candidateRoots = [resolvedRoot]
      if (normalizePathForCompare(resolvedRoot) !== normalizePathForCompare(config.workspaceDir)) {
        candidateRoots.push(config.workspaceDir)
      }

      if (typeof SessionManager.findById === 'function') {
        for (const candidateRoot of candidateRoots) {
          const direct = SessionManager.findById(candidateRoot, sessionId, this.sessionDir)
          if (!direct) continue
          const header = await readSessionHeaderInfo(direct)
          const owned = header.exists
            ? this.sessionBelongsToWorkspace(sessionId, header.cwd)
            : this.sessionBelongsToWorkspace(sessionId, candidateRoot)
          return owned ? direct : null
        }
      }

      if (typeof SessionManager.listAll !== 'function') return null
      const infos = await SessionManager.listAll(this.sessionDir)
      const matched = infos.find((info) => info.id === sessionId)
      if (!matched) return null
      if (!this.sessionBelongsToWorkspace(matched.id, matched.cwd)) return null
      return matched.path
    } catch (error) {
      this.logger.warn('[Agent Manager] Failed to locate session file:', error)
      return null
    }
  }

  /** 判定 sessionId 是否已落盘但明确归属其他工作区（防止删除无本地文件会话时误删他仓 extras） */
  private async isForeignSessionOnDisk(sessionId: string): Promise<boolean> {
    const config = this.config
    if (!config || typeof SessionManager.listAll !== 'function') return false
    try {
      const infos = await SessionManager.listAll(this.sessionDir)
      const matched = infos.find((info) => info.id === sessionId)
      if (!matched) return false
      if (config.isSessionOfWorkspace) {
        return !config.isSessionOfWorkspace(matched.id, matched.cwd)
      }
      const workspaceRoot = normalizePathForCompare(config.workspaceDir)
      const infoCwd = matched.cwd ? normalizePathForCompare(matched.cwd) : workspaceRoot
      return infoCwd !== workspaceRoot
    } catch {
      return false
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
    if (this.disposed) return false
    const pending = this.pendingRoots.get(runtime.id)
    if (!pending) return false
    if (this.runtimes.get(runtime.id) !== runtime) return false
    if (this.rebinding.has(runtime.id)) return false
    if (this.isRuntimeBusy(runtime)) return false

    const id = runtime.id
    const oldRoot = runtime.sessionManager.getCwd()
    if (normalizePathForCompare(oldRoot) === normalizePathForCompare(pending.root)) {
      this.pendingRoots.delete(id)
      return true
    }

    // 必须在首个 await（resolvePersistedSessionFile）前同步加锁并登记 rebindingPromises，
    // 否则排队中的 chat() 可在 await 间隙启动并被中途 dispose
    this.rebinding.add(id)
    this.pendingRoots.delete(id)
    const pendingTitle = runtime.pendingTitle
    const sessionName = runtime.sessionManager.getSessionName()
    // 迁移跨轮常驻 traceSinks，否则云端或工具订阅方在切工作树后静默失明
    const preservedSinks = [...runtime.traceSinks]

    const task = (async (): Promise<boolean> => {
      let file: string | null = null
      try {
        file = await this.resolvePersistedSessionFile(runtime)
        await this.disposeRuntime(runtime)
        const manager = this.openManagerForRoot(id, file, pending.root)
        if (manager.getSessionId() !== id) {
          throw new Error(
            `Session id changed while switching worktrees (${id} -> ${manager.getSessionId()}).`
          )
        }
        const next = await this.createRuntime(manager)
        for (const sink of preservedSinks) next.traceSinks.add(sink)
        this.carrySessionIdentity(next, file, pendingTitle, sessionName)
        this.lastSessionId = next.id
        this.config?.onSessionRootChanged?.(next.id, pending.root)
        this.logger.info(
          `[Agent Manager] Session ${next.id} switched to worktree: ${pending.root}`
        )
        return true
      } catch (error) {
        if (this.disposed) return false
        this.logger.error('[Agent Manager] Failed to apply worktree switch:', error)
        try {
          const manager = this.openManagerForRoot(id, file, oldRoot)
          const restored = await this.createRuntime(manager)
          for (const sink of preservedSinks) restored.traceSinks.add(sink)
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
    })()
    this.rebindingPromises.set(id, task)
    const cleanupRebind = () => {
      if (this.rebindingPromises.get(id) === task) {
        this.rebindingPromises.delete(id)
      }
    }
    void task.then(cleanupRebind, cleanupRebind)
    return task
  }

  /** 会话在磁盘上的文件；未落盘的新会话返回 null */
  private async resolvePersistedSessionFile(runtime: SessionRuntime): Promise<string | null> {
    const file = runtime.sessionManager.getSessionFile()
    if (file && existsSync(file)) return file
    const found = await this.findSessionFile(runtime.id, runtime.sessionManager.getCwd())
    return found && existsSync(found) ? found : null
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
    // 已落盘的会话由文件本身恢复名称；未落盘的会话若 sidecar 已补写过标题就不再重复追加
    else if (!persistedFile && sessionName && !runtime.sessionManager.getSessionName()) {
      runtime.sessionManager.appendSessionInfo(sessionName)
    }
    // 标题已确定：重建后不得再次自动生成
    if (pendingTitle) this.titleService.setSettled(runtime.id, pendingTitle)
    else if (sessionName) this.settleSessionTitle(runtime, sessionName)
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
    if (this.isRuntimeBusy(runtime) || this.rebinding.has(sessionId)) {
      return { success: true, scheduled: true }
    }
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
    const isLiveStreaming = Boolean(
      runtime.isProcessing || runtime.sdkStreaming || (runtime.session as any)?.isStreaming
    )
    return deriveMessages(activeTimeline(runtime.sessionManager), {
      thinkingDurations: runtime.extras.thinkingDurations,
      toolFilePath: (toolName: string, args: any) =>
        this.toolFilePath(toolName, args, runtime.sessionManager.getCwd()),
      isLiveStreaming,
    })
  }

  /** 成功压缩后取回本次落盘的 compaction entry（只扫当前分支）；已转发过则返回 null */
  private resolveCompactionEntry(runtime: SessionRuntime): any | null {
    return resolveBranchCompactionEntry(runtime, this.logger)
  }

  private runtimeSummary(runtime: SessionRuntime): SessionSummary {
    let messageCount = 0
    for (const msg of this.timelineMessages(runtime)) {
      if (msg.role === 'user' || msg.role === 'assistant') messageCount += 1
    }

    return {
      id: runtime.id,
      title: (
        this.titleService.sessionTitle(runtime) ?? this.titleService.recordFirstUserText(runtime)
      ).slice(0, 60),
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
        const recentId = manager.getSessionId()
        const rebinding = this.rebindingPromises.get(recentId)
        if (rebinding) {
          await rebinding.catch(() => undefined)
        }
        runtime = await this.trackRuntimeCreation(recentId, () => this.createRuntime(manager))
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
  /**
   * 新建会话（第一条消息前不落盘）；root 为会话绑定工作树，默认工作区根。
   *
   * `permission` 只对**本次新建**的会话生效：工单会话（G3）靠它种成 `auto`，
   * 不需要审批通道也不弹审批。已有会话的权限以落盘的 sidecar 为准，不会被覆盖。
   */
  async createSession(
    root?: string,
    options?: { permission?: SessionPermission }
  ): Promise<SessionOpenResult> {
    try {
      if (!this.modelRuntime || !this.config) {
        return { success: false, error: 'Agent not initialized.' }
      }
      const targetRoot =
        typeof root === 'string' && root.trim()
          ? path.resolve(root)
          : this.config.workspaceDir
      const manager = SessionManager.create(targetRoot, this.sessionDir)
      if (options?.permission) {
        this.seedPermissions.set(
          manager.getSessionId(),
          normalizeSessionPermission(options.permission)
        )
      }
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
      const workspaceRoot = normalizePathForCompare(config.workspaceDir)
      for (const info of infos) {
        if (belongs) {
          if (!belongs(info.id, info.cwd)) continue
        } else {
          const cwd = info.cwd ? normalizePathForCompare(info.cwd) : workspaceRoot
          if (cwd !== workspaceRoot) continue
        }
        sessions.set(info.id, {
          id: info.id,
          title: (
            info.name?.trim() ||
            this.titleService.getSettled(info.id)?.trim() ||
            stripContextBlock(info.firstMessage ?? '').trim()
          ).slice(0, 60),
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
      // 同名重命名直接成功：重复追加只会在 JSONL 里留下多余的 session_info
      const current = runtime
        ? this.titleService.sessionTitle(runtime)
        : this.titleService.getSettled(sessionId) ?? null
      if (current === title) {
        this.titleService.setSettled(sessionId, title)
        return { success: true }
      }
      if (runtime) {
        runtime.pendingTitle = title
        if (runtime.sessionManager.isPersisted()) {
          runtime.sessionManager.appendSessionInfo(title)
          runtime.pendingTitle = null
        }
        this.settleSessionTitle(runtime, title)
        runtime.updatedAt = Date.now()
        return { success: true }
      }
      const config = this.config
      if (!config) return { success: false, error: 'Agent not initialized.' }
      const root = config.resolveSessionRoot?.(sessionId) ?? config.workspaceDir
      const file = await this.findSessionFile(sessionId, root)
      if (!file) return { success: false, error: 'Session not found.' }
      const manager = SessionManager.open(file, this.sessionDir, root)
      manager.appendSessionInfo(title)
      this.titleService.setSettled(sessionId, title)
      void this.titleService.saveSessionTitleExtra(sessionId, title)
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
      // 会话 extras 以 id 为文件名，必须先确认 id 不属于其他工作区，避免跨工作区误删
      const root = config.resolveSessionRoot?.(sessionId) ?? config.workspaceDir
      const hadLocalRuntime =
        this.runtimes.has(sessionId) || this.creatingRuntimes.has(sessionId)
      const file = await this.findSessionFile(sessionId, root)
      if (!file && !hadLocalRuntime && (await this.isForeignSessionOnDisk(sessionId))) {
        return { success: true }
      }
      let resolvedFile: string | null = null
      if (file) {
        resolvedFile = path.resolve(file)
        const normalizedResolved = normalizePathForCompare(resolvedFile)
        const normalizedSessionDir = normalizePathForCompare(this.sessionDir)
        const sessionDirPrefix = normalizedSessionDir.endsWith(path.sep)
          ? normalizedSessionDir
          : normalizedSessionDir + path.sep
        if (!normalizedResolved.startsWith(sessionDirPrefix)) {
          return {
            success: false,
            error: 'Refusing to delete a session outside the session directory.',
          }
        }
      }
      // 先标记 deletedSessions 并等待在途创建结束，避免删除瞬间创建完成的运行时回魂
      this.deletedSessions.add(sessionId)
      if (this.deletedSessions.size > 500) {
        const oldest = this.deletedSessions.values().next().value
        if (oldest !== undefined) this.deletedSessions.delete(oldest)
      }
      const inflight = this.creatingRuntimes.get(sessionId)
      if (inflight) {
        await inflight.catch(() => undefined)
      }
      await this.closeSession(sessionId)
      this.titleService.delete(sessionId)
      this.creatingRuntimes.delete(sessionId)
      this.seedPermissions.delete(sessionId)
      // 未落盘会话也可能已写入权限/标题 sidecar，无论 file 是否存在都必须清理 extras
      if (this.extrasStore) {
        await this.extrasStore.delete(sessionId).catch((error) => {
          this.logger.warn('[Agent Manager] Failed to delete session extras:', error)
        })
      }
      if (!resolvedFile) return { success: true }
      await fs.unlink(resolvedFile).catch((error: NodeJS.ErrnoException) => {
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

    // 轮次边界若有在途或待应用的切工作树，必须先等重建完成再置 isProcessing，避免挤掉切换或被中途 dispose
    const targetId = sessionId ?? this.lastSessionId
    if (targetId) {
      const rebinding = this.rebindingPromises.get(targetId)
      if (rebinding) {
        await rebinding.catch(() => undefined)
      }
      const existingBeforeTurn = this.runtimes.get(targetId)
      if (existingBeforeTurn && this.pendingRoots.has(targetId) && !this.isRuntimeBusy(existingBeforeTurn)) {
        await this.applyPendingRoot(existingBeforeTurn).catch(() => undefined)
      }
    }

    // 已有运行时时同步置位，避免 dispose 在 await 间隙漏掉正在启动的请求
    let runtime: SessionRuntime | null = sessionId
      ? this.runtimes.get(sessionId) ?? null
      : this.lastSessionId
        ? this.runtimes.get(this.lastSessionId) ?? null
        : null

    if (runtime) {
      if (runtime.isProcessing || runtime.sdkStreaming || (runtime.session as any)?.isStreaming) {
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
      if (runtime.isProcessing || runtime.sdkStreaming || (runtime.session as any)?.isStreaming) {
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
      // 若手动压缩正在进行，必须先等待压缩完成；压缩失败时一并终止本轮（不写入会话历史）
      if (runtime.compactingPromise) {
        const compactOutcome = await runtime.compactingPromise
        if (this.runtimes.get(runtime.id) !== runtime) {
          return { success: false, error: 'Agent request was aborted.' }
        }
        if (!compactOutcome.success) {
          return {
            success: false,
            error: compactOutcome.error || 'Context compaction failed.',
            compactionFailed: true,
          }
        }
      }

      runtime.onTextDelta = options?.onTextDelta ?? null
      runtime.turnTrace = options?.onTrace ?? null
      runtime.pendingEdits = []
      runtime.editSnapshots.clear()
      // 只认本轮新增的 assistant 消息，避免请求失败时把上一轮回复当成本轮结果
      const messageStartIndex = runtime.session.messages.length
      // 压缩会重建 messages 数组使下标失效，同时用本轮开始时间兜底
      const runStartedAt = Date.now()
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
      const imagePromptText = this.withImagePlaceholder(promptText, chatImages.length, runtime)
      const finalPrompt = worktreeBlock
        ? `${worktreeBlock}\n\n${imagePromptText}`
        : imagePromptText
      const images = chatImages.map((image) => ({
        type: 'image' as const,
        data: image.data,
        mimeType: image.mimeType,
      }))
      // 必须在 session.prompt() 之前挂好看门狗：否则 prompt 同步发出的
      // compaction_start / agent_start 会漏掉挂起信号或误建后台看门狗
      // 只监视“模型静默”：工具执行、审批等待与压缩期间看门狗自动挂起，不设整轮上限
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

      const promptPromise = session.prompt(
        finalPrompt,
        images.length > 0 ? { images } : undefined
      )
      // 防止 hardStopPromise 先触发后 promptPromise 迟到拒绝成为 Node 24 unhandledRejection
      void promptPromise.catch(() => {})
      await Promise.race([promptPromise, hardStopPromise])

      if (hardStopTimer) clearTimeout(hardStopTimer)

      // 收集本轮文件修改（在读取回复前取出，确保不串到下一轮）
      const edits = runtime.pendingEdits.splice(0)

      if (stalled) {
        return { success: false, error: stallErrorMessage(), edits }
      }

      const messages = runtime.session.messages

      // 只认本轮新增的 assistant 消息；同时聚合多步工具调用的 usage，避免只计最后一步漏算前序 token/费用
      const runAssistants = collectRunAssistants(messages, messageStartIndex, runStartedAt)
      const lastAssistant = runAssistants[runAssistants.length - 1] ?? null

      if (!lastAssistant) {
        this.logger.warn(
          `[Agent Manager] No assistant message for this run on ${runtime.id}: ` +
            `messages=${messages.length}, startIndex=${messageStartIndex}, startedAt=${runStartedAt}`
        )
        return { success: false, error: 'Agent did not produce a response.', edits }
      }

      const usage = aggregateTurnUsage(runAssistants)

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

      // 输出撞上限：如实报错（`success:false` + `errorCode`），不冒充成功
      if (lastAssistant.stopReason === 'length') {
        const limit = this.outputLimit(runtime)
        const output = usage?.output ?? 0
        const reasoning = usage?.reasoning ?? 0
        const body = Math.max(0, output - reasoning)
        const detail = assistantResponse
          ? `Output truncated: reasoning ${reasoning} + text ${body} of ${limit} tokens. Raise the output limit in Settings and retry.`
          : `No reply body: reasoning used the whole ${limit}-token output limit. Raise the output limit in Settings and retry.`
        this.logger.warn(
          `[Agent Manager] Output truncated on ${runtime.id}: limit=${limit} output=${output} reasoning=${reasoning} hasText=${assistantResponse.length > 0}`
        )
        // 不写 runtime.messageHistory：空壳或残缺回复进入历史会污染下一轮请求
        return { success: false, error: detail, edits, usage, errorCode: 'output-truncated', outputLimit: limit }
      }

      if (!assistantResponse) {
        this.logger.warn(
          `[Agent Manager] Empty assistant response on ${runtime.id}: stopReason=${lastAssistant.stopReason} output=${usage?.output ?? 0}`
        )
        return {
          success: false,
          error: 'No reply body: the model returned only thinking or tool calls.',
          edits,
          usage,
          errorCode: 'empty-response',
          outputLimit: this.outputLimit(runtime),
        }
      }

      runtime.messageHistory.push({
        role: 'assistant',
        content: assistantResponse,
        timestamp: Date.now(),
      })
      runtime.updatedAt = Date.now()

      // 未落盘的临时标题在会话首次落盘后写入（手动重命名，确定后不再自动改写）
      if (runtime.pendingTitle && runtime.sessionManager.isPersisted()) {
        const pendingTitle = runtime.pendingTitle
        runtime.pendingTitle = null
        try {
          runtime.sessionManager.appendSessionInfo(pendingTitle)
          this.settleSessionTitle(runtime, pendingTitle)
        } catch (error) {
          runtime.pendingTitle = pendingTitle
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
        runtime.turnTrace = null
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
    const preservedSinks = [...runtime.traceSinks]
    await this.disposeRuntime(runtime, { skipAbort: true })
    const config = this.config
    if (!config || this.disposed || this.deletedSessions.has(id)) return

    try {
      const next = await this.trackRuntimeCreation(id, async () => {
        const file = await this.findSessionFile(id, root)
        const manager = file
          ? SessionManager.open(file, this.sessionDir, root)
          : SessionManager.create(root, this.sessionDir, { id })
        return await this.createRuntime(manager)
      })
      for (const sink of preservedSinks) next.traceSinks.add(sink)
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

  /** 纯图片消息的模型输入文本：仅 Anthropic Messages 需要非空 text 块（优先读会话当前模型） */
  private withImagePlaceholder(
    text: string,
    imageCount: number,
    runtime?: SessionRuntime
  ): string {
    if (imageCount === 0 || text.trim()) return text
    if (this.resolveSessionModel(runtime)?.api !== 'anthropic-messages') return text
    return this.config?.getLanguage?.() === 'en' ? IMAGE_ONLY_PROMPTS[1] : IMAGE_ONLY_PROMPTS[0]
  }

  private maybeGenerateTitle(runtime: SessionRuntime): Promise<void> {
    return this.titleService.maybeGenerateTitle(runtime)
  }

  private settleSessionTitle(runtime: SessionRuntime, title: string): void {
    this.titleService.settleSessionTitle(runtime, title)
  }

  /**
   * 复用当前已初始化的模型与凭证做一次轻量辅助请求（云端记忆抽取 / 梦境整理用）。
   * 走 SDK 原生 `completeSimple`，绝不另起请求层或碰明文 Key；失败返回 null。
   */
  async completeAuxiliaryPrompt(
    systemPrompt: string,
    userPrompt: string,
    options?: { maxTokens?: number; timeoutMs?: number }
  ): Promise<string | null> {
    const runtime = this.modelRuntime
    const config = this.config
    if (!runtime || !config) return null
    const model =
      this.resolveActiveModel() ??
      runtime.getModel(
        config.apiConfig.providerId as never,
        config.apiConfig.modelId as never
      )
    if (!model) return null
    const controller = new AbortController()
    const timeoutMs = options?.timeoutMs ?? 20_000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const response = await runtime.completeSimple(
        model,
        {
          systemPrompt,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: userPrompt }],
              timestamp: Date.now(),
            } as never,
          ],
        },
        {
          maxTokens: options?.maxTokens ?? 1024,
          temperature: 0.2,
          signal: controller.signal,
        }
      )
      const text = (response.content ?? [])
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('')
        .trim()
      return text || null
    } catch (error) {
      this.logger.warn('[Agent Manager] Auxiliary prompt failed:', error)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 清理所有会话与共享资源
   */
  async dispose() {
    this.disposed = true
    const inflight = [
      ...this.creatingRuntimes.values(),
      ...this.rebindingPromises.values(),
    ]
    if (inflight.length > 0) {
      await Promise.allSettled(inflight)
    }
    await this.disposeAllRuntimes()
    this.titleService.clear()
    this.catalogService.resetSnapshot()
    this.creatingRuntimes.clear()
    this.rebindingPromises.clear()
    this.rebinding.clear()
    this.deletedSessions.clear()
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
