/**
 * OAuth 登录交互桥。
 *
 * SDK 的登录实现通过 `AuthInteraction` 与用户对话：`prompt()` 要一个输入（
 * select / text / secret / manual_code），`notify()` 推通知（授权链接 / 设备码 /
 * 进度）。桌面端把这两条通道映射成 IPC 事件：
 * - `prompt`  → `providers:auth-event { kind: 'prompt', requestId, prompt }`，
 *               渲染层用 `providers:auth-answer { requestId, value }` 回答；
 * - `notify` → `providers:auth-event { kind: <event.type>, ... }`，只展示不等待。
 *
 * 同一时刻每个 provider 只允许一个登录流程（回调端口 / 设备码都不能并发），
 * 取消走 `AbortController`，超时默认 5 分钟。
 */

import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import * as path from 'path'
import { isPresetProviderId } from 'pi-bridge'
import { getAppDir } from './app-paths.js'
import { createDesktopCredentialStore } from './credentials-store.js'
import { getModelsStore } from './models-store.js'
import { resetCatalogRuntime, saveApiKey, saveOAuthCredential } from './providers-service.js'
import { deviceIdSync } from './device-id.js'

export interface AuthPromptPayload {
  requestId: string
  prompt: {
    type: AuthPrompt['type']
    message: string
    placeholder?: string
    options?: Array<{ id: string; label: string; description?: string }>
  }
}

export type AuthEventPayload =
  | { kind: 'prompt'; prompt: AuthPromptPayload }
  | ({ kind: AuthEvent['type'] } & Record<string, unknown>)
  | { kind: 'result'; success: boolean; error?: string }

export interface AuthFlowDeps {
  /** 把事件发给渲染层（主窗口与拆出的面板窗口） */
  emit(providerId: string, payload: AuthEventPayload): void
}

const ANSWER_TIMEOUT_MS = 5 * 60 * 1000

interface PendingPrompt {
  providerId: string
  resolve: (value: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const flows = new Map<string, AbortController>()
const pendingPrompts = new Map<string, PendingPrompt>()
let deps: AuthFlowDeps = { emit: () => {} }

export function configureAuthFlow(next: AuthFlowDeps): void {
  deps = next
}

/**
 * 开始 OAuth 登录。调用后立刻返回 `{ started }`，结果通过
 * `providers:auth-event` 的 `result` 事件通知，避免 IPC 长时间挂起。
 */
export async function startOAuthLogin(
  providerId: string,
  type: 'oauth' | 'api_key' = 'oauth'
): Promise<{ started: boolean; error?: string }> {
  if (!isPresetProviderId(providerId)) return { started: false, error: 'PROVIDER_UNKNOWN' }
  if (flows.has(providerId)) return { started: false, error: 'ALREADY_RUNNING' }

  const controller = new AbortController()
  flows.set(providerId, controller)

  void runLogin(providerId, type, controller).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    deps.emit(providerId, { kind: 'result', success: false, error: message })
  })

  return { started: true }
}

/** 渲染层回答某个提示 */
export function answerAuthPrompt(requestId: string, value: string): { ok: boolean } {
  const pending = pendingPrompts.get(requestId)
  if (!pending) return { ok: false }
  pendingPrompts.delete(requestId)
  clearTimeout(pending.timer)
  pending.resolve(value)
  return { ok: true }
}

/** 取消该 provider 正在进行的登录 */
export function cancelOAuthLogin(providerId: string): { ok: boolean } {
  const controller = flows.get(providerId)
  if (!controller) return { ok: false }
  controller.abort()
  flows.delete(providerId)
  for (const [requestId, pending] of pendingPrompts) {
    if (pending.providerId !== providerId) continue
    pendingPrompts.delete(requestId)
    clearTimeout(pending.timer)
    pending.reject(new Error('LOGIN_CANCELLED'))
  }
  return { ok: true }
}

async function runLogin(
  providerId: string,
  type: 'oauth' | 'api_key',
  controller: AbortController
): Promise<void> {
  try {
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      credentials: createDesktopCredentialStore(),
      modelsStore: getModelsStore(),
      refreshOnCreate: false,
      allowModelNetwork: false,
    })

    const interaction: AuthInteraction = {
      signal: controller.signal,
      prompt: (prompt) => promptUser(providerId, prompt, controller.signal),
      notify: (event) => deps.emit(providerId, { kind: event.type, ...event }),
    }

    const credential = await runtime.login(providerId, type, interaction, {
      agentName: 'Pi Workbench',
      // SDK 会把它当 agentHostId 上报，必须是稳定 UUID（D27）
      getDeviceId: () => deviceIdSync(path.join(getAppDir(), 'config', 'device-id')),
    })

    if (credential.type === 'oauth') {
      await saveOAuthCredential(providerId, credential)
    } else if (credential.type === 'api_key' && credential.key) {
      const saved = await saveApiKey(providerId, credential.key)
      if (!saved.ok) throw new Error(saved.error)
    } else {
      await createDesktopCredentialStore().modify(providerId, async () => credential)
      resetCatalogRuntime()
    }

    deps.emit(providerId, { kind: 'result', success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.emit(providerId, { kind: 'result', success: false, error: message })
  } finally {
    if (flows.get(providerId) === controller) {
      flows.delete(providerId)
    }
  }
}

function promptUser(
  providerId: string,
  prompt: AuthPrompt,
  signal: AbortSignal
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('LOGIN_CANCELLED'))
      return
    }
    const requestId = `${providerId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`

    const timer = setTimeout(() => {
      pendingPrompts.delete(requestId)
      reject(new Error('LOGIN_TIMEOUT'))
    }, ANSWER_TIMEOUT_MS)

    pendingPrompts.set(requestId, { providerId, resolve, reject, timer })

    // 整个流程被取消时，未回答的提示一并失败
    signal.addEventListener(
      'abort',
      () => {
        if (!pendingPrompts.has(requestId)) return
        pendingPrompts.delete(requestId)
        clearTimeout(timer)
        reject(new Error('LOGIN_CANCELLED'))
      },
      { once: true }
    )

    deps.emit(providerId, {
      kind: 'prompt',
      prompt: {
        requestId,
        prompt: {
          type: prompt.type,
          message: prompt.message,
          ...('placeholder' in prompt && prompt.placeholder
            ? { placeholder: prompt.placeholder }
            : {}),
          ...(prompt.type === 'select'
            ? { options: prompt.options.map((option) => ({ ...option })) }
            : {}),
        },
      },
    })
  })
}
