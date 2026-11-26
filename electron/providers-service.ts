/**
 * 供应商运行时服务（主进程唯一实例）。
 *
 * 负责三件事：
 * 1. 目录：一个常驻 `ModelRuntime`（注入凭证 + 目录缓存），设置页与刷新共用；
 * 2. 配置：`config/providers.json`（active provider / 模型 / 容量覆盖）；
 * 3. 登录：api-key 写入凭证文件；OAuth 交给 `auth-flow.ts` 的交互桥。
 *
 * 这个运行时**不承载会话**：写完配置后由 `providers:changed` 通知各工作区重建
 * Agent（会话仍由 `AgentManager` 自己创建运行时）。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai'
import {
  PRESET_PROVIDER_IDS,
  PROVIDER_PRESETS,
  builtinCatalogGeneratedAt,
  catalogLimits,
  credentialFingerprint,
  diffCatalogSnapshots,
  filterEffectiveCatalogModels,
  isInvalidKeyProbeResponse,
  isPresetProviderId,
  isRemoteCatalogEffective,
  lookupModelsDevEnrichment,
  normalizeOverrides,
  providerModelsProbeRequest,
  resolveLimits,
  type CatalogSnapshot,
  type ModelLimits,
  type ModelOverrides,
  type ModelsDevEnrichment,
  type ProvidersConfig,
} from 'pi-bridge'
import { getAppDir, piAgentDir } from './app-paths.js'
import { createDesktopCredentialStore } from './credentials-store.js'
import { createDesktopProvidersConfigStore } from './providers-config.js'
import { getModelsStore } from './models-store.js'
import {
  getModelsDevSnapshot,
  refreshModelsDevSnapshot,
} from './models-dev-store.js'
import { deviceId } from './device-id.js'
import { getAppSettingsCache } from './ipc/settings.js'

/** `PI_OFFLINE` 总开关（D6）：任意非 0/false 值都视为离线模式，禁止请求远端模型目录 */
export function isPiOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PI_OFFLINE
  if (typeof raw !== 'string') return false
  const normalized = raw.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false'
}

/** 是否允许后台自动联网刷新模型目录（D6：`PI_OFFLINE` 优先于应用设置） */
export function isCatalogNetworkAllowed(): boolean {
  if (isPiOffline()) return false
  return getAppSettingsCache().autoRefreshCatalog !== false
}

export interface ProviderDirectoryView {
  source: 'remote' | 'bundled'
  checkedAt?: number
  lastModified?: number
}

export interface ProviderModelView {
  id: string
  name: string
  limits: ModelLimits
  /** 目录原始上限（用于设置下拉允许把已下调的值调回更高档位） */
  catalogLimits?: ModelLimits
  /** 归一化后的下调值；缺省 = 跟 catalog 一致 */
  overrides?: ModelOverrides
  reasoning: boolean
  vision: boolean
  /** 请求协议，能力表展示用 */
  api: string
  /** 模型支持的思考档位 */
  thinkingLevels: string[]
  /** 输入模态 */
  input: string[]
  cost?: unknown
  /** models.dev 独立富数据（可选展示增强，P-07） */
  enrichment?: ModelsDevEnrichment
}

export interface ProviderView {
  id: string
  name: string
  connected: boolean
  credentialType?: 'api_key' | 'oauth'
  authMethods: Array<'api_key' | 'oauth'>
  active: boolean
  model?: string
  models: ProviderModelView[]
  /** 模型目录来源与时间戳（D12 / D26） */
  directory: ProviderDirectoryView
}

let catalogRuntime: ModelRuntime | null = null
let catalogRuntimePromise: Promise<ModelRuntime> | null = null
let lastRefreshAt: number | null = null

function credentialsStore() {
  return createDesktopCredentialStore()
}

