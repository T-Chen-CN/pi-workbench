/** Agent 生命周期、对话、流式控制与审批 IPC（会话与工具结果子域分别在 agent-sessions.ts / agent-tools.ts） */

import * as path from 'path'
import { getAppDir, getBridgeEntryUrl } from '../app-paths.js'
import { isTrustedWorkspacePath } from '../workspace-trust.js'
import { providerConfigKey } from '../agent-config-key.js'
import { activeProviderConfig } from '../providers-service.js'
import { createDesktopCredentialStore } from '../credentials-store.js'
import { getModelsStore } from '../models-store.js'
import { sanitizeApprovalDecision } from '../approval-broker.js'
import { getCoordinator } from '../worktree-coordinator.js'
import { readDocumentForAgent } from '../documents/agent-read.js'
import {
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
const initializingAgents = new Map<string, Promise<{ success: boolean; error?: string }>>()

function agentInitKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export async function ensureWorkspaceAgent(
  context: AgentIpcContext,
  workspaceDir: string
): Promise<{ success: boolean; error?: string }> {
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
): Promise<{ success: boolean; error?: string }> {
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
      overrides: active.overrides?.[active.modelId],
    })

    if (context.agentRegistry.shouldReuse(workspaceDir, configKey)) {
      console.log('[Main] Reusing agent for workspace:', workspaceDir)
      return { success: true }
    }

    // 延迟加载 AgentManager（用运行时路径解析，避免类型检查依赖未构建的 pi-bridge/dist）
    const { AgentManager } = await import(getBridgeEntryUrl())
    const agent = new AgentManager()
    const coordinator = await getCoordinator(workspaceDir)

    // 初始化 Agent（传入完整的 apiConfig + 便携式 agent 数据目录）
    const result = await agent.initialize({
      workspaceDir,
      agentDir: path.join(getAppDir(), 'data', 'agent'),
      apiConfig: providerConfig,
      credentials: createDesktopCredentialStore(),
      modelsStore: getModelsStore(),
      allowModelNetwork: true,
      // 联网是应用基础能力：扩展随包内置，由 Agent 在每次创建会话时加载
      webAccessExtensionPaths: webAccessExtensionPaths(),
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
      requestApproval: (request: unknown) => context.approvalBroker.request(request as any),
      resolveSessionRoot: (sessionId: string) => coordinator?.getSessionRoot(sessionId),
      isSessionOfWorkspace: (sessionId: string, headerCwd: string) => {
        if (coordinator?.hasBinding(sessionId)) return true
        return path.resolve(headerCwd || workspaceDir) === path.resolve(workspaceDir)
      },
      getWorktreeContext: (sessionId: string) => coordinator?.contextFor(sessionId) ?? '',
      onWorktreeSwitch: async (sessionId: string, target: string, base?: string) => {
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
      },
      onSessionRootChanged: (sessionId: string, root: string) => {
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
      },
    })

    if (result.success) {
      // 登记实例；若该工作区已有旧实例会先释放
      await context.agentRegistry.set(workspaceDir, agent, configKey)
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
  handleIpc('agent:initialize', async (_event, config: { workspaceDir: string }) => {
    try {
      const { workspaceDir } = config
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      console.log('[Main] Initializing Pi Agent for workspace:', workspaceDir)
      return await ensureWorkspaceAgent(context, workspaceDir)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[Main] Agent initialization error:', errorMessage)
      return {
        success: false,
        error: `Failed to initialize agent: ${errorMessage}`,
      }
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
        const agent = workspaceDir ? context.agentRegistry.get(workspaceDir) : null
        if (!agent) {
          return {
            success: false,
            error: 'Agent not initialized for this workspace. Please initialize agent first.',
          }
        }

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

        // 流式事件统一走 agent:stream（文本 / 思考 / 工具），带路由字段供渲染层过滤
        const onTrace = (trace: { type: string; [key: string]: unknown }) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('agent:stream', { requestId, workspaceDir, sessionId, ...trace })
          }
        }
        const chatOptions = safeImages.length > 0 ? { onTrace, images: safeImages } : { onTrace }
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
      await agent.abort(sessionId)
      // 中止后挂起的审批已无意义，通知渲染层移除卡片
      if (sessionId) context.approvalBroker.cancelForSession(sessionId)
      else if (workspaceDir) context.approvalBroker.cancelForWorkspace(workspaceDir)
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
        await context.agentRegistry.dispose(workspaceDir)
        context.approvalBroker.cancelForWorkspace(workspaceDir)
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
