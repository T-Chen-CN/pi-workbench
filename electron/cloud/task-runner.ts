/**
 * 工单执行器（G7 / G12 / G8 / G6）。
 *
 * 一个工作单元一个 git worktree，一个单元只写一条合成绑定 `cloud:<unitId>`：
 * 工单会话本身**不 bind**（它直接用 `createSession(worktreePath)` 建在工作树里），
 * 绑定只为了让 `cleanupOrphans()` 不收它、Git 视图能看见并有 diff 入口。
 *
 * 会话由独立的 AgentManager 承载（独立 agentDir，不进用户的会话列表，D-24），
 * 但**必须复用用户当前的 API 配置**：SDK 的 Key 是进程级串写的。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'
import {
  CLOUD_TASK_HEARTBEAT_MS,
  CLOUD_TOOL_STALL_MS,
  type CloudChangedFile,
  type CloudSecretHit,
  type CloudTaskMilestone,
  type CloudTaskResult,
  type CloudTaskSpec,
  type CloudTaskStatus,
} from 'pi-bridge'
import { getBridgeEntryUrl } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomic, writeJsonAtomicAsync } from '../atomic-json.js'
import {
  createTaskGuardExtension,
  installWorktreePrePushHook,
  type TaskGuardInfo,
} from './task-guard.js'
import {
  annotateChangedFiles,
  collectTaskDiff,
  redactSecrets,
  scanWorktreeSecrets,
} from './task-report.js'
import { createDesktopCredentialStore } from '../credentials-store.js'
import { getModelsStore } from '../models-store.js'
import { isCatalogNetworkAllowed } from '../providers-service.js'
import { sanitizeTerminalEnv } from '../terminal-manager.js'

const execFileAsync = promisify(execFile)

/** 工单会话允许的工具：读、写、搜、看、跑命令与 ask_cloud；其余一律不激活 */
export const TASK_TOOL_ALLOWLIST = [
  'read',
  'ls',
  'grep',
  'find',
  'edit',
  'write',
  'bash',
  ...(process.platform === 'win32' ? ['powershell'] : []),
  'ask_cloud',
]

/** 进度上报节流：终端一轮里可能几十次工具调用，全推上去会把通道打满 */
const MILESTONE_THROTTLE_MS = 2_000
const GIT_TIMEOUT_MS = 15_000

/**
 * 工单会话的压缩参数（§4.0 实测约束 1）。
 *
 * `models.json` 的 `contextWindow` 只有四档（64k/128k/256k/1M），写别的值会被
 * `normalizeContextWindow` 静默回落成 128k；想让工单更早压缩只能改 `settings.json`
 * 的 `compaction`（自由数值）。默认值 16384/20000 对长工单太宽松。
 */
const TASK_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 8_192, keepRecentTokens: 12_000 }

/**
 * 把更激进的压缩参数写进工单 agentDir 的 `settings.json`。
 *
 * 只覆盖 `compaction` 里的三个键：其它字段（本机设置、未来版本新增项）原样保留。
 * 跟模型配置同步不冲突——同步只写 `models.json`，从不碰这里。
 */
async function ensureTaskAgentSettings(agentDir: string): Promise<void> {
  const file = path.join(agentDir, 'settings.json')
  const existing = readJsonWithBackup<Record<string, unknown>>(file).data ?? {}
  const current = { ...((existing.compaction ?? {}) as Record<string, unknown>) }
  // 必须删除 initialize() 写入的 modelOverrides（16k/20k），否则其优先级高于顶层 compaction，
  // 会导致工单专属 8k/12k 压缩阈值完全失效。
  const hadOverrides = 'modelOverrides' in current
  delete current.modelOverrides
  const merged = { ...current, ...TASK_COMPACTION_SETTINGS }
  if (
    !hadOverrides &&
    current.enabled === merged.enabled &&
    current.reserveTokens === merged.reserveTokens &&
    current.keepRecentTokens === merged.keepRecentTokens
  ) {
    return
  }
  await writeJsonAtomicAsync(file, { ...existing, compaction: merged }, { backup: false })
}

export interface CloudTaskRunnerDeps {
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
  /** 工单数据目录（`{appDir}/data/cloud`）；会话 agentDir 在其下另开一层 */
  dataDir: string
  /**
   * 与用户会话同一份供应商配置（工单跟随 activeProvider，D5）。
   * 只给 provider / 模型 / 凭证指纹；Key 由 Agent 自己从 CredentialStore 取。
   */
  getApiConfig: () => Promise<{
    providerId: string
    modelId: string
    overrides?: Record<string, { contextWindow?: number; maxTokens?: number }>
    fingerprint: string
  } | null>
  /** 工作区白名单校验：绝不允许在未登记/未受信任目录建 worktree 或跑 auto 权限 Agent */
  isAllowedWorkspace?: (workspacePath: string) => boolean | Promise<boolean>
  /** 工作树协调器；非 git 仓库返回 null（G10 由此拒绝派活） */
  getCoordinator: (
    repoPath: string
  ) => Promise<{
    bind: (
      sessionId: string,
      target: string,
      base?: string
    ) => Promise<{ success: boolean; error?: string; worktree?: { path: string; branch: string | null } }>
    getSessionBinding: (sessionId: string) => { key: string; path: string; branch: string | null }
    hasBinding: (sessionId: string) => boolean
    /** `release()` 的三态语义：脏树保留 / 干净无新提交删树删分支 / 有提交只删目录 */
    release: (sessionId: string) => Promise<{
      success: boolean
      removed?: boolean
      dirty?: boolean
      worktreePath?: string
      error?: string
    }>
  } | null>
  /** 上报给云端（device agent 负责成帧与离线队列） */
  onStatus: (taskId: string, status: CloudTaskStatus) => void
  onWorktree: (taskId: string, unitId: string, worktreePath: string, branch?: string) => void
  onMilestone: (taskId: string, milestone: CloudTaskMilestone) => void
  onQuestion: (taskId: string, questionId: string, text: string) => void
  /** 工具静默超阈值时上报停滞（C-02：同一次停滞只报一次） */
  onStalled?: (taskId: string, info: { toolName?: string; idleMs: number; at: number }) => void
  /** 工单运行期 60s 心跳（C-02；普通心跳不重置工具停滞计时） */
  onTaskHeartbeat?: (taskId: string, at: number) => void
  /** 可覆盖默认阈值（测试用） */
  toolStallMs?: number
  taskHeartbeatMs?: number
  now?: () => number
  /** 可覆盖 pre-push hook 安装实现（测试注入用，缺省走真实 installWorktreePrePushHook） */
  installPrePushHook?: typeof installWorktreePrePushHook
  onResult: (taskId: string, result: CloudTaskResult) => void
  onFailed: (
    taskId: string,
    error: string,
    changedFiles?: CloudChangedFile[],
    worktreeClean?: boolean,
    secretHits?: CloudSecretHit[]
  ) => void
  onInterrupted: (taskId: string, reason: string, worktreeClean?: boolean) => void
  /** 工作单元回收回执（F-19a / A-43）：只有这里才能让云端写 `closedAt` */
  onUnitClosed: (
    unitId: string,
    result: {
      removed: boolean
      dirty: boolean
      worktreePath?: string
      branch?: string
      error?: string
    }
  ) => void
  /** 工作树状态的兜底上报（启动 / 重连）：干净且已收敛的单元会被云端自动回收 */
  onUnitState: (
    unitId: string,
    state: { clean: boolean; worktreePath?: string }
  ) => void
}

