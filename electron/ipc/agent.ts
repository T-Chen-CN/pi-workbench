/** Agent 生命周期、对话、流式控制与审批 IPC（会话与工具结果子域分别在 agent-sessions.ts / agent-tools.ts） */

import * as path from 'path'
import { getAppDir } from '../app-paths.js'
import type { RegisteredAgent } from '../agent-registry.js'
import { childRegistry } from '../child-registry.js'
import { resolveEffectiveMcpServers } from '../mcp-store.js'
import {
  AgentHostClient,
  isAgentUtilityProcessAvailable,
  type StreamPortTarget,
} from '../agent-host-client.js'
import { isTrustedWorkspacePath } from '../workspace-trust.js'
import { providerConfigKey } from '../agent-config-key.js'
import { activeProviderConfig, isCatalogNetworkAllowed } from '../providers-service.js'
import { createDesktopCredentialStore } from '../credentials-store.js'
import { getModelsStore } from '../models-store.js'
import { sanitizeApprovalDecision } from '../approval-broker.js'
import { getCoordinator } from '../worktree-coordinator.js'
import { readDocumentForAgent } from '../documents/agent-read.js'
import {
  WEB_SEARCH_KEY_ENV_PREFIX,
  currentWebSearchConfigVersion,
  webAccessExtensionPaths,
} from './web-search.js'
import { handleIpc } from './register.js'
import {
  broadcastToWindows,
  isValidSessionId,
  normalizeChatImages,
  type AgentIpcContext,
} from './agent-helpers.js'
import { registerAgentSessionIpc } from './agent-sessions.js'
import { registerAgentToolAndExportIpc } from './agent-tools.js'

export type { AgentIpcContext }

/** 确保某个工作区有一个可用 Agent（渲染层 IPC 与派活 worker 共用这一条路径）。 */
const initializingAgents = new Map<
  string,
  Promise<{ success: boolean; error?: string; utilityProcessPid?: number }>
>()
/** 记录最近发生过 utilityProcess 崩溃的工作区：下一次 agent:chat 自动无缝重建进程 */
const crashedWorkspaces = new Set<string>()

function agentInitKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function currentWebSearchEnvSnapshot(): Record<string, string | null> {
  const snapshot: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(WEB_SEARCH_KEY_ENV_PREFIX)) continue
    snapshot[key] = typeof value === 'string' && value.length > 0 ? value : null
  }
  return snapshot
}

function ensureStreamPortForSender(
  agent: RegisteredAgent | null,
  sender: Electron.WebContents | undefined
): boolean {
  if (!sender || !(agent instanceof AgentHostClient)) return false
  return agent.attachRendererStreamPort(sender as unknown as StreamPortTarget)
}

export async function ensureWorkspaceAgent(
  context: AgentIpcContext,
  workspaceDir: string
): Promise<{ success: boolean; error?: string; utilityProcessPid?: number }> {
  const key = agentInitKey(workspaceDir)
  const inflight = initializingAgents.get(key)
  if (inflight) return inflight

  const task = initializeWorkspaceAgent(context, workspaceDir)
  initializingAgents.set(key, task)
  const cleanup = () => {
    if (initializingAgents.get(key) === task) initializingAgents.delete(key)
  }
  void task.then(cleanup, cleanup)
  return task
}

