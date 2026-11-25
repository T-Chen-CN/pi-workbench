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
  overrides?: ModelOverrides
}

export function providerConfigKey(input: ProviderConfigKeyInput): string {
  const overrides = input.overrides ?? {}
  return JSON.stringify({
    providerId: input.providerId,
    modelId: input.modelId,
    credentialFingerprint: input.credentialFingerprint,
    // 字段顺序固定，避免同一份覆盖因键序不同而重建；缺省与 0 均表示使用默认上限
    contextWindow: overrides.contextWindow || null,
    maxTokens: overrides.maxTokens || null,
  })
}
