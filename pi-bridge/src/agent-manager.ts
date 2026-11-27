/**
 * Agent Manager（工作区级 Agent 运行时宿主）
 *
 * 负责协调工作区级模型运行时（`ModelRuntime` / `AgentCatalogService`）、
 * 会话仓储（`SessionRepository`）、标题服务（`AgentTitleService`）与各活跃会话的
 * `SessionController` 实例（并发创建去重、轮次边界工作树重建与资源回收）。
 */

import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import * as path from 'path'
import { AgentCatalogService, isPiOffline, normalizePiOfflineEnv } from './agent-catalog.js'
import {
  ABORT_GRACE_MS,
  APPROVAL_TIMEOUT_MS,
  INIT_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  consoleAgentLogger,
  effectiveLimits,
  normalizePathForCompare,
  sanitizeAgentShellEnv,
  type SessionRuntime,
} from './agent-runtime-types.js'
import { AgentTitleService } from './agent-title-service.js'
import {
  normalizeSessionPermission,
  type PermissionLevel,
  type SessionMode,
  type SessionPermission,
} from './approval-policy.js'
import { withTimeout } from './async-utils.js'
import { ensureBashOnPath } from './environment.js'
import { validateChatImages } from './images.js'
import { writeCompactionSettings, writeModelsConfig } from './model-config.js'
import {
  type PlanStatus,
  type PlanStep,
  type PlanStepStatus,
  type StructuredPlan,
} from './plan.js'
import { type ModelLimits } from './provider-presets.js'
import {
  SessionController,
  createSessionController,
  type SessionControllerDeps,
} from './session-controller.js'
import { type ExportLanguage } from './session-export.js'
import { SessionExtrasStore } from './session-extras.js'
import { SessionRepository } from './session-repository.js'
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

export type { PlanStep, PlanStepStatus, PlanStatus, StructuredPlan }
export { ABORT_GRACE_MS, APPROVAL_TIMEOUT_MS, STALL_TIMEOUT_MS, sanitizeAgentShellEnv }
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

export class AgentManager {
  private config: AgentConfig | null = null
  private logger: AgentLogger = consoleAgentLogger
  private modelRuntime: ModelRuntime | null = null
  private agentDir = ''
  private extrasStore: SessionExtrasStore | null = null
  private sessionDir = ''
  private controllers = new Map<string, SessionController>()
  /** 与 `controllers` 1:1 同步的底层运行时索引，供标题服务与诊断访问 */
  private runtimes = new Map<string, SessionRuntime>()
  private lastSessionId: string | null = null
  private rebinding = new Set<string>()
  private rebindingPromises = new Map<string, Promise<boolean>>()
  private creatingControllers = new Map<string, Promise<SessionController>>()
  private deletedSessions = new Set<string>()
  private lastWebAccessVersion: string | null = null
  private seedPermissions = new Map<string, SessionPermission>()
  private disposed = false

  private readonly catalogService = new AgentCatalogService({
    getConfig: () => this.config,
    getModelRuntime: () => this.modelRuntime,
    getLogger: () => this.logger,
  })

  private readonly titleService: AgentTitleService = new AgentTitleService({
    getConfig: () => this.config,
    getModelRuntime: () => this.modelRuntime,
    getLogger: () => this.logger,
    getSessionDir: () => this.sessionDir,
    getExtrasStore: () => this.extrasStore,
    getLiveRuntime: (id) => this.runtimes.get(id),
    isDeleted: (id) => this.deletedSessions.has(id),
    findSessionFile: (id): Promise<string | null> => this.repository.findSessionFile(id),
    resolveSessionModel: (runtime) => this.catalogService.resolveSessionModel(runtime),
    persistExtras: (runtime) => {
      this.controllers.get(runtime.id)?.persistExtras()
    },
  })

  private readonly repository: SessionRepository = new SessionRepository({
    getConfig: () => this.config,
    getSessionDir: () => this.sessionDir,
    getExtrasStore: () => this.extrasStore,
    getLogger: () => this.logger,
    getSettledTitle: (id): string | undefined => this.titleService.getSettled(id),
  })

