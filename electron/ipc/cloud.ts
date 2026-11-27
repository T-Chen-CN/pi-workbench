/**
 * 云端连接 IPC（配对 / 解绑 / 状态 / 工作区刷新）。
 *
 * 只有「这台机器连哪台云端」走 IPC；工单内容和云端会话都不经过桌面端——
 * 那是 Web 客户端与云端之间的通道（F-34）。
 */

import type { McpServerInput, McpServerStatus, McpToolInfo } from 'pi-bridge'
import { handleIpc } from './register.js'
import {
  cloudPairSchema,
  cloudSaveConfigSchema,
  mcpServerIdInputSchema,
  parseIpcInput,
} from './schemas.js'
import { getAppDir } from '../app-paths.js'
import { getCoordinator } from '../worktree-coordinator.js'
import { canonicalizePath, isTrustedWorkspacePath, normalizeForComparison } from '../workspace-trust.js'
import { activeProviderConfig } from '../providers-service.js'
import { resolveEffectiveMcpServers } from '../mcp-store.js'
import {
  clearCloudLink,
  normalizeBaseUrl,
  readCloudClientToken,
  readCloudLink,
  readCloudToken,
  saveCloudLink,
  toLinkView,
} from '../cloud/link-store.js'
import { describeWorkspaces } from '../cloud/inventory.js'
import { DeviceAgent, type DeviceLinkState } from '../cloud/device-agent.js'
import { CloudClientBridge, type CloudClientState } from '../cloud/client-link.js'

export interface CloudIpcContext {
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
  /** 已登记的工作区路径（workspaceStore.list()） */
  listWorkspacePaths: () => string[]
  /** 状态变化推给渲染层（托盘 / 云端页角标） */
  onStateChange: (state: DeviceLinkState) => void
  /** 客户端通道的帧与状态推给云端页 */
  onClientFrame: (frame: unknown) => void
  onClientState: (state: CloudClientState) => void
}

let deviceAgent: DeviceAgent | null = null
let clientBridge: CloudClientBridge | null = null

/** 渲染层只能发这几种客户端帧；其余一律拒绝，避免把主进程当代理 */
const CLIENT_FRAME_TYPES = new Set([
  'say',
  'confirm_plan',
  'stop_reply',
  'stop_task',
  'close_unit',
  'mark_read',
  'task_message',
  'ack',
  'ping',
])

function ensureClientBridge(context: CloudIpcContext): CloudClientBridge {
  if (clientBridge) return clientBridge
  clientBridge = new CloudClientBridge({
    logger: context.logger,
    onFrame: (frame) => context.onClientFrame(frame),
    onState: (state) => context.onClientState(state),
  })
  return clientBridge
}

async function ensureAgent(context: CloudIpcContext): Promise<DeviceAgent> {
  if (deviceAgent) return deviceAgent
  deviceAgent = new DeviceAgent({
    logger: context.logger,
    dataDir: `${getAppDir()}/data/cloud`,
    getWorkspaces: async () => describeWorkspaces(context.listWorkspacePaths()),
    isAllowedWorkspace: (workspacePath: string) => {
      if (isTrustedWorkspacePath(workspacePath)) return true
      const target = canonicalizePath(workspacePath)
      if (!target) return false
      const normalized = normalizeForComparison(target)
      return context.listWorkspacePaths().some((item) => {
        const canonical = canonicalizePath(item)
        return canonical !== null && normalizeForComparison(canonical) === normalized
      })
    },
    getApiConfig: async () => {
      // 设备端只上报 provider / 模型 / 指纹，从不把 Key 或片段发给云端（A5）
      const active = await activeProviderConfig()
      if (!active.ok) return null
      return {
        providerId: active.providerId,
        modelId: active.modelId,
        ...(active.overrides ? { overrides: active.overrides } : {}),
        fingerprint: active.fingerprint,
      }
    },
    getCoordinator: async (repoPath: string) => {
      const coordinator = await getCoordinator(repoPath)
      if (!coordinator) return null
      return {
        bind: (sessionId: string, target: string, base?: string) =>
          coordinator.bind(sessionId, target, base),
        getSessionBinding: (sessionId: string) => coordinator.getSessionBinding(sessionId),
        hasBinding: (sessionId: string) => coordinator.hasBinding(sessionId),
        release: (sessionId: string) => coordinator.release(sessionId),
      }
    },
    getMcpServers: (workspacePath: string, worktreePath: string) =>
      resolveEffectiveMcpServers(workspacePath, { cwdOverride: worktreePath }),
    onStateChange: (state) => context.onStateChange(state),
  })
  return deviceAgent
}

