/**
 * 固定供应商白名单（8 家）与内置模型目录桥接。
 *
 * 纯常量与容量口径定义在 `./presets.js`（浏览器安全，零 SDK / Node 依赖）；
 * 本模块在此之上叠加 `@earendil-works/pi-ai` 内置 catalog 查询，供桌面端与云端服务端共用。
 */

import type { Api, Model } from '@earendil-works/pi-ai'
import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
  getBuiltinProviders,
} from '@earendil-works/pi-ai/providers/all'

export {
  PRESET_PROVIDER_IDS,
  PROVIDER_PRESETS,
  catalogLimits,
  diffCatalogSnapshots,
  isInvalidKeyProbeResponse,
  isPresetProviderId,
  normalizeOverrides,
  presetDisplayName,
  providerModelsHeaders,
  providerModelsProbeRequest,
  resolveLimits,
  type ModelLimits,
  type ModelOverrides,
  type ProviderPreset,
} from './presets.js'

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
