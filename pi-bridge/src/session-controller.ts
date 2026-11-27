/**
 * 单会话控制器（SessionController）：管理单个会话的完整生命周期、显式轮次状态机、
 * 空闲看门狗、工具审批与权限模式、结构化计划、分支切换、轮次边界工作树切换调度、
 * prompt / steer / rewind / compaction 执行以及 SDK 事件订阅。
 */

import {
  createAgentSession,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionFactory,
  type ModelRuntime,
  type SessionEntry,
  type SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { Api, Model, ThinkingLevel } from '@earendil-works/pi-ai'
import { existsSync } from 'fs'
import { IMAGE_ONLY_PROMPTS } from './agent-projections.js'
import {
  ABORT_GRACE_MS,
  ABORT_TIMEOUT_MS,
  APPROVAL_TIMEOUT_MS,
  EXTRAS_SAVE_TIMEOUT_MS,
  INIT_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  aggregateTurnUsage,
  collectRunAssistants,
  sanitizeAgentShellEnv,
  stallErrorMessage,
  thinkingLevelsOf,
  type SessionRuntime,
} from './agent-runtime-types.js'
import {
  resolveCompactionEntry as resolveBranchCompactionEntry,
  subscribeSessionEvents,
} from './agent-session-events.js'
import { createApprovalExtension } from './approval-extension.js'
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
import { withTimeout, withTimeoutResult } from './async-utils.js'
import { createCompactHookExtension } from './compact-hook-extension.js'
import { validateChatImages } from './images.js'
import { createMcpExtension } from './mcp-extension.js'
import type { McpClientHost } from './mcp-host.js'
import { computeCompactionThresholds } from './model-config.js'
import { type StructuredPlan } from './plan.js'
import { createPlanExtension } from './plan-extension.js'
import { createReadWithDocumentsDefinition } from './read-with-documents.js'
import {
  buildBranchGroups,
  deepestLeaf,
  isAncestorOrSelf,
  sessionTreeNodes,
} from './session-branch.js'
import { type SessionExtras, type SessionExtrasLoadResult } from './session-extras.js'
import { StallWatchdog } from './stall-watchdog.js'
import {
  CONTEXT_BLOCK_END,
  CONTEXT_BLOCK_START,
  messageText as toMessageText,
  parseContextBlock,
  stripContextBlock,
  wrapPlanPrompt,
} from './text-utils.js'
import { resolveModeTools } from './tool-policy.js'
import type {
  AgentChatOptions,
  AgentChatResult,
  AgentConfig,
  AgentLogger,
  AgentMessage,
  AgentTraceEvent,
  ConversationBranchGroup,
  MessageContext,
  PromptTemplateInfo,
  SessionSummary,
  SkillInfo,
} from './types.js'
import { createWorktreeExtension } from './worktree-extension.js'

/** 显式单会话轮次状态机 */
export type SessionTurnState = 'idle' | 'running' | 'aborting' | 'disposed'

export interface PendingRootSwitch {
  root: string
  branch?: string
}

export interface SessionControllerDeps {
  getConfig: () => AgentConfig | null
  getLogger: () => AgentLogger
  saveExtras: (sessionId: string, extras: SessionExtras) => Promise<void>
  resolveSessionModel: (runtime?: SessionRuntime) => Model<Api> | undefined
  outputLimit: (runtime?: SessionRuntime) => number
  getSummaryTitle: (runtime: SessionRuntime) => string
  settleSessionTitle: (runtime: SessionRuntime, title: string) => void
  maybeGenerateTitle: (runtime: SessionRuntime) => Promise<void>
  deriveMessages: (runtime: SessionRuntime) => AgentMessage[]
  timelineMessages: (sessionManager: SessionManager) => any[]
  isCurrentController?: (controller: SessionController) => boolean
  onPendingRootReady?: (controller: SessionController) => void
  onAgentSettled?: (sessionId: string) => void
  onHardStop?: (controller: SessionController) => Promise<void>
  getMcpHost?: () => McpClientHost | null
}

export interface BuildExtensionFactoriesInput {
  id: string
  config: AgentConfig
  logger: AgentLogger
  sessionManager: SessionManager
  planContext: { runtime: SessionRuntime | null }
  controllerRef: { current: SessionController | null }
  fallbackPermission: SessionPermission
  mcpHost?: McpClientHost | null
  onWorktreeSwitch: (
    target: string,
    base?: string
  ) => Promise<{
    success: boolean
    root?: string
    branch?: string
    sharedWith?: number
    error?: string
  }>
}

/**
 * 装配会话的扩展工厂（G1）。
 *
 * 三个内置扩展可按 `builtinExtensions` 剔除：工单会话必须去掉 worktree，
 * 因为它把实例级 `workspaceDir` 写死成了 coordinator 的目标仓库。
 * 压缩钩子扩展始终注入——它是内核供给，不是可选开关。外部工厂最后追加，
 * 这样宿主守卫能看到内置扩展之后的注册表。
 */
export function buildSessionExtensionFactories(
  input: BuildExtensionFactoriesInput
): ExtensionFactory[] {
  const { id, config, logger, sessionManager, planContext, controllerRef, fallbackPermission } =
    input
  const toggles = config.builtinExtensions ?? {}
  const factories: ExtensionFactory[] = []

  if (toggles.approval !== false) {
    factories.push(
      createApprovalExtension(
        {
          // 必须传主工作区根路径而非链接工作树路径：渲染层按主工作区路径路由审批卡与取消审批
          workspaceDir: config.workspaceDir,
          logger,
          requestApproval: (request) =>
            controllerRef.current
              ? controllerRef.current.requestToolApproval(request)
              : Promise.resolve({
                  action: 'deny',
                  reason: 'No approval channel is available in this environment.',
                }),
          isSwitchPending: () => controllerRef.current?.hasPendingRoot() ?? false,
          isReadOnlyTool: input.mcpHost
            ? (name) => input.mcpHost?.isReadOnlyTool(name) ?? false
            : undefined,
        },
        id,
        () =>
          controllerRef.current
            ? normalizeSessionPermission(controllerRef.current.runtime.extras.permission)
            : fallbackPermission,
        (category) => {
          const controller = controllerRef.current
          if (!controller) return
          const current = normalizeSessionPermission(controller.runtime.extras.permission)
          if (current.mode !== 'ask' || current.grants.includes(category)) return
          controller.runtime.extras.permission = {
            mode: current.mode,
            grants: [...current.grants, category],
          }
          controller.persistExtras()
          return controller.runtime.extrasSave
        }
      )
    )
  }

  if (toggles.plan !== false) {
    factories.push(
      createPlanExtension({
        getRuntime: () => planContext.runtime,
        persistExtras: () => {
          controllerRef.current?.persistExtras()
        },
        getMode: () =>
          normalizeSessionPermission(
            controllerRef.current?.runtime.extras.permission ?? fallbackPermission
          ).mode,
      })
    )
  }

  if (toggles.worktree !== false) {
    factories.push(
      createWorktreeExtension({
        sessionId: id,
        workspaceDir: config.workspaceDir,
        getRoot: () => sessionManager.getCwd() || config.workspaceDir,
        onSwitch: (target, base) => input.onWorktreeSwitch(target, base),
        scheduleRoot: (nextRoot, branch) => {
          controllerRef.current?.schedulePendingRoot(nextRoot, branch)
        },
      })
    )
  }

  factories.push(
    createCompactHookExtension({
      logger,
      onBeforeCompact: (event) => {
        const handler = config.onSessionBeforeCompact
        if (!handler) return
        try {
          handler(id, event)
        } catch (error) {
          logger.warn('[Agent Manager] onSessionBeforeCompact failed:', error)
        }
      },
    })
  )

  if (input.mcpHost && input.mcpHost.getTools().length > 0) {
    factories.push(createMcpExtension(input.mcpHost))
  }

  for (const factory of config.extensionFactories ?? []) factories.push(factory)
  return factories
}

export interface CreateSessionControllerOptions {
  config: AgentConfig
  agentDir: string
  modelRuntime: ModelRuntime
  model: Model<Api>
  sessionManager: SessionManager
  logger: AgentLogger
  mcpHost?: McpClientHost | null
  loadExtras: (sessionId: string) => Promise<SessionExtrasLoadResult>
  takeSeedPermission: (sessionId: string) => SessionPermission | undefined
  onTitleRestored: (sessionId: string, title: string) => void
  getLastWebAccessVersion: () => string | null
  setLastWebAccessVersion: (version: string) => void
  isCancelled: () => string | null
  onWorktreeSwitch: (
    sessionId: string,
    target: string,
    base?: string
  ) => Promise<{
    success: boolean
    root?: string
    branch?: string
    sharedWith?: number
    error?: string
  }>
  controllerDeps: SessionControllerDeps
}

/** 创建并装配一个完整的单会话控制器（含扩展装载、自定义工具与事件订阅） */
export async function createSessionController(
  options: CreateSessionControllerOptions
): Promise<SessionController> {
  const { config, agentDir, modelRuntime, model, sessionManager, logger } = options
  const id = sessionManager.getSessionId()
  const planContext: { runtime: SessionRuntime | null } = { runtime: null }
  const controllerRef: { current: SessionController | null } = { current: null }

  const loadedExtras = await options.loadExtras(id)
  const extras = loadedExtras.extras
  // 模式只在会话诞生时从全局默认档取一次，此后会话自行持有并落盘。
  // 若既有 sidecar 损坏导致权限丢失，fail-closed 降级到 readonly，绝不静默提权。
  const seededPermission = extras.permission === null
  if (seededPermission) {
    const seed = options.takeSeedPermission(id)
    const rawDefault = config.getDefaultPermissionLevel?.()
    const defaultLevel: PermissionLevel = isPermissionLevel(rawDefault)
      ? rawDefault
      : DEFAULT_PERMISSION_LEVEL
    extras.permission =
      seed ??
      (loadedExtras.corrupted
        ? { mode: 'readonly', grants: [] }
        : { mode: defaultLevel, grants: [] })
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
    options.onTitleRestored(id, recordedTitle)
    if (extras.title !== recordedTitle) {
      extras.title = recordedTitle
      titleBackfilled = true
    }
  } else if (extras.title) {
    // 记录里丢了标题（分支裁剪 / 迁移 / 旧版本）：标题已确定，绝不重新生成
    options.onTitleRestored(id, extras.title)
    if (persistedOnDisk) {
      try {
        sessionManager.appendSessionInfo(extras.title)
      } catch (error) {
        logger.warn('[Agent Manager] Failed to restore the session title:', error)
      }
    } else {
      restoredPendingTitle = extras.title
    }
  }

  // 禁止自动信任工作区内的 .pi/settings.json 与 .pi/extensions/*（防打开任意仓库即触发主进程 RCE）；
  // 应用内置扩展一律通过 additionalExtensionPaths 与 extensionFactories 显式白名单注入。
  const settingsManager = SettingsManager.create(config.workspaceDir, agentDir, {
    projectTrusted: false,
  })
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: config.webAccessExtensionPaths?.length
      ? config.webAccessExtensionPaths
      : undefined,
    extensionFactories: buildSessionExtensionFactories({
      id,
      config,
      logger,
      sessionManager,
      planContext,
      controllerRef,
      fallbackPermission,
      mcpHost: options.mcpHost,
      onWorktreeSwitch: (target, base) => options.onWorktreeSwitch(id, target, base),
    }),
  })
  await resourceLoader.reload()

  // Pi 按 cwd 缓存扩展工厂；联网配置变化后需要再 reload 一次才会重新读取扩展配置
  const webAccessVersion = config.getWebAccessConfigVersion?.() ?? ''
  const previousWebAccessVersion = options.getLastWebAccessVersion()
  if (
    webAccessVersion &&
    previousWebAccessVersion !== null &&
    previousWebAccessVersion !== webAccessVersion
  ) {
    await resourceLoader.reload()
  }
  if (webAccessVersion) options.setLastWebAccessVersion(webAccessVersion)

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
    createBashToolDefinition(root, {
      spawnHook: sanitizeShellSpawn,
    }) as unknown as ToolDefinition<any, any>,
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
    agentDir,
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
    logger
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
        logger.warn(
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
    onTrace: () => {},
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
  const cancelledReason = options.isCancelled()
  if (cancelledReason) {
    try {
      runtime.session.dispose()
    } catch {
      // ignore
    }
    throw new Error(cancelledReason)
  }

  const controller = new SessionController(runtime, options.controllerDeps)
  planContext.runtime = runtime
  controllerRef.current = controller
  controller.applyModeTools(fallbackPermission.mode)
  if (seededPermission || titleBackfilled) controller.persistExtras()
  return controller
}