/** 启动时若有配对记录就自动连上（失败只记日志，不影响应用启动） */
export async function startCloudDeviceAgentIfLinked(context: CloudIpcContext): Promise<void> {
  const link = readCloudLink()
  if (!link) return
  const agent = await ensureAgent(context)
  void agent.start().catch((error) => {
    context.logger.warn('[Cloud] device agent failed to start:', error)
  })
}

/** 退出前把在跑的工单标 interrupted 并尽量送出队列 */
export async function shutdownCloudDeviceAgent(): Promise<void> {
  clientBridge?.close()
  clientBridge = null
  if (!deviceAgent) return
  const agent = deviceAgent
  deviceAgent = null
  await agent.interruptRunning().catch(() => undefined)
  await agent.stop().catch(() => undefined)
}

export function registerCloudIpc(context: CloudIpcContext): void {
  handleIpc('cloud:linkStatus', async () => {
    const link = readCloudLink()
    const state = deviceAgent?.getState()
    return {
      success: true,
      link: toLinkView(link),
      state: state ?? { status: readCloudLink() ? 'offline' : 'unlinked', pending: 0 },
      dataDir: `${getAppDir()}/data/cloud`,
    }
  })

  /** 配对：云端返回 deviceId + token，本机加密落盘后立刻连接 */
  handleIpc(
    'cloud:pair',
    async (
      _event,
      input: { baseUrl?: string; code?: string; deviceName?: string }
    ) => {
      const parsed = parseIpcInput(cloudPairSchema, input)
      if (!parsed.ok) return { success: false, error: parsed.error }
      const baseUrl = normalizeBaseUrl(parsed.data.baseUrl)
      const code = parsed.data.code.trim()
      if (!baseUrl) return { success: false, error: 'Cloud address is required' }
      if (!/^\d{6}$/.test(code)) return { success: false, error: 'The pairing code is 6 digits' }

      const workspaces = await describeWorkspaces(context.listWorkspacePaths())
      let response: Response
      try {
        response = await fetch(`${baseUrl}/v1/pair`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            code,
            deviceName: input?.deviceName || 'Pi Workbench',
            platform: process.platform,
            workspaces,
          }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? `Cannot reach ${baseUrl}: ${error.message}` : 'Cannot reach the cloud',
        }
      }
      if (!response.ok) {
        // 云端刻意不区分「码错 / 过期 / 被用过」
        return {
          success: false,
          error:
            response.status === 429
              ? 'Too many attempts. Wait a few minutes and try again.'
              : 'The pairing code is invalid or expired.',
        }
      }
      const payload = (await response.json()) as {
        deviceId?: string
        token?: string
        clientToken?: string
      }
      if (!payload.deviceId || !payload.token) {
        return { success: false, error: 'The cloud returned an unexpected pairing response' }
      }

      await saveCloudLink({
        baseUrl,
        deviceId: payload.deviceId,
        deviceName: input?.deviceName || 'Pi Workbench',
        token: payload.token,
        ...(payload.clientToken ? { clientToken: payload.clientToken } : {}),
      })
      // 重新配对时先停掉旧实例并清空句柄，避免旧 WS 泄漏或旧执行器向新云端继续回传事件
      if (deviceAgent) {
        const previous = deviceAgent
        deviceAgent = null
        await previous.stop().catch(() => undefined)
      }
      const agent = await ensureAgent(context)
      await agent.start()
      // 换了 token：客户端通道必须重连，否则还在用旧凭据
      clientBridge?.close()
      clientBridge = null
      return { success: true, link: toLinkView(readCloudLink()), state: agent.getState() }
    }
  )

  handleIpc('cloud:unlink', async () => {
    clientBridge?.close()
    clientBridge = null
    const link = readCloudLink()
    const agent = deviceAgent
    // 必须置空 deviceAgent：unlink 会把内部 runner.disposed 置 true，否则同进程重新配对会永久丢单
    deviceAgent = null
    if (link && agent) await agent.unlink()
    await clearCloudLink()
    // 尽力通知云端吊销（服务端已支持设备用自身 Bearer Token 自吊销并踢线）
    if (link) {
      try {
        const token = readCloudToken(link)
        if (token) {
          const response = await fetch(`${link.baseUrl}/v1/devices/${encodeURIComponent(link.deviceId)}`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8_000),
          })
          if (!response.ok) {
            context.logger.warn(`[Cloud] revoke returned HTTP ${response.status}`)
          }
        }
      } catch (error) {
        context.logger.warn('[Cloud] failed to revoke the device on the cloud:', error)
      }
    }
    return { success: true }
  })

  handleIpc('cloud:reconnect', async () => {
    if (!readCloudLink()) return { success: false, error: 'This device is not paired' }
    const agent = await ensureAgent(context)
    await agent.reconnect()
    return { success: true, state: agent.getState() }
  })

  handleIpc('cloud:refreshWorkspaces', async () => {
    if (!deviceAgent) return { success: false, error: 'Not linked' }
    await deviceAgent.refreshWorkspaces()
    return { success: true, workspaces: await describeWorkspaces(context.listWorkspacePaths()) }
  })

  /** 云端页：打开客户端通道（未配对时返回失败，由页面引导去配对） */
  handleIpc('cloud:clientOpen', async () => {
    const bridge = ensureClientBridge(context)
    return { success: true, state: bridge.open() }
  })

  handleIpc('cloud:clientClose', async () => {
    clientBridge?.close()
    return { success: true }
  })

  handleIpc('cloud:clientSend', async (_event, frame: { type?: string }) => {
    const bridge = ensureClientBridge(context)
    const type = String(frame?.type ?? '')
    if (!CLIENT_FRAME_TYPES.has(type)) {
      return { success: false, error: `Unsupported frame type: ${type}` }
    }
    return bridge.send(frame as never)
  })

  /** 云端配置：桌面端通过主进程代理（渲染层不直接打云端，避免 CORS 与凭据外泄） */
  handleIpc('cloud:getConfig', async () => {
    const link = readCloudLink()
    if (!link) return { success: false, error: 'This device is not paired' }
    const token = readCloudClientToken(link)
    if (!token) return { success: false, error: 'Saved token cannot be decrypted; pair again.' }
    try {
      const response = await fetch(`${link.baseUrl}/v1/cloud-config`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return { success: false, error: `HTTP ${response.status}` }
      return { success: true, config: await response.json() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('cloud:saveConfig', async (_event, config: unknown) => {
    const parsed = parseIpcInput(cloudSaveConfigSchema, config ?? {})
    if (!parsed.ok) return { success: false, error: parsed.error }
    const link = readCloudLink()
    if (!link) return { success: false, error: 'This device is not paired' }
    const token = readCloudClientToken(link)
    if (!token) return { success: false, error: 'Saved token cannot be decrypted; pair again.' }
    try {
      const response = await fetch(`${link.baseUrl}/v1/cloud-config`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(15_000),
      })
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
      if (!response.ok) {
        return {
          success: false,
          error: String(payload.error ?? `HTTP ${response.status}`),
        }
      }
      return { success: true, result: payload }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** 云端页：代拉供应商模型清单（走云端 /v1/cloud-config/catalog） */
  handleIpc('cloud:fetchModels', async (_event, input: unknown) => {
    const link = readCloudLink()
    if (!link) return { success: false, error: 'This device is not paired', models: [], catalog: [] }
    const token = readCloudClientToken(link)
    if (!token) {
      return {
        success: false,
        error: 'Saved token cannot be decrypted; pair again.',
        models: [],
        catalog: [],
      }
    }
    const providerId =
      input && typeof input === 'object' && typeof (input as { providerId?: unknown }).providerId === 'string'
        ? (input as { providerId: string }).providerId.trim()
        : ''
    if (!providerId) return { success: false, error: 'providerId is required', models: [], catalog: [] }
    try {
      const url = `${link.baseUrl}/v1/cloud-config/catalog?providerId=${encodeURIComponent(providerId)}`
      const response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      })
      const payload = (await response.json().catch(() => ({}))) as {
        models?: Array<
          | string
          | {
              id?: string
              name?: string
              contextWindow?: number
              maxTokens?: number
              reasoning?: boolean
              vision?: boolean
            }
        >
        error?: string
      }
      if (!response.ok) {
        return {
          success: false,
          error: String(payload.error ?? `HTTP ${response.status}`),
          models: [],
          catalog: [],
        }
      }
      const catalog = Array.isArray(payload.models)
        ? payload.models
            .map((entry) =>
              typeof entry === 'string'
                ? { id: entry }
                : {
                    id: String(entry?.id ?? ''),
                    name: typeof entry?.name === 'string' ? entry.name : undefined,
                    contextWindow: typeof entry?.contextWindow === 'number' ? entry.contextWindow : undefined,
                    maxTokens: typeof entry?.maxTokens === 'number' ? entry.maxTokens : undefined,
                    reasoning: typeof entry?.reasoning === 'boolean' ? entry.reasoning : undefined,
                    vision: typeof entry?.vision === 'boolean' ? entry.vision : undefined,
                  }
            )
            .filter((entry) => Boolean(entry.id))
        : []
      const models = catalog.map((entry) => entry.id)
      return { success: true, models, catalog }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        models: [],
        catalog: [],
      }
    }
  })

  handleIpc('cloud:clientState', async () => ({
    success: true,
    state: clientBridge?.getState() ?? { status: 'closed' },
  }))

  handleIpc('cloud:listWorkspaces', async () => ({
    success: true,
    workspaces: await describeWorkspaces(context.listWorkspacePaths()),
  }))

  // ------------------------------ 云端记忆、留存文档与梦境代理（F-39 / F-41 / C-03a） ------------------------------

  const cloudRequest = async (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    apiPath: string,
    body?: unknown,
    timeoutMs = 25_000
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> => {
    const link = readCloudLink()
    if (!link) return { ok: false, error: 'This device is not paired' }
    const token = readCloudClientToken(link)
    if (!token) return { ok: false, error: 'Saved token cannot be decrypted; pair again.' }
    try {
      const response = await fetch(`${link.baseUrl}${apiPath}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
      if (!response.ok) {
        return { ok: false, error: String(payload.error ?? `HTTP ${response.status}`) }
      }
      return { ok: true, data: payload }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  handleIpc('cloud:getMemoryData', async () => {
    const [memRes, docRes, dreamRes] = await Promise.all([
      cloudRequest('GET', '/v1/memories'),
      cloudRequest('GET', '/v1/cloud-docs'),
      cloudRequest('GET', '/v1/dreams'),
    ])
    if (!memRes.ok) return { success: false, error: memRes.error }
    if (!docRes.ok) return { success: false, error: docRes.error }
    if (!dreamRes.ok) return { success: false, error: dreamRes.error }
    return {
      success: true,
      memories: Array.isArray(memRes.data.memories) ? memRes.data.memories : [],
      docs: Array.isArray(docRes.data.docs) ? docRes.data.docs : [],
      dreams: Array.isArray(dreamRes.data.dreams) ? dreamRes.data.dreams : [],
    }
  })

  handleIpc(
    'cloud:addMemory',
    async (_event, input: { kind?: string; content: string; tags?: string[]; pinned?: boolean }) => {
      const res = await cloudRequest('POST', '/v1/memories', input)
      if (!res.ok) return { success: false, error: res.error }
      return { success: true, memory: res.data.memory }
    }
  )

  handleIpc(
    'cloud:updateMemory',
    async (
      _event,
      input: { id: string; kind?: string; content?: string; tags?: string[]; pinned?: boolean }
    ) => {
      const id = String(input?.id ?? '').trim()
      if (!id) return { success: false, error: 'id is required' }
      const res = await cloudRequest('PATCH', `/v1/memories/${encodeURIComponent(id)}`, {
        kind: input.kind,
        content: input.content,
        tags: input.tags,
        pinned: input.pinned,
      })
      if (!res.ok) return { success: false, error: res.error }
      return { success: true, memory: res.data.memory }
    }
  )

  handleIpc('cloud:deleteMemory', async (_event, id: string) => {
    const clean = String(id ?? '').trim()
    if (!clean) return { success: false, error: 'id is required' }
    const res = await cloudRequest('DELETE', `/v1/memories/${encodeURIComponent(clean)}`)
    if (!res.ok) return { success: false, error: res.error }
    return { success: true }
  })

  handleIpc('cloud:saveDoc', async (_event, input: { name: string; content: string }) => {
    const name = String(input?.name ?? '').trim()
    if (name !== 'AGENTS.md' && name !== 'SOUL.md') {
      return { success: false, error: 'Unsupported document name' }
    }
    const res = await cloudRequest('PUT', `/v1/cloud-docs/${encodeURIComponent(name)}`, {
      content: typeof input?.content === 'string' ? input.content : '',
    })
    if (!res.ok) return { success: false, error: res.error }
    return { success: true, doc: res.data.doc }
  })

  handleIpc('cloud:runDream', async () => {
    const res = await cloudRequest('POST', '/v1/dreams/run', {})
    if (!res.ok) return { success: false, error: res.error }
    return { success: true, dream: res.data.dream ?? null }
  })

  // ------------------------------ 云端 MCP 服务器管理代理（Phase F · Step F3） ------------------------------

  const deriveCloudMcpId = (name: string): string => {
    const slug = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/-+$/g, '')
      .slice(0, 56)
    return slug && mcpServerIdInputSchema.safeParse(slug).success
      ? slug
      : `mcp-${Date.now().toString(36)}`
  }

  handleIpc('cloud:mcp:list', async () => {
    const res = await cloudRequest('GET', '/v1/mcp')
    if (!res.ok) return { success: false, servers: [], error: res.error }
    return {
      success: true,
      servers: Array.isArray(res.data.servers) ? (res.data.servers as McpServerStatus[]) : [],
    }
  })

  handleIpc('cloud:mcp:save', async (_event, input: McpServerInput) => {
    const candidateId =
      typeof input?.id === 'string' && input.id.trim().length > 0
        ? input.id.trim()
        : deriveCloudMcpId(String(input?.name ?? ''))
    const idCheck = parseIpcInput(mcpServerIdInputSchema, candidateId)
    if (!idCheck.ok) return { success: false, error: idCheck.error }
    const res = await cloudRequest(
      'PUT',
      `/v1/mcp/${encodeURIComponent(idCheck.data)}`,
      { ...input, id: idCheck.data }
    )
    if (!res.ok) return { success: false, error: res.error }
    return {
      success: true,
      ...(res.data.server ? { server: res.data.server as McpServerStatus } : {}),
    }
  })

  handleIpc('cloud:mcp:delete', async (_event, id: string) => {
    const parsed = parseIpcInput(mcpServerIdInputSchema, id)
    if (!parsed.ok) return { success: false, error: parsed.error }
    const res = await cloudRequest('DELETE', `/v1/mcp/${encodeURIComponent(parsed.data)}`)
    if (!res.ok) return { success: false, error: res.error }
    return { success: true }
  })

  handleIpc(
    'cloud:mcp:test',
    async (_event, payload: { id?: string; config?: McpServerInput }) => {
      const requestedTimeout =
        typeof payload?.config?.timeoutMs === 'number' && Number.isFinite(payload.config.timeoutMs)
          ? Math.min(130_000, Math.max(30_000, payload.config.timeoutMs + 10_000))
          : 45_000
      const res = await cloudRequest('POST', '/v1/mcp/test', payload ?? {}, requestedTimeout)
      if (!res.ok) return { success: false, error: res.error }
      return {
        success: true,
        result: {
          ok: Boolean(res.data.ok),
          tools: Array.isArray(res.data.tools) ? (res.data.tools as McpToolInfo[]) : [],
          latencyMs: typeof res.data.latencyMs === 'number' ? res.data.latencyMs : 0,
          ...(typeof res.data.error === 'string' ? { error: res.data.error } : {}),
        },
      }
    }
  )
}

/** 工作区清单变化：让设备代理立刻重报（离线时进 outbox，重连后补） */
export function notifyCloudWorkspacesChanged(): void {
  void deviceAgent?.refreshWorkspaces().catch((error) => {
    console.warn('[Cloud] failed to refresh workspaces:', error)
  })
}

export function getCloudDeviceAgent(): DeviceAgent | null {
  return deviceAgent
}