async function initializeWorkspaceAgent(
  context: AgentIpcContext,
  workspaceDir: string
): Promise<{ success: boolean; error?: string; utilityProcessPid?: number }> {
  try {
    // 唯一配置源：当前 active provider + 模型 + 凭证指纹（D4 / D21）
    const active = await activeProviderConfig()
    if (!active.ok) {
      return {
        success: false,
        error:
          active.error === 'NOT_CONNECTED'
            ? 'No provider connected. Add one in Settings.'
            : 'No provider selected. Pick one in Settings.',
      }
    }
    const providerConfig = {
      providerId: active.providerId,
      modelId: active.modelId,
      ...(active.overrides ? { overrides: active.overrides } : {}),
    }
    const configKey = providerConfigKey({
      providerId: active.providerId,
      modelId: active.modelId,
      credentialFingerprint: active.fingerprint,
      overridesByModel: active.overrides,
    })

    if (context.agentRegistry.shouldReuse(workspaceDir, configKey)) {
      console.log('[Main] Reusing agent for workspace:', workspaceDir)
      const existing = context.agentRegistry.get(workspaceDir)
      const existingPid = existing?.getPid?.() ?? null
      return existingPid ? { success: true, utilityProcessPid: existingPid } : { success: true }
    }

    const coordinator = await getCoordinator(workspaceDir)
    const agentDir = path.join(getAppDir(), 'data', 'agent')
    const allowModelNetwork = isCatalogNetworkAllowed()
    const webAccessPaths = webAccessExtensionPaths()

    const handleWorktreeSwitch = async (sessionId: string, target: string, base?: string) => {
      if (!coordinator) return { success: false, error: 'Not a git repository' }
      const bound = await coordinator.bind(sessionId, target, base, sessionId)
      if (!bound.success || !bound.worktree) {
        return { success: false, error: bound.error ?? 'Unable to bind worktree' }
      }
      return {
        success: true,
        root: bound.worktree.path,
        branch: bound.worktree.branch ?? undefined,
        sharedWith: bound.sharedWith,
      }
    }

    const handleSessionRootChanged = (sessionId: string, root: string): void => {
      // 运行时实际 cwd 是事实来源：切换失败回滚时也要把工作树绑定改回旧根
      if (coordinator) {
        const current = coordinator.getSessionRoot(sessionId)
        if (path.resolve(current) !== path.resolve(root)) {
          const target =
            path.resolve(root) === path.resolve(coordinator.repo.root) ? 'main' : root
          void coordinator.bind(sessionId, target).catch((error: unknown) => {
            context.logger.warn('[Main] Failed to sync worktree binding:', error)
          })
        }
      }
      broadcastToWindows('agent:session-root-changed', { workspaceDir, sessionId, root })
    }

    // Electron 生产/开发运行时优先使用独立 utilityProcess 承载 Agent（崩溃与 CPU 与主进程隔离）
    if (isAgentUtilityProcessAvailable()) {
      const hostClient = new AgentHostClient({
        workspaceDir,
        hostCallbacks: {
          credentials: createDesktopCredentialStore(),
          modelsStore: getModelsStore(),
          readDocument: (request) => readDocumentForAgent(request),
          requestApproval: (request) => context.approvalBroker.request(request),
          resolveSessionRoot: (sessionId) => coordinator?.getSessionRoot(sessionId),
          isSessionOfWorkspace: (sessionId, headerCwd) => {
            if (coordinator?.hasBinding(sessionId)) return true
            return path.resolve(headerCwd || workspaceDir) === path.resolve(workspaceDir)
          },
          getWorktreeContext: (sessionId) => coordinator?.contextFor(sessionId) ?? '',
          onWorktreeSwitch: handleWorktreeSwitch,
          getSyncState: () => ({
            defaultPermissionLevel: context.getDefaultPermissionLevel(),
            language: context.getLanguage(),
            webAccessConfigVersion: currentWebSearchConfigVersion(),
            sessionRoots: coordinator ? coordinator.getSessionRootsSnapshot() : {},
            webSearchEnv: currentWebSearchEnvSnapshot(),
          }),
          onSessionTitle: (sessionId, title) => {
            broadcastToWindows('agent:session-title', { workspaceDir, sessionId, title })
          },
          onSessionRootChanged: handleSessionRootChanged,
          resolveMcpServers: () => resolveEffectiveMcpServers(workspaceDir),
          logger: context.logger,
        },
        onCrash: ({ workspaceDir: crashedWs, exitCode, interruptedSessionIds }) => {
          crashedWorkspaces.add(agentInitKey(crashedWs))
          context.approvalBroker.cancelWorkspace(
            crashedWs,
            `Agent process crashed (exit code ${exitCode}).`
          )
          context.agentRegistry.evictIfSame(crashedWs, hostClient)
          broadcastToWindows('agent:host-crashed', {
            workspaceDir: crashedWs,
            exitCode,
            interruptedSessionIds,
          })
        },
      })

      const result = await hostClient.initialize({
        workspaceDir,
        agentDir,
        apiConfig: providerConfig,
        allowModelNetwork,
        webAccessExtensionPaths: webAccessPaths,
      })

      if (result.success) {
        crashedWorkspaces.delete(agentInitKey(workspaceDir))
        await context.agentRegistry.set(workspaceDir, hostClient, configKey)
        const pid = hostClient.getPid()
        console.log(
          `[Main] Pi Agent initialized in utilityProcess (pid=${pid ?? 'pending'}) for:`,
          workspaceDir
        )
        return pid ? { success: true, utilityProcessPid: pid } : { success: true }
      }
      await hostClient.dispose().catch(() => undefined)
      console.error('[Main] Failed to initialize Pi Agent utilityProcess:', result.error)
      return result
    }

    // 仅在 utilityProcess 不可用（如 Vitest mock 或 PI_AGENT_IN_PROCESS=1）时回退进程内 AgentManager
    const { AgentManager } = await import('pi-bridge')
    const agent = new AgentManager()

    const result = await agent.initialize({
      workspaceDir,
      agentDir,
      apiConfig: providerConfig,
      credentials: createDesktopCredentialStore(),
      modelsStore: getModelsStore(),
      allowModelNetwork,
      // 联网是应用基础能力：扩展随包内置，由 Agent 在每次创建会话时加载
      webAccessExtensionPaths: webAccessPaths,
      getWebAccessConfigVersion: () => currentWebSearchConfigVersion(),
      logger: context.logger,
      onSessionTitle: (sessionId: string, title: string) => {
        broadcastToWindows('agent:session-title', { workspaceDir, sessionId, title })
      },
      // 会话权限：全局只提供新会话的默认档位；无审批通道时 Agent 侧按拒绝处理
      getDefaultPermissionLevel: () => context.getDefaultPermissionLevel(),
      getLanguage: () => context.getLanguage(),
      // read 工具遇到 pdf / docx / xlsx / pptx 等时回来要内容（工作线程在渲染层）
      readDocument: (request: { path: string; pages?: string; sheet?: string; slide?: string }) =>
        readDocumentForAgent(request),
      requestApproval: (request) => context.approvalBroker.request(request),
      resolveSessionRoot: (sessionId: string) => coordinator?.getSessionRoot(sessionId),
      isSessionOfWorkspace: (sessionId: string, headerCwd: string) => {
        if (coordinator?.hasBinding(sessionId)) return true
        return path.resolve(headerCwd || workspaceDir) === path.resolve(workspaceDir)
      },
      getWorktreeContext: (sessionId: string) => coordinator?.contextFor(sessionId) ?? '',
      onWorktreeSwitch: handleWorktreeSwitch,
      onSessionRootChanged: handleSessionRootChanged,
      getMcpServers: () => resolveEffectiveMcpServers(workspaceDir),
      allowMcpTools: true,
      onMcpChildPid: (pid: number, kill: () => void) =>
        childRegistry.register({ pid, group: 'utility', kill }),
    })

    if (result.success) {
      crashedWorkspaces.delete(agentInitKey(workspaceDir))
      // 登记实例；若该工作区已有旧实例会先释放
      await context.agentRegistry.set(
        workspaceDir,
        agent as unknown as RegisteredAgent,
        configKey
      )
      console.log('[Main] Pi Agent initialized successfully')
    } else {
      await agent.dispose().catch(() => undefined)
      console.error('[Main] Failed to initialize Pi Agent:', result.error)
    }

    return result
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[Main] Agent initialization error:', errorMessage)
    return {
      success: false,
      error: `Failed to initialize agent: ${errorMessage}`,
    }
  }
}

