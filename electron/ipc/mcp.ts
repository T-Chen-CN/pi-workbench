/**
 * 桌面端 MCP 服务器管理 IPC 处理器（全局配置 CRUD + 项目级信任授权 + 连通性测试）。
 *
 * - 所有通道均经 `handleIpc()` 注册，享受发送方来源校验与 `IPC_INVOKE_SCHEMAS` 入参校验；
 * - 项目级操作严格经过 `isTrustedWorkspacePath` 校验；
 * - 返回给渲染层的服务器快照始终脱敏（零明文 `env` / `headers`）；
 * - 配置或信任变更后自动触发活跃工作区 Agent 热刷新其 `McpClientHost`。
 */

import {
  McpClientHost,
  type McpServerConfig,
  type McpServerInput,
  type McpServerStatus,
} from 'pi-bridge'
import { AgentHostClient } from '../agent-host-client.js'
import type { AgentRegistry } from '../agent-registry.js'
import { redactSecrets } from '../cloud/task-report.js'
import {
  deleteGlobalMcpServer,
  getGlobalMcpServerConfig,
  getProjectMcpServerConfig,
  listMcpServersForUi,
  resolveEffectiveMcpServers,
  resolveInlineMcpServerForTest,
  saveGlobalMcpServer,
  setGlobalMcpServerEnabled,
  setProjectServerTrust,
} from '../mcp-store.js'
import { isTrustedWorkspacePath } from '../workspace-trust.js'
import type { McpTestRequest } from './contract.js'
import type { LoggerLike } from './agent-helpers.js'
import { handleIpc } from './register.js'
import {
  mcpServerIdInputSchema,
  mcpSetGlobalEnabledSchema,
  mcpSetProjectTrustSchema,
  parseIpcInput,
} from './schemas.js'

