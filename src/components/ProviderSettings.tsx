/**
 * 供应商设置：8 家固定预设 + 凭证登录 + 模型能力表。
 *
 * 三条硬约束（见 docs/architecture/provider-presets.md）：
 * 1. 模型能力只展示 catalog 可读字段，应用不维护第二份真值；
 * 2. 上下文窗口 / 输出上限只能向下调，按模型存，超上限由主进程夹住；
 * 3. 任何接口都不回传密钥，UI 只知道「已连接 / 未连接」和凭证类型。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import type {
  ProviderAuthMethod,
  ProviderModelOverrides,
  ProviderModelView,
  ProviderView
} from '../types/electron'
import { api } from '../api'
import { useI18nStore } from '../store/i18nStore'
import { useSettingsStore } from '../store/settingsStore'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import { emitAppEvent } from '../utils/appEvents'
import { persistAppSettings } from '../utils/persistSettings'
import { Button, Field, Input, Select } from './ui'
import { SearchField, SettingsTable, SettingsTableRow } from './patterns'
import { ProviderAuthPanel } from './ProviderAuthPanel'

function formatCatalogTime(timestamp: number | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm}`
}

function formatCatalogDate(timestamp: number | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`
  return `${Math.round(value / 1024)}K`
}

/** 下拉档位：catalog 真值 + 常用向下档位（都夹在真值以内） */
function limitOptions(max: number): number[] {
  const steps = [8_192, 16_384, 32_768, 65_536, 131_072, 262_144, 524_288, 1_000_000]
  const values = steps.filter((step) => step < max)
  return [...values, max]
}

function formatUsd(value: number): string {
  if (value === 0) return '0'
  if (value >= 10) return Number(value.toFixed(1)).toString()
  if (value >= 1) return Number(value.toFixed(2)).toString()
  return Number(value.toFixed(3)).toString()
}

function resolveModelCost(model: ProviderModelView): {
  input?: number
  output?: number
  cacheRead?: number
} | null {
  const fromEnrichment = model.enrichment?.cost
  if (fromEnrichment && (fromEnrichment.input !== undefined || fromEnrichment.output !== undefined)) {
    return fromEnrichment
  }
  if (model.cost && typeof model.cost === 'object' && !Array.isArray(model.cost)) {
    const raw = model.cost as Record<string, unknown>
    const input = typeof raw.input === 'number' && Number.isFinite(raw.input) ? raw.input : undefined
    const output = typeof raw.output === 'number' && Number.isFinite(raw.output) ? raw.output : undefined
    const cacheRead =
      typeof raw.cacheRead === 'number' && Number.isFinite(raw.cacheRead) ? raw.cacheRead : undefined
    if (input !== undefined || output !== undefined) return { input, output, cacheRead }
  }
  return null
}

function capabilityCells(
  model: ProviderModelView,
  t: (
    key: Parameters<ReturnType<typeof useI18nStore.getState>['t']>[0],
    params?: Record<string, string | number>
  ) => string
) {
  const modalities = model.enrichment?.modalities?.input?.length
    ? model.enrichment.modalities.input
    : model.input
  const extraModalities = modalities.filter((item) => item !== 'text' && item !== 'image')
  const parts = [
    `${t('modelContextColumn')} ${formatTokens(model.limits.contextWindow)}`,
    `${t('modelMaxTokensColumn')} ${formatTokens(model.limits.maxTokens)}`,
    model.reasoning ? t('providerReasoningYes') : t('providerReasoningNo'),
    model.vision ? t('providerVisionYes') : t('providerVisionNo')
  ]
  if (extraModalities.length > 0) parts.push(extraModalities.join('/'))
  const cost = resolveModelCost(model)
  if (cost && cost.input !== undefined && cost.output !== undefined) {
    parts.push(`$${formatUsd(cost.input)}/$${formatUsd(cost.output)}`)
  }
  if (model.enrichment?.status === 'deprecated') parts.push(t('providerModelDeprecated'))
  return parts.join(' · ')
}