export function registerAgentIpc(context: AgentIpcContext): void {
  // Agent 初始化（按工作区）
  handleIpc('agent:initialize', async (event, config: { workspaceDir: string }) => {
    try {
      const { workspaceDir } = config
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      console.log('[Main] Initializing Pi Agent for workspace:', workspaceDir)
      const result = await ensureWorkspaceAgent(context, workspaceDir)
      if (result.success) {
        ensureStreamPortForSender(context.agentRegistry.get(workspaceDir), event.sender)
      }
      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[Main] Agent initialization error:', errorMessage)
      return {
        success: false,
        error: `Failed to initialize agent: ${errorMessage}`,
      }
    }
  })

  // Agent 宿主进程诊断信息（供 E2E 与排障核验隔离进程 PID）
  handleIpc('agent:hostInfo', async (_event, workspaceDir: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      return {
        success: true,
        isolated: agent instanceof AgentHostClient,
        mainPid: process.pid,
        utilityProcessPid: agent?.getPid?.() ?? null,
        runningSessionIds: agent?.hasRunningSessions?.() ?? [],
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Agent 聊天
  handleIpc(
    'agent:chat',
    async (
      event,
      message: string,
      requestId?: string,
      workspaceDir?: string,
      sessionId?: string,
      images?: unknown
    ) => {
      const startedAt = Date.now()
      try {
        if (workspaceDir && !isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (sessionId !== undefined && sessionId !== '' && !isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
        }
        let agent = workspaceDir ? context.agentRegistry.get(workspaceDir) : null
        if (!agent && workspaceDir && crashedWorkspaces.has(agentInitKey(workspaceDir))) {
          const respawned = await ensureWorkspaceAgent(context, workspaceDir)
          if (!respawned.success) {
            return {
              success: false,
              error: respawned.error ?? 'Failed to restart agent process after crash.',
            }
          }
          agent = context.agentRegistry.get(workspaceDir)
        }
        if (!agent) {
          return {
            success: false,
            error: 'Agent not initialized for this workspace. Please initialize agent first.',
          }
        }

        // 确保直连渲染层 MessagePort 已就绪（已绑定时幂等空操作；崩后重建时自动重绑新端口）
        ensureStreamPortForSender(agent, event.sender)

        // 图像附件：格式 / 张数 / 单张与总大小统一校验，超限明确报错而不是静默丢弃
        const imageCheck = normalizeChatImages(images)
        if (imageCheck.error) {
          return { success: false, error: imageCheck.error }
        }
        const safeImages = imageCheck.images

        console.log('[Main] Sending message to agent:', message.substring(0, 100))
        if (workspaceDir) {
          void context.pluginManager.emit(workspaceDir, 'chat:message', { message })
        }

        // 流式事件统一走直连 MessagePort；未绑定端口（测试 / 进程内回退）时走 agent:stream 兜底
        const onTrace = (trace: { type: string; [key: string]: unknown }) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('agent:stream', { requestId, workspaceDir, sessionId, ...trace })
          }
        }
        const chatOptions = {
          ...(requestId ? { requestId } : {}),
          onTrace,
          ...(safeImages.length > 0 ? { images: safeImages } : {}),
        }
        const result = sessionId
          ? await agent.chat(sessionId, message, chatOptions)
          : await agent.chat(message, chatOptions)

        if (result.success) {
          console.log('[Main] Agent response received')
          const elapsed = Date.now() - startedAt
          // 短任务不打扰；只有超过阈值且窗口不在前台时才通知
          if (workspaceDir && elapsed >= 15_000) {
            const text = context.notificationText()
            context.notify({
              kind: 'complete',
              workspaceDir,
              sessionId: sessionId ?? '',
              title: text.complete,
              body: `${path.basename(workspaceDir)} · ${Math.round(elapsed / 1000)}s`,
            })
          }
        } else {
          console.error('[Main] Agent chat error:', result.error)
          if (workspaceDir) {
            const text = context.notificationText()
            context.notify({
              kind: 'error',
              workspaceDir,
              sessionId: sessionId ?? '',
              title: text.error,
              body: (result.error ?? '').slice(0, 140),
            })
          }
        }

        return result
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        console.error('[Main] Agent chat error:', errorMessage)
        if (workspaceDir) {
          const text = context.notificationText()
          context.notify({
            kind: 'error',
            workspaceDir,
            sessionId: sessionId ?? '',
            title: text.error,
            body: errorMessage.slice(0, 140),
          })
        }
        return {
          success: false,
          error: `Agent error: ${errorMessage}`,
        }
      }
    }
  )

  // 上下文占用与压缩
  handleIpc('agent:context:usage', async (_event, workspaceDir: string, sessionId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (!isValidSessionId(sessionId)) {
        return { success: false, error: 'Invalid session id' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.getContextUsage !== 'function') {
        return { success: false, error: 'Context usage is not supported by this agent' }
      }
      return await agent.getContextUsage(sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('agent:context:compact', async (_event, workspaceDir: string, sessionId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (!isValidSessionId(sessionId)) {
        return { success: false, error: 'Invalid session id' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.compactContext !== 'function') {
        return { success: false, error: 'Compaction is not supported by this agent' }
      }
      return await agent.compactContext(sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 重试 / 编辑重发：回退到最后一条用户消息
  handleIpc(
    'agent:rewind',
    async (_event, workspaceDir: string, sessionId: string, newText?: string) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
        }
        const agent = context.agentRegistry.get(workspaceDir)
        if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
        if (typeof agent.rewindToLastUser !== 'function') {
          return { success: false, error: 'Rewind is not supported by this agent' }
        }
        return await agent.rewindToLastUser(
          sessionId,
          typeof newText === 'string' ? newText : undefined
        )
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // 分支切换（R-03）：列出同一用户消息下的多条回复，或切换到指定回复
  handleIpc('agent:branches:list', async (_event, workspaceDir: string, sessionId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (!isValidSessionId(sessionId)) {
        return { success: false, error: 'Invalid session id' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.listBranches !== 'function') {
        return { success: false, error: 'Branches are not supported by this agent' }
      }
      return await agent.listBranches(sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc(
    'agent:branches:switch',
    async (_event, workspaceDir: string, sessionId: string, entryId: string) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
        }
        if (typeof entryId !== 'string' || !entryId) {
          return { success: false, error: 'Branch entry is required' }
        }
        const agent = context.agentRegistry.get(workspaceDir)
        if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
        if (typeof agent.switchBranch !== 'function') {
          return { success: false, error: 'Branches are not supported by this agent' }
        }
        return await agent.switchBranch(sessionId, entryId)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // 运行中插话：把消息注入当前轮（允许纯图片、空文本）
  handleIpc(
    'agent:steer',
    async (
      _event,
      workspaceDir: string,
      sessionId: string,
      message: unknown,
      images?: unknown
    ) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
        }
        if (typeof message !== 'string') {
          return { success: false, error: 'Message is empty' }
        }
        const text = message.trim()
        const imageCheck = normalizeChatImages(images)
        if (imageCheck.error) return { success: false, error: imageCheck.error }
        if (!text && imageCheck.images.length === 0) {
          return { success: false, error: 'Message is empty' }
        }
        const agent = context.agentRegistry.get(workspaceDir)
        if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
        if (typeof agent.steer !== 'function') {
          return { success: false, error: 'Steering is not supported by this agent' }
        }
        return await agent.steer(
          sessionId,
          text,
          imageCheck.images.length > 0 ? imageCheck.images : undefined
        )
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // Agent 中止请求（按会话；不传 sessionId 时中止该工作区全部会话）
  handleIpc('agent:abort', async (_event, workspaceDir?: string, sessionId?: string) => {
    try {
      if (workspaceDir && !isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (sessionId !== undefined && sessionId !== '' && !isValidSessionId(sessionId)) {
        return { success: false, error: 'Invalid session id' }
      }
      const agent = workspaceDir ? context.agentRegistry.get(workspaceDir) : null
      if (!agent) {
        return { success: false, error: 'Agent not initialized for this workspace' }
      }
      if (typeof agent.abort !== 'function') {
        return { success: false, error: 'Agent does not support abort' }
      }
      // 必须先释放挂起审批再 abort，否则 tool_call 钩子阻塞会话队列导致死锁
      if (sessionId) context.approvalBroker.cancelForSession(sessionId)
      else if (workspaceDir) context.approvalBroker.cancelForWorkspace(workspaceDir)
      await agent.abort(sessionId)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  // 会话管理、配置、标签与元数据子域
  registerAgentSessionIpc(context)
  // 工具结果查看、会话导出、模型能力与结构化计划子域
  registerAgentToolAndExportIpc(context)

  // Agent 清理
  handleIpc('agent:dispose', async (_event, workspaceDir?: string) => {
    try {
      if (workspaceDir && !isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (workspaceDir) {
        crashedWorkspaces.delete(agentInitKey(workspaceDir))
        // 必须先解除该工作区的挂起审批，避免 dispose 内部 abort 等待 tool_call 死锁
        context.approvalBroker.cancelForWorkspace(workspaceDir)
        await context.agentRegistry.dispose(workspaceDir)
        console.log('[Main] Agent disposed:', workspaceDir)
      }
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  // 工具审批响应：渲染层选择“允许一次 / 本会话 / 始终 / 拒绝”
  handleIpc('agent:approval:respond', async (_event, requestId: unknown, decision: unknown) => {
    if (typeof requestId !== 'string' || !requestId) {
      return { success: false, error: 'Invalid approval request id' }
    }
    const sanitized = sanitizeApprovalDecision(decision)
    if (!sanitized) {
      return { success: false, error: 'Invalid approval decision' }
    }
    const delivered = context.approvalBroker.respond(requestId, sanitized)
    if (!delivered) {
      return { success: false, error: 'Approval request is no longer pending' }
    }
    return { success: true }
  })
}