export interface McpIpcContext {
  agentRegistry: AgentRegistry
  logger?: LoggerLike
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mergeRuntimeStatuses(
  items: McpServerStatus[],
  liveStatuses: readonly McpServerStatus[]
): McpServerStatus[] {
  if (liveStatuses.length === 0) return items
  const bySourceAndId = new Map<string, McpServerStatus>()
  for (const live of liveStatuses) {
    bySourceAndId.set(`${live.source}:${live.id}`, live)
  }
  return items.map((item) => {
    if (!item.enabled) return item
    const live = bySourceAndId.get(`${item.source}:${item.id}`)
    if (!live) return item
    return {
      ...item,
      state: live.state,
      tools: live.tools,
      ...(live.error !== undefined ? { error: live.error } : {}),
      ...(live.checkedAt !== undefined ? { checkedAt: live.checkedAt } : {}),
    }
  })
}

async function readLiveMcpStatuses(
  agentRegistry: AgentRegistry,
  workspaceDir?: string
): Promise<McpServerStatus[]> {
  const candidates = workspaceDir
    ? [agentRegistry.get(workspaceDir)]
    : agentRegistry.listWorkspaces().map((ws) => agentRegistry.get(ws))
  for (const agent of candidates) {
    if (!agent || !agent.isInitialized() || typeof agent.getMcpStatuses !== 'function') continue
    try {
      const statuses = await agent.getMcpStatuses()
      if (Array.isArray(statuses)) return statuses
    } catch {
      // 忽略正在重启或异常的 Agent 进程，不影响设置页读取磁盘配置
    }
  }
  return []
}

function refreshActiveAgents(
  agentRegistry: AgentRegistry,
  logger: LoggerLike | undefined,
  targetWorkspaceDir?: string
): void {
  const workspaces = targetWorkspaceDir ? [targetWorkspaceDir] : agentRegistry.listWorkspaces()
  for (const ws of workspaces) {
    const agent = agentRegistry.get(ws)
    if (!agent || !agent.isInitialized() || typeof agent.refreshMcpServers !== 'function') {
      continue
    }
    try {
      const promise =
        agent instanceof AgentHostClient
          ? agent.refreshMcpServers()
          : agent.refreshMcpServers(resolveEffectiveMcpServers(ws))
      void Promise.resolve(promise).catch((error) => {
        logger?.warn(`[MCP IPC] Failed to refresh MCP servers for ${ws}:`, error)
      })
    } catch (error) {
      logger?.warn(`[MCP IPC] Failed to schedule MCP refresh for ${ws}:`, error)
    }
  }
}

export function registerMcpIpc(context: McpIpcContext): void {
  handleIpc('mcp:list', async (_event, workspaceDir?: string) => {
    try {
      const cleanWorkspace =
        typeof workspaceDir === 'string' && workspaceDir.trim().length > 0
          ? workspaceDir.trim()
          : undefined
      if (cleanWorkspace && !isTrustedWorkspacePath(cleanWorkspace)) {
        return {
          success: false,
          global: [],
          project: [],
          error: 'Workspace is not approved',
        }
      }
      const snapshot = listMcpServersForUi(cleanWorkspace)
      const liveStatuses = await readLiveMcpStatuses(context.agentRegistry, cleanWorkspace)
      return {
        success: true,
        global: mergeRuntimeStatuses(snapshot.global, liveStatuses),
        project: mergeRuntimeStatuses(snapshot.project, liveStatuses),
      }
    } catch (error) {
      return {
        success: false,
        global: [],
        project: [],
        error: errorMessageOf(error),
      }
    }
  })

  handleIpc('mcp:saveGlobal', async (_event, input: McpServerInput) => {
    try {
      const server = await saveGlobalMcpServer(input)
      refreshActiveAgents(context.agentRegistry, context.logger)
      return { success: true, server }
    } catch (error) {
      return { success: false, error: errorMessageOf(error) }
    }
  })

  handleIpc('mcp:deleteGlobal', async (_event, id: string) => {
    try {
      const parsed = parseIpcInput(mcpServerIdInputSchema, id)
      if (!parsed.ok) return { success: false, error: parsed.error }
      const deleted = await deleteGlobalMcpServer(parsed.data)
      if (!deleted) {
        return { success: false, error: 'MCP server not found' }
      }
      refreshActiveAgents(context.agentRegistry, context.logger)
      return { success: true }
    } catch (error) {
      return { success: false, error: errorMessageOf(error) }
    }
  })

  handleIpc('mcp:setGlobalEnabled', async (_event, id: string, enabled: boolean) => {
    try {
      const parsed = parseIpcInput(mcpSetGlobalEnabledSchema, { id, enabled })
      if (!parsed.ok) return { success: false, error: parsed.error }
      const server = await setGlobalMcpServerEnabled(parsed.data.id, parsed.data.enabled)
      if (!server) {
        return { success: false, error: 'MCP server not found' }
      }
      refreshActiveAgents(context.agentRegistry, context.logger)
      return { success: true, server }
    } catch (error) {
      return { success: false, error: errorMessageOf(error) }
    }
  })

  handleIpc(
    'mcp:setProjectTrust',
    async (_event, workspaceDir: string, serverId: string, enabled: boolean) => {
      try {
        const parsed = parseIpcInput(mcpSetProjectTrustSchema, {
          workspaceDir,
          serverId,
          enabled,
        })
        if (!parsed.ok) return { success: false, error: parsed.error }
        if (!isTrustedWorkspacePath(parsed.data.workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        const server = await setProjectServerTrust(
          parsed.data.workspaceDir,
          parsed.data.serverId,
          parsed.data.enabled
        )
        refreshActiveAgents(context.agentRegistry, context.logger, parsed.data.workspaceDir)
        return { success: true, ...(server ? { server } : {}) }
      } catch (error) {
        return { success: false, error: errorMessageOf(error) }
      }
    }
  )

  handleIpc('mcp:test', async (_event, request: McpTestRequest) => {
    try {
      if (!request || typeof request !== 'object') {
        return { success: false, error: 'Invalid MCP test request' }
      }
      let targetConfig: McpServerConfig | null = null
      let defaultCwd: string | undefined

      if (request.scope === 'global') {
        const idCheck = parseIpcInput(mcpServerIdInputSchema, request.id)
        if (!idCheck.ok) return { success: false, error: idCheck.error }
        targetConfig = getGlobalMcpServerConfig(idCheck.data)
        if (!targetConfig) return { success: false, error: 'MCP server not found' }
      } else if (request.scope === 'project') {
        if (!isTrustedWorkspacePath(request.workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        const idCheck = parseIpcInput(mcpServerIdInputSchema, request.id)
        if (!idCheck.ok) return { success: false, error: idCheck.error }
        defaultCwd = request.workspaceDir
        targetConfig = getProjectMcpServerConfig(request.workspaceDir, idCheck.data)
        if (!targetConfig) return { success: false, error: 'Project MCP server not found' }
      } else if (request.scope === 'inline') {
        if (request.workspaceDir && !isTrustedWorkspacePath(request.workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        defaultCwd = request.workspaceDir
        targetConfig = resolveInlineMcpServerForTest(request.config, {
          cwdOverride: request.workspaceDir,
        })
      } else {
        return { success: false, error: 'Unsupported MCP test scope' }
      }

      const host = new McpClientHost({
        logger: context.logger,
        defaultCwd,
        outputRedactor: (text) => redactSecrets(text),
      })
      try {
        const result = await host.testServer(targetConfig)
        return { success: true, result }
      } finally {
        await host.dispose().catch(() => undefined)
      }
    } catch (error) {
      return { success: false, error: errorMessageOf(error) }
    }
  })
}