/** 常驻目录运行时：只做模型清单 / 目录刷新 / 登录，不承载会话 */
async function getCatalogRuntime(): Promise<ModelRuntime> {
  if (catalogRuntime) return catalogRuntime
  if (catalogRuntimePromise) return catalogRuntimePromise
  const task = (async () => {
    const runtime = await ModelRuntime.create({
      modelsPath: path.join(piAgentDir, 'models.json'),
      credentials: credentialsStore(),
      modelsStore: getModelsStore(),
      refreshOnCreate: false,
      allowModelNetwork: false,
    })
    // 仅从本地 models-store.json 恢复缓存到内存（不发网络），否则 dynamicModels 始终为空
    await runtime.refresh({
      allowNetwork: false,
      providers: [...PRESET_PROVIDER_IDS],
    })
    return runtime
  })()
  catalogRuntimePromise = task
  void task.then(
    (runtime) => {
      if (catalogRuntimePromise === task) {
        catalogRuntime = runtime
        catalogRuntimePromise = null
      }
    },
    () => {
      if (catalogRuntimePromise === task) catalogRuntimePromise = null
    }
  )
  return task
}

/**
 * 统一构造目录视图与配置 store：
 * 1. runtime 已从本地 models-store.json 恢复远端增量；
 * 2. 按 D12/D26 用远端快照过滤内置快照里上游已下架的模型；
 * 3. `providers.json` 的读写校验复用同一份过滤后的模型表，确保远端新增模型可选且不被清洗掉。
 */
