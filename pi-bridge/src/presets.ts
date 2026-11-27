/**
 * 供应商预设白名单、模型容量口径与探测纯函数（`pi-bridge/presets`）。
 *
 * 严格零 `node:*` 与零 `@earendil-works/pi-*` 运行时依赖，浏览器与渲染层可安全引用。
 */

export interface ProviderPreset {
  /** Pi catalog 里的 provider id，也是凭证文件的键 */
  id: string
  name: string
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'google', name: 'Google' },
  { id: 'xai', name: 'xAI' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'xiaomi', name: '小米 MiMo' },
  { id: 'xiaomi-token-plan-cn', name: '小米（Token 套餐）' },
  { id: 'openai-codex', name: 'OpenAI Codex' },
]

export const PRESET_PROVIDER_IDS: readonly string[] = PROVIDER_PRESETS.map((preset) => preset.id)

export function isPresetProviderId(providerId: unknown): providerId is string {
  return typeof providerId === 'string' && PRESET_PROVIDER_IDS.includes(providerId)
}

export function presetDisplayName(providerId: string): string {
  return PROVIDER_PRESETS.find((preset) => preset.id === providerId)?.name ?? providerId
}

/** 按 provider 对比刷新前后的模型 id 集合，避免总计相减把「增 1 删 1」抵消成 0 */
export function diffCatalogSnapshots(
  before: ReadonlyArray<{ providerId: string; ids: readonly string[] }>,
  after: ReadonlyArray<{ providerId: string; ids: readonly string[] }>
): { added: number; removed: number } {
  const beforeByProvider = new Map(before.map((entry) => [entry.providerId, new Set(entry.ids)]))
  const afterByProvider = new Map(after.map((entry) => [entry.providerId, new Set(entry.ids)]))
  const providers = new Set([...beforeByProvider.keys(), ...afterByProvider.keys()])
  let added = 0
  let removed = 0
  for (const providerId of providers) {
    const prev = beforeByProvider.get(providerId) ?? new Set<string>()
    const next = afterByProvider.get(providerId) ?? new Set<string>()
    for (const id of next) if (!prev.has(id)) added += 1
    for (const id of prev) if (!next.has(id)) removed += 1
  }
  return { added, removed }
}

/** 各家 `/models` 探测的鉴权头：Anthropic 用 x-api-key，Google 用 x-goog-api-key，其余走 Bearer */
export function providerModelsHeaders(providerId: string, apiKey: string): Record<string, string> {
  if (providerId === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }
  if (providerId === 'google') {
    return { 'x-goog-api-key': apiKey }
  }
  return { authorization: `Bearer ${apiKey}` }
}

/** 各家轻量 Key 探测请求（D24）：Anthropic 的 baseUrl 不含 /v1，需补上 `/v1/models` */
export function providerModelsProbeRequest(
  providerId: string,
  baseUrl: string,
  apiKey: string
): { url: string; headers: Record<string, string> } {
  const trimmed = baseUrl.replace(/\/+$/, '')
  const endpoint =
    providerId === 'anthropic' && !trimmed.endsWith('/v1') ? '/v1/models' : '/models'
  return {
    url: `${trimmed}${endpoint}`,
    headers: providerModelsHeaders(providerId, apiKey),
  }
}

/**
 * 判定 `/models` 探测响应是否明确表明 API Key 无效（P-05 实测结论）：
 * - OpenAI / Anthropic / DeepSeek / Xiaomi / Codex：无效 Key 返回 401/403；
 * - Google（API_KEY_INVALID）与 xAI（Incorrect API key provided）：无效 Key 返回 400。
 *   Google 的地区限制同样返回 400（User location is not supported），不能误判为 Key 无效。
 */
export function isInvalidKeyProbeResponse(
  providerId: string,
  status: number,
  bodyText = ''
): boolean {
  if (status === 401 || status === 403) return true
  if (status === 400 && (providerId === 'google' || providerId === 'xai')) {
    const lower = bodyText.toLowerCase()
    if (lower.includes('location is not supported')) return false
    return (
      lower.includes('api_key_invalid') ||
      lower.includes('api key not valid') ||
      lower.includes('incorrect api key') ||
      lower.includes('invalid api key')
    )
  }
  return false
}

export interface ModelLimits {
  contextWindow: number
  maxTokens: number
}

export interface ModelOverrides {
  contextWindow?: number
  maxTokens?: number
}

function toPositiveInt(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.floor(parsed)
}

/** catalog 真值；缺 `maxTokens` 时按上下文窗口兜底（SDK 只按上下文余量 clamp） */
export function catalogLimits(model: {
  contextWindow?: number
  maxTokens?: number
}): ModelLimits {
  const contextWindow = toPositiveInt(model.contextWindow) ?? 0
  const maxTokens = toPositiveInt(model.maxTokens) ?? contextWindow
  return { contextWindow, maxTokens: Math.min(maxTokens, contextWindow) }
}

/**
 * 归一化用户下调值：只保留正整数，且不得超过 catalog 真值。
 * 返回 `undefined` 表示该字段没有覆盖（等于「最高 / 默认」）。
 */
export function normalizeOverrides(
  catalog: ModelLimits,
  overrides: ModelOverrides | undefined
): ModelOverrides {
  const normalized: ModelOverrides = {}
  const contextWindow = toPositiveInt(overrides?.contextWindow)
  if (contextWindow !== undefined) {
    normalized.contextWindow = Math.min(contextWindow, catalog.contextWindow)
  }
  const maxTokens = toPositiveInt(overrides?.maxTokens)
  if (maxTokens !== undefined) {
    // 输出上限同时受 catalog 与上下文窗口约束
    normalized.maxTokens = Math.min(
      maxTokens,
      catalog.maxTokens,
      normalized.contextWindow ?? catalog.contextWindow
    )
  }
  return normalized
}

/** 叠加覆盖后的生效值；写入与展示都用它，避免两处各算一遍 */
export function resolveLimits(
  catalog: ModelLimits,
  overrides: ModelOverrides | undefined
): ModelLimits {
  const normalized = normalizeOverrides(catalog, overrides)
  return {
    contextWindow: Math.min(normalized.contextWindow ?? catalog.contextWindow, catalog.contextWindow),
    maxTokens: Math.min(
      normalized.maxTokens ?? catalog.maxTokens,
      catalog.maxTokens,
      normalized.contextWindow ?? catalog.contextWindow
    ),
  }
}