function enrichmentMetaItems(
  model: ProviderModelView,
  t: (
    key: Parameters<ReturnType<typeof useI18nStore.getState>['t']>[0],
    params?: Record<string, string | number>
  ) => string
): string[] {
  const items: string[] = []
  const cost = resolveModelCost(model)
  if (cost && cost.input !== undefined && cost.output !== undefined) {
    items.push(
      t('providerModelPrice', { input: formatUsd(cost.input), output: formatUsd(cost.output) })
    )
    if (cost.cacheRead !== undefined && cost.cacheRead > 0) {
      items.push(t('providerModelCacheReadPrice', { price: formatUsd(cost.cacheRead) }))
    }
  }
  const enrichment = model.enrichment
  if (enrichment?.modalities?.input?.length) {
    items.push(t('providerModelModalities', { input: enrichment.modalities.input.join(' / ') }))
  }
  if (enrichment?.knowledge) {
    items.push(t('providerModelKnowledge', { date: enrichment.knowledge }))
  }
  if (enrichment?.releaseDate) {
    items.push(t('providerModelReleaseDate', { date: enrichment.releaseDate }))
  }
  if (enrichment?.openWeights) {
    items.push(t('providerModelOpenWeights'))
  }
  return items
}

export function ProviderSettings() {
  const t = useI18nStore((store) => store.t)
  const autoRefreshCatalog = useSettingsStore((store) => store.autoRefreshCatalog)
  const setAutoRefreshCatalog = useSettingsStore((store) => store.setAutoRefreshCatalog)
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [activeProvider, setActiveProvider] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [builtinGeneratedAt, setBuiltinGeneratedAt] = useState<number | undefined>(undefined)
  const [apiKey, setApiKey] = useState('')
  const [modelQuery, setModelQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const result = await api.providersList()
      if (!result.success || !result.providers) {
        toast.error(useI18nStore.getState().t('loadProvidersFailed'))
        return
      }
      setProviders(result.providers)
      setActiveProvider(result.activeProvider ?? null)
      setOffline(result.offline === true)
      setBuiltinGeneratedAt(result.builtinGeneratedAt)
      setSelectedId((current) => {
        if (current && result.providers!.some((provider) => provider.id === current)) return current
        return result.activeProvider ?? result.providers![0]?.id ?? null
      })
    } catch (error) {
      console.error('[Providers] load failed:', error)
      toast.error(useI18nStore.getState().t('loadProvidersFailed'))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const selected = useMemo(
    () => providers.find((provider) => provider.id === selectedId) ?? null,
    [providers, selectedId]
  )
  const selectedModel = useMemo(
    () =>
      selected?.models.find((item) => item.id === selected.model) ??
      selected?.models[0] ??
      null,
    [selected]
  )
  const selectedMetaItems = useMemo(
    () => (selectedModel ? enrichmentMetaItems(selectedModel, t) : []),
    [selectedModel, t]
  )

  const displayedModels = useMemo(() => {
    if (!selected) return []
    const needle = modelQuery.trim().toLowerCase()
    const filtered = needle
      ? selected.models.filter(
          (model) =>
            model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)
        )
      : selected.models
    const activeId = selected.model
    if (!activeId) return filtered
    const activeIndex = filtered.findIndex((model) => model.id === activeId)
    if (activeIndex <= 0) return filtered
    return [
      filtered[activeIndex],
      ...filtered.slice(0, activeIndex),
      ...filtered.slice(activeIndex + 1),
    ]
  }, [selected, modelQuery])

  const notifyAgent = useCallback(() => {
    // 各工作区的 Agent 用新配置重建（会话本身不受影响）
    emitAppEvent('api-config-saved')
  }, [])

  // OAuth 登录是异步流（providers:login 立即返回），必须在收到 result 成功事件后再刷新与通知 Agent
  useEffect(() => {
    const off = api.onProvidersAuthEvent((payload) => {
      if (payload.kind !== 'result' || !payload.success) return
      void api
        .providersRefresh(false)
        .catch(() => {})
        .finally(() => {
          void load().then(notifyAgent)
        })
    })
    return () => off()
  }, [load, notifyAgent])

  const handleSaveKey = async () => {
    if (!selected || !apiKey.trim()) return
    setBusy('key')
    try {
      const result = await api.providersSetApiKey(selected.id, apiKey.trim())
      if (!result.success) {
        toast.error(
          result.error === 'INVALID_KEY'
            ? t('providerInvalidKey')
            : t('providerLoginFailed', {
                error: localizeError(result.error ?? '') || t('unknownError')
              })
        )
        return
      }
      setApiKey('')
      // 首次连接后按 4h 缓存节流拉一次最新目录（离线/失败静默回退内置快照）
      await api.providersRefresh(false).catch(() => {})
      await load()
      notifyAgent()
      toast.success(t('providerConnected', { name: selected.name }))
    } finally {
      setBusy(null)
    }
  }

  const handleOAuth = async (method: ProviderAuthMethod) => {
    if (!selected) return
    setBusy('oauth')
    const result = await api.providersLogin(selected.id, method)
    setBusy(null)
    if (!result.success) {
      toast.error(
        t('providerLoginFailed', {
          error: localizeError(result.error ?? '') || t('unknownError')
        })
      )
      return
    }
  }

  const handleSelectModel = async (modelId: string) => {
    if (!selected) return
    const result = await api.providersSetActive(selected.id, modelId)
    if (!result.success) {
      toast.error(t('providerSelectModelFailed', { error: localizeError(result.error ?? '') }))
      return
    }
    await load()
    notifyAgent()
  }

  const handleOverride = async (
    model: ProviderModelView,
    patch: ProviderModelOverrides
  ) => {
    if (!selected) return
    const merged = { ...(model.overrides ?? {}), ...patch }
    const result = await api.providersSetOverrides(selected.id, model.id, merged)
    if (!result.success) {
      toast.error(t('providerSelectModelFailed', { error: localizeError(result.error ?? '') }))
      return
    }
    await load()
    // 上限走 models.json：正在跑的会话在轮次边界生效（D23）
    if (result.pending) toast.info(t('providerLimitPending'))
    notifyAgent()
  }

  const handleForget = async () => {
    if (!selected) return
    await api.providersForget(selected.id)
    await load()
    notifyAgent()
  }

  const handleAutoRefreshChange = (enabled: boolean) => {
    setAutoRefreshCatalog(enabled)
    void persistAppSettings({ autoRefreshCatalog: enabled })
  }

  const handleRefresh = async () => {
    if (offline) {
      toast.info(t('providerCatalogOffline'))
      return
    }
    setRefreshing(true)
    try {
      const result = await api.providersRefresh(true)
      if (!result.success) {
        toast.error(
          result.error === 'PI_OFFLINE'
            ? t('providerCatalogOffline')
            : t('providerRefreshFailed', {
                error: localizeError(result.error ?? '') || t('unknownError')
              })
        )
        return
      }
      await load()
      toast.success(
        t('providerRefreshed', { added: result.added, removed: result.removed })
      )
    } finally {
      setRefreshing(false)
    }
  }

  const directorySummary = useMemo(() => {
    if (!selected) return null
    if (offline) return t('providerCatalogOffline')
    const dir = selected.directory
    if (dir?.source === 'remote') {
      const stamp = formatCatalogTime(dir.checkedAt ?? dir.lastModified)
      return t('providerCatalogSourceRemote', { time: stamp || '-' })
    }
    const bundledDate = formatCatalogDate(builtinGeneratedAt)
    return bundledDate
      ? t('providerCatalogSourceBundled', { time: bundledDate })
      : t('providerCatalogSourceBundledNoDate')
  }, [selected, offline, builtinGeneratedAt, t])

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="m-0 type-reading text-ink-muted">{t('providerSettingsDesc')}</p>

      <Field label={t('providerLabel')}>
        <Select
          value={selectedId ?? ''}
          onChange={(event) => {
            setSelectedId(event.target.value)
            setApiKey('')
            setModelQuery('')
          }}
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
              {provider.connected ? ` · ${t('providerConnectedShort')}` : ''}
              {provider.id === activeProvider ? ` · ${t('providerActiveShort')}` : ''}
            </option>
          ))}
        </Select>
      </Field>

      {selected && (
        <>
          {selected.connected ? (
            <div className="flex items-center justify-between gap-3">
              <span className="type-caption text-ink-muted">
                {t('providerConnectedAs', {
                  type:
                    selected.credentialType === 'oauth'
                      ? t('providerAuthOAuth')
                      : t('providerAuthApiKey')
                })}
              </span>
              <Button variant="ghost" size="sm" icon={Trash2} onClick={() => void handleForget()}>
                {t('providerForget')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {selected.authMethods.includes('api_key') && (
                <Field label={t('apiKey')} hint={t('apiKeyHint')}>
                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter' &&
                          !event.nativeEvent.isComposing &&
                          event.keyCode !== 229
                        ) {
                          void handleSaveKey()
                        }
                      }}
                      placeholder="sk-..."
                      className="type-code"
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busy === 'key'}
                      disabled={!apiKey.trim()}
                      onClick={() => void handleSaveKey()}
                    >
                      {t('providerConnect')}
                    </Button>
                  </div>
                </Field>
              )}
              {selected.authMethods.includes('oauth') && (
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy === 'oauth'}
                    onClick={() => void handleOAuth('oauth')}
                  >
                    {t('providerSignInOAuth')}
                  </Button>
                </div>
              )}
              <ProviderAuthPanel providerId={selected.id} />
            </div>
          )}

          {(selected.id === 'openai' || selected.id === 'openai-codex') && (
            <p className="m-0 type-caption text-ink-muted">
              {t('providerOpenAICodexSeparateHint')}
            </p>
          )}

          <Field label={t('model')} hint={t('modelsAvailable', { count: selected.models.length })}>
            <Select
              value={selected.model ?? ''}
              onChange={(event) => void handleSelectModel(event.target.value)}
              disabled={!selected.connected || selected.models.length === 0}
            >
              {selected.models.length === 0 ? (
                <option value="">{t('noModelsAvailable')}</option>
              ) : (
                selected.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))
              )}
            </Select>
          </Field>

          {selectedModel &&
            (selectedMetaItems.length > 0 ||
              selectedModel.enrichment?.description ||
              selectedModel.enrichment?.status === 'deprecated') && (
              <div className="flex flex-col gap-1 rounded border border-rule-divide bg-surface px-3 py-2">
                {(selectedModel.enrichment?.description ||
                  selectedModel.enrichment?.status === 'deprecated') && (
                  <div className="flex items-center gap-2">
                    {selectedModel.enrichment?.status === 'deprecated' && (
                      <span className="shrink-0 type-caption text-danger">
                        {t('providerModelDeprecated')}
                      </span>
                    )}
                    {selectedModel.enrichment?.description && (
                      <p className="m-0 min-w-0 flex-1 type-caption text-ink">
                        {selectedModel.enrichment.description}
                      </p>
                    )}
                  </div>
                )}
                {selectedMetaItems.length > 0 && (
                  <p className="m-0 type-caption text-ink-muted">
                    {selectedMetaItems.join(' · ')}
                  </p>
                )}
              </div>
            )}

          {selected.models.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-baseline gap-2">
                  <span className="type-label text-ink">{t('modelCapabilityTable')}</span>
                  {modelQuery.trim() && (
                    <span className="type-caption text-ink-muted">
                      {t('providerModelsFilteredCount', {
                        shown: displayedModels.length,
                        total: selected.models.length,
                      })}
                    </span>
                  )}
                </span>
                <SearchField
                  value={modelQuery}
                  onChange={setModelQuery}
                  placeholder={t('providerModelSearchPlaceholder')}
                  ariaLabel={t('providerModelSearchPlaceholder')}
                  className="w-52"
                />
              </div>
              <SettingsTable
                columns={[
                  { label: t('modelColumn'), className: 'min-w-0 flex-1' },
                  { label: t('modelContextColumn'), className: 'w-24' },
                  { label: t('modelMaxTokensColumn'), className: 'w-24' },
                  { label: t('providerCapabilitiesColumn'), className: 'w-40' }
                ]}
              >
                <div className="max-h-72 overflow-y-auto">
                  {displayedModels.length === 0 ? (
                    <p className="m-0 px-3 py-3 type-caption text-ink-muted">
                      {t('providerModelsNoMatch')}
                    </p>
                  ) : (
                    displayedModels.map((model) => (
                      <SettingsTableRow key={model.id} selected={model.id === selected.model}>
                        <span className="flex min-w-0 flex-1 items-center gap-1.5" title={model.id}>
                          <span className="min-w-0 truncate type-data text-ink">{model.id}</span>
                          {model.id === selected.model && (
                            <span className="flex-shrink-0 rounded border border-accent px-1 type-caption text-accent">
                              {t('providerActiveShort')}
                            </span>
                          )}
                        </span>
                        <div className="w-24">
                          <Select
                            value={model.limits.contextWindow}
                            aria-label={`${model.id} ${t('modelContextColumn')}`}
                            onChange={(event) =>
                              void handleOverride(model, {
                                contextWindow: Number(event.target.value)
                              })
                            }
                          >
                            {limitOptions(
                              model.catalogLimits?.contextWindow ?? model.limits.contextWindow
                            ).map((value) => (
                              <option key={value} value={value}>
                                {formatTokens(value)}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className="w-24">
                          <Select
                            value={model.limits.maxTokens}
                            aria-label={`${model.id} ${t('modelMaxTokensColumn')}`}
                            onChange={(event) =>
                              void handleOverride(model, { maxTokens: Number(event.target.value) })
                            }
                          >
                            {limitOptions(
                              Math.min(
                                model.catalogLimits?.maxTokens ?? model.limits.maxTokens,
                                model.limits.contextWindow
                              )
                            ).map((value) => (
                              <option key={value} value={value}>
                                {formatTokens(value)}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <span
                          className="w-40 truncate type-caption text-ink-muted"
                          title={capabilityCells(model, t)}
                        >
                          {capabilityCells(model, t)}
                        </span>
                      </SettingsTableRow>
                    ))
                  )}
                </div>
              </SettingsTable>
              <span className="type-caption text-ink-muted">{t('modelContextHint')}</span>
              <span className="type-caption text-ink-muted">{t('modelMaxTokensHint')}</span>
            </div>
          )}
        </>
      )}

      <div className="flex flex-col gap-3 border-t border-rule-divide pt-3">
        <Field
          label={t('providerAutoRefreshCatalog')}
          hint={t('providerAutoRefreshCatalogHint')}
          htmlFor="auto-refresh-catalog"
        >
          <label className="flex h-8 items-center gap-2 type-value text-ink">
            <input
              id="auto-refresh-catalog"
              type="checkbox"
              className="h-3 w-3 accent-[rgb(var(--accent))]"
              checked={!offline && autoRefreshCatalog}
              disabled={offline}
              onChange={(event) => handleAutoRefreshChange(event.target.checked)}
            />
            {offline
              ? t('providerCatalogOffline')
              : autoRefreshCatalog
                ? t('providerAutoRefreshCatalogOn')
                : t('providerAutoRefreshCatalogOff')}
          </label>
        </Field>

        {directorySummary && (
          <p className="m-0 type-caption text-ink-muted">{directorySummary}</p>
        )}

        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            loading={refreshing}
            disabled={offline}
            onClick={() => void handleRefresh()}
          >
            {t('providerRefreshCatalog')}
          </Button>
        </div>
      </div>
    </div>
  )
}
