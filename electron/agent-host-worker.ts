/**
 * Agent utilityProcess 宿主页入口（纯 Node / Electron `process.parentPort`，严禁引入 `electron`）。
 *
 * 运行在独立操作系统进程中承载 `AgentRuntimeHost`（`AgentManager`）：
 * - 通过 `process.parentPort` 承接主进程 `AgentHostClient` 的全部结构化 RPC；
 * - 通过受控 `host:req` RPC 按需向主进程请求 `safeStorage` 加密凭证、模型目录缓存、文档解析、审批与工作树切换
 *   （凭证永不在本进程落盘明文，也不随初始化参数下发）；
 * - 通过主进程转交的直连 `MessagePort` 将高频流式 trace 事件直推渲染层，零主进程逐 token 中转；
 *   仅在未绑定渲染层端口（如单测 / 无头执行）时回退 `parentPort` 推送 `stream-event`。
 */

import * as path from 'path'
import {
  AgentRuntimeHost,
  type AgentChatOptions,
  type AgentChatResult,
  type AgentConfig,
  type AgentLogger,
  type AgentTraceEvent,
  type ApprovalDecision,
  type ApprovalRequestPayload,
  type CatalogSnapshot,
  type McpServerConfig,
  type McpServerStatus,
  type TrackedModelsStore,
} from 'pi-bridge'
import {
  serializeLogArgs,
  type AgentChatRpcInput,
  type AgentHostCallbackMethod,
  type AgentHostEventName,
  type AgentHostInitPayload,
  type AgentHostRpcMethod,
  type AgentHostSyncState,
  type AgentStreamWirePayload,
  type AgentWorkerToMainMessage,
  type MainToAgentWorkerMessage,
  type MessagePortLike,
  type ParentPortLike,
  type ParentPortMessageEvent,
} from './agent-host-protocol.js'

type CredentialStoreLike = NonNullable<AgentConfig['credentials']>
type CredentialValue = Awaited<ReturnType<CredentialStoreLike['read']>>
type CredentialInfoList = Awaited<ReturnType<CredentialStoreLike['list']>>
type ModelsStoreReadValue = Awaited<ReturnType<TrackedModelsStore['read']>>
type ModelsStoreWriteEntry = Parameters<TrackedModelsStore['write']>[1]
type DocumentReadResult = Awaited<ReturnType<NonNullable<AgentConfig['readDocument']>>>
type WorktreeSwitchResult = Awaited<ReturnType<NonNullable<AgentConfig['onWorktreeSwitch']>>>