export class SessionController {
  readonly id: string
  private turnState: SessionTurnState = 'idle'
  private pendingRoot: PendingRootSwitch | null = null

  constructor(
    readonly runtime: SessionRuntime,
    private readonly deps: SessionControllerDeps
  ) {
    this.id = runtime.id
    this.runtime.onTrace = (event) => this.dispatchTrace(event)
    this.runtime.unsubscribe = subscribeSessionEvents(this.runtime, {
      getLogger: () => this.deps.getLogger(),
      getWorkspaceDir: () => this.deps.getConfig()?.workspaceDir,
      persistExtras: () => this.persistExtras(),
      onAgentSettled: (target) => {
        if (this.turnState !== 'disposed' && !this.isSdkOrTurnActive()) {
          this.turnState = 'idle'
        }
        // 在事件回调外重建，避免销毁正在分发事件的会话
        setTimeout(() => {
          this.deps.onPendingRootReady?.(this)
        }, 0)
        try {
          this.deps.onAgentSettled?.(target.id)
        } catch (error) {
          this.deps.getLogger().warn('[Agent Manager] onAgentSettled failed:', error)
        }
      },
    })
  }

  private isSdkOrTurnActive(): boolean {
    return Boolean(
      this.runtime.isProcessing ||
        this.runtime.sdkStreaming ||
        this.runtime.compactingPromise ||
        (this.runtime.session as any)?.isStreaming
    )
  }

