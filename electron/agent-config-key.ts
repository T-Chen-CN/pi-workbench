import type { ModelOverrides } from 'pi-bridge'

/**
 * Agent 配置签名。
 *
 * 任何会改变 models.json 的字段变化都必须重建 Agent：模型列表、容量档位、
 * 输出上限、图片勾选、API URL 与 Key 都会影响模型运行时，因此全部纳入签名。
 * 排序后序列化，避免模型列表顺序变化触发无谓重建。
 */

export interface AgentConfigKeyInput {
  provider: string
  apiUrl: string
  apiKey: string
  selectedModel: string
  models?: Array<{ id: string; contextWindow: number; image: boolean; maxTokens?: number }>
}

export function agentConfigKey(apiConfig: AgentConfigKeyInput): string {
  const models = (Array.isArray(apiConfig.models) ? apiConfig.models : [])
    .map((entry) => ({
      id: typeof entry?.id === 'string' ? entry.id : '',
      contextWindow: Number(entry?.contextWindow ?? 0),
      image: entry?.image === true,
      // 缺省与 0 都是「自动」，签名保持一致
      maxTokens: Number(entry?.maxTokens ?? 0),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return JSON.stringify({
    provider: apiConfig.provider,
    apiUrl: apiConfig.apiUrl,
    selectedModel: apiConfig.selectedModel,
    apiKey: apiConfig.apiKey,
    models,
  })
}

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
    // 字段顺序固定，避免同一份覆盖因键序不同而重建
    contextWindow: overrides.contextWindow ?? null,
    maxTokens: overrides.maxTokens ?? null,
  })
}
