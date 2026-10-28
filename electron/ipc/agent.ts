/** Agent 生命周期、会话、计划、工具结果与审批 IPC */

import * as fs from 'fs/promises'
import * as path from 'path'
import { shell, dialog, BrowserWindow } from 'electron'
import { getAppDir, getBridgeEntryUrl } from '../app-paths.js'
import { isTrustedWorkspacePath } from '../workspace-trust.js'
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.js'
import { agentConfigKey } from '../agent-config-key.js'
import { sanitizeApprovalDecision, type ApprovalBroker } from '../approval-broker.js'
import type { AgentRegistry } from '../agent-registry.js'
import type { PluginManager } from '../plugin-manager.js'
import { getCoordinator } from '../worktree-coordinator.js'
import {
  currentWebSearchConfigVersion,
  webAccessExtensionPaths,
} from './web-search.js'
import { handleIpc } from './register.js'

const MAX_CHAT_IMAGES = 20
const MAX_IMAGE_BASE64_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3)
const MAX_TOTAL_IMAGE_BASE64_CHARS = 48 * 1024 * 1024
const CHAT_IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/i

interface LoggerLike {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

interface NotificationPayload {
  kind: 'approval' | 'complete' | 'error'
  workspaceDir: string
  sessionId: string
  title: string
  body: string
}

export interface AgentIpcContext {
  agentRegistry: AgentRegistry
  approvalBroker: ApprovalBroker
  pluginManager: PluginManager
  getMainWindow: () => BrowserWindow | null
  getDefaultPermissionLevel: () => unknown
  getLanguage: () => 'zh' | 'en'
  logger: LoggerLike
  notificationText: () => { approval: string; complete: string; error: string }
  notify: (event: NotificationPayload) => void
}

/**
 * 校验并归一化图像附件：格式 / 张数 / 单张与总大小统一处理，
 * 超限明确报错而不是静默丢弃。chat 与 steer 共用。
 */
function normalizeChatImages(images: unknown): {
  images: Array<{ data: string; mimeType: string }>
  error?: string
} {
  const safeImages: Array<{ data: string; mimeType: string }> = []
  if (images === undefined || images === null) return { images: safeImages }
  if (!Array.isArray(images)) {
    return { images: [], error: 'Images must be an array.' }
  }
  if (images.length > MAX_CHAT_IMAGES) {
    return {
      images: [],
      error: `At most ${MAX_CHAT_IMAGES} images can be sent at once.`,
    }
  }
  let totalChars = 0
  for (const image of images) {
    const data = (image as { data?: unknown } | null)?.data
    const mimeType = (image as { mimeType?: unknown } | null)?.mimeType
    if (typeof data !== 'string' || data.length === 0) {
      return { images: [], error: 'Invalid image payload.' }
    }
    if (typeof mimeType !== 'string' || !CHAT_IMAGE_MIME.test(mimeType)) {
      return { images: [], error: 'Unsupported image format.' }
    }
    if (data.length > MAX_IMAGE_BASE64_CHARS) {
      return { images: [], error: 'Each image must be at most 10 MB.' }
    }
    totalChars += data.length
    if (totalChars > MAX_TOTAL_IMAGE_BASE64_CHARS) {
      return { images: [], error: 'Images exceed the total size limit.' }
    }
    safeImages.push({ data, mimeType })
  }
  return { images: safeImages }
}

/**
 * 广播到所有窗口。
 * 面板可以拆成独立窗口（各自一个渲染进程），只发主窗口会让拆出的对话列
 * 收不到会话标题 / 工作树切换事件，只能等下一次列表刷新，出现标题回退与滞后。
 */
function broadcastToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

export function registerAgentIpc(context: AgentIpcContext): void {

// ==================== Pi Agent Integration ====================

// Agent 初始化（按工作区）
handleIpc('agent:initialize', async (_event, config: {
  workspaceDir: string
  apiConfig: {
    provider: string
    apiUrl: string
    apiKey: string
    selectedModel: string
    models?: Array<{ id: string; contextWindow: number; image: boolean }>
  }
}) => {
  try {
    const { workspaceDir, apiConfig } = config

    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }

    console.log('[Main] Initializing Pi Agent with config:', {
      provider: apiConfig.provider,
      model: apiConfig.selectedModel,
      workspaceDir
    })

    // 验证 API Key
    if (!apiConfig.apiKey) {
      return {
        success: false,
        error: 'API key not configured. Please set it in Settings.'
      }
    }

    const configKey = agentConfigKey(apiConfig)
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
      apiConfig,
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
      error: `Failed to initialize agent: ${errorMessage}`
    }
  }
})

