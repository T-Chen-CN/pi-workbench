/**
 * 云端连接 IPC（配对 / 解绑 / 状态 / 工作区刷新）。
 *
 * 只有「这台机器连哪台云端」走 IPC；工单内容和云端会话都不经过桌面端——
 * 那是 Web 客户端与云端之间的通道（F-34）。
 */

import { handleIpc } from './register.js'
import { getAppDir } from '../app-paths.js'
import { getCoordinator } from '../worktree-coordinator.js'
import { loadApiConfig } from './api-config.js'
import {
  clearCloudLink,
  normalizeBaseUrl,
  readCloudLink,
  readCloudToken,
  saveCloudLink,
  toLinkView,
} from '../cloud/link-store.js'
import { describeWorkspaces } from '../cloud/inventory.js'
import { DeviceAgent, type DeviceLinkState } from '../cloud/device-agent.js'

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
}

let deviceAgent: DeviceAgent | null = null

async function ensureAgent(context: CloudIpcContext): Promise<DeviceAgent> {
  if (deviceAgent) return deviceAgent
  deviceAgent = new DeviceAgent({
    logger: context.logger,
    dataDir: `${getAppDir()}/data/cloud`,
    getWorkspaces: async () => describeWorkspaces(context.listWorkspacePaths()),
    getApiConfig: async () => {
      const config = await loadApiConfig()
      if (!config || typeof config.apiKey !== 'string' || !config.apiKey) return null
      return {
        provider: String(config.provider ?? 'custom'),
        apiUrl: String(config.apiUrl ?? ''),
        apiKey: config.apiKey,
        selectedModel: String(config.selectedModel ?? ''),
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
      const baseUrl = normalizeBaseUrl(String(input?.baseUrl ?? ''))
      const code = String(input?.code ?? '').trim()
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
      const payload = (await response.json()) as { deviceId?: string; token?: string }
      if (!payload.deviceId || !payload.token) {
        return { success: false, error: 'The cloud returned an unexpected pairing response' }
      }

      await saveCloudLink({
        baseUrl,
        deviceId: payload.deviceId,
        deviceName: input?.deviceName || 'Pi Workbench',
        token: payload.token,
      })
      const agent = await ensureAgent(context)
      await agent.start()
      return { success: true, link: toLinkView(readCloudLink()), state: agent.getState() }
    }
  )

  handleIpc('cloud:unlink', async () => {
    const link = readCloudLink()
    if (link && deviceAgent) await deviceAgent.unlink()
    await clearCloudLink()
    // 尽力通知云端吊销；失败不影响本机解绑
    if (link) {
      try {
        const token = readCloudToken(link)
        if (token) {
          await fetch(`${link.baseUrl}/v1/devices/${encodeURIComponent(link.deviceId)}`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8_000),
          })
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

  handleIpc('cloud:listWorkspaces', async () => ({
    success: true,
    workspaces: await describeWorkspaces(context.listWorkspacePaths()),
  }))
}

export function getCloudDeviceAgent(): DeviceAgent | null {
  return deviceAgent
}