  private isStillCurrent(): boolean {
    if (this.turnState === 'disposed') return false
    return this.deps.isCurrentController ? this.deps.isCurrentController(this) : true
  }

  /** 当前显式轮次状态机状态 */
  getTurnState(): SessionTurnState {
    if (this.turnState === 'disposed') return 'disposed'
    if (this.turnState === 'aborting') return 'aborting'
    if (this.isSdkOrTurnActive()) return 'running'
    return this.turnState
  }

  isBusy(): boolean {
    const state = this.getTurnState()
    return state === 'running' || state === 'aborting'
  }

  isDisposed(): boolean {
    return this.turnState === 'disposed'
  }

  /** 串行保存会话附加数据，避免并发覆盖 */
  persistExtras(): void {
    const id = this.id
    const extras = this.runtime.extras
    this.runtime.extrasSave = this.runtime.extrasSave
      .catch(() => undefined)
      .then(() => this.deps.saveExtras(id, extras))
      .catch((error) => {
        this.deps.getLogger().warn('[Agent Manager] Failed to save session extras:', error)
      })
  }

  /**
   * trace 统一分发：逐轮回调（chat 期间）+ 常驻订阅（事件唤醒的轮次）。
   * 任何一个 sink 抛错都不能掀掉本轮，因此逐个 try/catch。
   */
  dispatchTrace(event: AgentTraceEvent): void {
    const turn = this.runtime.turnTrace
    if (turn) {
      try {
        turn(event)
      } catch (error) {
        this.deps.getLogger().warn('[Agent Manager] Trace handler failed:', error)
      }
    }
    for (const sink of this.runtime.traceSinks) {
      try {
        sink(event)
      } catch (error) {
        this.deps.getLogger().warn('[Agent Manager] Trace subscriber failed:', error)
      }
    }
  }

