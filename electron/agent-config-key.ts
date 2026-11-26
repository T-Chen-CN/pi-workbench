import type { ModelOverrides } from 'pi-bridge'

/**
 * 供应商预设时代的配置签名。
 *
 * 只包含**身份**：换 provider / 换模型 / 换 key（指纹变）/ 改容量覆盖才重建。
 * OAuth token 刷新不影响指纹（`credentialFingerprint` 对 oauth 固定返回 `oauth`），
 * 否则每次刷新都会 dispose 正在跑的会话。
 */
export interface ProviderConfigKeyInput {
  providerId: string
  modelId: string
  credentialFingerprint: string
  /** 兼容旧调用方：单模型覆盖，归并到当前 modelId */
  overrides?: ModelOverrides
  /** 当前 provider 下按模型存的全部覆盖；改任意模型上限都必须触发重建 */
  overridesByModel?: Record<string, ModelOverrides>
}

function normalizeOverrideEntry(value: ModelOverrides | undefined): {
  contextWindow: number | null
  maxTokens: number | null
} | null {
  if (!value) return null
  const contextWindow = value.contextWindow || null
  const maxTokens = value.maxTokens || null
  if (contextWindow === null && maxTokens === null) return null
  return { contextWindow, maxTokens }
}

export function providerConfigKey(input: ProviderConfigKeyInput): string {
  const merged: Record<string, { contextWindow: number | null; maxTokens: number | null }> = {}
  if (input.overridesByModel) {
    for (const modelId of Object.keys(input.overridesByModel).sort()) {
      const normalized = normalizeOverrideEntry(input.overridesByModel[modelId])
      if (normalized) merged[modelId] = normalized
    }
  }
  const single = normalizeOverrideEntry(input.overrides)
  if (single) merged[input.modelId] = single

  const sortedOverrides: Record<
    string,
    { contextWindow: number | null; maxTokens: number | null }
  > = {}
  for (const modelId of Object.keys(merged).sort()) {
    sortedOverrides[modelId] = merged[modelId]
  }

  return JSON.stringify({
    providerId: input.providerId,
    modelId: input.modelId,
    credentialFingerprint: input.credentialFingerprint,
    overrides: sortedOverrides,
  })
}