/** 与 `AgentManager`（`AgentRuntimeHost`）公开方法对齐的结构化接口，便于单测注入替身 */
export interface AgentRuntimeInstance {
  initialize: (config: AgentConfig) => Promise<{ success: boolean; error?: string }>
  chat: {
    (message: string, options?: AgentChatOptions): Promise<AgentChatResult>
    (sessionId: string, message: string, options?: AgentChatOptions): Promise<AgentChatResult>
  }
  abort: (sessionId?: string) => Promise<void>
  steer: (
    sessionId: string,
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ) => Promise<{ success: boolean; error?: string }>
  dispose: () => Promise<void>
  requestSessionRoot: (
    sessionId: string,
    root: string
  ) => Promise<{ success: boolean; scheduled?: boolean; error?: string }>
  listSessions: () => Promise<unknown[]>
  openSession: (sessionId?: string) => Promise<unknown>
  createSession: (root?: string) => Promise<unknown>
  closeSession: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, name: string) => Promise<unknown>
  deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>
  getContextUsage: (sessionId: string) => Promise<unknown>
  compactContext: (sessionId: string) => Promise<unknown>
  rewindToLastUser: (sessionId: string, newText?: string) => Promise<unknown>
  listBranches: (sessionId: string) => Promise<unknown>
  switchBranch: (sessionId: string, entryId: string) => Promise<unknown>
  getToolResultMeta: (sessionId: string, toolCallId: string) => Promise<unknown>
  readToolResultChunk: (
    sessionId: string,
    toolCallId: string,
    offset?: number,
    limit?: number
  ) => Promise<unknown>
  getToolResultImage: (sessionId: string, toolCallId: string, index?: number) => Promise<unknown>
  getToolResultText: (sessionId: string, toolCallId: string) => Promise<unknown>
  exportSessionMarkdown: (sessionId: string, language?: 'zh' | 'en') => Promise<unknown>
  exportSessionHtml: (sessionId: string, language?: 'zh' | 'en') => Promise<unknown>
  getSessionJsonlPath: (sessionId: string) => Promise<unknown>
  getModelCapabilities: () => Promise<unknown>
  listPromptResources: (sessionId: string) => Promise<unknown>
  getPlan: (sessionId: string) => Promise<unknown>
  approvePlan: (
    sessionId: string,
    planId: string,
    targetMode: 'ask' | 'auto'
  ) => Promise<unknown>
  rejectPlan: (sessionId: string, planId: string) => Promise<unknown>
  getSessionSettings: (sessionId: string) => Promise<unknown>
  setSessionModel: (sessionId: string, modelId: string) => Promise<unknown>
  setSessionThinking: (sessionId: string, level: string) => Promise<unknown>
  setSessionPermission: (sessionId: string, permission: unknown) => Promise<unknown>
  getSessionStats: (sessionId: string) => Promise<unknown>
  getSessionMessages: (sessionId?: string) => unknown
  getMessageHistory: (sessionId?: string) => unknown
  getCurrentSessionId: () => string | null
  hasRunningSessions: () => string[]
  getMcpStatuses?: () => McpServerStatus[]
  refreshMcpServers?: (servers: McpServerConfig[]) => Promise<McpServerStatus[]>
}

export interface AgentHostWorkerDeps {
  createAgent?: () => AgentRuntimeInstance
}

export interface AgentHostWorkerHandle {
  detach: () => void
  getAttachedPortCount: () => number
}

