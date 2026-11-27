/**
 * 主进程 Agent utilityProcess 代理（实现 `RegisteredAgent` 接口）。
 *
 * 职责：
 * - 为单个工作区派生隔离的 Electron `utilityProcess`（`agent-host-worker.js`），将 PID 登记进 `childRegistry`；
 * - 代理全部 `AgentManager` 方法的 RPC 往返，并在主进程侧承接 `safeStorage` 凭证、模型缓存、文档抽取、工具审批与工作树回调；
 * - 通过 `MessageChannelMain` 建立 `utilityProcess ↔ Renderer` 直连流式端口（零主进程逐 token 中转）；
 * - 监控 `exit` 事件：异常崩溃时立即拒绝对话/挂起 RPC、清理本地状态并触发 `onCrash` 实现自愈。
 */

import * as fs from 'fs'
import { fileURLToPath } from 'url'
import * as electron from 'electron'
import type {
  AgentConfig,
  AgentLogger,
  ApprovalDecision,
  ApprovalRequestPayload,
  McpServerConfig,
  McpServerStatus,
  TrackedModelsStore,
} from 'pi-bridge'
import type {
  AgentChatOutcome,
  RegisteredAgent,
  SessionPermissionPayload,
  StructuredPlanPayload,
} from './agent-registry.js'
import { childRegistry, killProcessTreeAsync, type ChildRegistry } from './child-registry.js'
import type {
  AgentChatRpcInput,
  AgentHostCallbackMethod,
  AgentHostEventName,
  AgentHostInitPayload,
  AgentHostRpcMethod,
  AgentHostSyncState,
  AgentStreamWirePayload,
  AgentWorkerToMainMessage,
  MainToAgentWorkerMessage,
  MessagePortLike,
} from './agent-host-protocol.js'

type CredentialStoreLike = NonNullable<AgentConfig['credentials']>
type CredentialValue = Awaited<ReturnType<CredentialStoreLike['read']>>
type ModelsStoreWriteEntry = Parameters<TrackedModelsStore['write']>[1]
type DocumentReadResult = Awaited<ReturnType<NonNullable<AgentConfig['readDocument']>>>
type WorktreeSwitchResult = Awaited<ReturnType<NonNullable<AgentConfig['onWorktreeSwitch']>>>

export interface UtilityProcessLike {
  readonly pid?: number
  readonly stdout?: NodeJS.ReadableStream | null
  readonly stderr?: NodeJS.ReadableStream | null
  postMessage(message: unknown, transfer?: unknown[]): void
  kill(): boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(event: 'spawn', listener: () => void): unknown
  on(
    event: 'error',
    listener: (type: string, location: string, report: string) => void
  ): unknown
  once?(event: 'spawn' | 'exit', listener: (...args: unknown[]) => void): unknown
}

export interface UtilityProcessForkOptions {
  serviceName?: string
  stdio?: 'inherit' | 'pipe' | 'ignore' | Array<'inherit' | 'pipe' | 'ignore'>
  env?: NodeJS.ProcessEnv
}

export type UtilityProcessForkFn = (
  modulePath: string,
  args?: string[],
  options?: UtilityProcessForkOptions
) => UtilityProcessLike

export interface MessageChannelLike {
  port1: MessagePortLike
  port2: MessagePortLike
}

export interface StreamPortTarget {
  id: number
  isDestroyed: () => boolean
  postMessage: (channel: string, message: unknown, transfer?: unknown[]) => void
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown
}

export interface AgentHostCrashInfo {
  workspaceDir: string
  exitCode: number
  interruptedSessionIds: string[]
}

export interface AgentHostCallbacks {
  credentials: CredentialStoreLike
  modelsStore: TrackedModelsStore
  readDocument: (request: {
    path: string
    pages?: string
    sheet?: string
    slide?: string
  }) => Promise<DocumentReadResult>
  requestApproval: (request: ApprovalRequestPayload) => Promise<ApprovalDecision>
  getWorktreeContext: (sessionId: string) => string | Promise<string>
  onWorktreeSwitch: (
    sessionId: string,
    target: string,
    base?: string
  ) => Promise<WorktreeSwitchResult>
  resolveSessionRoot: (sessionId: string) => string | undefined
  isSessionOfWorkspace: (sessionId: string, headerCwd: string) => boolean
  getSyncState: () => AgentHostSyncState
  onSessionTitle: (sessionId: string, title: string) => void
  onSessionRootChanged: (sessionId: string, root: string) => void
  onAgentSettled?: (sessionId: string) => void
  resolveMcpServers?: () => McpServerConfig[] | Promise<McpServerConfig[]>
  logger: AgentLogger
}