// 会话元数据：置顶 / 归档（按工作区存 .pi-workbench/sessions-meta.json）
handleIpc('agent:sessions:meta:get', async (_event, workspaceDir: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const metaPath = path.join(workspaceDir, '.pi-workbench', 'sessions-meta.json')
    const result = readJsonWithBackup<{ pinned?: unknown; archived?: unknown }>(metaPath)
    const sanitize = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((id): id is string => typeof id === 'string').slice(0, 500)
        : []
    return {
      success: true,
      meta: {
        pinned: sanitize(result.data?.pinned),
        archived: sanitize(result.data?.archived),
      },
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc(
  'agent:sessions:meta:set',
  async (_event, workspaceDir: string, meta: { pinned?: unknown; archived?: unknown }) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const sanitize = (value: unknown): string[] =>
        Array.isArray(value)
          ? [...new Set(value.filter((id): id is string => typeof id === 'string'))].slice(0, 500)
          : []
      const dir = path.join(workspaceDir, '.pi-workbench')
      await fs.mkdir(dir, { recursive: true })
      await writeJsonAtomic(path.join(dir, 'sessions-meta.json'), {
        pinned: sanitize(meta?.pinned),
        archived: sanitize(meta?.archived),
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

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

// 会话列表 / 打开 / 新建 / 关闭 / 重命名 / 删除
handleIpc('agent:sessions:list', async (_event, workspaceDir: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = context.agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    const sessions = typeof agent.listSessions === 'function' ? await agent.listSessions() : []
    return { success: true, sessions, currentId: agent.getCurrentSessionId?.() ?? null }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('agent:sessions:open', async (_event, workspaceDir: string, sessionId?: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = context.agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.openSession !== 'function') {
      return { success: false, error: 'Sessions are not supported by this agent' }
    }
    const opened = (await agent.openSession(sessionId)) as
      | { success?: boolean; error?: string }
      | undefined
    // 恢复历史会话时补一次依赖检查：应用关着期间 lockfile 可能已经变了。
    // 装依赖失败不能连坐会话打开，所以单独兜一层。
    if (opened?.success && sessionId) {
      try {
        const coordinator = await getCoordinator(workspaceDir)
        await coordinator?.ensureSessionDeps(sessionId)
      } catch (error) {
        context.logger.warn('[Main] Worktree dependency check failed:', error)
      }
    }
    return opened
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('agent:sessions:create', async (_event, workspaceDir: string, root?: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = context.agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.createSession !== 'function') {
      return { success: false, error: 'Sessions are not supported by this agent' }
    }
    const targetRoot = typeof root === 'string' && root.trim() ? root.trim() : undefined
    if (targetRoot) {
      const { isPathInWorkspace } = await import('../git-worktrees.js')
      if (!isPathInWorkspace(workspaceDir, targetRoot)) {
        return { success: false, error: 'Worktree is outside the workspace' }
      }
    }
    return await agent.createSession(targetRoot)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('agent:sessions:close', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = context.agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.closeSession !== 'function') {
      return { success: false, error: 'Sessions are not supported by this agent' }
    }
    await agent.closeSession(sessionId)
    context.approvalBroker.cancelForSession(sessionId)
    const coordinator = await getCoordinator(workspaceDir)
    const released = coordinator ? await coordinator.release(sessionId) : null
    return { success: true, ...(released ?? {}) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// 工具结果全量查看（R-20）：只读访问会话消息中的完整结果
handleIpc('agent:tool-result:meta', async (_event, workspaceDir: string, sessionId: string, toolCallId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = context.agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.getToolResultMeta !== 'function') {
      return { success: false, error: 'Tool results are not supported by this agent' }
    }
    return await agent.getToolResultMeta(sessionId, toolCallId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc(
  'agent:tool-result:chunk',
  async (
    _event,
    workspaceDir: string,
    sessionId: string,
    toolCallId: string,
    offset?: number,
    limit?: number
  ) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.readToolResultChunk !== 'function') {
        return { success: false, error: 'Tool results are not supported by this agent' }
      }
      const safeOffset = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0
      const safeLimit = typeof limit === 'number' && Number.isFinite(limit) ? limit : 65_536
      return await agent.readToolResultChunk(sessionId, toolCallId, safeOffset, safeLimit)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc(
  'agent:tool-result:image',
  async (_event, workspaceDir: string, sessionId: string, toolCallId: string, index?: number) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.getToolResultImage !== 'function') {
        return { success: false, error: 'Tool results are not supported by this agent' }
      }
      return await agent.getToolResultImage(
        sessionId,
        toolCallId,
        typeof index === 'number' && Number.isFinite(index) ? index : 0
      )
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 完整结果导出到应用缓存并用系统编辑器打开（不产生第二份长期副本）
handleIpc(
  'agent:tool-result:open',
  async (_event, workspaceDir: string, sessionId: string, toolCallId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.getToolResultText !== 'function') {
        return { success: false, error: 'Tool results are not supported by this agent' }
      }
      const result = await agent.getToolResultText(sessionId, toolCallId)
      if (!result.success || typeof result.text !== 'string') return result

      const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'result'
      const filePath = path.join(
        getAppDir(),
        'cache',
        'temp',
        `tool-result-${safeId}.txt`
      )
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, result.text, 'utf-8')
      const openError = await shell.openPath(filePath)
      return openError
        ? { success: false, error: openError, path: filePath }
        : { success: true, path: filePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 会话导出（R-10）：Markdown / 自带样式 HTML / 原始 JSONL
handleIpc(
  'agent:export-session',
  async (
    _event,
    workspaceDir: string,
    sessionId: string,
    format: string,
    language?: string
  ) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (format !== 'md' && format !== 'html' && format !== 'jsonl') {
        return { success: false, error: 'Unsupported export format' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      const lang: 'zh' | 'en' = language === 'en' ? 'en' : 'zh'

      let title = sessionId
      let content: string | null = null
      let sourcePath: string | null = null

      if (format === 'jsonl') {
        if (typeof agent.getSessionJsonlPath !== 'function') {
          return { success: false, error: 'JSONL export is not supported by this agent' }
        }
        const result = await agent.getSessionJsonlPath(sessionId)
        if (!result.success || !result.path) return result
        title = result.title ?? sessionId
        sourcePath = result.path
      } else if (format === 'md') {
        if (typeof agent.exportSessionMarkdown !== 'function') {
          return { success: false, error: 'Markdown export is not supported by this agent' }
        }
        const result = await agent.exportSessionMarkdown(sessionId, lang)
        if (!result.success || typeof result.content !== 'string') return result
        title = result.title ?? sessionId
        content = result.content
      } else {
        if (typeof agent.exportSessionHtml !== 'function') {
          return { success: false, error: 'HTML export is not supported by this agent' }
        }
        const result = await agent.exportSessionHtml(sessionId, lang)
        if (!result.success || typeof result.content !== 'string') return result
        title = result.title ?? sessionId
        content = result.content
      }

      const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'session'
      const extension = format === 'md' ? 'md' : format === 'html' ? 'html' : 'jsonl'
      const filterName = format === 'md' ? 'Markdown' : format === 'html' ? 'HTML' : 'JSONL'
      const options = {
        defaultPath: path.join(workspaceDir, `${safeTitle}.${extension}`),
        filters: [{ name: filterName, extensions: [extension] }],
      }
      const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      const picked = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options)
      if (picked.canceled || !picked.filePath) {
        return { success: true, canceled: true }
      }

      if (sourcePath) {
        await fs.copyFile(sourcePath, picked.filePath)
      } else {
        await fs.writeFile(picked.filePath, content ?? '', 'utf-8')
      }
      return { success: true, path: picked.filePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 模型能力提示（R-06）：上下文窗口、思考与图像输入
handleIpc('agent:models:capabilities', async (_event, workspaceDir: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = context.agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.getModelCapabilities !== 'function') {
      return { success: false, error: 'Model capabilities are not supported by this agent' }
    }
    return await agent.getModelCapabilities()
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// 提示模板与技能（R-13）
handleIpc(
  'agent:prompt-resources',
  async (_event, workspaceDir: string, sessionId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.listPromptResources !== 'function') {
        return { success: false, error: 'Prompt resources are not supported by this agent' }
      }
      return await agent.listPromptResources(sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

// 结构化计划（R-04）：读取 / 批准 / 拒绝
handleIpc('agent:plan:get', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = context.agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.getPlan !== 'function') {
      return { success: false, error: 'Plans are not supported by this agent' }
    }
    return await agent.getPlan(sessionId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc(
  'agent:plan:approve',
  async (
    _event,
    workspaceDir: string,
    sessionId: string,
    planId: string,
    targetMode: 'ask' | 'auto'
  ) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (targetMode !== 'ask' && targetMode !== 'auto') {
        return { success: false, error: 'Invalid execute mode' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.approvePlan !== 'function') {
        return { success: false, error: 'Plans are not supported by this agent' }
      }
      return await agent.approvePlan(sessionId, planId, targetMode)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc(
  'agent:plan:reject',
  async (_event, workspaceDir: string, sessionId: string, planId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.rejectPlan !== 'function') {
        return { success: false, error: 'Plans are not supported by this agent' }
      }
      return await agent.rejectPlan(sessionId, planId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc('agent:session:stats', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = context.agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.getSessionStats !== 'function') {
      return { success: false, error: 'Session stats are not supported by this agent' }
    }
    return await agent.getSessionStats(sessionId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc('agent:session:settings', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const agent = context.agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.getSessionSettings !== 'function') {
      return { success: false, error: 'Session settings are not supported by this agent' }
    }
    return await agent.getSessionSettings(sessionId)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc(
  'agent:session:setPermission',
  async (_event, workspaceDir: string, sessionId: string, permission: unknown) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.setSessionPermission !== 'function') {
        return { success: false, error: 'Session permissions are not supported by this agent' }
      }
      return await agent.setSessionPermission(sessionId, permission)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc(
  'agent:session:setModel',
  async (_event, workspaceDir: string, sessionId: string, modelId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (typeof modelId !== 'string' || !modelId) {
        return { success: false, error: 'Invalid model id' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.setSessionModel !== 'function') {
        return { success: false, error: 'Model switching is not supported by this agent' }
      }
      return await agent.setSessionModel(sessionId, modelId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc(
  'agent:session:setThinking',
  async (_event, workspaceDir: string, sessionId: string, level: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.setSessionThinking !== 'function') {
        return { success: false, error: 'Thinking control is not supported by this agent' }
      }
      return await agent.setSessionThinking(sessionId, level)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc(
  'agent:sessions:rename',
  async (_event, workspaceDir: string, sessionId: string, name: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.renameSession !== 'function') {
        return { success: false, error: 'Sessions are not supported by this agent' }
      }
      return await agent.renameSession(sessionId, name)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

handleIpc('agent:sessions:delete', async (_event, workspaceDir: string, sessionId: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    // 会话 id 会参与 sidecar 文件名，必须在进程边界拒绝路径分隔符与 `..`
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      return { success: false, error: 'Invalid session id' }
    }
    const agent = context.agentRegistry.get(workspaceDir)
    if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
    if (typeof agent.deleteSession !== 'function') {
      return { success: false, error: 'Sessions are not supported by this agent' }
    }
    const result = await agent.deleteSession(sessionId)
    if (result.success) {
      context.approvalBroker.cancelForSession(sessionId)
      const coordinator = await getCoordinator(workspaceDir)
      const released = coordinator ? await coordinator.release(sessionId) : null
      return { ...result, ...(released ?? {}) }
    }
    return result
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// 会话标签持久化（按工作区）
handleIpc('agent:sessions:getTabs', async (_event, workspaceDir: string) => {
  try {
    if (!isTrustedWorkspacePath(workspaceDir)) {
      return { success: false, error: 'Workspace is not approved' }
    }
    const file = path.join(workspaceDir, '.pi-workbench', 'chat-tabs.json')
    const result = readJsonWithBackup<{ open?: string[]; active?: string | null }>(file)
    if (!result.data) {
      return { success: true, tabs: { open: [], active: null } }
    }
    const open = Array.isArray(result.data.open)
      ? result.data.open.filter((id): id is string => typeof id === 'string')
      : []
    const active = typeof result.data.active === 'string' ? result.data.active : null
    return { success: true, tabs: { open, active } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

handleIpc(
  'agent:sessions:setTabs',
  async (_event, workspaceDir: string, tabs: { open?: string[]; active?: string | null }) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const open = Array.isArray(tabs?.open)
        ? tabs.open.filter((id): id is string => typeof id === 'string').slice(0, 20)
        : []
      const active = typeof tabs?.active === 'string' ? tabs.active : null
      const dir = path.join(workspaceDir, '.pi-workbench')
      await fs.mkdir(dir, { recursive: true })
      await writeJsonAtomic(path.join(dir, 'chat-tabs.json'), { open, active })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
)

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
      error: error instanceof Error ? error.message : String(error)
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
