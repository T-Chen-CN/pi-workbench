/**
 * models.dev 富数据解析与映射（P-07，见 provider-presets.md §8.3）。
 *
 * 设计边界：
 * - 完全解耦于 Pi catalog：只做可选展示增强（价格、多模态、知识截止、发布时间、
 *   开源权重、废弃状态与简介），绝不参与协议判断或覆盖 catalog 的 limits/compat。
 * - 只提取当前 8 家预设供应商对应的 6 个上游命名空间，避免把全部 300+ 家落盘。
 */

export const MODELS_DEV_API_URL = 'https://models.dev/api.json'
export const MODELS_DEV_CACHE_VERSION = 1

/** 本项目 8 家预设供应商在 models.dev 对应的上游 provider key */
export const MODELS_DEV_UPSTREAM_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'xiaomi',
] as const

const PRESET_TO_MODELS_DEV_PROVIDER: Record<string, string> = {
  openai: 'openai',
  'openai-codex': 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'xai',
  deepseek: 'deepseek',
  xiaomi: 'xiaomi',
  'xiaomi-token-plan-cn': 'xiaomi',
}

/** 单价：美元 / 1M tokens */
export interface ModelsDevCost {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

export interface ModelsDevModalities {
  input: string[]
  output: string[]
}

export interface ModelsDevEnrichment {
  description?: string
  cost?: ModelsDevCost
  modalities?: ModelsDevModalities
  knowledge?: string
  releaseDate?: string
  openWeights?: boolean
  status?: string
}

export interface ModelsDevCacheSnapshot {
  version: number
  fetchedAt: number
  etag?: string
  providers: Record<string, Record<string, ModelsDevEnrichment>>
}

function asNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function asNonEmptyString(value: unknown, maxLen = 200): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, maxLen)
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const normalized = item.trim().toLowerCase()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function parseCost(raw: unknown): ModelsDevCost | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const cost: ModelsDevCost = {}
  const input = asNonNegativeNumber(obj.input)
  const output = asNonNegativeNumber(obj.output)
  const cacheRead = asNonNegativeNumber(obj.cache_read ?? obj.cacheRead)
  const cacheWrite = asNonNegativeNumber(obj.cache_write ?? obj.cacheWrite)
  const reasoning = asNonNegativeNumber(obj.reasoning)
  if (input !== undefined) cost.input = input
  if (output !== undefined) cost.output = output
  if (cacheRead !== undefined) cost.cacheRead = cacheRead
  if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite
  if (reasoning !== undefined) cost.reasoning = reasoning
  return Object.keys(cost).length > 0 ? cost : undefined
}

function parseModalities(raw: unknown): ModelsDevModalities | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const input = asStringList(obj.input)
  const output = asStringList(obj.output)
  if (input.length === 0 && output.length === 0) return undefined
  return { input, output }
}

function parseEntry(raw: unknown): ModelsDevEnrichment | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const entry: ModelsDevEnrichment = {}
  const description = asNonEmptyString(obj.description, 240)
  const cost = parseCost(obj.cost)
  const modalities = parseModalities(obj.modalities)
  const knowledge = asNonEmptyString(obj.knowledge, 32)
  const releaseDate = asNonEmptyString(obj.release_date ?? obj.releaseDate, 32)
  const status = asNonEmptyString(obj.status, 32)
  if (description) entry.description = description
  if (cost) entry.cost = cost
  if (modalities) entry.modalities = modalities
  if (knowledge) entry.knowledge = knowledge
  if (releaseDate) entry.releaseDate = releaseDate
  if (typeof obj.open_weights === 'boolean') entry.openWeights = obj.open_weights
  else if (typeof obj.openWeights === 'boolean') entry.openWeights = obj.openWeights
  if (status) entry.status = status
  return Object.keys(entry).length > 0 ? entry : undefined
}

/**
 * 从 models.dev 全量响应中提取本项目 6 个上游命名空间的精简富数据快照。
 * 非法结构静默跳过，保证单条脏数据不会破坏整个快照。
 */
export function extractModelsDevSnapshot(
  raw: unknown,
  fetchedAt: number,
  etag?: string
): ModelsDevCacheSnapshot {
  const providers: Record<string, Record<string, ModelsDevEnrichment>> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: MODELS_DEV_CACHE_VERSION, fetchedAt, ...(etag ? { etag } : {}), providers }
  }
  const root = raw as Record<string, unknown>
  for (const upstreamId of MODELS_DEV_UPSTREAM_PROVIDERS) {
    const providerObj = root[upstreamId]
    if (!providerObj || typeof providerObj !== 'object' || Array.isArray(providerObj)) continue
    const rawModels = (providerObj as Record<string, unknown>).models
    if (!rawModels || typeof rawModels !== 'object' || Array.isArray(rawModels)) continue
    const bucket: Record<string, ModelsDevEnrichment> = {}
    for (const [modelId, rawModel] of Object.entries(rawModels as Record<string, unknown>)) {
      const parsed = parseEntry(rawModel)
      if (parsed) bucket[modelId] = parsed
    }
    if (Object.keys(bucket).length > 0) {
      providers[upstreamId] = bucket
    }
  }
  return {
    version: MODELS_DEV_CACHE_VERSION,
    fetchedAt,
    ...(etag ? { etag } : {}),
    providers,
  }
}

/** 校验磁盘读出的缓存文件形状，非法时返回 null 以便安全忽略 */
export function parseModelsDevCacheSnapshot(raw: unknown): ModelsDevCacheSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (obj.version !== MODELS_DEV_CACHE_VERSION) return null
  if (typeof obj.fetchedAt !== 'number' || !Number.isFinite(obj.fetchedAt) || obj.fetchedAt <= 0) {
    return null
  }
  if (!obj.providers || typeof obj.providers !== 'object' || Array.isArray(obj.providers)) {
    return null
  }
  const providers: Record<string, Record<string, ModelsDevEnrichment>> = {}
  for (const upstreamId of MODELS_DEV_UPSTREAM_PROVIDERS) {
    const rawBucket = (obj.providers as Record<string, unknown>)[upstreamId]
    if (!rawBucket || typeof rawBucket !== 'object' || Array.isArray(rawBucket)) continue
    const bucket: Record<string, ModelsDevEnrichment> = {}
    for (const [modelId, rawModel] of Object.entries(rawBucket as Record<string, unknown>)) {
      const parsed = parseEntry(rawModel)
      if (parsed) bucket[modelId] = parsed
    }
    if (Object.keys(bucket).length > 0) providers[upstreamId] = bucket
  }
  const etag = asNonEmptyString(obj.etag, 256)
  return {
    version: MODELS_DEV_CACHE_VERSION,
    fetchedAt: obj.fetchedAt,
    ...(etag ? { etag } : {}),
    providers,
  }
}

/** 按预设 providerId + modelId 查富数据；映射不到返回 undefined */
export function lookupModelsDevEnrichment(
  snapshot: ModelsDevCacheSnapshot | null | undefined,
  providerId: string,
  modelId: string
): ModelsDevEnrichment | undefined {
  if (!snapshot) return undefined
  const upstreamId = PRESET_TO_MODELS_DEV_PROVIDER[providerId]
  if (!upstreamId) return undefined
  const bucket = snapshot.providers[upstreamId]
  if (!bucket) return undefined
  return bucket[modelId]
}