interface UnitRecord {
  repoPath: string
  worktreePath: string
  branch: string | null
  base?: string
  createdAt: number
}

interface RunningToolState {
  toolName: string
  lastOutputAt: number
  reported: boolean
}

interface TaskCreateSessionResult {
  success?: boolean
  error?: string
  session?: { id?: string }
  sessionId?: string
  id?: string
}

interface TaskChatOutcome {
  success?: boolean
  error?: string
  response?: string
}

interface TaskTraceEvent {
  type?: string
  toolCallId?: string
  toolName?: string
  status?: string
  filePath?: string
  args?: unknown
  argsSummary?: string
  resultPreview?: string
}

interface AskCloudToolRegistrar {
  registerTool: (definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    execute: (
      toolCallId: string,
      params: { question?: string },
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: { sessionManager?: { getSessionId?: () => string }; cwd?: string }
    ) => Promise<{
      content: Array<{ type: 'text'; text: string }>
      isError: boolean
      details: undefined
    }>
  }) => void
}

interface TaskAgentManager {
  initialize: (options: Record<string, unknown>) => Promise<{ success?: boolean; error?: string }>
  createSession: (
    cwd: string,
    options?: { permission?: { mode: 'auto'; grants: never[] } }
  ) => Promise<TaskCreateSessionResult | undefined>
  closeSession?: (sessionId: string) => Promise<unknown>
  subscribeTrace?: (
    sessionId: string,
    listener: (event: TaskTraceEvent) => void
  ) => Promise<(() => void) | undefined> | (() => void) | undefined
  chat: (sessionId: string, prompt: string) => Promise<TaskChatOutcome | undefined>
  abort?: (sessionId: string) => Promise<unknown>
  isSessionBusy?: (sessionId: string) => boolean
  steer?: (sessionId: string, text: string) => Promise<unknown>
  dispose?: () => Promise<unknown>
}

interface ActiveTask {
  id: string
  spec: CloudTaskSpec
  unitId: string
  repoPath: string
  worktreePath: string
  sessionId: string
  /** 创建该工单会话时的 AgentManager 实例，避免热切配置时提前销毁仍在使用的旧 manager */
  manager?: TaskAgentManager
  /** 同一工单的轮次串行链（初轮与 ask_cloud 回答续轮），防止并发调用 manager.chat */
  turnChain?: Promise<void>
  status: CloudTaskStatus
  startedAt: number
  /** 最近一次进度上报时间（节流用） */
  lastMilestoneAt: number
  changed: Map<string, CloudChangedFile>
  /** 当前运行中的工具（C-02 停滞检测：只认 tool_update 为输出增量） */
  runningTools: Map<string, RunningToolState>
  unsubscribeTrace?: () => void
  stallTimer?: NodeJS.Timeout
  heartbeatTimer?: NodeJS.Timeout
  questionId?: string
  /** `ask_cloud` 之后本轮要停：回答到达后重新起一轮 */
  awaitingAnswer: boolean
}

interface PersistedTask {
  id: string
  unitId: string
  repoPath: string
  worktreePath: string
  status: CloudTaskStatus
  startedAt: number
}

const UNIT_BINDING_PREFIX = 'cloud:'

export class CloudTaskRunner {
  private deps: CloudTaskRunnerDeps
  private manager: TaskAgentManager | null = null
  private managerKey = ''
  /** 已替换但仍有活跃/waiting_human 工单引用的旧 AgentManager，等引用归零后延迟销毁 */
  private retiredManagers = new Set<TaskAgentManager>()
  private active = new Map<string, ActiveTask>()
  /** 正在准备阶段（建 worktree / 建会话）的工单：防并发 start 与 closeUnit 竞态 */
  private starting = new Map<string, string>()
  /** 按工作单元串行化 worktree 创建与回收，避免并发 start 建重复 worktree */
  private unitLocks = new Map<string, Promise<unknown>>()
  /** 单设备串行启动锁：确保同一设备并发收到多条 task 帧时严格 FIFO 执行 */
  private startChain: Promise<void> = Promise.resolve()
  private units = new Map<string, UnitRecord>()
  private persistedTasks = new Map<string, PersistedTask>()
  private cancelRequested = new Set<string>()
  private disposed = false

  constructor(deps: CloudTaskRunnerDeps) {
    this.deps = deps
  }

  private withUnitLock<T>(unitId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.unitLocks.get(unitId) ?? Promise.resolve()
    const run = prev.catch(() => undefined).then(fn)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.unitLocks.set(unitId, tail)
    void tail.then(() => {
      if (this.unitLocks.get(unitId) === tail) this.unitLocks.delete(unitId)
    })
    return run
  }

  private unitsFile(): string {
    return path.join(this.deps.dataDir, 'units.json')
  }

  private tasksFile(): string {
    return path.join(this.deps.dataDir, 'tasks.json')
  }

  async load(): Promise<void> {
    this.disposed = false
    await fs.mkdir(this.deps.dataDir, { recursive: true })
    const units = readJsonWithBackup<Record<string, UnitRecord>>(this.unitsFile())
    if (units.data && typeof units.data === 'object') {
      for (const [unitId, record] of Object.entries(units.data)) {
        if (record && typeof record.worktreePath === 'string') this.units.set(unitId, record)
      }
    }
    const tasks = readJsonWithBackup<Record<string, PersistedTask>>(this.tasksFile())
    if (tasks.data && typeof tasks.data === 'object') {
      for (const [taskId, record] of Object.entries(tasks.data)) {
        if (record && typeof record.id === 'string') this.persistedTasks.set(taskId, record)
      }
    }
  }

  /**
   * G6：上次进程留下的未完成工单改判 `interrupted` 并汇报。
   * 不续跑 —— 工单的语义是「本次执行」，续跑会让用户以为失败被吞了。
   */
  async recoverInterrupted(): Promise<string[]> {
    const interrupted: string[] = []
    for (const record of this.persistedTasks.values()) {
      if (!['queued', 'assigned', 'running', 'waiting_human'].includes(record.status)) continue
      interrupted.push(record.id)
      try {
        this.deps.onInterrupted(record.id, 'device agent restarted')
      } catch (error) {
        this.deps.logger.warn('[Cloud Task] failed to report interrupted task:', error)
      }
    }
    if (interrupted.length > 0) {
      this.persistedTasks.clear()
      await this.persistTasks()
    }
    return interrupted
  }

  private async persistUnits(): Promise<void> {
    const data: Record<string, UnitRecord> = {}
    for (const [unitId, record] of this.units) data[unitId] = record
    await writeJsonAtomic(this.unitsFile(), data)
  }

  private async persistTasks(): Promise<void> {
    const data: Record<string, PersistedTask> = {}
    for (const [taskId, record] of this.persistedTasks) data[taskId] = record
    await writeJsonAtomic(this.tasksFile(), data)
  }

  /** 应用退出前已成功上报 `task_interrupted` 的工单须从台账移除，避免下次启动重复上报 */
  async clearPersistedTasks(taskIds: string[]): Promise<void> {
    let changed = false
    for (const id of taskIds) {
      if (this.persistedTasks.delete(id)) changed = true
    }
    if (changed) await this.persistTasks()
  }

  private taskManager(task: ActiveTask): TaskAgentManager | null {
    return task.manager ?? this.manager
  }

  private disposeUnusedRetiredManagers(): void {
    if (this.retiredManagers.size === 0) return
    const inUse = new Set<TaskAgentManager>()
    for (const activeTask of this.active.values()) {
      if (activeTask.manager) inUse.add(activeTask.manager)
    }
    for (const retired of [...this.retiredManagers]) {
      if (retired === this.manager || inUse.has(retired)) continue
      this.retiredManagers.delete(retired)
      void retired.dispose?.().catch(() => undefined)
    }
  }

