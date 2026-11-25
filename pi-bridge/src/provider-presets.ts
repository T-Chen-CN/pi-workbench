/**
 * 固定供应商白名单（8 家）与模型容量口径。
 *
 * 桌面端与云端共用这一份：`apps/cloud` 只依赖 `pi-bridge`，不能再从
 * `electron/` 或直接 `@earendil-works/pi-ai` 取常量。
 *
 * 为什么只有白名单、没有 provider 元数据：`baseUrl` / `api` 协议 / `compat`
 * 全部来自 Pi 内置 catalog（pi.dev 只做增量），我们维护一份副本只会漂移。
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
  getBuiltinProviders,
} from '@earendil-works/pi-ai/providers/all'

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

/** 内置快照的生成时间；远端目录只有比它新才会生效（SDK 的 `isNewer()` 判据） */
export function builtinCatalogGeneratedAt(): number | undefined {
  return getBuiltinModelDataGeneratedAt()
}

/**
 * 远端目录是否真的生效：SDK 只在 `lastModified > 内置快照生成时间` 时用它。
 * `source` 与列表过滤必须共此判据，否则会显示一个变少的假列表（D26）。
 */
export function isRemoteCatalogEffective(lastModified: number | undefined): boolean {
  if (typeof lastModified !== 'number' || lastModified <= 0) return false
  const generatedAt = builtinCatalogGeneratedAt()
  if (generatedAt === undefined) return true
  return lastModified > generatedAt
}

/**
 * 按远端目录快照过滤运行时模型列表（D12 / D26）。
 * SDK 的 `withRemoteCatalog` 只把远端模型叠加到内置快照，不会删掉上游已下架的模型；
 * 仅当远端快照比内置更新且非空时按远端 id 集合收敛，离线或远端更旧时原样保留。
 */
export function filterEffectiveCatalogModels<T extends { id: string }>(
  models: readonly T[],
  snapshot: { lastModified?: number; ids: readonly string[] } | undefined
): T[] {
  if (!snapshot || snapshot.ids.length === 0 || !isRemoteCatalogEffective(snapshot.lastModified)) {
    return [...models]
  }
  const allowed = new Set(snapshot.ids)
  const filtered = models.filter((model) => allowed.has(model.id))
  return filtered.length > 0 ? filtered : [...models]
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

export function isBuiltinCatalogProvider(providerId: string): boolean {
  return getBuiltinProviders().includes(providerId as never)
}

/** 内置快照里的 chat 模型（离线 / 首次启动的兜底） */
export function builtinCatalogModels(providerId: string): readonly Model<Api>[] {
  if (!isBuiltinCatalogProvider(providerId)) return []
  return getBuiltinModels(providerId as never) as readonly Model<Api>[]
}

export function builtinCatalogModel(providerId: string, modelId: string): Model<Api> | undefined {
  return builtinCatalogModels(providerId).find((model) => model.id === modelId)
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
