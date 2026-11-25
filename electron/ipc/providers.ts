/**
 * 供应商与鉴权 IPC。
 *
 * 配置模型：`config/providers.json`（active provider / 模型 / 容量覆盖）+
 * `config/credentials.json`（加密凭证）。**任何频道都不返回密钥**，
 * 只返回「是否已连接」与凭证类型。
 */

import { BrowserWindow } from 'electron'
import { handleIpc } from './register.js'
import {
  forgetProvider,
  listProviders,
  probeApiKey,
  refreshProviders,
  saveApiKey,
  setActiveProvider,
  setModelOverrides,
} from '../providers-service.js'
import {
  answerAuthPrompt,
  cancelOAuthLogin,
  startOAuthLogin,
  type AuthEventPayload,
} from '../auth-flow.js'

/** 登录事件要广播到所有窗口：面板可以拆成独立窗口 */
export function broadcastAuthEvent(providerId: string, payload: AuthEventPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('providers:auth-event', { providerId, ...payload })
  }
}

export function registerProvidersIpc(): void {
  handleIpc('providers:list', async () => {
    try {
      return { success: true, ...(await listProviders()) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('providers:setActive', async (_event, providerId: string, modelId?: string) => {
    const result = await setActiveProvider(providerId, modelId)
    if (!result.ok) return { success: false, error: result.code }
    return { success: true, config: result.config }
  })

  handleIpc(
    'providers:setOverrides',
    async (_event, providerId: string, modelId: string, overrides: unknown) => {
      const result = await setModelOverrides(
        providerId,
        modelId,
        (overrides ?? undefined) as never
      )
      if (!result.ok) return { success: false, error: result.code }
      return { success: true, effective: result.effective, pending: result.pending }
    }
  )

  handleIpc('providers:refresh', async (_event, force?: boolean) => {
    return refreshProviders(force === true)
  })

  handleIpc('providers:setApiKey', async (_event, providerId: string, apiKey: string) => {
    if (typeof apiKey !== 'string' || !apiKey.trim()) return { success: false, error: 'EMPTY_KEY' }
    // 配置时做一次轻量探测（D24）：401/403 直接拒绝，网络异常放行
    const probe = await probeApiKey(providerId, apiKey)
    if (!probe.ok) return { success: false, error: probe.error ?? 'INVALID_KEY' }
    const result = await saveApiKey(providerId, apiKey)
    return result.ok ? { success: true } : { success: false, error: result.error }
  })

  handleIpc('providers:forget', async (_event, providerId: string) => {
    await forgetProvider(providerId)
    return { success: true }
  })

  handleIpc('providers:login', async (_event, providerId: string, type: string) => {
    const result = await startOAuthLogin(providerId, type === 'api_key' ? 'api_key' : 'oauth')
    return result.started ? { success: true } : { success: false, error: result.error }
  })

  handleIpc('providers:authAnswer', async (_event, requestId: string, value: string) => {
    return answerAuthPrompt(requestId, value)
  })

  handleIpc('providers:cancelLogin', async (_event, providerId: string) => {
    return cancelOAuthLogin(providerId)
  })
}
