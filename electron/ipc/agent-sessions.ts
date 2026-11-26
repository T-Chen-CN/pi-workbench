/** Agent 会话管理、统计、配置与标签持久化 IPC */

import * as fs from 'fs/promises'
import * as path from 'path'
import { isTrustedWorkspacePath } from '../workspace-trust.js'
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.js'
import { getCoordinator } from '../worktree-coordinator.js'
import { handleIpc } from './register.js'
import { isValidSessionId, type AgentIpcContext } from './agent-helpers.js'

export function registerAgentSessionIpc(context: AgentIpcContext): void {
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
      if (sessionId !== undefined && sessionId !== '' && !isValidSessionId(sessionId)) {
        return { success: false, error: 'Invalid session id' }
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
      if (!isValidSessionId(sessionId)) {
        return { success: false, error: 'Invalid session id' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.closeSession !== 'function') {
        return { success: false, error: 'Sessions are not supported by this agent' }
      }
      // 必须先释放挂起审批，避免 closeSession 内部 abort 与 tool_call 死锁
      context.approvalBroker.cancelForSession(sessionId)
      await agent.closeSession(sessionId)
      const coordinator = await getCoordinator(workspaceDir)
      const released = coordinator ? await coordinator.release(sessionId) : null
      return { success: true, ...(released ?? {}) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('agent:session:stats', async (_event, workspaceDir: string, sessionId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      if (!isValidSessionId(sessionId)) {
        return { success: false, error: 'Invalid session id' }
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
      if (!isValidSessionId(sessionId)) {
        return { success: false, error: 'Invalid session id' }
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
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
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
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
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
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
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
        if (!isValidSessionId(sessionId)) {
          return { success: false, error: 'Invalid session id' }
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
      if (!isValidSessionId(sessionId)) {
        return { success: false, error: 'Invalid session id' }
      }
      const agent = context.agentRegistry.get(workspaceDir)
      if (!agent) return { success: false, error: 'Agent not initialized for this workspace' }
      if (typeof agent.deleteSession !== 'function') {
        return { success: false, error: 'Sessions are not supported by this agent' }
      }
      // 必须先释放挂起审批，避免 deleteSession 内部关闭会话时等待 tool_call 死锁
      context.approvalBroker.cancelForSession(sessionId)
      const result = await agent.deleteSession(sessionId)
      if (result.success) {
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
}