  private controllerDeps(): SessionControllerDeps {
    return {
      getConfig: () => this.config,
      getLogger: () => this.logger,
      saveExtras: (sessionId, extras) => this.repository.saveExtras(sessionId, extras),
      resolveSessionModel: (runtime) => this.catalogService.resolveSessionModel(runtime),
      outputLimit: (runtime) => this.catalogService.outputLimit(runtime),
      getSummaryTitle: (runtime) =>
        this.titleService.sessionTitle(runtime) ?? this.titleService.recordFirstUserText(runtime),
      settleSessionTitle: (runtime, title) => this.titleService.settleSessionTitle(runtime, title),
      maybeGenerateTitle: (runtime) => this.titleService.maybeGenerateTitle(runtime),
      deriveMessages: (runtime) => this.repository.deriveSessionMessages(runtime),
      timelineMessages: (sessionManager) => this.repository.timelineMessages(sessionManager),
      isCurrentController: (controller) => this.controllers.get(controller.id) === controller,
      onPendingRootReady: (controller) => {
        void this.applyPendingRoot(controller)
      },
      onAgentSettled: (sessionId) => {
        this.config?.onAgentSettled?.(sessionId)
      },
      onHardStop: (controller) => this.resetControllerAfterHardStop(controller),
    }
  }

