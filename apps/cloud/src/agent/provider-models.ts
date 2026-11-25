/**
 * 云端供应商校验（F-13 / A-16 / D24）。
 *
 * 配置只接受 8 家白名单内的 provider，模型必须存在于 Pi 内置 catalog —— 这两步
 * 是纯本地判断，不发请求。`/models` 只用来做一次**轻量 Key 探测**：401/403 拒绝，
 * 连不上按可用处理（云端不该因为供应商抖动而拒绝一份有效 Key）。
 *
 * 为什么不再自己拉模型清单：catalog 才是模型的唯一真值，供应商的 `/models`
 * 经常和实际可用的 chat 模型对不上（多出 embedding / 别名），照它列会让用户选到
 * 一个跑不起来的 id。
 */

import { builtinCatalogModel, builtinCatalogModels, isPresetProviderId } from 'pi-bridge'

/** 供应商 `/models` 的鉴权头 */
export function modelsHeaders(providerId: string, apiKey: string): Record<string, string> {
  return providerId === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` }
}

export type CatalogModelSummary = {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  vision: boolean
}

/** 该 provider 的 catalog 模型（云端配置页下拉用） */
export function catalogModelList(providerId: string): CatalogModelSummary[] {
  return builtinCatalogModels(providerId).map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow ?? 0,
    maxTokens: model.maxTokens ?? 0,
    reasoning: model.reasoning === true,
    vision: Array.isArray(model.input) && model.input.includes('image'),
  }))
}

export function isCatalogModel(providerId: string, modelId: string): boolean {
  return builtinCatalogModel(providerId, modelId) !== undefined
}

export function isKnownProvider(providerId: string): boolean {
  return isPresetProviderId(providerId)
}

export type KeyProbeResult = { ok: true; warning?: string } | { ok: false; reason: string }

/**
 * 一次性 Key 探测：拿 catalog 里的 baseUrl 请求 `/models`。
 *
 * 判据与桌面端一致：401/403 判无效；供应商不提供清单（404/405/501）视为
 * 「无从验证」放行；网络异常也放行，只在日志里留痕。
 */
export async function probeProviderKey(
  input: { providerId: string; apiKey: string },
  timeoutMs = 6_000
): Promise<KeyProbeResult> {
  const model = builtinCatalogModels(input.providerId)[0] as { baseUrl?: string } | undefined
  const baseUrl = model?.baseUrl?.replace(/\/+$/, '')
  if (!baseUrl) return { ok: true, warning: 'catalog 里没有 baseUrl，跳过探测' }

  let response: Response
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: modelsHeaders(input.providerId, input.apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: true, warning: `探测未完成（${message.slice(0, 120)}），按可用处理` }
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: `供应商拒绝了这把 Key（HTTP ${response.status}）` }
  }
  if ([404, 405, 501].includes(response.status)) {
    return { ok: true, warning: `供应商不提供模型清单（HTTP ${response.status}）` }
  }
  if (!response.ok) {
    return { ok: false, reason: `供应商返回 HTTP ${response.status}` }
  }
  return { ok: true }
}
