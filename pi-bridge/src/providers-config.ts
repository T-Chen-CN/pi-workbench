/**
 * 供应商配置（`config/providers.json`）与旧配置迁移。
 *
 * 纯 Node，依赖注入：桌面端注入 safeStorage 解密与自己的凭证 store，
 * 云端注入自己的实现。配置里**不含任何密钥**，只有 active / model / overrides。
 *
 * 两条不变量：
 * - 只允许写入白名单内的 provider 与 catalog 内存在的模型，清洗在读取时也做一遍
 *   （文件可能被手工改过、catalog 也可能跟着升级变小）；
 * - overrides 一律经 `resolveLimits()` 归一化，写入值永远不放超过 catalog 真值。
 */

import * as fs from 'fs/promises'
import { existsSync, readFileSync, renameSync } from 'fs'
import * as path from 'path'
import { createHash } from 'node:crypto'
import type { CredentialStore } from '@earendil-works/pi-ai'
import {
  builtinCatalogModels,
  catalogLimits,
  isPresetProviderId,
  normalizeOverrides,
  resolveLimits,
  type ModelLimits,
  type ModelOverrides,
} from './provider-presets.js'
import { writeJsonAtomicSync } from './atomic-json.js'

export const PROVIDERS_CONFIG_VERSION = 1
export const PROVIDERS_CONFIG_FILE = 'providers.json'
/** 与既有 `electron/ipc/api-config.ts` 的命名保持一致，避免目录里出现两种 legacy 名 */
export const LEGACY_API_CONFIG_FILE = 'api-config.legacy.json'
export const LEGACY_AUTH_FILE = 'auth.json.legacy'

export interface ProviderConfigEntry {
  /** 该 provider 当前选中的模型；必须是 catalog 内存在的 id */
  model: string
  /** 按模型存的下调值；缺省 = catalog 真值 */
  overrides?: Record<string, ModelOverrides>
}

export interface ProvidersConfig {
  version: number
  activeProvider: string | null
  providers: Record<string, ProviderConfigEntry>
}

export interface ProviderModelSummary {
  id: string
  contextWindow?: number
  maxTokens?: number
}

export interface ProvidersConfigLogger {
  warn(message: string, ...args: unknown[]): void
}

export interface ProvidersConfigStoreOptions {
  /** `config/providers.json` 的绝对路径 */
  path: string
  /** 旧配置里的 key 解密；缺省视为「没有旧 key 可迁移」 */
  decryptSecret?: (value: string) => string
  credentials?: CredentialStore
  logger?: ProvidersConfigLogger
  /** 模型清单来源，默认读 Pi 内置 catalog */
  listModels?: (providerId: string) => readonly ProviderModelSummary[]
  /** 旧数据目录（`data/agent`），迁移时从其中导入 `auth.json` */
  agentDir?: string
}

export type LegacyMigrationReason =
  | 'already-migrated'
  | 'no-legacy-config'
  | 'unmapped-provider'

export interface LegacyMigrationResult {
  migrated: boolean
  reason?: LegacyMigrationReason
  providerId?: string
  modelId?: string
  /** 迁移进凭证 store 的 provider（含从 auth.json 导入的） */
  importedCredentials: string[]
  /** 旧文件是否已改名为 `.legacy` */
  legacyArchived: boolean
}

export type SetActiveResult =
  | { ok: true; config: ProvidersConfig }
  | { ok: false; code: 'PROVIDER_UNKNOWN' | 'MODEL_UNKNOWN' | 'NOT_CONNECTED' }

export function emptyProvidersConfig(): ProvidersConfig {
  return { version: PROVIDERS_CONFIG_VERSION, activeProvider: null, providers: {} }
}

/** 凭证身份指纹：换 key 要重建 Agent，OAuth token 刷新不需要（D21） */
export function credentialFingerprint(credential: { type: string; key?: string } | undefined): string {
  if (!credential) return 'none'
  if (credential.type === 'oauth') return 'oauth'
  if (!credential.key) return 'api_key:empty'
  return `api_key:${createHash('sha256').update(credential.key!).digest('hex').slice(0, 12)}`
}