  /** 统一捕获单会话控制器获取与执行异常，返回标准 `{ success, error }` 形态 */
  private async withController<T extends { success: boolean; error?: string }>(
    sessionId: string,
    fn: (controller: SessionController) => T | Promise<T>
  ): Promise<T> {
    try {
      const controller = await this.ensureController(sessionId)
      return await fn(controller)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      } as T
    }
  }

  /** 初始化共享运行时（models.json / ModelRuntime / 环境租约），并打开最近会话 */
  async initialize(config: AgentConfig): Promise<{ success: boolean; error?: string }> {
    let initialized = false
    this.disposed = false
    this.logger = config.logger ?? consoleAgentLogger
    try {
      await this.disposeAllControllers()
      this.lastWebAccessVersion = null
      this.config = config
      const { providerId, modelId, overrides } = config.apiConfig

      this.logger.info('[Agent Manager] Initializing agent...')
      this.logger.info('[Agent Manager] Workspace:', config.workspaceDir)
      this.logger.info('[Agent Manager] Provider:', providerId)
      this.logger.info('[Agent Manager] Model:', modelId)

      this.agentDir = config.agentDir || path.join(config.workspaceDir, '.pi-workbench', 'agent')
      this.extrasStore = new SessionExtrasStore(path.join(this.agentDir, 'session-extras'))
      const modelsPath = await writeModelsConfig(this.agentDir, { providerId, overrides })
      ensureBashOnPath(this.logger)

      this.catalogService.resetSnapshot()
      normalizePiOfflineEnv()
      this.modelRuntime = await withTimeout(
        ModelRuntime.create({
          modelsPath,
          credentials: config.credentials,
          modelsStore: config.modelsStore,
          refreshOnCreate: false,
          allowModelNetwork: false,
        }),
        INIT_TIMEOUT_MS,
        'Agent model runtime'
      )

      if (typeof this.modelRuntime.refresh === 'function') {
        await this.modelRuntime.refresh({ allowNetwork: false, providers: [providerId] })
      }
      await this.catalogService.syncRemoteCatalogSnapshot(providerId)

      const providerModels = this.catalogService
        .catalogModels()
        .map((entry) => ({ id: entry.id, contextWindow: effectiveLimits(entry).contextWindow }))
        .filter((entry) => entry.contextWindow > 0)
      if (providerModels.length > 0) {
        await writeCompactionSettings(this.agentDir, providerId, providerModels)
      }

      const model = this.catalogService.resolveActiveModel()
      if (!model) {
        throw new Error(
          `Provider "${providerId}" has no available model. Pick another provider in Settings.`
        )
      }

      if (config.allowModelNetwork && !isPiOffline()) void this.refreshCatalog()

      this.sessionDir = path.join(this.agentDir, 'sessions')
      const sessionManager = SessionManager.continueRecent(config.workspaceDir, this.sessionDir)
      const controller = await this.createController(sessionManager)
      this.lastSessionId = controller.id

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
      return { success: false, error: `Failed to initialize agent: ${errorMessage}` }
    } finally {
      if (!initialized) {
        this.controllers.clear()
        this.runtimes.clear()
        this.modelRuntime = null
      }
    }
  }

  private async requestWorktreeSwitch(sessionId: string, target: string, base?: string) {
    if (!this.config?.onWorktreeSwitch) {
      return { success: false, error: 'Worktree switching is unavailable.' }
    }
    try {
      return await this.config.onWorktreeSwitch(sessionId, target, base)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async createController(sessionManager: SessionManager): Promise<SessionController> {
    const config = this.config
    const modelRuntime = this.modelRuntime
    if (!config || !modelRuntime) throw new Error('Agent not initialized.')

    const id = sessionManager.getSessionId()
    const existing = this.controllers.get(id)
    if (existing) return existing

    const model = this.catalogService.resolveSessionInitialModel(sessionManager)
    if (!model) throw new Error('Selected model is unavailable.')

    const controller = await createSessionController({
      config,
      agentDir: this.agentDir,
      modelRuntime,
      model,
      sessionManager,
      logger: this.logger,
      loadExtras: (sessionId) => this.repository.loadExtrasWithStatus(sessionId),
      takeSeedPermission: (sessionId) => {
        const seed = this.seedPermissions.get(sessionId)
        this.seedPermissions.delete(sessionId)
        return seed
      },
      onTitleRestored: (sessionId, title) => this.titleService.setSettled(sessionId, title),
      getLastWebAccessVersion: () => this.lastWebAccessVersion,
      setLastWebAccessVersion: (version) => {
        this.lastWebAccessVersion = version
      },
      isCancelled: () =>
        this.disposed
          ? 'Agent manager was disposed.'
          : this.deletedSessions.has(id)
            ? 'Session was deleted.'
            : null,
      onWorktreeSwitch: (sessionId, target, base) =>
        this.requestWorktreeSwitch(sessionId, target, base),
      controllerDeps: this.controllerDeps(),
    })

    const superseded = this.controllers.get(id)
    if (superseded && superseded !== controller) {
      await superseded.dispose({ skipAbort: true })
    }
    this.controllers.set(id, controller)
    this.runtimes.set(id, controller.runtime)
    return controller
  }

  private async disposeController(
    controller: SessionController,
    options?: { skipAbort?: boolean }
  ): Promise<void> {
    await controller.dispose(options)
    if (this.controllers.get(controller.id) === controller) this.controllers.delete(controller.id)
    if (this.runtimes.get(controller.id) === controller.runtime) this.runtimes.delete(controller.id)
    if (this.lastSessionId === controller.id) this.lastSessionId = null
  }

  private async disposeAllControllers(): Promise<void> {
    for (const controller of [...this.controllers.values()]) {
      await this.disposeController(controller)
    }
    this.controllers.clear()
    this.runtimes.clear()
    this.lastSessionId = null
  }

  private trackControllerCreation(
    sessionId: string,
    factory: () => Promise<SessionController>
  ): Promise<SessionController> {
    const existing = this.controllers.get(sessionId)
    if (existing) return Promise.resolve(existing)
    const inflight = this.creatingControllers.get(sessionId)
    if (inflight) return inflight

    const creation = factory()
    this.creatingControllers.set(sessionId, creation)
    const cleanup = () => {
      if (this.creatingControllers.get(sessionId) === creation) {
        this.creatingControllers.delete(sessionId)
      }
    }
    void creation.then(cleanup, cleanup)
    return creation
  }

  private async ensureController(sessionId: string): Promise<SessionController> {
    const rebinding = this.rebindingPromises.get(sessionId)
    if (rebinding) await rebinding.catch(() => undefined)
    return this.trackControllerCreation(sessionId, async () => {
      const config = this.config
      if (!config) throw new Error('Agent not initialized.')
      const root = config.resolveSessionRoot?.(sessionId) ?? config.workspaceDir
      const file = await this.repository.findSessionFile(sessionId, root)
      if (!file) throw new Error('Session not found.')
      const manager = SessionManager.open(file, this.sessionDir, root)
      return await this.createController(manager)
    })
  }

  /** 在轮次边界应用待切换的工作树，保持 sessionId 与常驻 trace 订阅不变，失败时回退旧根 */
  private async applyPendingRoot(controller: SessionController): Promise<boolean> {
    if (this.disposed) return false
    const pending = controller.peekPendingRoot()
    if (!pending) return false
    if (this.controllers.get(controller.id) !== controller) return false
    if (this.rebinding.has(controller.id) || controller.isBusy()) return false

    const id = controller.id
    const oldRoot = controller.runtime.sessionManager.getCwd()
    if (normalizePathForCompare(oldRoot) === normalizePathForCompare(pending.root)) {
      controller.clearPendingRoot()
      return true
    }

    // 必须在首个 await 前同步加锁并登记 rebindingPromises，防止排队中的 chat() 在间隙启动并被中途 dispose
    this.rebinding.add(id)
    controller.consumePendingRoot()
    const pendingTitle = controller.runtime.pendingTitle
    const sessionName = controller.runtime.sessionManager.getSessionName()
    const preservedSinks = [...controller.runtime.traceSinks]

    const task = (async (): Promise<boolean> => {
      let file: string | null = null
      try {
        file = await this.repository.resolvePersistedSessionFile(
          controller.runtime.sessionManager,
          id
        )
        await this.disposeController(controller)
        const manager = this.repository.openManagerForRoot(id, file, pending.root)
        if (manager.getSessionId() !== id) {
          throw new Error(
            `Session id changed while switching worktrees (${id} -> ${manager.getSessionId()}).`
          )
        }
        const next = await this.createController(manager)
        for (const sink of preservedSinks) next.runtime.traceSinks.add(sink)
        this.carrySessionIdentity(next.runtime, file, pendingTitle, sessionName)
        this.lastSessionId = next.id
        this.config?.onSessionRootChanged?.(next.id, pending.root)
        this.logger.info(`[Agent Manager] Session ${next.id} switched to worktree: ${pending.root}`)
        return true
      } catch (error) {
        if (this.disposed) return false
        this.logger.error('[Agent Manager] Failed to apply worktree switch:', error)
        try {
          const manager = this.repository.openManagerForRoot(id, file, oldRoot)
          const restored = await this.createController(manager)
          for (const sink of preservedSinks) restored.runtime.traceSinks.add(sink)
          this.carrySessionIdentity(restored.runtime, file, pendingTitle, sessionName)
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
      if (this.rebindingPromises.get(id) === task) this.rebindingPromises.delete(id)
    }
    void task.then(cleanupRebind, cleanupRebind)
    return task
  }

  private carrySessionIdentity(
    runtime: SessionRuntime,
    persistedFile: string | null,
    pendingTitle: string | null,
    sessionName: string | undefined
  ): void {
    if (pendingTitle) runtime.pendingTitle = pendingTitle
    else if (!persistedFile && sessionName && !runtime.sessionManager.getSessionName()) {
      runtime.sessionManager.appendSessionInfo(sessionName)
    }
    if (pendingTitle) this.titleService.setSettled(runtime.id, pendingTitle)
    else if (sessionName) this.titleService.settleSessionTitle(runtime, sessionName)
  }

  private async resetControllerAfterHardStop(controller: SessionController): Promise<void> {
    const id = controller.id
    const root = controller.runtime.sessionManager.getCwd()
    const preservedSinks = [...controller.runtime.traceSinks]
    await this.disposeController(controller, { skipAbort: true })
    if (!this.config || this.disposed || this.deletedSessions.has(id)) return
    try {
      const next = await this.trackControllerCreation(id, async () => {
        const file = await this.repository.findSessionFile(id, root)
        return await this.createController(this.repository.openManagerForRoot(id, file, root))
      })
      for (const sink of preservedSinks) next.runtime.traceSinks.add(sink)
      this.lastSessionId = next.id
    } catch (error) {
      this.logger.error('[Agent Manager] Failed to reinitialize after hard stop:', error)
    }
  }

  // ---------------------------------------------------------------------------
  // 会话生命周期 API
  // ---------------------------------------------------------------------------

  async openSession(sessionId?: string): Promise<SessionOpenResult> {
    try {
      if (!this.modelRuntime || !this.config) {
        return { success: false, error: 'Agent not initialized.' }
      }
      let controller: SessionController
      if (sessionId) {
        controller = await this.ensureController(sessionId)
      } else if (this.lastSessionId && this.controllers.has(this.lastSessionId)) {
        controller = this.controllers.get(this.lastSessionId)!
      } else {
        const manager = SessionManager.continueRecent(this.config.workspaceDir, this.sessionDir)
        const recentId = manager.getSessionId()
        const rebinding = this.rebindingPromises.get(recentId)
        if (rebinding) await rebinding.catch(() => undefined)
        controller = await this.trackControllerCreation(recentId, () =>
          this.createController(manager)
        )
      }
      this.lastSessionId = controller.id
      return { success: true, session: controller.getSummary(), history: controller.getMessages() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async createSession(
    root?: string,
    options?: { permission?: SessionPermission }
  ): Promise<SessionOpenResult> {
    try {
      if (!this.modelRuntime || !this.config) {
        return { success: false, error: 'Agent not initialized.' }
      }
      const targetRoot =
        typeof root === 'string' && root.trim() ? path.resolve(root) : this.config.workspaceDir
      const manager = SessionManager.create(targetRoot, this.sessionDir)
      if (options?.permission) {
        this.seedPermissions.set(
          manager.getSessionId(),
          normalizeSessionPermission(options.permission)
        )
      }
      const controller = await this.createController(manager)
      this.lastSessionId = controller.id
      return { success: true, session: controller.getSummary(), history: [] }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.repository.listSessions(
      [...this.controllers.values()].map((controller) => controller.getSummary())
    )
  }

  async closeSession(sessionId: string): Promise<void> {
    const controller = this.controllers.get(sessionId)
    if (controller) await this.disposeController(controller)
  }

  async renameSession(
    sessionId: string,
    name: string
  ): Promise<{ success: boolean; error?: string }> {
    const title = name.trim().slice(0, 80)
    if (!title) return { success: false, error: 'Session name cannot be empty.' }
    try {
      const controller = this.controllers.get(sessionId)
      const current = controller
        ? this.titleService.sessionTitle(controller.runtime)
        : this.titleService.getSettled(sessionId) ?? null
      if (current === title) {
        this.titleService.setSettled(sessionId, title)
        return { success: true }
      }
      if (controller) {
        controller.runtime.pendingTitle = title
        if (controller.runtime.sessionManager.isPersisted()) {
          controller.runtime.sessionManager.appendSessionInfo(title)
          controller.runtime.pendingTitle = null
        }
        this.titleService.settleSessionTitle(controller.runtime, title)
        controller.runtime.updatedAt = Date.now()
        return { success: true }
      }
      const res = await this.repository.renameSessionOnDisk(sessionId, title)
      if (!res.success) return res
      this.titleService.setSettled(sessionId, title)
      void this.titleService.saveSessionTitleExtra(sessionId, title)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async deleteSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
    const hadLocalRuntime =
      this.controllers.has(sessionId) || this.creatingControllers.has(sessionId)
    return this.repository.deleteSessionFiles(sessionId, {
      hadLocalRuntime,
      onBeforeCleanup: async () => {
        this.deletedSessions.add(sessionId)
        if (this.deletedSessions.size > 500) {
          const oldest = this.deletedSessions.values().next().value
          if (oldest !== undefined) this.deletedSessions.delete(oldest)
        }
        const inflight = this.creatingControllers.get(sessionId)
        if (inflight) await inflight.catch(() => undefined)
        await this.closeSession(sessionId)
        this.titleService.delete(sessionId)
        this.creatingControllers.delete(sessionId)
        this.seedPermissions.delete(sessionId)
      },
    })
  }

  async requestSessionRoot(
    sessionId: string,
    root: string
  ): Promise<{ success: boolean; scheduled?: boolean; error?: string }> {
    const controller = this.controllers.get(sessionId)
    if (!controller) return { success: true }
    controller.schedulePendingRoot(root)
    if (controller.isBusy() || this.rebinding.has(sessionId)) {
      return { success: true, scheduled: true }
    }
    return (await this.applyPendingRoot(controller))
      ? { success: true }
      : { success: false, error: 'Failed to switch the session worktree.' }
  }

  // ---------------------------------------------------------------------------
  // 对话、控制与单会话委托
  // ---------------------------------------------------------------------------

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

    // 先做图像附件前置校验，非法载荷在未初始化 / 打开会话前即快速失败
    const imageCheck = validateChatImages(options?.images)
    if (imageCheck.error) return { success: false, error: imageCheck.error }

    const targetId = sessionId ?? this.lastSessionId
    if (targetId) {
      const rebinding = this.rebindingPromises.get(targetId)
      if (rebinding) await rebinding.catch(() => undefined)
      const existingBeforeTurn = this.controllers.get(targetId)
      if (existingBeforeTurn?.hasPendingRoot() && !existingBeforeTurn.isBusy()) {
        await this.applyPendingRoot(existingBeforeTurn).catch(() => undefined)
      }
    }

    let controller =
      (sessionId ? this.controllers.get(sessionId) : null) ??
      (this.lastSessionId ? this.controllers.get(this.lastSessionId) : null) ??
      null
    if (!controller) {
      try {
        if (sessionId) {
          controller = await this.ensureController(sessionId)
        } else {
          const opened = await this.openSession()
          if (!opened.success) {
            return { success: false, error: opened.error || 'Agent not initialized.' }
          }
          controller = this.controllers.get(this.lastSessionId ?? '') ?? null
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (!controller) {
        return { success: false, error: 'Agent not initialized. Please initialize first.' }
      }
    }

    this.lastSessionId = controller.id
    return controller.chat(message, options)
  }

  async steer(
    sessionId: string,
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<{ success: boolean; error?: string }> {
    const imageCheck = validateChatImages(images)
    if (imageCheck.error) return { success: false, error: imageCheck.error }
    if (!message.trim() && imageCheck.images.length === 0) {
      return { success: false, error: 'Message is empty.' }
    }
    return this.withController(sessionId, (c) => c.steer(message, images))
  }

  async abort(sessionId?: string): Promise<void> {
    const targets = sessionId
      ? [this.controllers.get(sessionId)].filter((c): c is SessionController => Boolean(c))
      : [...this.controllers.values()]
    for (const controller of targets) await controller.abort()
  }

  async subscribeTrace(
    sessionId: string,
    sink: (event: AgentTraceEvent) => void
  ): Promise<() => void> {
    return (await this.ensureController(sessionId)).subscribeTrace(sink)
  }

  isSessionBusy(sessionId?: string): boolean {
    const id = sessionId ?? this.lastSessionId
    return id ? (this.controllers.get(id)?.isBusy() ?? false) : false
  }

  hasRunningSessions(): string[] {
    return [...this.controllers.values()].filter((c) => c.isBusy()).map((c) => c.id)
  }

  sendCustomMessage(
    sessionId: string,
    message: {
      customType: string
      content: string | Array<{ type: 'text'; text: string }>
      display?: boolean
      details?: unknown
    },
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' }
  ) {
    if (!message.customType.trim()) {
      return Promise.resolve({ success: false, error: 'customType is required.' })
    }
    return this.withController(sessionId, (c) => c.sendCustomMessage(message, options))
  }

  getContextUsage(sessionId: string) {
    return this.withController(sessionId, (c) => c.getContextUsage())
  }

  compactContext(sessionId: string) {
    return this.withController(sessionId, (c) => c.compactContext())
  }

  rewindToLastUser(
    sessionId: string,
    newText?: string
  ): Promise<{ success: boolean; text?: string; context?: MessageContext; error?: string }> {
    return this.withController(sessionId, (c) => c.rewindToLastUser(newText))
  }

  listBranches(
    sessionId: string
  ): Promise<{ success: boolean; groups?: ConversationBranchGroup[]; error?: string }> {
    return this.withController(sessionId, (c) => c.listBranches())
  }

  switchBranch(
    sessionId: string,
    entryId: string
  ): Promise<{ success: boolean; history?: AgentMessage[]; error?: string }> {
    return this.withController(sessionId, (c) => c.switchBranch(entryId))
  }

  getPlan(
    sessionId: string
  ): Promise<{ success: boolean; plan?: StructuredPlan | null; error?: string }> {
    return this.withController(sessionId, (c) => c.getPlan())
  }

  approvePlan(
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
      return Promise.resolve({ success: false, error: 'Invalid execute mode.' })
    }
    return this.withController(sessionId, (c) => c.approvePlan(planId, targetMode))
  }

  rejectPlan(sessionId: string, planId: string) {
    return this.withController(sessionId, (c) => c.rejectPlan(planId))
  }

  getToolResultMeta(
    sessionId: string,
    toolCallId: string
  ): Promise<{ success: boolean; meta?: ToolResultMeta; error?: string }> {
    return this.withController(sessionId, (c) =>
      this.repository.getToolResultMeta(
        c.runtime.sessionManager,
        c.runtime.session.messages ?? [],
        toolCallId
      )
    )
  }

  readToolResultChunk(sessionId: string, toolCallId: string, offset = 0, limit = 65_536) {
    return this.withController(sessionId, (c) =>
      this.repository.readToolResultChunk(
        c.runtime.sessionManager,
        c.runtime.session.messages ?? [],
        toolCallId,
        offset,
        limit
      )
    )
  }

  getToolResultImage(sessionId: string, toolCallId: string, index = 0) {
    return this.withController(sessionId, (c) =>
      this.repository.getToolResultImage(
        c.runtime.sessionManager,
        c.runtime.session.messages ?? [],
        toolCallId,
        index
      )
    )
  }

  getToolResultText(sessionId: string, toolCallId: string) {
    return this.withController(sessionId, (c) =>
      this.repository.getToolResultText(
        c.runtime.sessionManager,
        c.runtime.session.messages ?? [],
        toolCallId
      )
    )
  }

  exportSessionMarkdown(sessionId: string, language: ExportLanguage = 'zh') {
    return this.withController(sessionId, (c) =>
      this.repository.exportMarkdown(
        c.runtime.sessionManager,
        c.getSummary().title || c.id,
        language
      )
    )
  }

  exportSessionHtml(sessionId: string, language: ExportLanguage = 'zh') {
    return this.withController(sessionId, (c) =>
      this.repository.exportHtml(c.runtime.sessionManager, c.getSummary().title || c.id, language)
    )
  }

  getSessionJsonlPath(sessionId: string) {
    return this.withController(sessionId, (c) =>
      this.repository.getSessionJsonlPath(c.runtime.sessionManager, c.getSummary().title || c.id)
    )
  }

  getSessionStats(sessionId: string) {
    return this.withController(sessionId, (c) => c.getSessionStats())
  }

  getSessionSettings(sessionId: string) {
    return this.withController(sessionId, (c) => c.getSessionSettings())
  }

  setSessionPermission(sessionId: string, permission: unknown) {
    return this.withController(sessionId, (c) => c.setSessionPermission(permission))
  }

  async setSessionModel(
    sessionId: string,
    modelId: string
  ): Promise<{ success: boolean; error?: string }> {
    const providerId = this.config?.apiConfig.providerId
    if (!this.modelRuntime || !providerId) return { success: false, error: 'Agent not initialized.' }
    const model = this.modelRuntime.getModel(providerId, modelId)
    if (!model) return { success: false, error: `Model "${modelId}" is unavailable.` }
    return this.withController(sessionId, (c) => c.setSessionModel(model))
  }

  setSessionThinking(
    sessionId: string,
    level: string
  ): Promise<{ success: boolean; error?: string }> {
    const allowed = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    if (!allowed.includes(level)) {
      return Promise.resolve({ success: false, error: `Unknown thinking level "${level}".` })
    }
    return this.withController(sessionId, (c) => c.setSessionThinking(level))
  }

  listPromptResources(
    sessionId: string
  ): Promise<{
    success: boolean
    templates?: PromptTemplateInfo[]
    skills?: SkillInfo[]
    error?: string
  }> {
    return this.withController(sessionId, (c) => c.listPromptResources())
  }

  // ---------------------------------------------------------------------------
  // 模型目录与轻量辅助请求
  // ---------------------------------------------------------------------------

  getModelCapabilities(): Promise<{
    success: boolean
    models?: ModelCapabilityInfo[]
    selected?: string
    error?: string
  }> {
    return this.catalogService.getModelCapabilities()
  }

  getProviderCatalog(): Promise<{
    success: boolean
    providerId?: string
    models?: Array<{ id: string; name: string; limits: ModelLimits; reasoning: boolean }>
    error?: string
  }> {
    return this.catalogService.getProviderCatalog()
  }

  refreshCatalog(options: { force?: boolean } = {}): Promise<{
    success: boolean
    added: number
    removed: number
    checkedAt?: number
    error?: string
  }> {
    return this.catalogService.refreshCatalog(options)
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
      this.catalogService.resolveActiveModel() ??
      runtime.getModel(config.apiConfig.providerId as never, config.apiConfig.modelId as never)
    if (!model) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 20_000)
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
        { maxTokens: options?.maxTokens ?? 1024, temperature: 0.2, signal: controller.signal }
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

  // ---------------------------------------------------------------------------
  // 状态查询与清理
  // ---------------------------------------------------------------------------

  getCurrentSessionId(): string | null {
    return this.lastSessionId
  }

  getSessionController(sessionId?: string): SessionController | undefined {
    const id = sessionId ?? this.lastSessionId
    return id ? this.controllers.get(id) : undefined
  }

  getSessionRepository(): SessionRepository {
    return this.repository
  }

  getMessageHistory(sessionId?: string): AgentMessage[] {
    return this.getSessionController(sessionId)?.getMessageHistory() ?? []
  }

  getSessionMessages(sessionId?: string): AgentMessage[] {
    return this.getSessionController(sessionId)?.getMessages() ?? []
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const inflight = [...this.creatingControllers.values(), ...this.rebindingPromises.values()]
    if (inflight.length > 0) await Promise.allSettled(inflight)
    await this.disposeAllControllers()
    this.titleService.clear()
    this.catalogService.resetSnapshot()
    this.creatingControllers.clear()
    this.rebindingPromises.clear()
    this.rebinding.clear()
    this.deletedSessions.clear()
    this.seedPermissions.clear()
    this.config = null
    this.modelRuntime = null
    this.sessionDir = ''
    this.agentDir = ''
    this.lastSessionId = null
  }

  isInitialized(): boolean {
    return this.modelRuntime !== null
  }

  getConfig(): AgentConfig | null {
    return this.config
  }
}

export { AgentManager as AgentRuntimeHost }