  subscribeTrace(sink: (event: AgentTraceEvent) => void): () => void {
    this.runtime.traceSinks.add(sink)
    return () => {
      this.runtime.traceSinks.delete(sink)
    }
  }

  /** 按会话模式切换可用工具集；模式是唯一事实源，不依赖会话历史 */
  applyModeTools(mode: SessionMode): void {
    try {
      const config = this.deps.getConfig()
      const mcpHost = this.deps.getMcpHost?.() ?? null
      const hasMcpTools = (mcpHost?.getTools().length ?? 0) > 0
      this.runtime.session.setActiveToolsByName(
        resolveModeTools(
          mode,
          this.runtime.registeredTools,
          process.platform,
          config?.toolAllowlist,
          {
            isReadOnlyTool: mcpHost ? (name) => mcpHost.isReadOnlyTool(name) : undefined,
            allowMcpTools: config?.allowMcpTools ?? hasMcpTools,
          }
        )
      )
    } catch (error) {
      this.deps.getLogger().warn('[Agent Manager] Failed to apply session mode tools:', error)
    }
  }

  /** 向宿主请求审批；没有审批通道或超时都按拒绝处理（fail-closed） */
  async requestToolApproval(request: ApprovalRequestPayload): Promise<ApprovalDecision> {
    const handler = this.deps.getConfig()?.requestApproval
    if (!handler) {
      return { action: 'deny', reason: 'No approval channel is available in this environment.' }
    }
    // 审批是 tool_call 钩子，先于 tool_execution_start；这段静默由审批自己的 120s 上限兜底
    const watchdog = this.runtime.watchdog
    watchdog?.beginApproval()
    try {
      return await withTimeout(handler(request), APPROVAL_TIMEOUT_MS, 'Tool approval')
    } catch (error) {
      this.deps.getLogger().warn('[Agent Manager] Approval failed or timed out:', error)
      return { action: 'deny', reason: 'The approval request timed out.' }
    } finally {
      watchdog?.endApproval()
    }
  }

  // ---------------------------------------------------------------------------
  // 轮次边界工作树切换调度
  // ---------------------------------------------------------------------------

  schedulePendingRoot(root: string, branch?: string): void {
    this.pendingRoot = { root, branch }
  }

  hasPendingRoot(): boolean {
    return this.pendingRoot !== null
  }

  peekPendingRoot(): PendingRootSwitch | null {
    return this.pendingRoot
  }

  consumePendingRoot(): PendingRootSwitch | null {
    const next = this.pendingRoot
    this.pendingRoot = null
    return next
  }

  clearPendingRoot(): void {
    this.pendingRoot = null
  }

  // ---------------------------------------------------------------------------
  // 对话、插话、事件消息与中止
  // ---------------------------------------------------------------------------

  /** 纯图片消息的模型输入文本：仅 Anthropic Messages 需要非空 text 块（优先读会话当前模型） */
  private withImagePlaceholder(text: string, imageCount: number): string {
    if (imageCount === 0 || text.trim()) return text
    if (this.deps.resolveSessionModel(this.runtime)?.api !== 'anthropic-messages') return text
    return this.deps.getConfig()?.getLanguage?.() === 'en'
      ? IMAGE_ONLY_PROMPTS[1]
      : IMAGE_ONLY_PROMPTS[0]
  }

