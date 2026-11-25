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
