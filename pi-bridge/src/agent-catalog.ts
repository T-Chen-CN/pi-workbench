/**
 * 模型目录与能力查询服务：从 `AgentManager` 拆出的独立子系统。
 * 负责同步远端目录快照、解析当前活跃模型、输出能力视图与刷新远端模型目录。
 */

import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai'
import {
  PRESET_PROVIDER_IDS,
  builtinCatalogModels,
  diffCatalogSnapshots,
  filterEffectiveCatalogModels,
  type ModelLimits,
} from './provider-presets.js'
import type { CatalogSnapshot } from './models-store.js'
import type { AgentConfig, AgentLogger, ModelCapabilityInfo } from './types.js'
import { effectiveLimits, thinkingLevelsOf, type SessionRuntime } from './agent-runtime-types.js'

export interface AgentCatalogDeps {
  getConfig: () => AgentConfig | null
  getModelRuntime: () => ModelRuntime | null
  getLogger: () => AgentLogger
}

export class AgentCatalogService {
  /** 当前 provider 的远端目录快照（D12/D26）：用于过滤内置快照里上游已下架的模型 */
  private remoteCatalogSnapshot: CatalogSnapshot | undefined = undefined

  constructor(private readonly deps: AgentCatalogDeps) {}

  resetSnapshot(): void {
    this.remoteCatalogSnapshot = undefined
  }

  async syncRemoteCatalogSnapshot(providerId: string): Promise<void> {
    const store = this.deps.getConfig()?.modelsStore
    if (!store || !('snapshotFor' in store) || typeof store.snapshotFor !== 'function') {
      this.remoteCatalogSnapshot = undefined
      return
    }
    try {
      this.remoteCatalogSnapshot = await (
        store as { snapshotFor(id: string): Promise<CatalogSnapshot | undefined> }
      ).snapshotFor(providerId)
    } catch {
      this.remoteCatalogSnapshot = undefined
    }
  }

  catalogModels(): Model<Api>[] {
    const providerId = this.deps.getConfig()?.apiConfig.providerId
    if (!providerId) return []
    const runtime = this.deps.getModelRuntime() as
      | (ModelRuntime & { getModels?: (id: string) => readonly Model<Api>[] })
      | null
    const fromRuntime = runtime?.getModels?.(providerId)
    const raw =
      fromRuntime && fromRuntime.length > 0 ? fromRuntime : builtinCatalogModels(providerId)
    return filterEffectiveCatalogModels(raw, this.remoteCatalogSnapshot)
  }

  resolveActiveModel(): Model<Api> | undefined {
    const config = this.deps.getConfig()
    const modelRuntime = this.deps.getModelRuntime()
    if (!config || !modelRuntime) return undefined
    const { providerId, modelId } = config.apiConfig
    const models = this.catalogModels()
    const recorded = models.find((entry) => entry.id === modelId)
    if (recorded) return recorded
    if (models.length === 0) {
      const direct = modelRuntime.getModel(providerId, modelId)
      if (direct) return direct
    }
    const fallback = models[0]
    if (fallback) {
      this.deps.getLogger().warn(
        `[Agent Manager] Model ${providerId}/${modelId} is unavailable; falling back to ${fallback.id}`
      )
    }
    return fallback
  }

  resolveSessionModel(runtime?: SessionRuntime): Model<Api> | undefined {
    const sessionModel = runtime?.session?.model as Model<Api> | undefined
    if (sessionModel?.provider && sessionModel?.id) {
      return (
        this.deps.getModelRuntime()?.getModel(sessionModel.provider, sessionModel.id) ??
        sessionModel
      )
    }
    return this.resolveActiveModel()
  }

  outputLimit(runtime?: SessionRuntime): number {
    const model = this.resolveSessionModel(runtime)
    if (!model) return 0
    return effectiveLimits(model).maxTokens
  }

  async getModelCapabilities(): Promise<{
    success: boolean
    models?: ModelCapabilityInfo[]
    selected?: string
    error?: string
  }> {
    try {
      const config = this.deps.getConfig()
      if (!this.deps.getModelRuntime() || !config) {
        return { success: false, error: 'Agent not initialized.' }
      }
      const { overrides } = config.apiConfig
      const active = this.resolveActiveModel()

      const models = this.catalogModels().map((model): ModelCapabilityInfo => {
        const limits = effectiveLimits(model)
        const override = overrides?.[model.id]
        const userSet =
          (typeof override?.contextWindow === 'number' && override.contextWindow > 0) ||
          (typeof override?.maxTokens === 'number' && override.maxTokens > 0)
        const supportsThinking = Boolean(model.reasoning)
        return {
          id: model.id,
          available: true,
          contextWindow: limits.contextWindow,
          maxTokens: limits.maxTokens,
          maxTokensSource: userSet
            ? 'user'
            : limits.maxTokens < (model.maxTokens ?? 0)
              ? 'clamped'
              : 'catalog',
          reasoning: supportsThinking,
          vision: Array.isArray(model.input) && model.input.includes('image'),
          thinkingLevels: supportsThinking ? thinkingLevelsOf(model) : [],
        }
      })

      return { success: true, models, selected: active?.id ?? config.apiConfig.modelId }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async getProviderCatalog(): Promise<{
    success: boolean
    providerId?: string
    models?: Array<{ id: string; name: string; limits: ModelLimits; reasoning: boolean }>
    error?: string
  }> {
    const config = this.deps.getConfig()
    if (!this.deps.getModelRuntime() || !config) {
      return { success: false, error: 'Agent not initialized.' }
    }
    const { providerId } = config.apiConfig
    return {
      success: true,
      providerId,
      models: this.catalogModels().map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        limits: effectiveLimits(model),
        reasoning: Boolean(model.reasoning),
      })),
    }
  }

  async refreshCatalog(options: { force?: boolean } = {}): Promise<{
    success: boolean
    added: number
    removed: number
    checkedAt?: number
    error?: string
  }> {
    const modelRuntime = this.deps.getModelRuntime()
    const config = this.deps.getConfig()
    if (!modelRuntime || !config) {
      return { success: false, added: 0, removed: 0, error: 'Agent not initialized.' }
    }
    const store = config.modelsStore
    const snapshotter =
      store && 'snapshot' in store
        ? (store as {
            snapshot(): Promise<Array<{ providerId: string; ids: string[]; checkedAt?: number }>>
          })
        : null
    const before = snapshotter ? await snapshotter.snapshot() : []
    try {
      const result = await modelRuntime.refresh({
        allowNetwork: true,
        providers: [...PRESET_PROVIDER_IDS],
        force: options.force === true,
      })
      await this.syncRemoteCatalogSnapshot(config.apiConfig.providerId)
      if (result.errors.size > 0) {
        const first = [...result.errors.entries()][0]
        return {
          success: false,
          added: 0,
          removed: 0,
          error: `${first[0]}: ${first[1].message}`,
        }
      }
      const after = snapshotter ? await snapshotter.snapshot() : []
      const { added, removed } = diffCatalogSnapshots(before, after)
      const checkedAt = after.reduce<number | undefined>(
        (latest, entry) =>
          entry.checkedAt && (!latest || entry.checkedAt > latest) ? entry.checkedAt : latest,
        undefined
      )
      return { success: true, added, removed, checkedAt }
    } catch (error) {
      return {
        success: false,
        added: 0,
        removed: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