/** 旧配置的 apiUrl → 白名单 provider；认不出来就不猜，交给 UI 重新选 */
export function legacyProviderFromUrl(apiUrl: unknown): string | undefined {
  if (typeof apiUrl !== 'string') return undefined
  const url = apiUrl.toLowerCase()
  if (url.includes('deepseek.com')) return 'deepseek'
  if (url.includes('anthropic.com')) return 'anthropic'
  if (url.includes('api.openai.com')) return 'openai'
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 主文件损坏时回退 `.bak`；两个都读不出来就是「没有配置」 */
function readJsonFileWithBackup(filePath: string): unknown {
  for (const candidate of [filePath, `${filePath}.bak`]) {
    if (!existsSync(candidate)) continue
    try {
      return JSON.parse(readFileSync(candidate, 'utf-8'))
    } catch {
      // 换下一个候选
    }
  }
  return undefined
}

function defaultListModels(providerId: string): readonly ProviderModelSummary[] {
  return builtinCatalogModels(providerId).map((model) => ({
    id: model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }))
}

export function createProvidersConfigStore(options: ProvidersConfigStoreOptions) {
  const { path: configPath } = options
  const logger = options.logger ?? console
  const listModels = options.listModels ?? defaultListModels

  function modelLimits(providerId: string, modelId: string): ModelLimits | undefined {
    const model = listModels(providerId).find((entry) => entry.id === modelId)
    if (!model) return undefined
    return catalogLimits(model)
  }

  /** 清洗一份配置：白名单、模型存在性、overrides 夹取 */
  function sanitize(input: unknown): ProvidersConfig {
    const config = emptyProvidersConfig()
    if (!isRecord(input) || !isRecord(input.providers)) return config

    for (const [providerId, rawEntry] of Object.entries(input.providers)) {
      if (!isPresetProviderId(providerId)) {
        logger.warn(`[Providers] 丢弃白名单外的供应商 ${providerId}`)
        continue
      }
      if (!isRecord(rawEntry)) continue
      const models = listModels(providerId)
      if (models.length === 0) {
        logger.warn(`[Providers] ${providerId} 在 catalog 里没有模型，已忽略`)
        continue
      }
      const requested = typeof rawEntry.model === 'string' ? rawEntry.model : ''
      const modelId = models.some((model) => model.id === requested) ? requested : models[0].id
      if (requested && modelId !== requested) {
        logger.warn(`[Providers] ${providerId} 上的模型 ${requested} 已不存在，回落到 ${modelId}`)
      }

      const entry: ProviderConfigEntry = { model: modelId }
      if (isRecord(rawEntry.overrides)) {
        const overrides: Record<string, ModelOverrides> = {}
        for (const [overrideModelId, raw] of Object.entries(rawEntry.overrides)) {
          const catalog = modelLimits(providerId, overrideModelId)
          if (!catalog || !isRecord(raw)) {
            logger.warn(`[Providers] 丢弃 ${providerId}/${overrideModelId} 的容量覆盖`)
            continue
          }
          const normalized = normalizeOverrides(catalog, raw as ModelOverrides)
          if (Object.keys(normalized).length > 0) overrides[overrideModelId] = normalized
        }
        if (Object.keys(overrides).length > 0) entry.overrides = overrides
      }
      config.providers[providerId] = entry
    }

    const requestedActive = typeof input.activeProvider === 'string' ? input.activeProvider : null
    config.activeProvider =
      requestedActive && config.providers[requestedActive] ? requestedActive : null
    return config
  }

  function write(config: ProvidersConfig): void {
    writeJsonAtomicSync(configPath, sanitize(config))
  }

  async function read(): Promise<ProvidersConfig> {
    try {
      const raw = await fs.readFile(configPath, 'utf-8')
      return sanitize(JSON.parse(raw))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') logger.warn('[Providers] 读取失败，按空配置处理:', error)
      return emptyProvidersConfig()
    }
  }

  /** 纯函数：切换 active，只接受白名单内且已配置的 provider / 存在的模型 */
  function setActive(
    config: ProvidersConfig,
    providerId: string,
    modelId?: string
  ): SetActiveResult {
    if (!isPresetProviderId(providerId)) return { ok: false, code: 'PROVIDER_UNKNOWN' }
    const connected = config.providers[providerId]
    if (!connected) return { ok: false, code: 'NOT_CONNECTED' }
    const target = modelId ?? connected.model
    const limits = modelLimits(providerId, target)
    if (!limits) return { ok: false, code: 'MODEL_UNKNOWN' }
    return {
      ok: true,
      config: {
        ...config,
        activeProvider: providerId,
        providers: { ...config.providers, [providerId]: { ...connected, model: target } },
      },
    }
  }

  /** 纯函数：写下调值，返回生效值与归一化后的配置 */
  function setOverrides(
    config: ProvidersConfig,
    providerId: string,
    modelId: string,
    overrides: ModelOverrides | undefined
  ): { config: ProvidersConfig; effective: ModelLimits } | { error: 'PROVIDER_UNKNOWN' | 'MODEL_UNKNOWN' } {
    if (!isPresetProviderId(providerId)) return { error: 'PROVIDER_UNKNOWN' }
    const connected = config.providers[providerId]
    if (!connected) return { error: 'PROVIDER_UNKNOWN' }
    const catalog = modelLimits(providerId, modelId)
    if (!catalog) return { error: 'MODEL_UNKNOWN' }

    const normalized = normalizeOverrides(catalog, overrides)
    const providerOverrides = { ...(connected.overrides ?? {}) }
    if (Object.keys(normalized).length === 0) delete providerOverrides[modelId]
    else providerOverrides[modelId] = normalized

    const entry: ProviderConfigEntry = { model: connected.model }
    if (Object.keys(providerOverrides).length > 0) entry.overrides = providerOverrides
    return {
      config: { ...config, providers: { ...config.providers, [providerId]: entry } },
      effective: resolveLimits(catalog, normalized),
    }
  }

  function archive(filePath: string, targetName: string): boolean {
    const target = path.join(path.dirname(filePath), targetName)
    try {
      if (existsSync(target)) return true
      renameSync(filePath, target)
      return true
    } catch (error) {
      logger.warn(`[Providers] 归档 ${filePath} 失败:`, error)
      return false
    }
  }

  /**
   * 启动迁移（幂等）。只在 `providers.json` 不存在时执行一次。
   *
   * `models.json` 不在这一步处理：它由 AgentManager 每次初始化覆盖生成。
   */
  async function migrateLegacy(): Promise<LegacyMigrationResult> {
    const result: LegacyMigrationResult = { migrated: false, importedCredentials: [], legacyArchived: false }
    if (existsSync(configPath)) return { ...result, reason: 'already-migrated' }

    const legacyPath = path.join(path.dirname(configPath), 'api-config.json')
    const legacy = readJsonFileWithBackup(legacyPath)
    if (!isRecord(legacy)) {
      // 没有旧配置：直接落一份空配置，让后续读取稳定
      write(emptyProvidersConfig())
      return { ...result, reason: 'no-legacy-config', legacyArchived: false }
    }

    const providerId = legacyProviderFromUrl(legacy.apiUrl)
    if (!providerId) {
      write(emptyProvidersConfig())
      const archived = existsSync(legacyPath) ? archive(legacyPath, LEGACY_API_CONFIG_FILE) : false
      return { ...result, reason: 'unmapped-provider', legacyArchived: archived }
    }

    const models = listModels(providerId)
    const requestedModel = typeof legacy.selectedModel === 'string' ? legacy.selectedModel : ''
    const modelId = models.some((model) => model.id === requestedModel)
      ? requestedModel
      : models[0]?.id
    if (!modelId) {
      write(emptyProvidersConfig())
      return { ...result, reason: 'unmapped-provider', legacyArchived: false }
    }

    const config: ProvidersConfig = {
      version: PROVIDERS_CONFIG_VERSION,
      activeProvider: providerId,
      providers: { [providerId]: { model: modelId } },
    }

    const imported: string[] = []
    const rawKey = typeof legacy.apiKey === 'string' ? legacy.apiKey : ''
    const key = rawKey && options.decryptSecret ? options.decryptSecret(rawKey) : ''
    if (key && options.credentials) {
      await options.credentials.modify(providerId, async (current) => current ?? { type: 'api_key', key })
      imported.push(providerId)
    }

    // 旧 SDK 的 auth.json 是 `Record<providerId, Credential>`（明文），逐条导入后归档
    if (options.credentials && options.agentDir) {
      const authPath = path.join(options.agentDir, 'auth.json')
      const stored = readJsonFileWithBackup(authPath)
      if (isRecord(stored)) {
        for (const [authProviderId, credential] of Object.entries(stored)) {
          if (!isPresetProviderId(authProviderId) || !isRecord(credential)) continue
          const type = credential.type
          if (type !== 'api_key' && type !== 'oauth') continue
          await options.credentials.modify(authProviderId, async (current) => current ?? (credential as never))
          if (!imported.includes(authProviderId)) imported.push(authProviderId)
        }
      }
      if (existsSync(authPath)) archive(authPath, LEGACY_AUTH_FILE)
    }

    write(config)
    const archived = existsSync(legacyPath) ? archive(legacyPath, LEGACY_API_CONFIG_FILE) : false
    return {
      migrated: true,
      providerId,
      modelId,
      importedCredentials: imported,
      legacyArchived: archived,
    }
  }

  return { read, write, sanitize, setActive, setOverrides, migrateLegacy }
}

export type ProvidersConfigStore = ReturnType<typeof createProvidersConfigStore>