interface PendingHostCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const WEB_SEARCH_KEY_ENV_PREFIX = 'PI_WORKBENCH_WEB_SEARCH_KEY_'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function raceWithAbortSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    void promise.catch(() => undefined)
    throw signal.reason instanceof Error ? signal.reason : new Error('Operation aborted')
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void promise.catch(() => undefined)
      reject(signal.reason instanceof Error ? signal.reason : new Error('Operation aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export function attachAgentHostWorker(
  port: ParentPortLike,
  deps: AgentHostWorkerDeps = {}
): AgentHostWorkerHandle {
  const createAgent = deps.createAgent ?? (() => new AgentRuntimeHost())
  let agent: AgentRuntimeInstance = createAgent()
  let workspaceDir = ''
  let nextHostCallId = 1
  let nextModifyId = 1
  const pendingHostCalls = new Map<number, PendingHostCall>()
  const pendingModifyFns = new Map<
    string,
    (current: CredentialValue) => Promise<CredentialValue>
  >()
  const attachedPorts = new Map<string, MessagePortLike>()
  const activeChatRefCounts = new Map<string, number>()

  let syncState: AgentHostSyncState = {
    defaultPermissionLevel: 'ask',
    language: 'zh',
    webAccessConfigVersion: '',
    sessionRoots: {},
  }

  const post = (message: AgentWorkerToMainMessage): void => {
    try {
      port.postMessage(message)
    } catch {
      // 父进程通道已关闭
    }
  }

  const applySyncState = (next?: AgentHostSyncState): void => {
    if (!next) return
    syncState = {
      defaultPermissionLevel: next.defaultPermissionLevel,
      language: next.language === 'en' ? 'en' : 'zh',
      webAccessConfigVersion:
        typeof next.webAccessConfigVersion === 'string' ? next.webAccessConfigVersion : '',
      sessionRoots:
        next.sessionRoots && typeof next.sessionRoots === 'object' ? { ...next.sessionRoots } : {},
    }
    if (next.webSearchEnv && typeof next.webSearchEnv === 'object') {
      for (const [envKey, value] of Object.entries(next.webSearchEnv)) {
        if (!envKey.startsWith(WEB_SEARCH_KEY_ENV_PREFIX)) continue
        if (typeof value === 'string' && value.length > 0) {
          process.env[envKey] = value
        } else {
          delete process.env[envKey]
        }
      }
    }
  }

  const collectRunningSessionIds = (): string[] => {
    const ids = new Set<string>(agent.hasRunningSessions())
    for (const [sessionId, count] of activeChatRefCounts.entries()) {
      if (count > 0 && sessionId) ids.add(sessionId)
    }
    return [...ids]
  }

  const notifyRunningSessions = (): void => {
    post({
      type: 'running-sessions-changed',
      runningSessionIds: collectRunningSessionIds(),
      currentSessionId: agent.getCurrentSessionId(),
    })
  }

  const emitHostEvent = (
    event: AgentHostEventName,
    payload: unknown
  ): void => {
    post({ type: 'host:event', event, payload })
  }

  const hostRequest = <T>(
    method: AgentHostCallbackMethod,
    payload: unknown,
    signal?: AbortSignal
  ): Promise<T> => {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new Error('Operation aborted')
      )
    }
    const callId = nextHostCallId++
    const operation = new Promise<T>((resolve, reject) => {
      pendingHostCalls.set(callId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      post({ type: 'host:req', callId, method, payload })
    })
    return raceWithAbortSignal(operation, signal)
  }

  const workerLogger: AgentLogger = {
    info: (...args: unknown[]) =>
      emitHostEvent('log', { level: 'info', args: serializeLogArgs(args) }),
    warn: (...args: unknown[]) =>
      emitHostEvent('log', { level: 'warn', args: serializeLogArgs(args) }),
    error: (...args: unknown[]) =>
      emitHostEvent('log', { level: 'error', args: serializeLogArgs(args) }),
    debug: (...args: unknown[]) =>
      emitHostEvent('log', { level: 'debug', args: serializeLogArgs(args) }),
  }

  /** 受控凭证代理：所有明文加解密与落盘均留在主进程 safeStorage 中完成 */
  const credentialProxy: CredentialStoreLike = {
    read: (providerId, options) =>
      hostRequest<CredentialValue>('credentials:get', { providerId }, options?.signal),
    list: (options) =>
      hostRequest<CredentialInfoList>('credentials:list', {}, options?.signal),
    delete: (providerId, options) =>
      hostRequest<void>('credentials:delete', { providerId }, options?.signal),
    modify: async (providerId, fn, options) => {
      const modifyId = `mod-${nextModifyId++}`
      pendingModifyFns.set(modifyId, fn)
      try {
        return await hostRequest<CredentialValue>(
          'credentials:modify',
          { providerId, modifyId },
          options?.signal
        )
      } finally {
        pendingModifyFns.delete(modifyId)
      }
    },
  }

  /** 受控模型目录代理：复用主进程单文件锁，避免多工作区并发刷新写冲突 */
  const modelsStoreProxy: TrackedModelsStore = {
    read: (providerId, options) =>
      hostRequest<ModelsStoreReadValue>('models:read', { providerId }, options?.signal),
    write: (providerId, entry: ModelsStoreWriteEntry, options) =>
      hostRequest<void>('models:write', { providerId, entry }, options?.signal),
    delete: (providerId, options) =>
      hostRequest<void>('models:delete', { providerId }, options?.signal),
    snapshot: () => hostRequest<CatalogSnapshot[]>('models:snapshot', {}),
    snapshotFor: (providerId) =>
      hostRequest<CatalogSnapshot | undefined>('models:snapshotFor', { providerId }),
  }

  const dispatchStreamTrace = (
    requestId: string | undefined,
    sessionId: string | undefined,
    trace: AgentTraceEvent
  ): void => {
    const resolvedSessionId = sessionId || agent.getCurrentSessionId() || undefined
    const payload: AgentStreamWirePayload = {
      ...(requestId !== undefined ? { requestId } : {}),
      workspaceDir,
      ...(resolvedSessionId !== undefined ? { sessionId: resolvedSessionId } : {}),
      ...trace,
    }
    if (attachedPorts.size > 0) {
      for (const [portId, streamPort] of [...attachedPorts.entries()]) {
        try {
          streamPort.postMessage(payload)
        } catch {
          attachedPorts.delete(portId)
        }
      }
      return
    }
    post({ type: 'stream-event', payload })
  }

  const closeAllAttachedPorts = (): void => {
    for (const [portId, streamPort] of [...attachedPorts.entries()]) {
      attachedPorts.delete(portId)
      try {
        streamPort.close?.()
      } catch {
        // ignore close errors
      }
    }
  }

  const rejectPendingHostCalls = (reason: string): void => {
    for (const [callId, entry] of [...pendingHostCalls.entries()]) {
      pendingHostCalls.delete(callId)
      entry.reject(new Error(reason))
    }
    pendingModifyFns.clear()
  }

  const handleRpc = async (
    method: AgentHostRpcMethod,
    args: readonly unknown[]
  ): Promise<unknown> => {
    switch (method) {
      case 'initialize': {
        const init = args[0] as AgentHostInitPayload
        workspaceDir = init.workspaceDir
        applySyncState(init.syncState)
        agent = createAgent()
        const config: AgentConfig = {
          workspaceDir: init.workspaceDir,
          agentDir: init.agentDir,
          apiConfig: init.apiConfig,
          credentials: credentialProxy,
          modelsStore: modelsStoreProxy,
          allowModelNetwork: init.allowModelNetwork,
          webAccessExtensionPaths: init.webAccessExtensionPaths,
          logger: workerLogger,
          getWebAccessConfigVersion: () => syncState.webAccessConfigVersion,
          getDefaultPermissionLevel: () => syncState.defaultPermissionLevel,
          getLanguage: () => syncState.language,
          resolveSessionRoot: (sessionId: string) => syncState.sessionRoots[sessionId],
          isSessionOfWorkspace: (sessionId: string, headerCwd: string) => {
            if (Object.prototype.hasOwnProperty.call(syncState.sessionRoots, sessionId)) {
              return true
            }
            return path.resolve(headerCwd || workspaceDir) === path.resolve(workspaceDir)
          },
          getWorktreeContext: (sessionId: string) =>
            hostRequest<string>('getWorktreeContext', { sessionId }),
          onWorktreeSwitch: (sessionId: string, target: string, base?: string) =>
            hostRequest<WorktreeSwitchResult>('onWorktreeSwitch', { sessionId, target, base }),
          readDocument: (request) => hostRequest<DocumentReadResult>('readDocument', request),
          requestApproval: (request: ApprovalRequestPayload) =>
            hostRequest<ApprovalDecision>('requestApproval', request),
          onSessionTitle: (sessionId: string, title: string) => {
            emitHostEvent('session-title', { sessionId, title })
          },
          onSessionRootChanged: (sessionId: string, root: string) => {
            syncState.sessionRoots[sessionId] = root
            emitHostEvent('session-root-changed', { sessionId, root })
          },
          onAgentSettled: (sessionId: string) => {
            emitHostEvent('agent-settled', { sessionId })
            notifyRunningSessions()
          },
          getMcpServers: () => hostRequest<McpServerConfig[]>('mcp:resolveServers', {}),
          allowMcpTools: true,
          onMcpChildPid: (pid: number) => {
            emitHostEvent('mcp-child-pid', { action: 'register', pid })
            let unregistered = false
            return () => {
              if (unregistered) return
              unregistered = true
              emitHostEvent('mcp-child-pid', { action: 'unregister', pid })
            }
          },
        }
        const res = await agent.initialize(config)
        notifyRunningSessions()
        return res
      }

      case 'chat': {
        const input = args[0] as AgentChatRpcInput
        const trackedId = input.sessionId || agent.getCurrentSessionId() || '__default__'
        activeChatRefCounts.set(trackedId, (activeChatRefCounts.get(trackedId) ?? 0) + 1)
        notifyRunningSessions()
        const options: AgentChatOptions = {
          onTrace: (trace) => dispatchStreamTrace(input.requestId, input.sessionId, trace),
          ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        }
        try {
          return input.sessionId
            ? await agent.chat(input.sessionId, input.message, options)
            : await agent.chat(input.message, options)
        } finally {
          const remaining = (activeChatRefCounts.get(trackedId) ?? 1) - 1
          if (remaining <= 0) activeChatRefCounts.delete(trackedId)
          else activeChatRefCounts.set(trackedId, remaining)
          notifyRunningSessions()
        }
      }

      case 'abort':
        await agent.abort(args[0] as string | undefined)
        notifyRunningSessions()
        return undefined

      case 'steer':
        return await agent.steer(
          args[0] as string,
          args[1] as string,
          args[2] as Array<{ data: string; mimeType: string }> | undefined
        )

      case 'dispose':
        closeAllAttachedPorts()
        await agent.dispose()
        activeChatRefCounts.clear()
        rejectPendingHostCalls('Agent host disposed')
        notifyRunningSessions()
        return undefined

      case 'requestSessionRoot':
        return await agent.requestSessionRoot(args[0] as string, args[1] as string)

      case 'listSessions':
        return await agent.listSessions()

      case 'openSession': {
        const res = await agent.openSession(args[0] as string | undefined)
        notifyRunningSessions()
        return res
      }

      case 'createSession': {
        const res = await agent.createSession(args[0] as string | undefined)
        notifyRunningSessions()
        return res
      }

      case 'closeSession':
        await agent.closeSession(args[0] as string)
        notifyRunningSessions()
        return undefined

      case 'renameSession':
        return await agent.renameSession(args[0] as string, args[1] as string)

      case 'deleteSession': {
        const res = await agent.deleteSession(args[0] as string)
        notifyRunningSessions()
        return res
      }

      case 'getContextUsage':
        return await agent.getContextUsage(args[0] as string)

      case 'compactContext':
        return await agent.compactContext(args[0] as string)

      case 'rewindToLastUser':
        return await agent.rewindToLastUser(args[0] as string, args[1] as string | undefined)

      case 'listBranches':
        return await agent.listBranches(args[0] as string)

      case 'switchBranch':
        return await agent.switchBranch(args[0] as string, args[1] as string)

      case 'getToolResultMeta':
        return await agent.getToolResultMeta(args[0] as string, args[1] as string)

      case 'readToolResultChunk':
        return await agent.readToolResultChunk(
          args[0] as string,
          args[1] as string,
          args[2] as number | undefined,
          args[3] as number | undefined
        )

      case 'getToolResultImage':
        return await agent.getToolResultImage(
          args[0] as string,
          args[1] as string,
          args[2] as number | undefined
        )

      case 'getToolResultText':
        return await agent.getToolResultText(args[0] as string, args[1] as string)

      case 'exportSessionMarkdown':
        return await agent.exportSessionMarkdown(
          args[0] as string,
          args[1] as 'zh' | 'en' | undefined
        )

      case 'exportSessionHtml':
        return await agent.exportSessionHtml(
          args[0] as string,
          args[1] as 'zh' | 'en' | undefined
        )

      case 'getSessionJsonlPath':
        return await agent.getSessionJsonlPath(args[0] as string)

      case 'getModelCapabilities':
        return await agent.getModelCapabilities()

      case 'listPromptResources':
        return await agent.listPromptResources(args[0] as string)

      case 'getPlan':
        return await agent.getPlan(args[0] as string)

      case 'approvePlan':
        return await agent.approvePlan(
          args[0] as string,
          args[1] as string,
          args[2] as 'ask' | 'auto'
        )

      case 'rejectPlan':
        return await agent.rejectPlan(args[0] as string, args[1] as string)

      case 'getSessionSettings':
        return await agent.getSessionSettings(args[0] as string)

      case 'setSessionModel':
        return await agent.setSessionModel(args[0] as string, args[1] as string)

      case 'setSessionThinking':
        return await agent.setSessionThinking(args[0] as string, args[1] as string)

      case 'setSessionPermission':
        return await agent.setSessionPermission(args[0] as string, args[1])

      case 'getSessionStats':
        return await agent.getSessionStats(args[0] as string)

      case 'getSessionMessages':
        return agent.getSessionMessages(args[0] as string | undefined)

      case 'getMessageHistory':
        return agent.getMessageHistory(args[0] as string | undefined)

      case 'getCurrentSessionId':
        return agent.getCurrentSessionId()

      case 'hasRunningSessions':
        return collectRunningSessionIds()

      case 'credentials:runModify': {
        const req = args[0] as { modifyId: string; current: CredentialValue }
        const fn = pendingModifyFns.get(req.modifyId)
        if (!fn) {
          throw new Error(`No pending credential modify callback for ${req.modifyId}`)
        }
        return await fn(req.current)
      }

      case 'mcp:getStatuses':
        return agent.getMcpStatuses?.() ?? []

      case 'mcp:refreshServers': {
        const provided = args[0] as McpServerConfig[] | undefined
        const servers = Array.isArray(provided)
          ? provided
          : await hostRequest<McpServerConfig[]>('mcp:resolveServers', {})
        return (await agent.refreshMcpServers?.(servers)) ?? []
      }
    }
  }

  const onMessage = (event: ParentPortMessageEvent): void => {
    const raw = event?.data
    if (!raw || typeof raw !== 'object') return
    const msg = raw as MainToAgentWorkerMessage

    if (msg.type === 'attach-stream-port') {
      const streamPort = event.ports?.[0]
      if (!streamPort || typeof msg.portId !== 'string' || !msg.portId) return
      const existing = attachedPorts.get(msg.portId)
      if (existing && existing !== streamPort) {
        try {
          existing.close?.()
        } catch {
          // ignore
        }
      }
      attachedPorts.set(msg.portId, streamPort)
      streamPort.on?.('close', () => {
        if (attachedPorts.get(msg.portId) === streamPort) {
          attachedPorts.delete(msg.portId)
        }
      })
      streamPort.start?.()
      return
    }

    if (msg.type === 'detach-stream-port') {
      const existing = attachedPorts.get(msg.portId)
      if (existing) {
        attachedPorts.delete(msg.portId)
        try {
          existing.close?.()
        } catch {
          // ignore
        }
      }
      return
    }

    if (msg.type === 'sync-state') {
      applySyncState(msg.syncState)
      return
    }

    if (msg.type === 'host:res') {
      applySyncState(msg.syncState)
      const pending = pendingHostCalls.get(msg.callId)
      if (!pending) return
      pendingHostCalls.delete(msg.callId)
      if (msg.ok) pending.resolve(msg.result)
      else pending.reject(new Error(msg.error || 'Host callback failed'))
      return
    }

    if (msg.type === 'rpc:req') {
      applySyncState(msg.syncState)
      void (async () => {
        try {
          const result = await handleRpc(msg.method, msg.args)
          post({
            type: 'rpc:res',
            id: msg.id,
            ok: true,
            result,
            currentSessionId: agent.getCurrentSessionId(),
            runningSessionIds: collectRunningSessionIds(),
          })
        } catch (error) {
          post({
            type: 'rpc:res',
            id: msg.id,
            ok: false,
            error: errorMessage(error),
            currentSessionId: agent.getCurrentSessionId(),
            runningSessionIds: collectRunningSessionIds(),
          })
        }
      })()
    }
  }

  port.on('message', onMessage)
  post({ type: 'ready' })

  return {
    detach: () => {
      port.off?.('message', onMessage)
      port.removeListener?.('message', onMessage)
      closeAllAttachedPorts()
      rejectPendingHostCalls('Agent host worker detached')
    },
    getAttachedPortCount: () => attachedPorts.size,
  }
}

const procParentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort
if (procParentPort) {
  attachAgentHostWorker(procParentPort)
}
