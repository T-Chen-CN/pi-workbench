/**
 * Agent 配置签名。
 *
 * 任何会改变 models.json 的字段变化都必须重建 Agent：模型列表、容量档位、
 * 图片勾选、API URL 与 Key 都会影响模型运行时，因此全部纳入签名。
 * 排序后序列化，避免模型列表顺序变化触发无谓重建。
 */

export interface AgentConfigKeyInput {
  provider: string
  apiUrl: string
  apiKey: string
  selectedModel: string
  models?: Array<{ id: string; contextWindow: number; image: boolean }>
}

export function agentConfigKey(apiConfig: AgentConfigKeyInput): string {
  const models = (Array.isArray(apiConfig.models) ? apiConfig.models : [])
    .map((entry) => ({
      id: typeof entry?.id === 'string' ? entry.id : '',
      contextWindow: Number(entry?.contextWindow ?? 0),
      image: entry?.image === true,
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
