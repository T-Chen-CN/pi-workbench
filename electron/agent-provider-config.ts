/**
 * 旧 `api-config.json` 形态 → 预设供应商形态的过渡层。
 *
 * P4 会把渲染层的设置页换成预设供应商 + 凭证登录；在那之前旧设置页仍在写
 * `{provider, apiUrl, apiKey, selectedModel}`，这里把它翻译成 `{providerId,
 * modelId, overrides}`，并把 Key 交给 `CredentialStore`（不再写 `process.env`）。
 * P4 落地后本文件整体删除。
 */

import type { Credential } from '@earendil-works/pi-ai'
import type { ModelOverrides } from 'pi-bridge'
import { credentialFingerprint, legacyProviderFromUrl } from 'pi-bridge'
import { providerConfigKey } from './agent-config-key.js'
import { createDesktopCredentialStore } from './credentials-store.js'
import { getModelsStore } from './models-store.js'

/** 渲染层当前还在传的形状 */
export interface LegacyAgentApiConfig {
  provider: string
  apiUrl: string
  apiKey: string
  selectedModel: string
  models?: Array<{ id: string; contextWindow: number; image: boolean }>
}

export interface ResolvedAgentProviderConfig {
  configKey: string
  apiConfig: {
    providerId: string
    modelId: string
    overrides?: Record<string, ModelOverrides>
  }
  credentials: ReturnType<typeof createDesktopCredentialStore>
  modelsStore: ReturnType<typeof getModelsStore>
}

export type ResolveResult =
  | { ok: true; value: ResolvedAgentProviderConfig }
  | { ok: false; error: string }

/** 旧配置里的容量档位 → 按模型存的覆盖（只搬上下文窗口，输出上限跟目录走） */
function legacyOverrides(config: LegacyAgentApiConfig): Record<string, ModelOverrides> | undefined {
  const entries = Array.isArray(config.models) ? config.models : []
  const overrides: Record<string, ModelOverrides> = {}
  for (const entry of entries) {
    const contextWindow = Number(entry?.contextWindow ?? 0)
    if (!entry?.id || !Number.isFinite(contextWindow) || contextWindow <= 0) continue
    overrides[entry.id] = { contextWindow }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

export async function resolveAgentProviderConfig(
  legacy: LegacyAgentApiConfig
): Promise<ResolveResult> {
  const providerId = legacyProviderFromUrl(legacy.apiUrl)
  if (!providerId) {
    return {
      ok: false,
      error:
        'Only OpenAI / Anthropic / DeepSeek endpoints map to a built-in provider. Pick a provider in Settings.',
    }
  }

  const modelId = legacy.selectedModel
  const overrides = legacyOverrides(legacy)
  const credentials = createDesktopCredentialStore()

  // Key 换过就覆盖：指纹参与配置签名，换 Key 需要重建运行时
  const desired: Credential = { type: 'api_key', key: legacy.apiKey }
  const existing = await credentials.read(providerId)
  if (existing?.type !== 'api_key' || existing.key !== desired.key) {
    await credentials.modify(providerId, async () => desired)
  }

  const apiConfig = { providerId, modelId, ...(overrides ? { overrides } : {}) }
  return {
    ok: true,
    value: {
      configKey: providerConfigKey({
        providerId,
        modelId,
        credentialFingerprint: credentialFingerprint(desired),
        overrides: overrides?.[modelId],
      }),
      apiConfig,
      credentials,
      modelsStore: getModelsStore(),
    },
  }
}