export interface AgentHostClientOptions {
  workspaceDir: string
  hostCallbacks: AgentHostCallbacks
  onCrash?: (info: AgentHostCrashInfo) => void
  workerModulePath?: string
  forkUtilityProcess?: UtilityProcessForkFn
  createMessageChannel?: () => MessageChannelLike
  childRegistry?: ChildRegistry
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

interface ActiveChatCallback {
  onTextDelta?: (delta: string) => void
  onTrace?: (event: { type: string; [key: string]: unknown }) => void
}

interface ElectronUtilityNamespace {
  utilityProcess?: {
    fork?: (
      modulePath: string,
      args?: string[],
      options?: UtilityProcessForkOptions
    ) => UtilityProcessLike
  }
  MessageChannelMain?: new () => MessageChannelLike
}

const DEFAULT_RPC_TIMEOUT_MS = 30_000
const LONG_RPC_TIMEOUT_MS = 120_000
const DISPOSE_RPC_TIMEOUT_MS = 1_500

function electronUtilityApi(): ElectronUtilityNamespace {
  return electron as unknown as ElectronUtilityNamespace
}

export function defaultAgentHostWorkerPath(): string {
  return fileURLToPath(new URL('./agent-host-worker.js', import.meta.url))
}

/** 仅在真实 Electron 运行时且编译后的 `dist-electron/agent-host-worker.js` 存在时启用 utilityProcess 隔离 */
export function isAgentUtilityProcessAvailable(): boolean {
  if (process.env.PI_AGENT_IN_PROCESS === '1') return false
  const api = electronUtilityApi()
  if (typeof api.utilityProcess?.fork !== 'function') return false
  if (typeof api.MessageChannelMain !== 'function') return false
  try {
    const workerPath = defaultAgentHostWorkerPath()
    return workerPath.endsWith('.js') && fs.existsSync(workerPath)
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultForkUtilityProcess(
  modulePath: string,
  args?: string[],
  options?: UtilityProcessForkOptions
): UtilityProcessLike {
  const fork = electronUtilityApi().utilityProcess?.fork
  if (typeof fork !== 'function') {
    throw new Error('Electron utilityProcess.fork is unavailable in this environment')
  }
  return fork(modulePath, args, options)
}

function defaultCreateMessageChannel(): MessageChannelLike {
  const Ctor = electronUtilityApi().MessageChannelMain
  if (typeof Ctor !== 'function') {
    throw new Error('Electron MessageChannelMain is unavailable in this environment')
  }
  return new Ctor()
}

export class AgentHostClient implements RegisteredAgent {
  readonly workspaceDir: string
  private readonly hostCallbacks: AgentHostCallbacks
  private readonly onCrash?: (info: AgentHostCrashInfo) => void
  private readonly workerModulePath: string
  private readonly forkUtilityProcess: UtilityProcessForkFn
  private readonly createMessageChannel: () => MessageChannelLike
  private readonly registry: ChildRegistry

  private child: UtilityProcessLike | null = null
  private currentPid: number | null = null
  private unregisterChild: (() => void) | null = null
  private nextRpcId = 1
  private nextPortId = 1
  private nextFallbackRequestId = 1
  private readonly pendingRpcs = new Map<number, PendingRpc>()
  private readonly activeChatCallbacks = new Map<string, ActiveChatCallback>()
  private readonly activeChatSessions = new Map<string, number>()
  private readonly attachedSenders = new Map<number, string>()
  private readonly mcpChildUnregisters = new Map<number, () => void>()

  private initialized = false
  private disposing = false
  private disposed = false
  private crashed = false
  private currentSessionId: string | null = null
  private runningSessionIds: string[] = []

  constructor(options: AgentHostClientOptions) {
    this.workspaceDir = options.workspaceDir
    this.hostCallbacks = options.hostCallbacks
    this.onCrash = options.onCrash
    this.workerModulePath = options.workerModulePath ?? defaultAgentHostWorkerPath()
    this.forkUtilityProcess = options.forkUtilityProcess ?? defaultForkUtilityProcess
    this.createMessageChannel = options.createMessageChannel ?? defaultCreateMessageChannel
    this.registry = options.childRegistry ?? childRegistry
  }

  getPid(): number | null {
    return this.currentPid ?? this.child?.pid ?? null
  }

  isInitialized(): boolean {
    return this.initialized && !this.disposed && !this.crashed && this.child !== null
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId
  }

  hasRunningSessions(): string[] {
    const ids = new Set<string>(this.runningSessionIds)
    for (const [sessionId, count] of this.activeChatSessions.entries()) {
      if (count > 0 && sessionId) ids.add(sessionId)
    }
    return [...ids]
  }

  /** 测试与诊断专用：主动杀掉底层 utilityProcess 以验证崩溃自愈路径（不标记为正常 dispose） */
  killForTest(): boolean {
    if (!this.child) return false
    return this.child.kill()
  }

  /**
   * 为渲染层 webContents 建立直连 Agent utilityProcess 的 MessagePort 流通道。
   * 同一 `(AgentHostClient, webContents.id)` 自动去重；页面销毁或重载时自动清理。
   */
  attachRendererStreamPort(sender: StreamPortTarget): boolean {
    if (!this.child || this.disposed || this.crashed || sender.isDestroyed()) {
      return false
    }
    if (this.attachedSenders.has(sender.id)) {
      return true
    }
    if (typeof sender.postMessage !== 'function') {
      return false
    }
    try {
      const { port1, port2 } = this.createMessageChannel()
      const portId = `stream-${this.nextPortId++}`
      this.attachedSenders.set(sender.id, portId)
      this.child.postMessage({ type: 'attach-stream-port', portId }, [port1])
      sender.postMessage(
        'agent:stream-port',
        { workspaceDir: this.workspaceDir, portId },
        [port2]
      )

      const detach = (): void => {
        this.detachRendererStreamPort(sender.id)
      }
      sender.once?.('destroyed', detach)
      sender.once?.('render-process-gone', detach)
      sender.once?.(
        'did-start-navigation',
        (_event: unknown, _url: unknown, isInPlace: unknown, isMainFrame: unknown) => {
          if (isInPlace === false && isMainFrame !== false) {
            detach()
          }
        }
      )
      return true
    } catch (error) {
      this.attachedSenders.delete(sender.id)
      this.hostCallbacks.logger.warn('[AgentHostClient] Failed to attach renderer stream port:', error)
      return false
    }
  }

  detachRendererStreamPort(senderId: number): void {
    const portId = this.attachedSenders.get(senderId)
    if (!portId) return
    this.attachedSenders.delete(senderId)
    if (this.child && !this.disposed && !this.crashed) {
      try {
        const msg: MainToAgentWorkerMessage = { type: 'detach-stream-port', portId }
        this.child.postMessage(msg)
      } catch {
        // worker 可能已退出
      }
    }
  }

  private ensureChild(): UtilityProcessLike {
    if (this.disposed) {
      throw new Error('Agent host client is disposed')
    }
    if (this.child) return this.child

    this.crashed = false
    const child = this.forkUtilityProcess(this.workerModulePath, [], {
      serviceName: 'pi-workbench-agent-host',
      stdio: 'pipe',
    })
    this.child = child

    const trackPid = (): void => {
      if (this.child !== child || this.disposed) return
      const pid = child.pid
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
        this.currentPid = pid
        this.unregisterChild?.()
        this.unregisterChild = this.registry.register({
          pid,
          group: 'utility',
          kill: () => {
            try {
              child.kill()
            } catch {
              // ignore
            }
          },
        })
      }
    }
    trackPid()
    child.on('spawn', trackPid)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk).trim()
      if (text) this.hostCallbacks.logger.debug('[AgentHost:stdout]', text.slice(0, 2000))
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk).trim()
      if (text) this.hostCallbacks.logger.warn('[AgentHost:stderr]', text.slice(0, 2000))
    })

    child.on('message', (message: unknown) => {
      if (this.child !== child) return
      this.handleWorkerMessage(child, message)
    })

    child.on('error', (type: string, location: string, report: string) => {
      this.hostCallbacks.logger.error(
        `[AgentHost] UtilityProcess fatal error (${type}) at ${location}:`,
        report.slice(0, 1000)
      )
    })

    child.on('exit', (code: number) => {
      if (this.child !== child) return
      this.handleProcessExit(code)
    })

    return child
  }

  private clearMcpChildPids(killOrphans: boolean): void {
    for (const [pid, unregister] of [...this.mcpChildUnregisters.entries()]) {
      this.mcpChildUnregisters.delete(pid)
      try {
        unregister()
      } catch {
        // ignore
      }
      if (killOrphans) {
        void killProcessTreeAsync(pid).catch(() => undefined)
      }
    }
  }

  private handleProcessExit(code: number): void {
    this.unregisterChild?.()
    this.unregisterChild = null
    this.child = null
    this.currentPid = null
    this.attachedSenders.clear()
    this.clearMcpChildPids(!this.disposing && !this.disposed)

    if (this.disposing || this.disposed) {
      this.initialized = false
      this.runningSessionIds = []
      this.activeChatSessions.clear()
      this.activeChatCallbacks.clear()
      this.rejectAllPending(new Error('Agent host disposed'))
      return
    }

    const interruptedSessionIds = this.hasRunningSessions()
    this.initialized = false
    this.crashed = true
    this.runningSessionIds = []
    this.activeChatSessions.clear()
    this.activeChatCallbacks.clear()

    const crashError = new Error(`Agent process crashed (exit code ${code})`)
    this.hostCallbacks.logger.error(
      `[AgentHost] UtilityProcess exited unexpectedly (code=${code}, workspace=${this.workspaceDir})`
    )
    this.rejectAllPending(crashError)

    try {
      this.onCrash?.({
        workspaceDir: this.workspaceDir,
        exitCode: code,
        interruptedSessionIds,
      })
    } catch (error) {
      this.hostCallbacks.logger.warn('[AgentHost] onCrash callback failed:', error)
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of [...this.pendingRpcs.entries()]) {
      this.pendingRpcs.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  private handleWorkerMessage(child: UtilityProcessLike, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const msg = raw as AgentWorkerToMainMessage

    if (msg.type === 'ready') {
      return
    }

    if (msg.type === 'running-sessions-changed') {
      this.runningSessionIds = Array.isArray(msg.runningSessionIds) ? [...msg.runningSessionIds] : []
      this.currentSessionId = typeof msg.currentSessionId === 'string' ? msg.currentSessionId : null
      return
    }

    if (msg.type === 'rpc:res') {
      if (msg.currentSessionId !== undefined) {
        this.currentSessionId = msg.currentSessionId
      }
      if (Array.isArray(msg.runningSessionIds)) {
        this.runningSessionIds = [...msg.runningSessionIds]
      }
      const pending = this.pendingRpcs.get(msg.id)
      if (!pending) return
      this.pendingRpcs.delete(msg.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (msg.ok) pending.resolve(msg.result)
      else pending.reject(new Error(msg.error || 'Agent host RPC failed'))
      return
    }

    if (msg.type === 'stream-event') {
      this.handleFallbackStreamEvent(msg.payload)
      return
    }

    if (msg.type === 'host:event') {
      this.handleHostEvent(msg.event, msg.payload)
      return
    }

    if (msg.type === 'host:req') {
      void this.handleHostRequest(child, msg.callId, msg.method, msg.payload)
    }
  }

  private handleFallbackStreamEvent(payload: AgentStreamWirePayload): void {
    const requestId = payload.requestId
    const targets: ActiveChatCallback[] = []
    if (requestId && this.activeChatCallbacks.has(requestId)) {
      const target = this.activeChatCallbacks.get(requestId)
      if (target) targets.push(target)
    } else if (!requestId && this.activeChatCallbacks.size === 1) {
      const only = this.activeChatCallbacks.values().next().value
      if (only) targets.push(only)
    }
    if (targets.length === 0) return

    const {
      requestId: _requestId,
      workspaceDir: _workspaceDir,
      sessionId: _sessionId,
      ...trace
    } = payload
    for (const target of targets) {
      try {
        target.onTrace?.(trace)
        if (trace.type === 'text_delta' && typeof trace.delta === 'string') {
          target.onTextDelta?.(trace.delta)
        }
      } catch (error) {
        this.hostCallbacks.logger.warn('[AgentHost] Fallback trace listener failed:', error)
      }
    }
  }

  private handleHostEvent(
    event: AgentHostEventName,
    payload: unknown
  ): void {
    const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    switch (event) {
      case 'session-title':
        if (typeof data.sessionId === 'string' && typeof data.title === 'string') {
          this.hostCallbacks.onSessionTitle(data.sessionId, data.title)
        }
        return
      case 'session-root-changed':
        if (typeof data.sessionId === 'string' && typeof data.root === 'string') {
          this.hostCallbacks.onSessionRootChanged(data.sessionId, data.root)
        }
        return
      case 'agent-settled':
        if (typeof data.sessionId === 'string') {
          this.hostCallbacks.onAgentSettled?.(data.sessionId)
        }
        return
      case 'mcp-child-pid': {
        const pid = typeof data.pid === 'number' && Number.isInteger(data.pid) ? data.pid : 0
        if (pid <= 0) return
        if (data.action === 'register') {
          this.mcpChildUnregisters.get(pid)?.()
          const unreg = this.registry.register({ pid, group: 'utility' })
          this.mcpChildUnregisters.set(pid, unreg)
        } else if (data.action === 'unregister') {
          const unreg = this.mcpChildUnregisters.get(pid)
          this.mcpChildUnregisters.delete(pid)
          unreg?.()
        }
        return
      }
      case 'log': {
        const level = typeof data.level === 'string' ? data.level : 'info'
        const args = Array.isArray(data.args) ? data.args : [data.args]
        if (level === 'error') this.hostCallbacks.logger.error(...args)
        else if (level === 'warn') this.hostCallbacks.logger.warn(...args)
        else if (level === 'debug') this.hostCallbacks.logger.debug(...args)
        else this.hostCallbacks.logger.info(...args)
        return
      }
    }
  }

  private async handleHostRequest(
    child: UtilityProcessLike,
    callId: number,
    method: AgentHostCallbackMethod,
    payload: unknown
  ): Promise<void> {
    const reply = (msg: MainToAgentWorkerMessage): void => {
      if (this.child !== child || this.disposed || this.crashed) return
      try {
        child.postMessage(msg)
      } catch {
        // worker 已退出
      }
    }

    try {
      const data =
        payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
      let result: unknown
      let refreshedSyncState: AgentHostSyncState | undefined

      switch (method) {
        case 'credentials:get':
          result = await this.hostCallbacks.credentials.read(String(data.providerId ?? ''))
          break
        case 'credentials:set': {
          const providerId = String(data.providerId ?? '')
          const credential = data.credential as CredentialValue
          result = await this.hostCallbacks.credentials.modify(providerId, async () => credential)
          break
        }
        case 'credentials:delete':
          await this.hostCallbacks.credentials.delete(String(data.providerId ?? ''))
          result = undefined
          break
        case 'credentials:list':
          result = await this.hostCallbacks.credentials.list()
          break
        case 'credentials:has': {
          const providerId = String(data.providerId ?? '')
          const entries = await this.hostCallbacks.credentials.list()
          result = entries.some((entry) => entry.providerId === providerId)
          break
        }
        case 'credentials:modify': {
          const providerId = String(data.providerId ?? '')
          const modifyId = String(data.modifyId ?? '')
          result = await this.hostCallbacks.credentials.modify(
            providerId,
            async (current) =>
              await this.callRpc<CredentialValue>(
                'credentials:runModify',
                [{ modifyId, current }],
                LONG_RPC_TIMEOUT_MS
              )
          )
          break
        }
        case 'models:read':
          result = await this.hostCallbacks.modelsStore.read(String(data.providerId ?? ''))
          break
        case 'models:write':
          await this.hostCallbacks.modelsStore.write(
            String(data.providerId ?? ''),
            data.entry as ModelsStoreWriteEntry
          )
          result = undefined
          break
        case 'models:delete':
          await this.hostCallbacks.modelsStore.delete(String(data.providerId ?? ''))
          result = undefined
          break
        case 'models:snapshot':
          result = await this.hostCallbacks.modelsStore.snapshot()
          break
        case 'models:snapshotFor':
          result = await this.hostCallbacks.modelsStore.snapshotFor(String(data.providerId ?? ''))
          break
        case 'readDocument':
          result = await this.hostCallbacks.readDocument(
            data as { path: string; pages?: string; sheet?: string; slide?: string }
          )
          break
        case 'requestApproval':
          result = await this.hostCallbacks.requestApproval(
            payload as ApprovalRequestPayload
          )
          break
        case 'resolveSessionRoot':
          result = this.hostCallbacks.resolveSessionRoot(String(data.sessionId ?? ''))
          break
        case 'isSessionOfWorkspace':
          result = this.hostCallbacks.isSessionOfWorkspace(
            String(data.sessionId ?? ''),
            String(data.headerCwd ?? '')
          )
          break
        case 'getWorktreeContext':
          result = await this.hostCallbacks.getWorktreeContext(String(data.sessionId ?? ''))
          break
        case 'onWorktreeSwitch':
          result = await this.hostCallbacks.onWorktreeSwitch(
            String(data.sessionId ?? ''),
            String(data.target ?? ''),
            typeof data.base === 'string' ? data.base : undefined
          )
          refreshedSyncState = this.hostCallbacks.getSyncState()
          break
        case 'getDefaultPermissionLevel':
          result = this.hostCallbacks.getSyncState().defaultPermissionLevel
          break
        case 'getLanguage':
          result = this.hostCallbacks.getSyncState().language
          break
        case 'getWebAccessConfigVersion':
          result = this.hostCallbacks.getSyncState().webAccessConfigVersion
          break
        case 'mcp:resolveServers':
          result = this.hostCallbacks.resolveMcpServers
            ? await this.hostCallbacks.resolveMcpServers()
            : []
          break
      }

      reply({
        type: 'host:res',
        callId,
        ok: true,
        result,
        ...(refreshedSyncState ? { syncState: refreshedSyncState } : {}),
      })
    } catch (error) {
      reply({
        type: 'host:res',
        callId,
        ok: false,
        error: errorMessage(error),
      })
    }
  }

  private callRpc<T>(
    method: AgentHostRpcMethod,
    args: readonly unknown[],
    timeoutMs: number | null = DEFAULT_RPC_TIMEOUT_MS
  ): Promise<T> {
    const child = this.ensureChild()
    const id = this.nextRpcId++
    const syncState = method === 'dispose' ? undefined : this.hostCallbacks.getSyncState()

    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null
      if (timeoutMs !== null && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingRpcs.delete(id)
          reject(new Error(`Agent host RPC "${method}" timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      }

      this.pendingRpcs.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })

      const request: MainToAgentWorkerMessage = {
        type: 'rpc:req',
        id,
        method,
        args,
        ...(syncState ? { syncState } : {}),
      }

      try {
        child.postMessage(request)
      } catch (error) {
        this.pendingRpcs.delete(id)
        if (timer) clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  // ---------------------------------------------------------------------------
  // RegisteredAgent 方法实现
  // ---------------------------------------------------------------------------

  async initialize(config: unknown): Promise<{ success: boolean; error?: string }> {
    const raw = (config && typeof config === 'object' ? config : {}) as Partial<AgentConfig>
    const payload: AgentHostInitPayload = {
      workspaceDir: raw.workspaceDir ?? this.workspaceDir,
      agentDir: raw.agentDir ?? '',
      apiConfig: raw.apiConfig ?? { providerId: '', modelId: '' },
      allowModelNetwork: Boolean(raw.allowModelNetwork),
      webAccessExtensionPaths: Array.isArray(raw.webAccessExtensionPaths)
        ? [...raw.webAccessExtensionPaths]
        : [],
      syncState: this.hostCallbacks.getSyncState(),
    }
    const result = await this.callRpc<{ success: boolean; error?: string }>(
      'initialize',
      [payload],
      LONG_RPC_TIMEOUT_MS
    )
    this.initialized = Boolean(result?.success)
    return result
  }

  chat(
    message: string,
    options?: {
      requestId?: string
      onTextDelta?: (delta: string) => void
      onTrace?: (event: { type: string; [key: string]: unknown }) => void
      images?: Array<{ data: string; mimeType: string }>
    }
  ): Promise<AgentChatOutcome>
  chat(
    sessionId: string,
    message: string,
    options?: {
      requestId?: string
      onTextDelta?: (delta: string) => void
      onTrace?: (event: { type: string; [key: string]: unknown }) => void
      images?: Array<{ data: string; mimeType: string }>
    }
  ): Promise<AgentChatOutcome>
  async chat(
    sessionIdOrMessage: string,
    messageOrOptions?:
      | string
      | {
          requestId?: string
          onTextDelta?: (delta: string) => void
          onTrace?: (event: { type: string; [key: string]: unknown }) => void
          images?: Array<{ data: string; mimeType: string }>
        },
    maybeOptions?: {
      requestId?: string
      onTextDelta?: (delta: string) => void
      onTrace?: (event: { type: string; [key: string]: unknown }) => void
      images?: Array<{ data: string; mimeType: string }>
    }
  ): Promise<AgentChatOutcome> {
    const hasSessionId = typeof messageOrOptions === 'string'
    const sessionId = hasSessionId ? sessionIdOrMessage : undefined
    const message = hasSessionId ? messageOrOptions : sessionIdOrMessage
    const options = hasSessionId
      ? maybeOptions
      : (messageOrOptions as
          | {
              requestId?: string
              onTextDelta?: (delta: string) => void
              onTrace?: (event: { type: string; [key: string]: unknown }) => void
              images?: Array<{ data: string; mimeType: string }>
            }
          | undefined)

    const requestId = options?.requestId ?? `host-chat-${this.nextFallbackRequestId++}`
    if (options?.onTrace || options?.onTextDelta) {
      this.activeChatCallbacks.set(requestId, {
        onTrace: options.onTrace,
        onTextDelta: options.onTextDelta,
      })
    }

    const trackedSession = sessionId || this.currentSessionId || '__default__'
    this.activeChatSessions.set(trackedSession, (this.activeChatSessions.get(trackedSession) ?? 0) + 1)

    const input: AgentChatRpcInput = {
      ...(sessionId ? { sessionId } : {}),
      message,
      requestId,
      ...(options?.images && options.images.length > 0 ? { images: options.images } : {}),
    }

    try {
      // 对话可能包含工具执行、人工审批与长思考，不设短传输超时（依赖 pi-bridge 看门狗与 exit 监听）
      return await this.callRpc<AgentChatOutcome>('chat', [input], null)
    } finally {
      this.activeChatCallbacks.delete(requestId)
      const remaining = (this.activeChatSessions.get(trackedSession) ?? 1) - 1
      if (remaining <= 0) this.activeChatSessions.delete(trackedSession)
      else this.activeChatSessions.set(trackedSession, remaining)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposing = true
    this.initialized = false
    const child = this.child
    if (child) {
      try {
        await this.callRpc<void>('dispose', [], DISPOSE_RPC_TIMEOUT_MS)
      } catch {
        // 超时或进程已退出时直接强杀兜底
      }
      try {
        child.kill()
      } catch {
        // ignore
      }
    }
    this.disposed = true
    this.unregisterChild?.()
    this.unregisterChild = null
    this.clearMcpChildPids(true)
    this.child = null
    this.currentPid = null
    this.attachedSenders.clear()
    this.runningSessionIds = []
    this.activeChatSessions.clear()
    this.activeChatCallbacks.clear()
    this.rejectAllPending(new Error('Agent host disposed'))
  }

  requestSessionRoot(
    sessionId: string,
    root: string
  ): Promise<{ success: boolean; scheduled?: boolean; error?: string }> {
    return this.callRpc('requestSessionRoot', [sessionId, root])
  }

  abort(sessionId?: string): Promise<void> {
    return this.callRpc('abort', [sessionId])
  }

  getSessionMessages(sessionId?: string): Promise<unknown> {
    return this.callRpc('getSessionMessages', [sessionId])
  }

  getMessageHistory(sessionId?: string): Promise<unknown> {
    return this.callRpc('getMessageHistory', [sessionId])
  }

  listSessions(): Promise<unknown[]> {
    return this.callRpc('listSessions', [])
  }

  openSession(sessionId?: string): Promise<unknown> {
    return this.callRpc('openSession', [sessionId])
  }

  createSession(root?: string): Promise<unknown> {
    return this.callRpc('createSession', [root])
  }

  closeSession(sessionId: string): Promise<void> {
    return this.callRpc('closeSession', [sessionId])
  }

  renameSession(sessionId: string, name: string): Promise<unknown> {
    return this.callRpc('renameSession', [sessionId, name])
  }

  deleteSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
    return this.callRpc('deleteSession', [sessionId])
  }

  steer(
    sessionId: string,
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<{ success: boolean; error?: string }> {
    return this.callRpc('steer', [sessionId, message, images])
  }

  getContextUsage(sessionId: string): Promise<{
    success: boolean
    usage?: {
      tokens: number | null
      contextWindow: number
      percent: number | null
      autoCompactPercent?: number
    }
    error?: string
  }> {
    return this.callRpc('getContextUsage', [sessionId])
  }

  compactContext(sessionId: string): Promise<{
    success: boolean
    tokensBefore?: number
    estimatedTokensAfter?: number
    entryId?: string
    timestamp?: number
    error?: string
  }> {
    return this.callRpc('compactContext', [sessionId], LONG_RPC_TIMEOUT_MS)
  }

  rewindToLastUser(
    sessionId: string,
    newText?: string
  ): Promise<{ success: boolean; text?: string; error?: string }> {
    return this.callRpc('rewindToLastUser', [sessionId, newText])
  }

  listBranches(sessionId: string): Promise<{
    success: boolean
    groups?: Array<{
      userTimestamp: number
      activeIndex: number
      branches: Array<{ entryId: string; preview: string }>
    }>
    error?: string
  }> {
    return this.callRpc('listBranches', [sessionId])
  }

  switchBranch(
    sessionId: string,
    entryId: string
  ): Promise<{ success: boolean; history?: unknown; error?: string }> {
    return this.callRpc('switchBranch', [sessionId, entryId])
  }

  getToolResultMeta(
    sessionId: string,
    toolCallId: string
  ): Promise<{
    success: boolean
    meta?: {
      toolName: string
      kind: 'text' | 'image'
      chars: number
      bytes: number
      lines: number
      imageCount: number
    }
    error?: string
  }> {
    return this.callRpc('getToolResultMeta', [sessionId, toolCallId])
  }

  readToolResultChunk(
    sessionId: string,
    toolCallId: string,
    offset?: number,
    limit?: number
  ): Promise<{
    success: boolean
    text?: string
    offset?: number
    nextOffset?: number
    chars?: number
    done?: boolean
    error?: string
  }> {
    return this.callRpc('readToolResultChunk', [sessionId, toolCallId, offset, limit])
  }

  getToolResultImage(
    sessionId: string,
    toolCallId: string,
    index?: number
  ): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }> {
    return this.callRpc('getToolResultImage', [sessionId, toolCallId, index])
  }

  getToolResultText(
    sessionId: string,
    toolCallId: string
  ): Promise<{ success: boolean; text?: string; toolName?: string; error?: string }> {
    return this.callRpc('getToolResultText', [sessionId, toolCallId])
  }

  exportSessionMarkdown(
    sessionId: string,
    language?: 'zh' | 'en'
  ): Promise<{ success: boolean; title?: string; content?: string; error?: string }> {
    return this.callRpc('exportSessionMarkdown', [sessionId, language])
  }

  exportSessionHtml(
    sessionId: string,
    language?: 'zh' | 'en'
  ): Promise<{ success: boolean; title?: string; content?: string; error?: string }> {
    return this.callRpc('exportSessionHtml', [sessionId, language])
  }

  getSessionJsonlPath(
    sessionId: string
  ): Promise<{ success: boolean; title?: string; path?: string; error?: string }> {
    return this.callRpc('getSessionJsonlPath', [sessionId])
  }

  getModelCapabilities(): Promise<{
    success: boolean
    models?: Array<{
      id: string
      available: boolean
      contextWindow: number
      maxTokens: number | null
      reasoning: boolean | null
      vision: boolean
      thinkingLevels: string[]
    }>
    selected?: string
    error?: string
  }> {
    return this.callRpc('getModelCapabilities', [])
  }

  listPromptResources(sessionId: string): Promise<{
    success: boolean
    templates?: Array<{
      name: string
      description: string
      argumentHint?: string
      scope: 'user' | 'project' | 'temporary'
    }>
    skills?: Array<{
      name: string
      description: string
      scope: 'user' | 'project' | 'temporary'
      disableModelInvocation: boolean
    }>
    error?: string
  }> {
    return this.callRpc('listPromptResources', [sessionId])
  }

  getPlan(sessionId: string): Promise<{
    success: boolean
    plan?: StructuredPlanPayload | null
    error?: string
  }> {
    return this.callRpc('getPlan', [sessionId])
  }

  approvePlan(
    sessionId: string,
    planId: string,
    targetMode: 'ask' | 'auto'
  ): Promise<{
    success: boolean
    plan?: StructuredPlanPayload
    permission?: SessionPermissionPayload
    error?: string
  }> {
    return this.callRpc('approvePlan', [sessionId, planId, targetMode])
  }

  rejectPlan(
    sessionId: string,
    planId: string
  ): Promise<{ success: boolean; plan?: StructuredPlanPayload; error?: string }> {
    return this.callRpc('rejectPlan', [sessionId, planId])
  }

  getSessionSettings(sessionId: string): Promise<{
    success: boolean
    modelId?: string
    thinkingLevel?: string
    permission?: SessionPermissionPayload
    error?: string
  }> {
    return this.callRpc('getSessionSettings', [sessionId])
  }

  setSessionModel(
    sessionId: string,
    modelId: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.callRpc('setSessionModel', [sessionId, modelId])
  }

  setSessionThinking(
    sessionId: string,
    level: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.callRpc('setSessionThinking', [sessionId, level])
  }

  setSessionPermission(
    sessionId: string,
    permission: unknown
  ): Promise<{ success: boolean; permission?: SessionPermissionPayload; error?: string }> {
    return this.callRpc('setSessionPermission', [sessionId, permission])
  }

  getSessionStats(sessionId: string): Promise<{
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
    return this.callRpc('getSessionStats', [sessionId])
  }

  async getMcpStatuses(): Promise<McpServerStatus[]> {
    if (!this.isInitialized()) return []
    return this.callRpc<McpServerStatus[]>('mcp:getStatuses', [])
  }

  async refreshMcpServers(servers?: McpServerConfig[]): Promise<McpServerStatus[]> {
    if (!this.isInitialized()) return []
    return this.callRpc<McpServerStatus[]>(
      'mcp:refreshServers',
      servers !== undefined ? [servers] : [],
      LONG_RPC_TIMEOUT_MS
    )
  }
}