  /** 该单元的工作树；没有就新建一个（G12：一单元一条绑定，同单元加锁防并发重复建树） */
  private async ensureUnitWorktree(spec: CloudTaskSpec): Promise<{
    ok: boolean
    error?: string
    record?: UnitRecord
  }> {
    return this.withUnitLock(spec.workUnitId, async () => {
      const repoPath = spec.repo.workspacePath
      // 无论单元是否已缓存，每次派活都必须复核工作区信任边界
      if (this.deps.isAllowedWorkspace) {
        const allowed = await this.deps.isAllowedWorkspace(repoPath)
        if (!allowed) {
          return {
            ok: false,
            error: `Workspace is not trusted or registered on this device: ${repoPath}`,
          }
        }
      }

      const installHook = this.deps.installPrePushHook ?? installWorktreePrePushHook
      const existing = this.units.get(spec.workUnitId)
      if (existing && existsSync(existing.worktreePath)) {
        const normPath = (p: string) =>
          process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
        if (normPath(existing.repoPath) !== normPath(repoPath)) {
          return {
            ok: false,
            error: `Work unit ${spec.workUnitId} is bound to a different repository.`,
          }
        }
        const hook = await installHook(existing.repoPath, existing.worktreePath).catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))
        if (!hook.ok) {
          this.deps.logger.warn('[Cloud Task] Failed to ensure worktree pre-push hook:', hook.error)
          return {
            ok: false,
            error: `Failed to install worktree pre-push guard: ${hook.error ?? 'unknown error'}`,
            record: existing,
          }
        }
        return { ok: true, record: existing }
      }

      if (!existsSync(repoPath)) return { ok: false, error: `Repository not found: ${repoPath}` }
      const coordinator = await this.deps.getCoordinator(repoPath)
      if (!coordinator) {
        return {
          ok: false,
          error: 'Not a git repository — delegated tasks need a worktree for isolation',
        }
      }

      const bindingId = `${UNIT_BINDING_PREFIX}${spec.workUnitId}`
      const base = spec.repo.baseBranch
      const bound = await coordinator.bind(bindingId, 'new', base)
      if (!bound.success || !bound.worktree) {
        return { ok: false, error: bound.error ?? 'Unable to create a worktree for this task' }
      }
      // D-32 / A-44：在单元工作树装独立 pre-push hook，防止绕过 tool_call 推送远端；失败一律 fail-closed 并清理刚建好的未受保护工作树
      const hook = await installHook(repoPath, bound.worktree.path).catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
      if (!hook.ok) {
        this.deps.logger.warn('[Cloud Task] Failed to install worktree pre-push hook:', hook.error)
        await coordinator.release(bindingId).catch(() => undefined)
        return {
          ok: false,
          error: `Failed to install worktree pre-push guard: ${hook.error ?? 'unknown error'}`,
        }
      }
      const record: UnitRecord = {
        repoPath,
        worktreePath: bound.worktree.path,
        branch: bound.worktree.branch,
        base,
        createdAt: Date.now(),
      }
      this.units.set(spec.workUnitId, record)
      await this.persistUnits()
      return { ok: true, record }
    })
  }

  /** 复用用户当前 API 配置，按需建一个专属 AgentManager（独立 agentDir） */
  private async ensureManager(): Promise<TaskAgentManager> {
    const config = await this.deps.getApiConfig()
    if (!config || !config.modelId) {
      throw new Error('API configuration is missing; configure the model in Settings first')
    }
    // 指纹只在换 key 时变；OAuth token 刷新不重建工单运行时（D21），但 overrides 变化必须重建
    const key = `${config.providerId}|${config.modelId}|${config.fingerprint}|${serializeApiOverrides(config.overrides)}`
    if (this.manager && this.managerKey === key) return this.manager

    const { AgentManager } = (await import(getBridgeEntryUrl())) as {
      AgentManager: new () => TaskAgentManager
    }
    const agentDir = path.join(this.deps.dataDir, 'agent')
    await fs.mkdir(agentDir, { recursive: true })
    await ensureTaskAgentSettings(agentDir)
    const manager = new AgentManager()
    const result = await manager.initialize({
      workspaceDir: path.join(this.deps.dataDir, 'workspace'),
      agentDir,
      apiConfig: {
        providerId: config.providerId,
        modelId: config.modelId,
        ...(config.overrides ? { overrides: config.overrides } : {}),
      },
      credentials: createDesktopCredentialStore(),
      modelsStore: getModelsStore(),
      allowModelNetwork: isCatalogNetworkAllowed(),
      logger: this.deps.logger,
      // 工单会话：不挂计划与工作树扩展（worktree 扩展用的是实例级 workspaceDir）
      builtinExtensions: { plan: false, worktree: false },
      toolAllowlist: [...TASK_TOOL_ALLOWLIST],
      getDefaultPermissionLevel: () => 'auto',
      extensionFactories: [
        createTaskGuardExtension({
          logger: this.deps.logger,
          onBlocked: (info) => this.reportBlocked(info),
        }),
        this.createAskCloudExtension(),
      ],
    })
    if (!result.success) {
      await manager.dispose?.().catch(() => undefined)
      throw new Error(result.error ?? 'failed to initialize the task agent')
    }
    // initialize() 会把默认 16k/20k 的 modelOverrides 写进 settings.json；
    // 必须在初始化后再落一次工单专属 8k/12k 压缩配置并清掉 modelOverrides，确保后续 createSession 生效。
    await ensureTaskAgentSettings(agentDir)
    const previous = this.manager
    this.manager = manager
    this.managerKey = key
    if (previous && previous !== manager) {
      // 仍有活跃或 waiting_human 工单引用旧 manager 时必须延迟销毁，否则会直接打死在途会话
      const stillInUse = [...this.active.values()].some((item) => item.manager === previous)
      if (stillInUse) {
        this.retiredManagers.add(previous)
      } else {
        await previous.dispose?.().catch(() => undefined)
      }
    }
    return manager
  }

  /** `ask_cloud`：把问题抛给用户，然后结束本轮等待回答（不做阻塞等待） */
  private createAskCloudExtension(): (pi: AskCloudToolRegistrar) => void {
    return (pi) => {
      pi.registerTool({
        name: 'ask_cloud',
        description:
          'Ask the user (through the cloud console) when a decision cannot be made from the task itself. ' +
          'Finish your turn right after calling this; the answer arrives as a follow-up message.',
        parameters: {
          type: 'object',
          properties: { question: { type: 'string', description: 'The question to ask' } },
          required: ['question'],
        },
        execute: async (
          _toolCallId: string,
          params: { question?: string },
          _signal?: AbortSignal,
          _onUpdate?: unknown,
          ctx?: { sessionManager?: { getSessionId?: () => string }; cwd?: string }
        ) => {
          const question = String(params?.question ?? '').trim()
          if (!question) {
            return {
              content: [{ type: 'text', text: 'A question is required.' }],
              isError: true,
              details: undefined,
            }
          }
          const sessionId = ctx?.sessionManager?.getSessionId?.()
          const task = this.currentTaskForSession(sessionId, ctx?.cwd)
          if (!task) {
            return {
              content: [{ type: 'text', text: 'No active task is attached to this session.' }],
              isError: true,
              details: undefined,
            }
          }
          const questionId = `q-${Date.now().toString(36)}`
          task.questionId = questionId
          task.awaitingAnswer = true
          this.stopTaskWatchdogs(task)
          this.deps.onQuestion(task.id, questionId, redactSecrets(question))
          this.setStatus(task.id, 'waiting_human')
          return {
            content: [
              {
                type: 'text',
                text: 'The question was sent to the user. Stop here and wait for the answer.',
              },
            ],
            isError: false,
            details: undefined,
          }
        },
      })
    }
  }

  /** 优先按 sessionId / cwd 精确匹配工单，找不到时再退回首个活跃工单 */
  private currentTaskForSession(sessionId?: string, cwd?: string): ActiveTask | undefined {
    if (sessionId) {
      for (const task of this.active.values()) {
        if (task.sessionId === sessionId) return task
      }
    }
    if (cwd) {
      const target = path.resolve(cwd).toLowerCase()
      for (const task of this.active.values()) {
        if (path.resolve(task.worktreePath).toLowerCase() === target) return task
      }
    }
    for (const task of this.active.values()) {
      if (task.awaitingAnswer) continue
      return task
    }
    return this.active.values().next().value
  }

  private setStatus(taskId: string, status: CloudTaskStatus): void {
    const task = this.active.get(taskId)
    if (task) task.status = status
    const persisted = this.persistedTasks.get(taskId)
    if (persisted) {
      persisted.status = status
      void this.persistTasks()
    }
    this.deps.onStatus(taskId, status)
  }

  /** 统一出口：所有上报给云端的里程碑文本必须先过密钥脱敏，防止命令输出或参数预览外泄密钥 */
  private emitMilestone(taskId: string, milestone: CloudTaskMilestone): void {
    const safeText = redactSecrets(milestone.text)
    this.deps.onMilestone(
      taskId,
      safeText === milestone.text ? milestone : { ...milestone, text: safeText }
    )
  }

  private reportBlocked(info: TaskGuardInfo): void {
    const task = this.currentTaskForSession(undefined, info.cwd)
    if (!task) return
    this.emitMilestone(task.id, {
      kind: 'progress',
      text: `已拦截一次越界操作（${info.toolName}）：${truncate(redactSecrets(info.reason), 200)}`,
      at: Date.now(),
    })
  }

  async start(taskId: string, spec: CloudTaskSpec, attempt = 0): Promise<void> {
    if (this.disposed) return
    if (this.active.has(taskId) || this.starting.has(taskId)) {
      this.deps.logger.warn(`[Cloud Task] task ${taskId} is already running`)
      return
    }
    // 立即登记启动占位并强制走 startChain 串行化（无论 attempt 取何值都不得绕过）
    this.starting.set(taskId, spec.workUnitId)
    const run = this.startChain
      .catch(() => undefined)
      .then(() => this.runStart(taskId, spec, attempt))
    this.startChain = run.catch(() => undefined)
    return run
  }

  private async runStart(taskId: string, spec: CloudTaskSpec, attempt: number): Promise<void> {
    if (this.disposed) {
      this.starting.delete(taskId)
      return
    }
    if (this.cancelRequested.has(taskId)) {
      this.starting.delete(taskId)
      this.cancelRequested.delete(taskId)
      return
    }
    try {
      // 先回一张 `assigned`：云端 `queued` 表示“已生成、终端未 ack”，而下面建工作树、建会话都可能失败。
      // 不回这一帧，失败就落在云端不允许的 `queued → failed` 上，工单会永远挂在执行中并堵住 FIFO。
      if (attempt === 0) this.deps.onStatus(taskId, 'assigned')

      const worktree = await this.ensureUnitWorktree(spec)
      if (this.cancelRequested.has(taskId)) {
        this.cancelRequested.delete(taskId)
        const clean = worktree.ok && worktree.record ? await this.isWorktreeClean(worktree.record.worktreePath) : true
        // 必须先释放 starting 占位再发终态帧，否则云端立刻回发的 close_unit 会被误判为 task-running（P-09）
        this.starting.delete(taskId)
        this.deps.onInterrupted(taskId, 'user-cancel', clean)
        return
      }
      if (!worktree.ok || !worktree.record) {
        if (worktree.record) {
          await this.failWithWorktree(
            taskId,
            worktree.error ?? 'Unable to prepare the worktree',
            worktree.record.worktreePath
          )
          return
        }
        // 树都没建起来（或守卫安装失败已即时释放）：云端那个单元没有 worktree 可收，按「干净」报一次让它能收口
        this.starting.delete(taskId)
        this.deps.onFailed(taskId, worktree.error ?? 'Unable to prepare the worktree', undefined, true)
        return
      }
      const unit = worktree.record
      this.deps.onWorktree(taskId, spec.workUnitId, unit.worktreePath, unit.branch ?? undefined)

      let manager: TaskAgentManager
      try {
        manager = await this.ensureManager()
      } catch (error) {
        if (this.disposed) {
          this.starting.delete(taskId)
          return
        }
        if (this.cancelRequested.has(taskId)) {
          this.cancelRequested.delete(taskId)
          const clean = await this.isWorktreeClean(unit.worktreePath)
          this.starting.delete(taskId)
          this.deps.onInterrupted(taskId, 'user-cancel', clean)
          return
        }
        // 在 startChain 内部原地重试一次（例如用户刚在设置里填好 Key），既持有 starting 占位也不绕过串行链
        const refreshed = attempt === 0 ? await this.retryAfterConfigRefresh(taskId) : null
        if (this.disposed) {
          this.starting.delete(taskId)
          return
        }
        if (this.cancelRequested.has(taskId)) {
          this.cancelRequested.delete(taskId)
          const clean = await this.isWorktreeClean(unit.worktreePath)
          this.starting.delete(taskId)
          this.deps.onInterrupted(taskId, 'user-cancel', clean)
          return
        }
        if (!refreshed) {
          // 准备阶段就失败（未配 Key 最常见）：必须带上 worktreeClean，否则云端不会回收这棵树
          await this.failWithWorktree(taskId, error instanceof Error ? error.message : String(error), unit.worktreePath)
          return
        }
        manager = refreshed
      }
      if (this.cancelRequested.has(taskId)) {
        this.cancelRequested.delete(taskId)
        const clean = await this.isWorktreeClean(unit.worktreePath)
        this.starting.delete(taskId)
        this.deps.onInterrupted(taskId, 'user-cancel', clean)
        return
      }

      let sessionId = ''
      try {
        const created = await manager.createSession(unit.worktreePath, {
          permission: { mode: 'auto', grants: [] },
        })
        // 严禁在 createSession 失败时回落到 getCurrentSessionId()，否则会静默劫持上一张工单的会话与 worktree
        if (created && created.success === false) {
          await this.failWithWorktree(
            taskId,
            String(created.error ?? 'Unable to create a task session'),
            unit.worktreePath
          )
          return
        }
        sessionId = String(created?.session?.id ?? created?.sessionId ?? created?.id ?? '')
      } catch (error) {
        await this.failWithWorktree(taskId, error instanceof Error ? error.message : String(error), unit.worktreePath)
        return
      }
      if (!sessionId) {
        await this.failWithWorktree(taskId, 'Unable to create a task session', unit.worktreePath)
        return
      }

      if (this.cancelRequested.has(taskId)) {
        this.cancelRequested.delete(taskId)
        void manager.closeSession?.(sessionId)?.catch?.(() => undefined)
        const clean = await this.isWorktreeClean(unit.worktreePath)
        this.starting.delete(taskId)
        this.deps.onInterrupted(taskId, 'user-cancel', clean)
        return
      }

      const task: ActiveTask = {
        id: taskId,
        spec,
        unitId: spec.workUnitId,
        repoPath: spec.repo.workspacePath,
        worktreePath: unit.worktreePath,
        sessionId,
        manager,
        status: 'assigned',
        startedAt: this.now(),
        lastMilestoneAt: 0,
        changed: new Map(),
        runningTools: new Map(),
        awaitingAnswer: false,
      }
      this.active.set(taskId, task)
      this.starting.delete(taskId)
      this.persistedTasks.set(taskId, {
        id: taskId,
        unitId: spec.workUnitId,
        repoPath: task.repoPath,
        worktreePath: unit.worktreePath,
        status: 'assigned',
        startedAt: task.startedAt,
      })
      await this.persistTasks()
      this.setStatus(taskId, 'assigned')

      try {
        const unsub = await manager.subscribeTrace?.(sessionId, (event: TaskTraceEvent) =>
          this.onTrace(task, event)
        )
        if (typeof unsub === 'function') task.unsubscribeTrace = unsub
      } catch (error) {
        this.deps.logger.warn('[Cloud Task] failed to subscribe trace:', error)
      }

      this.setStatus(taskId, 'running')
      this.startTaskWatchdogs(task)
      this.emitMilestone(taskId, { kind: 'accepted', text: '已接单，开始执行', at: this.now() })

      const firstTurn = this.runTurn(task, spec, buildTaskPrompt(spec, unit.worktreePath))
      task.turnChain = firstTurn.catch(() => undefined)
      await firstTurn
    } finally {
      this.starting.delete(taskId)
    }
  }

  /**
   * 准备阶段失败（还没进 `active`）：也要把脏标记报上去。
   * 这些失败点在工作树已建好之后，不报 `worktreeClean` 云端就永远不发回收请求，树一直挂在磁盘上。
   */
  private async failWithWorktree(
    taskId: string,
    error: string,
    worktreePath: string
  ): Promise<void> {
    let changedFiles: CloudChangedFile[] = []
    let clean = true
    try {
      const output = await this.git(worktreePath, ['status', '--porcelain'])
      changedFiles = annotateChangedFiles(parsePorcelainChangedFiles(output))
      clean = changedFiles.length === 0
    } catch {
      // git 不可用：按“不确定”处理，宁可保留树也不要误删
      clean = false
    }
    const secretHits = clean ? [] : await scanWorktreeSecrets(undefined, worktreePath).catch(() => [])
    // 必须先释放 starting 占位再发 task_failed，否则云端立刻回发 close_unit 会被 closeUnit 误判为 task-running（P-09）
    this.starting.delete(taskId)
    this.deps.onFailed(
      taskId,
      error,
      changedFiles,
      clean,
      secretHits.length > 0 ? secretHits : undefined
    )
  }

  /** 配置刚改过时在当前 startChain 内延迟 1s 重试一次 ensureManager，绝不绕过串行链 */
  private async retryAfterConfigRefresh(taskId: string): Promise<TaskAgentManager | null> {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    if (this.disposed || this.cancelRequested.has(taskId)) return null
    try {
      return await this.ensureManager()
    } catch {
      return null
    }
  }

  private async runTurn(task: ActiveTask, spec: CloudTaskSpec, prompt: string): Promise<void> {
    try {
      const manager = this.taskManager(task)
      if (!manager) {
        await this.finishFailed(task, 'Task agent manager is not initialized')
        return
      }
      const outcome = await manager.chat(task.sessionId, prompt)
      if (this.cancelRequested.has(task.id)) {
        this.cancelRequested.delete(task.id)
        return
      }
      if (!task.awaitingAnswer && outcome && outcome.success === false) {
        await this.finishFailed(task, outcome.error ?? 'task turn failed')
        return
      }
      if (task.awaitingAnswer) return
      await this.finishDone(task, spec, outcome)
    } catch (error) {
      if (this.cancelRequested.has(task.id)) {
        this.cancelRequested.delete(task.id)
        return
      }
      await this.finishFailed(task, error instanceof Error ? error.message : String(error))
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** 启动工单运行期看门狗：工具静默检测（10 分钟）+ 工单心跳（60 s）（C-02） */
  private startTaskWatchdogs(task: ActiveTask): void {
    this.stopTaskWatchdogs(task)
    const stallMs = Math.max(50, this.deps.toolStallMs ?? CLOUD_TOOL_STALL_MS)
    const pollMs = Math.min(30_000, Math.max(25, Math.floor(stallMs / 4)))
    task.stallTimer = setInterval(() => {
      if (this.disposed || task.awaitingAnswer || task.status !== 'running') return
      const now = this.now()
      for (const tool of task.runningTools.values()) {
        if (tool.reported) continue
        const idleMs = now - tool.lastOutputAt
        if (idleMs >= stallMs) {
          tool.reported = true
          this.deps.onStalled?.(task.id, { toolName: tool.toolName, idleMs, at: now })
        }
      }
    }, pollMs)
    task.stallTimer.unref?.()

    const heartbeatMs = Math.max(50, this.deps.taskHeartbeatMs ?? CLOUD_TASK_HEARTBEAT_MS)
    task.heartbeatTimer = setInterval(() => {
      if (this.disposed || task.awaitingAnswer || task.status !== 'running') return
      this.deps.onTaskHeartbeat?.(task.id, this.now())
    }, heartbeatMs)
    task.heartbeatTimer.unref?.()
  }

  private stopTaskWatchdogs(task: ActiveTask): void {
    if (task.stallTimer) {
      clearInterval(task.stallTimer)
      task.stallTimer = undefined
    }
    if (task.heartbeatTimer) {
      clearInterval(task.heartbeatTimer)
      task.heartbeatTimer = undefined
    }
    task.runningTools.clear()
  }

  private onTrace(task: ActiveTask, event: TaskTraceEvent | null | undefined): void {
    if (!event || this.disposed) return
    try {
      const toolKey = String(event.toolCallId ?? event.toolName ?? '')
      if (event.type === 'tool_update') {
        const running = toolKey ? task.runningTools.get(toolKey) : undefined
        if (running) {
          running.lastOutputAt = this.now()
          running.reported = false
        }
        return
      }
      if (event.type === 'tool_end') {
        if (toolKey) task.runningTools.delete(toolKey)
        if (event.status !== 'success') return
        const filePath = typeof event.filePath === 'string' ? event.filePath : ''
        if (filePath && (event.toolName === 'write' || event.toolName === 'edit')) {
          this.noteChanged(task, filePath, 'modified')
        }
        if (event.toolName === 'bash' || event.toolName === 'powershell') {
          // 必须先脱敏再截断，否则被截断一半的密钥无法命中规则而泄露半截凭据
          const safePreview = redactSecrets(String(event.resultPreview ?? ''))
          this.maybeMilestone(task, {
            kind: 'progress',
            text: `执行命令：${truncate(safePreview, 80) || event.toolName}`,
            at: this.now(),
          })
        }
        return
      }
      if (event.type === 'tool_start') {
        const toolName = String(event.toolName ?? '')
        if (toolKey) {
          task.runningTools.set(toolKey, {
            toolName: toolName || 'tool',
            lastOutputAt: this.now(),
            reported: false,
          })
        }
        if (toolName === 'write' || toolName === 'edit') {
          const targetPath = extractWriteOrEditPath(event)
          if (targetPath) this.noteChanged(task, targetPath, 'modified')
        }
        const safeArgs = redactSecrets(String(event.argsSummary ?? ''))
        this.maybeMilestone(task, {
          kind: 'progress',
          text: `${toolName} ${truncate(safeArgs, 100)}`.trim(),
          at: this.now(),
        })
      }
    } catch (error) {
      this.deps.logger.warn('[Cloud Task] trace projection failed:', error)
    }
  }

  private noteChanged(task: ActiveTask, filePath: string, kind: CloudChangedFile['kind']): void {
    const relative = toWorktreeRelative(task.worktreePath, filePath)
    if (!relative) return
    const normalized = relative.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!normalized || task.changed.has(normalized)) return
    task.changed.set(normalized, { path: normalized, kind })
    if (task.changed.size === 1) {
      this.emitMilestone(task.id, {
        kind: 'first-change',
        text: `第一次改动：${normalized}`,
        at: Date.now(),
        changedFiles: [...task.changed.values()],
      })
    }
  }

  private maybeMilestone(task: ActiveTask, milestone: CloudTaskMilestone): void {
    const now = Date.now()
    if (now - task.lastMilestoneAt < MILESTONE_THROTTLE_MS) return
    task.lastMilestoneAt = now
    this.emitMilestone(task.id, milestone)
  }

  private async finishDone(
    task: ActiveTask,
    spec: CloudTaskSpec,
    outcome: TaskChatOutcome | undefined
  ): Promise<void> {
    const changedFiles = await this.collectChangedFiles(task)
    // F-19a：干净 = 什么都没留下来，服务端可以自动回收（脏树则保留等用户）
    const worktreeClean = await this.isWorktreeClean(task.worktreePath)
    const secretHits = await scanWorktreeSecrets(
      this.units.get(task.unitId)?.base,
      task.worktreePath
    ).catch(() => [] as CloudSecretHit[])
    const diff = await collectTaskDiff(
      this.units.get(task.unitId)?.base,
      task.worktreePath,
      spec.output.diffLimitBytes
    ).catch(() => undefined)
    let commit = ''
    let branch = ''
    try {
      const rev = await this.git(task.worktreePath, ['rev-parse', '--short', 'HEAD'])
      commit = rev.trim()
      const head = await this.git(task.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
      branch = head.trim()
    } catch {
      // 不是 git 仓库或还没提交：留空即可
    }
    const rawSummary = String(outcome?.response ?? '').trim()
    const summary = (rawSummary ? redactSecrets(rawSummary) : '') || '(模型没有返回总结)'
    const result: CloudTaskResult = {
      summary,
      changedFiles,
      branch: branch && branch !== 'HEAD' ? branch : undefined,
      commit: commit || undefined,
      secretHits: secretHits.length > 0 ? secretHits : undefined,
      ...(diff ? { diff } : {}),
      worktreeClean,
    }
    if (changedFiles.length === 0) {
      result.notes = '没有检测到文件改动'
    } else if (spec.commit && !commit) {
      result.notes = '本单要求提交，但工作树里没有新提交'
    }
    this.stopTaskWatchdogs(task)
    this.releaseTaskSession(task)
    this.active.delete(task.id)
    this.disposeUnusedRetiredManagers()
    this.cancelRequested.delete(task.id)
    this.persistedTasks.delete(task.id)
    await this.persistTasks()
    this.deps.onResult(task.id, result)
  }

  private async finishFailed(task: ActiveTask, error: string): Promise<void> {
    this.stopTaskWatchdogs(task)
    this.releaseTaskSession(task)
    const changedFiles = await this.collectChangedFiles(task).catch(() => [] as CloudChangedFile[])
    const worktreeClean = await this.isWorktreeClean(task.worktreePath)
    const secretHits = await scanWorktreeSecrets(
      this.units.get(task.unitId)?.base,
      task.worktreePath
    ).catch(() => [] as CloudSecretHit[])
    this.active.delete(task.id)
    this.disposeUnusedRetiredManagers()
    this.cancelRequested.delete(task.id)
    this.persistedTasks.delete(task.id)
    await this.persistTasks().catch(() => undefined)
    this.deps.onFailed(
      task.id,
      redactSecrets(error),
      changedFiles,
      worktreeClean,
      secretHits.length > 0 ? secretHits : undefined
    )
  }

  /** 退订流式轨迹并释放工单会话句柄，防止每单泄漏监听与 SDK 会话内存 */
  private releaseTaskSession(task: ActiveTask): void {
    try {
      task.unsubscribeTrace?.()
    } catch {
      // ignore
    }
    task.unsubscribeTrace = undefined
    void this.taskManager(task)?.closeSession?.(task.sessionId)?.catch?.(() => undefined)
  }

  /** 工作树是否干净：`git status --porcelain` 无输出（ignored 文件不算脏，所以装了依赖也算干净） */
  private async isWorktreeClean(worktreePath: string): Promise<boolean> {
    try {
      const output = await this.git(worktreePath, ['status', '--porcelain'])
      return output.trim().length === 0
    } catch {
      // git 不可用 / 目录已不在：一律当脏，宁可不删
      return false
    }
  }

  // ------------------------------ 工作单元回收（F-19a / A-43） ------------------------------

  /**
   * 回收一个工作单元的工作树。
   * 一律走 `coordinator.release()`：它内部有讲行队列、会终止依赖安装，并按三态处理
   * （脏树保留 / 干净且无新提交删树删分支 / 有提交只删目录保留 `pi/*` 分支）。
   */
  async closeUnit(unitId: string): Promise<{ ok: boolean; error?: string }> {
    return this.withUnitLock(unitId, async () => {
      const record = this.units.get(unitId)
      for (const task of this.active.values()) {
        // 云端已拦过；终端再兜一次，绝不在工单还在写文件时回收
        if (task.unitId === unitId) return { ok: false, error: 'task-running' }
      }
      for (const startingUnitId of this.starting.values()) {
        if (startingUnitId === unitId) return { ok: false, error: 'task-running' }
      }
      if (!record) {
        // 没有台账（已回收 / 从未建树）：告知云端可以收口
        this.deps.onUnitClosed(unitId, { removed: false, dirty: false })
        return { ok: true }
      }

      const coordinator = await this.deps.getCoordinator(record.repoPath)
      if (!coordinator) {
        this.deps.onUnitClosed(unitId, {
          removed: false,
          dirty: false,
          worktreePath: record.worktreePath,
          branch: record.branch ?? undefined,
          error: 'not-a-repo',
        })
        return { ok: false, error: 'not-a-repo' }
      }

      const binding = `${UNIT_BINDING_PREFIX}${unitId}`
      let released: Awaited<ReturnType<typeof coordinator.release>>
      try {
        // 脏树那一次 `release()` 已经把绑定删了（但树留着）：不重挂的话第二次 `release()`
        // 只会看到“没有绑定”直接返回成功，我们会错报“已回收”而磁盘上树还在。
        if (!coordinator.hasBinding(binding) && existsSync(record.worktreePath)) {
          await coordinator.bind(binding, record.worktreePath)
        }
        released = await coordinator.release(binding)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.deps.logger.warn(`[Cloud Task] failed to release ${binding}:`, message)
        this.deps.onUnitClosed(unitId, {
          removed: false,
          dirty: false,
          worktreePath: record.worktreePath,
          error: message,
        })
        return { ok: false, error: message }
      }

      const dirty = released.dirty === true
      const removed = released.removed === true
      const settled = released.success !== false
      // 只有“真处理掉了”（已删 / 目录本就不在 / 本来就脏）才删台账：
      // 删树失败时保留台账，否则下次同 unitId 会再建一棵、旧树变孤儿
      if (settled && !dirty) {
        this.units.delete(unitId)
        await this.persistUnits().catch(() => undefined)
      }
      this.deps.onUnitClosed(unitId, {
        removed,
        dirty,
        worktreePath: released.worktreePath ?? record.worktreePath,
        branch: record.branch ?? undefined,
        error: settled ? undefined : released.error,
      })
      return { ok: settled, error: released.error }
    })
  }

  /**
   * 启动兜底（A-43）：把本地台账里每个单元的工作树状态上报一次。
   * 覆盖“设备离线被取消 / 进程被杀，没来得及报 worktreeClean”的单元。
   */
  async sweepUnits(): Promise<void> {
    for (const [unitId, record] of [...this.units]) {
      if (!existsSync(record.worktreePath)) {
        // 工作树已经不在了：丢台账，让云端能收口
        this.units.delete(unitId)
        this.deps.onUnitClosed(unitId, {
          removed: false,
          dirty: false,
          worktreePath: record.worktreePath,
          branch: record.branch ?? undefined,
        })
        continue
      }
      const clean = await this.isWorktreeClean(record.worktreePath)
      this.deps.onUnitState(unitId, { clean, worktreePath: record.worktreePath })
    }
    await this.persistUnits().catch(() => undefined)
  }

  private async collectChangedFiles(task: ActiveTask): Promise<CloudChangedFile[]> {
    return collectTaskChangedFiles(this.units.get(task.unitId)?.base, task.worktreePath, [
      ...task.changed.values(),
    ])
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: sanitizeTerminalEnv(process.env),
    })
    return stdout
  }

  /** 用户停止：中止本轮，工作树与分支保留（改动可能有用） */
  async cancel(taskId: string, reason = 'user-cancel'): Promise<boolean> {
    const task = this.active.get(taskId)
    if (!task) {
      // 工单尚在准备阶段（建 worktree / 建会话）：登记取消标记，由 runStart 在下一个检查点结算
      if (this.starting.has(taskId)) {
        this.cancelRequested.add(taskId)
        return true
      }
      return false
    }
    this.cancelRequested.add(taskId)
    try {
      await this.taskManager(task)?.abort?.(task.sessionId)
    } catch (error) {
      this.deps.logger.warn('[Cloud Task] abort failed:', error)
    }
    this.stopTaskWatchdogs(task)
    this.releaseTaskSession(task)
    // abort 之后再判：停止了但树是干净的，服务端可以直接自动回收（A-43）
    const worktreeClean = await this.isWorktreeClean(task.worktreePath)
    this.active.delete(taskId)
    this.disposeUnusedRetiredManagers()
    this.persistedTasks.delete(taskId)
    await this.persistTasks().catch(() => undefined)
    this.deps.onInterrupted(taskId, reason, worktreeClean)
    return true
  }

  /** 用户回答 `ask_cloud` 的问题：校验等待状态并按工单串行链续跑，防止重放帧并发调 chat */
  async answer(taskId: string, text: string, questionId?: string): Promise<boolean> {
    const task = this.active.get(taskId)
    if (!task) return false
    if (!task.awaitingAnswer) return false
    if (task.questionId && questionId && task.questionId !== questionId) return false
    // 必须在任何 await 之前同步消费 awaitingAnswer，阻止重复到达的 task_answer 并发调用 manager.chat()
    task.awaitingAnswer = false
    task.questionId = undefined
    const run = (task.turnChain ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.runAnswerTurn(task, text))
    task.turnChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async runAnswerTurn(task: ActiveTask, text: string): Promise<boolean> {
    if (this.disposed || !this.active.has(task.id) || this.cancelRequested.has(task.id)) {
      return false
    }
    this.setStatus(task.id, 'running')
    this.startTaskWatchdogs(task)
    try {
      const manager = this.taskManager(task)
      if (!manager) {
        await this.finishFailed(task, 'Task agent manager is not initialized')
        return false
      }
      const outcome = await manager.chat(
        task.sessionId,
        `用户的回答（针对上一个问题）：\n\n${text.trim()}\n\n请继续执行工单。`
      )
      if (this.cancelRequested.has(task.id)) {
        this.cancelRequested.delete(task.id)
        return false
      }
      // 回答后模型若再次调用 ask_cloud 提问，本轮必须停手等待下一次回答，不能误结算
      if (task.awaitingAnswer) return true
      if (outcome && outcome.success === false) {
        await this.finishFailed(task, outcome.error ?? 'task turn failed')
        return false
      }
      await this.finishDone(task, task.spec, outcome)
      return true
    } catch (error) {
      if (this.cancelRequested.has(task.id)) {
        this.cancelRequested.delete(task.id)
        return false
      }
      await this.finishFailed(task, error instanceof Error ? error.message : String(error))
      return false
    }
  }

  /** 插话：不结束本轮，按 steer 注入，并回送一条确认里程碑（C-03d） */
  async message(taskId: string, text: string): Promise<boolean> {
    const task = this.active.get(taskId)
    if (!task) return false
    const manager = this.taskManager(task)
    if (!manager) return false
    const preview = redactSecrets(text).trim().replace(/\s+/g, ' ').slice(0, 80)
    if (preview) {
      this.emitMilestone(task.id, {
        kind: 'progress',
        text: `已收到追加指令：${preview}`,
        at: this.now(),
      })
    }
    const busy = Boolean(manager?.isSessionBusy?.(task.sessionId))
    try {
      if (busy) {
        await manager.steer?.(task.sessionId, text)
      } else {
        const outcome = await manager.chat(task.sessionId, text)
        if (this.cancelRequested.has(task.id)) {
          this.cancelRequested.delete(task.id)
          return false
        }
        if (task.awaitingAnswer) return true
        if (outcome && outcome.success === false) {
          await this.finishFailed(task, outcome.error ?? 'task turn failed')
          return false
        }
        await this.finishDone(task, task.spec, outcome)
      }
      return true
    } catch (error) {
      this.deps.logger.warn('[Cloud Task] steer/message failed:', error)
      if (!busy && this.active.has(task.id)) {
        await this.finishFailed(task, error instanceof Error ? error.message : String(error))
      }
      return false
    }
  }

  isRunning(taskId: string): boolean {
    return this.active.has(taskId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const task of [...this.active.values()]) {
      this.stopTaskWatchdogs(task)
      // 必须先 abort 再 closeSession：先关闭会话会导致 abort 找不到会话而无法终止在途请求
      try {
        await this.taskManager(task)?.abort?.(task.sessionId)
      } catch {
        // ignore
      }
      this.releaseTaskSession(task)
    }
    this.active.clear()
    this.cancelRequested.clear()
    const managersToDispose = new Set<TaskAgentManager>(this.retiredManagers)
    if (this.manager) managersToDispose.add(this.manager)
    this.retiredManagers.clear()
    this.manager = null
    for (const mgr of managersToDispose) {
      await mgr?.dispose?.().catch(() => undefined)
    }
  }
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

export function buildTaskPrompt(spec: CloudTaskSpec, worktreePath: string): string {
  const lines = [
    '你正在执行云端下发的一张工单。你跑在一个专用的 git worktree 里，改动不会碰用户的主工作区。',
    '',
    `工单标题：${spec.title}`,
    `工作目录：${worktreePath}`,
    '',
    '## 背景',
    spec.background || '(未提供)',
    '',
    '## 目标',
    spec.goal,
    '',
    '## 验收标准',
    spec.acceptance,
  ]
  if (spec.expectedChanges) {
    lines.push('', '## 预期改动范围（沟通用，不是限制）', spec.expectedChanges)
  }
  if (spec.forbidden?.length) {
    lines.push('', '## 禁止事项', ...spec.forbidden.map((item) => `- ${item}`))
  }
  lines.push(
    '',
    '## 规则',
    '- 只在当前工作目录内写文件；工作目录之外的绝对路径会被拒绝。',
    '- 不要 `git push`；需要提交时就地提交，并把分支与提交号写进总结。',
    '- 需要用户决策（方案、取舍、权限之外的资源）时调用 `ask_cloud`，然后结束本轮等待回答。',
    '- 结束时用中文写总结：做了什么、改了哪些文件、跑了什么验证、还有什么没做。'
  )
  return lines.join('\n')
}

function serializeApiOverrides(
  overrides?: Record<string, { contextWindow?: number; maxTokens?: number }>
): string {
  if (!overrides) return ''
  const entries = Object.keys(overrides)
    .sort()
    .map((key) => [key, overrides[key]?.contextWindow ?? null, overrides[key]?.maxTokens ?? null])
  return JSON.stringify(entries)
}

/** 仅按 porcelain 前两位状态码判定文件改动类型，绝不对文件名本身做 includes('D') */
function parsePorcelainChangedFiles(output: string): CloudChangedFile[] {
  const result: CloudChangedFile[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const status = line.slice(0, 2)
    const filePath = line.slice(3).trim().replace(/^"|"$/g, '').replace(/\\/g, '/')
    if (!filePath) continue
    const kind: CloudChangedFile['kind'] =
      status.trim() === '??'
        ? 'added'
        : status.includes('D')
          ? 'deleted'
          : status.includes('R')
            ? 'renamed'
            : 'modified'
    result.push({ path: filePath, kind })
  }
  return result
}

/**
 * 从 write / edit 工具起始事件中提取完整目标路径：
 * 优先结构化字段与已知 JSON 路径键，其次按 `summarizeToolArgs` 的 `<path> · <元信息>` 切分，
 * 避免用粗正则误把 `src/foo.bar/baz.ts` 中的带点目录段 `foo.bar` 当成独立改动文件。
 */
function extractWriteOrEditPath(event: TaskTraceEvent | null | undefined): string | null {
  if (typeof event?.filePath === 'string' && event.filePath.trim()) {
    return event.filePath.trim()
  }
  const rawArgs = event?.args
  if (rawArgs && typeof rawArgs === 'object') {
    for (const key of ['path', 'file_path', 'filePath', 'target']) {
      const value = (rawArgs as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  const summary = typeof event?.argsSummary === 'string' ? event.argsSummary.trim() : ''
  if (!summary) return null
  if (summary.startsWith('{')) {
    try {
      const parsed = JSON.parse(summary) as Record<string, unknown>
      for (const key of ['path', 'file_path', 'filePath', 'target']) {
        const value = parsed[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    } catch {
      const keyMatch = /"(?:path|file_path|filePath|target)"\s*:\s*"((?:\\.|[^"\\])+)"/.exec(summary)
      if (keyMatch) {
        try {
          const decoded = JSON.parse(`"${keyMatch[1]}"`)
          if (typeof decoded === 'string' && decoded.trim()) return decoded.trim()
        } catch {
          return keyMatch[1].trim()
        }
      }
    }
    return null
  }
  if (summary.startsWith('·')) return null
  const head = summary.split(/\s+·\s+/)[0]?.trim() ?? ''
  const unquoted = head.replace(/^['"]|['"]$/g, '').trim()
  if (!unquoted || unquoted.startsWith('·') || /[\r\n]/.test(unquoted)) return null
  return unquoted
}

/** 给测试用的纯函数版本（压缩参数写入、porcelain 解析与工具路径提取） */
export const taskRunnerInternals = {
  ensureTaskAgentSettings,
  TASK_COMPACTION_SETTINGS,
  parsePorcelainChangedFiles,
  extractWriteOrEditPath,
  serializeApiOverrides,
}

function normalizeCloudPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^"|"$/g, '')
}

const WINDOWS_DRIVE_PATH = /^([A-Za-z]):[\\/]/

/**
 * 工具的路径参数 → 工作树里的相对路径；不在树里就返回 null。
 *
 * 必须同时排除跨盘符：Windows 上 `path.relative('C:\\tree', 'E:/x')` 会原样返回绝对路径，
 * 只查 `startsWith('..')` 的话会把 `E:/second.txt` 这种外部路径当成改动写进清单。
 * 盘符前缀要显式判断，否则同一份代码在 POSIX 上（CI 跑 Linux）会把 `E:/x` 当成相对路径放行。
 */
export function toWorktreeRelative(worktreePath: string, filePath: string): string | null {
  const reportedDrive = WINDOWS_DRIVE_PATH.exec(filePath)?.[1]?.toLowerCase()
  if (reportedDrive && reportedDrive !== WINDOWS_DRIVE_PATH.exec(worktreePath)?.[1]?.toLowerCase()) {
    return null
  }
  const relative = path.isAbsolute(filePath) ? path.relative(worktreePath, filePath) : filePath
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative
}

/**
 * 改动清单：三个来源合并。
 *
 * 1. 工具轨迹里记到的路径（文件工具写的，一定算）；
 * 2. `git status --porcelain`：还没提交的现场；
 * 3. `git diff --name-status <base>...HEAD`：**已提交**的改动。
 *
 * 第三个不能少：模型常用 bash（`printf > f && git commit`）改文件，工具轨迹里没有它，
 * 提交后 status 又是空的，少了这一行就会在云端显示「没有检测到文件改动」—— 而磁盘上明明有提交。
 */
export async function collectTaskChangedFiles(
  base: string | undefined,
  worktreePath: string,
  known: CloudChangedFile[]
): Promise<CloudChangedFile[]> {
  const files = new Map<string, CloudChangedFile>()
  for (const file of known) {
    const key = normalizeCloudPath(file.path)
    if (key) files.set(key, { ...file, path: key })
  }
  const run = (args: string[]): Promise<string> =>
    execFileAsync('git', ['-C', worktreePath, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: sanitizeTerminalEnv(process.env),
    }).then((result) => result.stdout)

  try {
    const output = await run(['status', '--porcelain'])
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue
      const status = line.slice(0, 2).trim()
      const filePath = normalizeCloudPath(line.slice(3).trim())
      if (!filePath) continue
      const kind: CloudChangedFile['kind'] =
        status === '??' ? 'added' : status.includes('D') ? 'deleted' : status.includes('R') ? 'renamed' : 'modified'
      files.set(filePath, { path: filePath, kind })
    }
  } catch {
    // git 不可用：退回工具轨迹里记到的路径
  }

  if (base) {
    try {
      const output = await run(['diff', '--name-status', `${base}...HEAD`])
      for (const line of output.split(/\r?\n/)) {
        const [code, ...rest] = line.split('\t')
        if (!code || rest.length === 0) continue
        // 重命名/复制占两列：取目标路径
        const filePath = normalizeCloudPath(rest[rest.length - 1] ?? '')
        if (!filePath) continue
        const kind: CloudChangedFile['kind'] =
          code.startsWith('A') || code.startsWith('C')
            ? 'added'
            : code.startsWith('D')
              ? 'deleted'
              : code.startsWith('R')
                ? 'renamed'
                : 'modified'
        // 未提交的现场优先（status 更准）
        if (!files.has(filePath)) files.set(filePath, { path: filePath, kind })
      }
    } catch {
      // base 分支没了 / 不是 git：退回到前两个来源
    }
  }

  return annotateChangedFiles([...files.values()].slice(0, 200))
}