  async chat(message: string, options?: AgentChatOptions): Promise<AgentChatResult> {
    const imageCheck = validateChatImages(options?.images)
    if (imageCheck.error) {
      return { success: false, error: imageCheck.error }
    }
    const chatImages = imageCheck.images

    if (this.turnState === 'disposed') {
      return { success: false, error: 'Agent request was aborted.' }
    }
    if (
      this.runtime.isProcessing ||
      this.runtime.sdkStreaming ||
      this.turnState === 'running' ||
      this.turnState === 'aborting' ||
      (this.runtime.session as any)?.isStreaming
    ) {
      return {
        success: false,
        error: 'This session is currently processing another request.',
      }
    }

    // 同步置位，避免 dispose 在首个 await 间隙漏掉正在启动的请求
    this.turnState = 'running'
    this.runtime.isProcessing = true

    const logger = this.deps.getLogger()
    let stalled = false
    let hardStopped = false
    let hardStopTimer: NodeJS.Timeout | null = null
    let rejectHardStop: ((error: Error) => void) | null = null
    const hardStopPromise = new Promise<never>((_resolve, reject) => {
      rejectHardStop = reject
    })

    try {
      // 若手动压缩正在进行，必须先等待压缩完成；压缩失败时一并终止本轮（不写入会话历史）
      if (this.runtime.compactingPromise) {
        const compactOutcome = await this.runtime.compactingPromise
        if (!this.isStillCurrent()) {
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

      this.runtime.onTextDelta = options?.onTextDelta ?? null
      this.runtime.turnTrace = options?.onTrace ?? null
      this.runtime.pendingEdits = []
      this.runtime.editSnapshots.clear()
      // 只认本轮新增的 assistant 消息，避免请求失败时把上一轮回复当成本轮结果
      const messageStartIndex = this.runtime.session.messages.length
      // 压缩会重建 messages 数组使下标失效，同时用本轮开始时间兜底
      const runStartedAt = Date.now()
      logger.info(
        `[Agent Manager] Sending message to session ${this.id}:`,
        message.substring(0, 100)
      )

      this.runtime.messageHistory.push({
        role: 'user',
        content: message,
        timestamp: Date.now(),
      })

      // 工作树上下文放进用户消息前的隐藏上下文块；恢复历史时由 stripContextBlock 剥离
      let worktreeBlock = ''
      const contextProvider = this.deps.getConfig()?.getWorktreeContext
      if (contextProvider) {
        try {
          const worktreeContext = await contextProvider(this.id)
          if (worktreeContext && worktreeContext.trim()) {
            worktreeBlock = `${CONTEXT_BLOCK_START}\n${worktreeContext.trim()}\n${CONTEXT_BLOCK_END}`
          }
        } catch (error) {
          logger.warn('[Agent Manager] Failed to build worktree context:', error)
        }
        if (!this.isStillCurrent()) {
          this.runtime.isProcessing = false
          return { success: false, error: 'Agent request was aborted.' }
        }
      }

      // 发送用户消息并等待 Agent 完成；超时先 abort，宽限期后仍未结束则强制收尾
      const session = this.runtime.session
      const planBefore = this.runtime.extras.plan?.id ?? null
      const promptText =
        normalizeSessionPermission(this.runtime.extras.permission).mode === 'plan'
          ? wrapPlanPrompt(message)
          : message
      const imagePromptText = this.withImagePlaceholder(promptText, chatImages.length)
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
        logger,
        onStall: (idleMs) => {
          stalled = true
          if (this.turnState === 'running') this.turnState = 'aborting'
          logger.warn(
            `[Agent Manager] No model output for ${Math.round(idleMs / 1000)}s; aborting session ${this.id}`
          )
          void session.abort().catch((error) => {
            logger.warn('[Agent Manager] Failed to abort stalled request:', error)
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
      this.runtime.watchdog = watchdog
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
      const edits = this.runtime.pendingEdits.splice(0)

      if (stalled) {
        return { success: false, error: stallErrorMessage(), edits }
      }

      const messages = this.runtime.session.messages
      // 只认本轮新增的 assistant 消息；同时聚合多步工具调用的 usage，避免只计最后一步漏算前序 token/费用
      const runAssistants = collectRunAssistants(messages, messageStartIndex, runStartedAt)
      const lastAssistant = runAssistants[runAssistants.length - 1] ?? null

      if (!lastAssistant) {
        logger.warn(
          `[Agent Manager] No assistant message for this run on ${this.id}: ` +
            `messages=${messages.length}, startIndex=${messageStartIndex}, startedAt=${runStartedAt}`
        )
        return { success: false, error: 'Agent did not produce a response.', edits }
      }

      const usage = aggregateTurnUsage(runAssistants)

      if (lastAssistant.stopReason === 'error') {
        const detail = lastAssistant.errorMessage || 'Agent request failed'
        logger.error('[Agent Manager] Provider error:', detail)
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
        const limit = this.deps.outputLimit(this.runtime)
        const output = usage?.output ?? 0
        const reasoning = usage?.reasoning ?? 0
        const body = Math.max(0, output - reasoning)
        const detail = assistantResponse
          ? `Output truncated: reasoning ${reasoning} + text ${body} of ${limit} tokens. Raise the output limit in Settings and retry.`
          : `No reply body: reasoning used the whole ${limit}-token output limit. Raise the output limit in Settings and retry.`
        logger.warn(
          `[Agent Manager] Output truncated on ${this.id}: limit=${limit} output=${output} reasoning=${reasoning} hasText=${assistantResponse.length > 0}`
        )
        // 不写 runtime.messageHistory：空壳或残缺回复进入历史会污染下一轮请求
        return {
          success: false,
          error: detail,
          edits,
          usage,
          errorCode: 'output-truncated',
          outputLimit: limit,
        }
      }

      if (!assistantResponse) {
        logger.warn(
          `[Agent Manager] Empty assistant response on ${this.id}: stopReason=${lastAssistant.stopReason} output=${usage?.output ?? 0}`
        )
        return {
          success: false,
          error: 'No reply body: the model returned only thinking or tool calls.',
          edits,
          usage,
          errorCode: 'empty-response',
          outputLimit: this.deps.outputLimit(this.runtime),
        }
      }

      this.runtime.messageHistory.push({
        role: 'assistant',
        content: assistantResponse,
        timestamp: Date.now(),
      })
      this.runtime.updatedAt = Date.now()

      // 未落盘的临时标题在会话首次落盘后写入（手动重命名，确定后不再自动改写）
      if (this.runtime.pendingTitle && this.runtime.sessionManager.isPersisted()) {
        const pendingTitle = this.runtime.pendingTitle
        this.runtime.pendingTitle = null
        try {
          this.runtime.sessionManager.appendSessionInfo(pendingTitle)
          this.deps.settleSessionTitle(this.runtime, pendingTitle)
        } catch (error) {
          this.runtime.pendingTitle = pendingTitle
          logger.warn('[Agent Manager] Failed to persist pending session title:', error)
        }
      }

      // 第一轮成功后异步生成标题，不阻塞聊天
      void this.deps.maybeGenerateTitle(this.runtime)

      logger.info('[Agent Manager] Agent response received')
      logger.info('[Agent Manager] Response preview:', assistantResponse.substring(0, 200))
      if (edits.length > 0) {
        logger.info('[Agent Manager] Files edited:', edits.map((e) => e.path).join(', '))
      }

      return {
        success: true,
        response: assistantResponse,
        edits,
        usage,
        // 本轮新提交的计划（R-04），保证 trace 丢失时前端也能拿到
        plan:
          this.runtime.extras.plan && this.runtime.extras.plan.id !== planBefore
            ? this.runtime.extras.plan
            : undefined,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (stalled) {
        logger.error('[Agent Manager] Response stalled:', errorMessage)
        const edits = this.runtime.pendingEdits.splice(0)
        if (hardStopped) {
          await this.deps.onHardStop?.(this)
        }
        return { success: false, error: stallErrorMessage(), edits }
      }
      logger.error('[Agent Manager] Chat error:', errorMessage)
      logger.error('[Agent Manager] Stack:', error instanceof Error ? error.stack : '')

      return {
        success: false,
        error: `Agent error: ${errorMessage}`,
        edits: this.runtime.pendingEdits.splice(0),
      }
    } finally {
      if (hardStopTimer) clearTimeout(hardStopTimer)
      this.runtime.watchdog?.stop()
      this.runtime.watchdog = null
      if (this.isStillCurrent()) {
        this.runtime.isProcessing = false
        this.runtime.onTextDelta = null
        this.runtime.turnTrace = null
        this.turnState = this.isSdkOrTurnActive() ? 'running' : 'idle'
      }
    }
  }

  /** 运行中插话：把消息（可带图片、可为纯图片）注入当前轮（steer），不等待本轮结束 */
  async steer(
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<{ success: boolean; error?: string }> {
    if (this.turnState === 'disposed') {
      return { success: false, error: 'Session is disposed.' }
    }
    const text = message.trim()
    const imageCheck = validateChatImages(images)
    if (imageCheck.error) return { success: false, error: imageCheck.error }
    if (!text && imageCheck.images.length === 0) {
      return { success: false, error: 'Message is empty.' }
    }
    try {
      if (this.runtime.compactingPromise) {
        return { success: false, error: 'Context compaction is in progress.' }
      }
      if (
        !this.runtime.isProcessing &&
        !this.runtime.sdkStreaming &&
        !(this.runtime.session as any)?.isStreaming
      ) {
        return { success: false, error: 'Session is not running.' }
      }
      const promptText = this.withImagePlaceholder(text, imageCheck.images.length)
      await this.runtime.session.prompt(promptText, {
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
      this.deps.getLogger().info(`[Agent Manager] Steered session ${this.id}`)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async sendCustomMessage(
    message: {
      customType: string
      content: string | Array<{ type: 'text'; text: string }>
      display?: boolean
      details?: unknown
    },
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }
  ): Promise<{ success: boolean; error?: string }> {
    if (this.turnState === 'disposed') {
      return { success: false, error: 'Session is disposed.' }
    }
    const customType = message.customType.trim()
    if (!customType) return { success: false, error: 'customType is required.' }
    try {
      await this.runtime.session.sendCustomMessage(
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

  /** 中止当前会话运行；运行中进入 `aborting` 状态，结束后收敛回 `idle`（或维持 `disposed`） */
  async abort(): Promise<void> {
    if (this.turnState === 'disposed') return
    const wasRunning = this.getTurnState() === 'running'
    if (wasRunning) this.turnState = 'aborting'
    try {
      await withTimeout(this.runtime.session.abort(), ABORT_TIMEOUT_MS, 'Agent abort')
    } catch (error) {
      this.deps.getLogger().warn('[Agent Manager] Failed to abort request:', error)
    } finally {
      if (this.turnState === 'aborting') {
        this.turnState = this.isSdkOrTurnActive() ? 'running' : 'idle'
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 上下文占用与压缩
  // ---------------------------------------------------------------------------

  getContextUsage(): {
    success: boolean
    usage?: {
      tokens: number | null
      contextWindow: number
      percent: number | null
      autoCompactPercent?: number
    }
    error?: string
  } {
    try {
      const usage = this.runtime.session.getContextUsage()
      let autoCompactPercent: number | undefined
      if (usage && usage.contextWindow > 0) {
        const settingsManager = (
          this.runtime.session as {
            settingsManager?: {
              getCompactionSettings?: (model?: unknown) => {
                enabled?: boolean
                reserveTokens?: number
              }
            }
          }
        ).settingsManager
        const compactionSettings = settingsManager?.getCompactionSettings?.(
          this.runtime.session.model
        )
        if (compactionSettings) {
          if (
            compactionSettings.enabled !== false &&
            typeof compactionSettings.reserveTokens === 'number'
          ) {
            autoCompactPercent = Math.max(
              1,
              Math.min(
                99,
                Math.round(
                  ((usage.contextWindow - compactionSettings.reserveTokens) /
                    usage.contextWindow) *
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
  async compactContext(): Promise<{
    success: boolean
    tokensBefore?: number
    estimatedTokensAfter?: number
    entryId?: string
    timestamp?: number
    error?: string
  }> {
    if (this.turnState === 'disposed') {
      return { success: false, error: 'Session is disposed.' }
    }
    if (this.runtime.compactingPromise) {
      return { success: false, error: 'Context compaction is already in progress.' }
    }
    if (this.isBusy()) {
      return {
        success: false,
        error: 'Session is running; wait for it to finish before compacting.',
      }
    }

    const prevEntryId = this.runtime.lastCompactionEntry?.id ?? this.runtime.lastCompactionEntryId
    const compactPromise = (async () => {
      try {
        const result = await this.runtime.session.compact()
        resolveBranchCompactionEntry(this.runtime, this.deps.getLogger())
        const latestEntry =
          this.runtime.lastCompactionEntry && this.runtime.lastCompactionEntry.id !== prevEntryId
            ? this.runtime.lastCompactionEntry
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

    this.runtime.compactingPromise = compactPromise
    try {
      return await compactPromise
    } finally {
      if (this.runtime.compactingPromise === compactPromise) {
        this.runtime.compactingPromise = null
      }
      if (this.hasPendingRoot() && !this.isBusy() && !this.isDisposed()) {
        setTimeout(() => {
          this.deps.onPendingRootReady?.(this)
        }, 0)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 回退 / 分支切换 / 计划模式 / 会话设置与统计
  // ---------------------------------------------------------------------------

  async rewindToLastUser(
    newText?: string
  ): Promise<{ success: boolean; text?: string; context?: MessageContext; error?: string }> {
    try {
      if (this.isBusy()) {
        return { success: false, error: 'Session is running; stop it before retrying.' }
      }
      const branch = this.runtime.sessionManager.getBranch()
      let last: SessionEntry | undefined
      for (const entry of branch) {
        if (entry.type === 'message' && entry.message.role === 'user') last = entry
      }
      if (!last || last.type !== 'message') {
        return { success: false, error: 'No user message to retry.' }
      }
      const raw = toMessageText(last.message)
      const result = await this.runtime.session.navigateTree(last.id, { summarize: false })
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

  listBranches(): { success: boolean; groups?: ConversationBranchGroup[]; error?: string } {
    try {
      return { success: true, groups: buildBranchGroups(this.runtime.sessionManager) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async switchBranch(
    entryId: string
  ): Promise<{ success: boolean; history?: AgentMessage[]; error?: string }> {
    try {
      if (this.isBusy()) {
        return { success: false, error: 'Session is running; stop it before switching branches.' }
      }
      const manager = this.runtime.sessionManager
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
        (child) => child.entry.type === 'message' && child.entry.message.role === 'assistant'
      )
      if (!siblings.some((child) => child.entry.id === entryId)) {
        return { success: false, error: 'Branch entry not found.' }
      }

      const branchIds = new Set(manager.getBranch().map((entry) => entry.id))
      const activeSibling = siblings.find((child) => branchIds.has(child.entry.id))
      const currentLeaf = manager.getLeafId()
      if (activeSibling && currentLeaf) {
        this.runtime.extras.branchLeaves[activeSibling.entry.id] = currentLeaf
      }

      const remembered = this.runtime.extras.branchLeaves[entryId]
      const targetLeaf =
        remembered && isAncestorOrSelf(manager, entryId, remembered)
          ? remembered
          : deepestLeaf(nodes.get(entryId))
      if (!targetLeaf) return { success: false, error: 'Branch entry not found.' }

      const result = await this.runtime.session.navigateTree(targetLeaf)
      if (result.cancelled) {
        return { success: false, error: 'Branch switch was cancelled.' }
      }
      this.persistExtras()
      return { success: true, history: this.getMessages() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  getPlan(): { success: boolean; plan?: StructuredPlan | null; error?: string } {
    return { success: true, plan: this.runtime.extras.plan }
  }

  async approvePlan(
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
      if (this.isBusy()) {
        return { success: false, error: 'Session is running; stop it before approving the plan.' }
      }
      const plan = this.runtime.extras.plan
      if (!plan || plan.id !== planId) return { success: false, error: 'Plan not found.' }
      if (plan.status !== 'proposed') {
        return { success: false, error: 'This plan is no longer awaiting approval.' }
      }
      plan.status = 'approved'
      const first = plan.steps.find((step) => step.status === 'pending')
      if (first) first.status = 'in_progress'
      plan.updatedAt = Date.now()

      const permission: SessionPermission = { mode: targetMode, grants: [] }
      this.runtime.extras.permission = permission
      this.applyModeTools(targetMode)
      this.persistExtras()
      await this.runtime.extrasSave
      return { success: true, plan, permission }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async rejectPlan(
    planId: string
  ): Promise<{ success: boolean; plan?: StructuredPlan; error?: string }> {
    try {
      if (this.isBusy()) {
        return { success: false, error: 'Session is running; stop it before rejecting the plan.' }
      }
      const plan = this.runtime.extras.plan
      if (!plan || plan.id !== planId) return { success: false, error: 'Plan not found.' }
      if (plan.status !== 'proposed') {
        return { success: false, error: 'This plan is no longer awaiting approval.' }
      }
      plan.status = 'rejected'
      plan.updatedAt = Date.now()
      this.persistExtras()
      await this.runtime.extrasSave
      return { success: true, plan }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  getSessionStats(): {
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
  } {
    try {
      const stats = this.runtime.session.getSessionStats()
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

  getSessionSettings(): {
    success: boolean
    modelId?: string
    thinkingLevel?: string
    permission?: SessionPermission
    error?: string
  } {
    return {
      success: true,
      modelId: this.runtime.session.model?.id,
      thinkingLevel: this.runtime.session.thinkingLevel,
      permission: normalizeSessionPermission(this.runtime.extras.permission),
    }
  }

  async setSessionPermission(
    permission: unknown
  ): Promise<{ success: boolean; permission?: SessionPermission; error?: string }> {
    try {
      const permissionBefore = normalizeSessionPermission(this.runtime.extras.permission)
      const nextPermission = normalizeSessionPermission(permission)
      this.runtime.extras.permission = nextPermission
      if (permissionBefore.mode !== nextPermission.mode) {
        this.applyModeTools(nextPermission.mode)
      }
      this.persistExtras()
      await this.runtime.extrasSave
      this.deps.getLogger().info(
        `[Agent Manager] Session ${this.id} mode -> ${nextPermission.mode}${
          nextPermission.grants.length > 0 ? ` (+${nextPermission.grants.join(',')})` : ''
        }`
      )
      return { success: true, permission: nextPermission }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async setSessionModel(model: Model<Api>): Promise<{ success: boolean; error?: string }> {
    try {
      await this.runtime.session.setModel(model)
      // 换模型后思考档位可能不被支持：自动降级到最高可用档，都没有就关掉（D11）
      const supported = thinkingLevelsOf(model)
      const current = String(this.runtime.session.thinkingLevel ?? '')
      if (current && !supported.includes(current)) {
        const next = (supported[supported.length - 1] ?? 'off') as ThinkingLevel
        try {
          this.runtime.session.setThinkingLevel(next)
        } catch {
          // 极老模型没有思考档位接口：保持关闭即可
        }
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  setSessionThinking(level: string): { success: boolean; error?: string } {
    const allowed = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    if (!allowed.includes(level)) {
      return { success: false, error: `Unknown thinking level "${level}".` }
    }
    try {
      this.runtime.session.setThinkingLevel(level as any)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async listPromptResources(): Promise<{
    success: boolean
    templates?: PromptTemplateInfo[]
    skills?: SkillInfo[]
    error?: string
  }> {
    try {
      if (this.runtime.resourceLoader) {
        try {
          await this.runtime.resourceLoader.reload()
        } catch (error) {
          this.deps.getLogger().warn('[Agent Manager] Failed to reload prompt resources:', error)
        }
      }

      const loaderPrompts = this.runtime.resourceLoader?.getPrompts?.().prompts
      const prompts = loaderPrompts ?? this.runtime.session.promptTemplates ?? []
      const skills = this.runtime.resourceLoader?.getSkills?.().skills ?? []

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

  getMessageHistory(): AgentMessage[] {
    return this.runtime.messageHistory
  }

  getMessages(): AgentMessage[] {
    return this.deps.deriveMessages(this.runtime)
  }

  getSummary(): SessionSummary {
    let messageCount = 0
    for (const msg of this.deps.timelineMessages(this.runtime.sessionManager)) {
      if (msg.role === 'user' || msg.role === 'assistant') messageCount += 1
    }
    return {
      id: this.id,
      title: this.deps.getSummaryTitle(this.runtime).slice(0, 60),
      messageCount,
      createdAt: this.runtime.createdAt,
      updatedAt: this.runtime.updatedAt,
    }
  }

  /** 释放看门狗、按需中止运行、有界等待 sidecar 落盘并销毁底层 AgentSession */
  async dispose(options?: { skipAbort?: boolean }): Promise<void> {
    if (this.turnState === 'disposed') return
    const wasBusy = this.isBusy()
    this.turnState = 'disposed'

    this.runtime.watchdog?.stop()
    this.runtime.watchdog = null
    this.runtime.bgWatchdog?.stop()
    this.runtime.bgWatchdog = null
    this.pendingRoot = null

    const logger = this.deps.getLogger()
    if (!options?.skipAbort && wasBusy) {
      try {
        await withTimeout(this.runtime.session.abort(), ABORT_TIMEOUT_MS, 'Agent abort')
      } catch (error) {
        logger.warn('[Agent Manager] Failed to abort before dispose:', error)
      }
    }
    // 等 sidecar 落盘完成，避免删除会话时与最后一次保存竞争。
    // 但必须有上界：退出时写盘卡住（磁盘慢 / 文件被占用）不能把清理拖进超时兜底。
    await withTimeoutResult(this.runtime.extrasSave, EXTRAS_SAVE_TIMEOUT_MS, 'extras save', logger)
    try {
      this.runtime.unsubscribe?.()
    } catch {
      // ignore
    }
    this.runtime.unsubscribe = null
    try {
      this.runtime.session.dispose()
    } catch (error) {
      logger.warn('[Agent Manager] Failed to dispose session:', error)
    }
  }
}