async function loadCatalogContext(): Promise<{
  runtime: ModelRuntime
  snapshots: Map<string, CatalogSnapshot>
  modelsByProvider: Map<string, readonly Model<Api>[]>
  store: ReturnType<typeof createDesktopProvidersConfigStore>
}> {
  const [runtime, snapshotList] = await Promise.all([
    getCatalogRuntime(),
    getModelsStore().snapshot(),
  ])
  const snapshots = new Map(snapshotList.map((item) => [item.providerId, item]))
  const modelsByProvider = new Map<string, readonly Model<Api>[]>()
  for (const preset of PROVIDER_PRESETS) {
    const raw = runtime.getModels(preset.id) as readonly Model<Api>[]
    modelsByProvider.set(
      preset.id,
      filterEffectiveCatalogModels(raw, snapshots.get(preset.id))
    )
  }
  const store = createDesktopProvidersConfigStore({
    credentials: credentialsStore(),
    listModels: (providerId) =>
      (modelsByProvider.get(providerId) ?? []).map((model) => ({
        id: model.id,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
  })
  return { runtime, snapshots, modelsByProvider, store }
}

/** 配置或凭证变化后必须重建：运行时缓存了 auth 解析结果 */
export function resetCatalogRuntime(): void {
  catalogRuntime = null
  catalogRuntimePromise = null
}

function modelView(
  model: Model<Api>,
  overrides: ModelOverrides | undefined,
  enrichment: ModelsDevEnrichment | undefined
): ProviderModelView {
  const catalog = catalogLimits(model)
  const normalized = normalizeOverrides(catalog, overrides)
  return {
    id: model.id,
    name: model.name ?? model.id,
    limits: resolveLimits(catalog, overrides),
    catalogLimits: catalog,
    ...(Object.keys(normalized).length > 0 ? { overrides: normalized } : {}),
    reasoning: model.reasoning === true,
    vision: Array.isArray(model.input) && model.input.includes('image'),
    api: String(model.api),
    thinkingLevels: thinkingLevels(model),
    input: Array.isArray(model.input) ? [...model.input] : ['text'],
    ...(model.cost ? { cost: model.cost } : {}),
    ...(enrichment ? { enrichment } : {}),
  }
}

function thinkingLevels(model: Model<Api>): string[] {
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const map = (model as { thinkingLevelMap?: Record<string, unknown> }).thinkingLevelMap
  if (!map) return levels
  return levels.filter((level) => map[level] !== null && map[level] !== undefined)
}

function directoryView(snapshot: CatalogSnapshot | undefined): ProviderDirectoryView {
  const effectiveRemote = Boolean(
    snapshot && snapshot.ids.length > 0 && isRemoteCatalogEffective(snapshot.lastModified)
  )
  return {
    source: effectiveRemote ? 'remote' : 'bundled',
    ...(typeof snapshot?.checkedAt === 'number' ? { checkedAt: snapshot.checkedAt } : {}),
    ...(typeof snapshot?.lastModified === 'number' ? { lastModified: snapshot.lastModified } : {}),
  }
}

/** 供应商列表（含能力表）；`activeProvider` 指向的那个额外标 active */
export async function listProviders(): Promise<{
  providers: ProviderView[]
  activeProvider: string | null
  offline: boolean
  builtinGeneratedAt?: number
}> {
  const [{ runtime, snapshots, modelsByProvider, store }, credentialInfo, modelsDevSnapshot] =
    await Promise.all([loadCatalogContext(), credentialsStore().list(), getModelsDevSnapshot()])
  const config = await store.read()
  const connected = new Map(credentialInfo.map((info) => [info.providerId, info.type]))

  const providers = PROVIDER_PRESETS.map((preset): ProviderView => {
    const entry = config.providers[preset.id]
    const models = (modelsByProvider.get(preset.id) ?? []).map((model) =>
      modelView(
        model,
        entry?.overrides?.[model.id],
        lookupModelsDevEnrichment(modelsDevSnapshot, preset.id, model.id)
      )
    )
    const credentialType = connected.get(preset.id)
    return {
      id: preset.id,
      name: preset.name,
      connected: credentialType !== undefined,
      ...(credentialType ? { credentialType } : {}),
      authMethods: authMethodsOf(runtime, preset.id),
      active: config.activeProvider === preset.id,
      ...(entry?.model ? { model: entry.model } : {}),
      models,
      directory: directoryView(snapshots.get(preset.id)),
    }
  })

  return {
    providers,
    activeProvider: config.activeProvider,
    offline: isPiOffline(),
    builtinGeneratedAt: builtinCatalogGeneratedAt(),
  }
}

/**
 * 该 provider 支持哪些鉴权方式。catalog 的 provider 定义里有 `auth`，
 * 取不到时按「都支持」处理，交给 SDK 在登录时报错。
 */
function authMethodsOf(runtime: ModelRuntime, providerId: string): Array<'api_key' | 'oauth'> {
  const providers = (runtime as unknown as {
    getProvider?: (id: string) => { auth?: Record<string, unknown> } | undefined
  }).getProvider?.(providerId)
  const auth = providers?.auth
  if (!auth) return ['api_key']
  const methods: Array<'api_key' | 'oauth'> = []
  if (auth.apiKey) methods.push('api_key')
  if (auth.oauth) methods.push('oauth')
  return methods.length > 0 ? methods : ['api_key']
}

/** 选中某个 provider + 模型；先要求已配置凭证，否则 SDK 首次请求才会报错 */
export async function setActiveProvider(
  providerId: string,
  modelId: string | undefined
): Promise<{ ok: true; config: ProvidersConfig } | { ok: false; code: string }> {
  if (!isPresetProviderId(providerId)) return { ok: false, code: 'PROVIDER_UNKNOWN' }
  const { store } = await loadCatalogContext()
  const config = await store.read()
  const target = modelId ?? config.providers[providerId]?.model
  if (!target) return { ok: false, code: 'MODEL_UNKNOWN' }

  const connected = config.providers[providerId]
  const next = store.setActive(
    connected ? config : { ...config, providers: { ...config.providers, [providerId]: { model: target } } },
    providerId,
    target
  )
  if (!next.ok) return { ok: false, code: next.code }
  store.write(next.config)
  return { ok: true, config: next.config }
}

/** 写下调值；返回生效值与该模型是否已经在跑（调用方决定何时生效） */
export async function setModelOverrides(
  providerId: string,
  modelId: string,
  overrides: ModelOverrides | undefined
): Promise<
  | { ok: true; effective: ModelLimits; pending: boolean }
  | { ok: false; code: string }
> {
  if (!isPresetProviderId(providerId)) return { ok: false, code: 'PROVIDER_UNKNOWN' }
  const { store } = await loadCatalogContext()
  const config = await store.read()
  const result = store.setOverrides(config, providerId, modelId, overrides)
  if ('error' in result) return { ok: false, code: result.error }
  store.write(result.config)
  return {
    ok: true,
    effective: result.effective,
    // 覆盖值随 models.json 生效：正在跑的会话在轮次边界才换（D23）
    pending: hasRunningSessions(),
  }
}

/** 由 main.ts 注入：是否有工作区正在跑轮次 */
let runningProbe: () => boolean = () => false
export function setRunningSessionsProbe(probe: () => boolean): void {
  runningProbe = probe
}
function hasRunningSessions(): boolean {
  return runningProbe()
}

/** 写入 api-key 凭证（登录）。探测由 `probeApiKey` 单独做 */
export async function saveApiKey(
  providerId: string,
  apiKey: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isPresetProviderId(providerId)) return { ok: false, error: 'PROVIDER_UNKNOWN' }
  const key = apiKey.trim()
  if (!key) return { ok: false, error: 'EMPTY_KEY' }

  const credentials = credentialsStore()
  await credentials.modify(providerId, async () => ({ type: 'api_key', key }))

  // 有 Key 就等于「已配置」：写进 providers.json 并设为 active
  const { modelsByProvider, store } = await loadCatalogContext()
  const config = await store.read()
  if (!config.providers[providerId]) {
    const first = (modelsByProvider.get(providerId) ?? [])[0]
    if (!first) return { ok: false, error: 'NO_MODEL' }
    store.write({
      ...config,
      activeProvider: config.activeProvider ?? providerId,
      providers: { ...config.providers, [providerId]: { model: first.id } },
    })
  }
  resetCatalogRuntime()
  return { ok: true }
}

/** 保存 OAuth 凭证（登录成功后由 auth-flow 调用） */
export async function saveOAuthCredential(
  providerId: string,
  credential: { type: 'oauth'; refresh: string; access: string; expires: number }
): Promise<void> {
  if (!isPresetProviderId(providerId)) return
  await credentialsStore().modify(providerId, async () => credential)
  const { modelsByProvider, store } = await loadCatalogContext()
  const config = await store.read()
  if (!config.providers[providerId]) {
    const first = (modelsByProvider.get(providerId) ?? [])[0]
    if (first) {
      store.write({
        ...config,
        activeProvider: config.activeProvider ?? providerId,
        providers: { ...config.providers, [providerId]: { model: first.id } },
      })
    }
  }
  resetCatalogRuntime()
}

/** 忘记该 provider：删凭证 + 删配置；active 指向它就清空 */
export async function forgetProvider(providerId: string): Promise<{ ok: boolean }> {
  if (!isPresetProviderId(providerId)) return { ok: false }
  await credentialsStore().delete(providerId)
  const { store } = await loadCatalogContext()
  const config = await store.read()
  const providers = { ...config.providers }
  delete providers[providerId]
  store.write({
    ...config,
    activeProvider: config.activeProvider === providerId ? null : config.activeProvider,
    providers,
  })
  resetCatalogRuntime()
  return { ok: true }
}

/** 当前生效的 provider / 模型 / 凭证指纹，Agent 重建与签名都用它 */
export async function activeProviderConfig(): Promise<
  | {
      ok: true
      providerId: string
      modelId: string
      overrides?: Record<string, ModelOverrides>
      fingerprint: string
    }
  | { ok: false; error: string }
> {
  const { store } = await loadCatalogContext()
  const config = await store.read()
  const providerId = config.activeProvider
  if (!providerId) return { ok: false, error: 'NO_ACTIVE_PROVIDER' }
  const entry = config.providers[providerId]
  if (!entry) return { ok: false, error: 'NO_ACTIVE_PROVIDER' }
  const credential = await credentialsStore().read(providerId)
  if (!credential) return { ok: false, error: 'NOT_CONNECTED' }
  return {
    ok: true,
    providerId,
    modelId: entry.model,
    ...(entry.overrides ? { overrides: entry.overrides } : {}),
    fingerprint: credentialFingerprint(credential),
  }
}

/** 刷新远端目录（只对已配置凭证的 provider 发请求，D14） */
export async function refreshProviders(force = false): Promise<{
  success: boolean
  added: number
  removed: number
  checkedAt: number
  error?: string
}> {
  if (isPiOffline()) {
    return {
      success: false,
      added: 0,
      removed: 0,
      checkedAt: Date.now(),
      error: 'PI_OFFLINE',
    }
  }
  // 关闭自动更新时，后台/自动刷新（force=false）静默跳过；用户手动点刷新（force=true）仍放行
  if (!force && !isCatalogNetworkAllowed()) {
    return { success: true, added: 0, removed: 0, checkedAt: Date.now() }
  }

  // models.dev 富数据独立刷新（失败静默降级，不影响 Pi catalog 刷新结果）
  const modelsDevPromise = refreshModelsDevSnapshot({ force, allowNetwork: true }).catch(() => null)

  const runtime = await getCatalogRuntime()
  const store = getModelsStore()
  const before = await store.snapshot()
  const configured = await credentialsStore().list()
  const providers = configured
    .map((info) => info.providerId)
    .filter((id): id is string => PRESET_PROVIDER_IDS.includes(id))
  if (providers.length === 0) {
    await modelsDevPromise
    return { success: true, added: 0, removed: 0, checkedAt: Date.now() }
  }

  let refreshResult: Awaited<ReturnType<ModelRuntime['refresh']>>
  try {
    refreshResult = await runtime.refresh({ allowNetwork: true, providers, force })
  } catch (error) {
    await modelsDevPromise
    return {
      success: false,
      added: 0,
      removed: 0,
      checkedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
  await modelsDevPromise

  const after = await store.snapshot()
  const { added, removed } = diffCatalogSnapshots(before, after)
  lastRefreshAt = Date.now()
  // 重置后下一次 getCatalogRuntime 会立刻通过 allowNetwork:false 重新从 models-store.json 载入
  resetCatalogRuntime()

  if (refreshResult.errors.size > 0 && refreshResult.errors.size >= providers.length) {
    const first = [...refreshResult.errors.entries()][0]
    return {
      success: false,
      added,
      removed,
      checkedAt: lastRefreshAt,
      error: `${first[0]}: ${first[1].message}`,
    }
  }

  return {
    success: true,
    added,
    removed,
    checkedAt: lastRefreshAt,
  }
}

/**
 * 启动时的轻量探测：只有显式 api-key 才请求 `/models`，网络异常按可用处理
 * （离线不该挡住用户用本地模型 / 已缓存的目录）。
 */
export async function probeApiKey(providerId: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  if (!isPresetProviderId(providerId)) return { ok: false, error: 'PROVIDER_UNKNOWN' }
  const runtime = await getCatalogRuntime()
  const model = (runtime.getModels(providerId) as readonly Model<Api>[])[0]
  const baseUrl = (model as { baseUrl?: string } | undefined)?.baseUrl
  if (!baseUrl) return { ok: true }
  // 含非法 HTTP 头字符（如换行 / 非 ASCII）在 fetch 中会抛 TypeError，必须判为无效 Key 而非网络不通
  if (/[^\t\x20-\x7e]/.test(apiKey)) {
    return { ok: false, error: 'INVALID_KEY' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  const request = providerModelsProbeRequest(providerId, baseUrl, apiKey)
  try {
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: controller.signal,
    })
    const bodyText = response.status === 400 ? await response.text().catch(() => '') : ''
    if (isInvalidKeyProbeResponse(providerId, response.status, bodyText)) {
      return { ok: false, error: 'INVALID_KEY' }
    }
    return { ok: true }
  } catch {
    return { ok: true }
  } finally {
    clearTimeout(timer)
  }
}

// ------------------------------ OAuth 需要的稳定设备 ID ------------------------------

/** 登录交互要用同一个设备 ID：OpenAI 会用 `agentHostId` 校验 UUID 格式（D27） */
export async function getDeviceId(): Promise<string> {
  return deviceId(path.join(getAppDir(), 'config', 'device-id'))
}

/** 目录缓存文件的绝对路径（测试与诊断用） */
export function modelsStoreFilePath(): string {
  return path.join(getAppDir(), 'data', 'agent', 'models-store.json')
}

/** 启动时确保 `data/agent` 存在：SDK 写目录缓存前不建目录 */
export async function ensureAgentDataDir(): Promise<void> {
  await fs.mkdir(piAgentDir, { recursive: true })
}
