/**
 * 供应商设置：8 家固定预设 + 凭证登录 + 模型能力表。
 *
 * 三条硬约束（见 docs/architecture/provider-presets.md）：
 * 1. 模型能力只展示 catalog 可读字段，应用不维护第二份真值；
 * 2. 上下文窗口 / 输出上限只能向下调，按模型存，超上限由主进程夹住；
 * 3. 任何接口都不回传密钥，UI 只知道「已连接 / 未连接」和凭证类型。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import type {
  ProviderAuthMethod,
  ProviderModelOverrides,
  ProviderModelView,
  ProviderView
} from '../types/electron'
import { api } from '../api'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import { emitAppEvent } from '../utils/appEvents'
import { Button, Field, Input, Select } from './ui'
import { SettingsTable, SettingsTableRow } from './patterns'
import { ProviderAuthPanel } from './ProviderAuthPanel'

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

function capabilityCells(
  model: ProviderModelView,
  t: (key: Parameters<ReturnType<typeof useI18nStore.getState>['t']>[0]) => string
) {
  const parts = [
    `${t('modelContextColumn')} ${formatTokens(model.limits.contextWindow)}`,
    `${t('modelMaxTokensColumn')} ${formatTokens(model.limits.maxTokens)}`,
    model.reasoning ? t('providerReasoningYes') : t('providerReasoningNo'),
    model.vision ? t('providerVisionYes') : t('providerVisionNo')
  ]
  return parts.join(' · ')
}

export function ProviderSettings() {
  const t = useI18nStore((store) => store.t)
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [activeProvider, setActiveProvider] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const result = await api.providersList()
      if (!result.success || !result.providers) {
        toast.error(t('loadProvidersFailed'))
        return
      }
      setProviders(result.providers)
      setActiveProvider(result.activeProvider ?? null)
      setSelectedId((current) => {
        if (current && result.providers!.some((provider) => provider.id === current)) return current
        return result.activeProvider ?? result.providers![0]?.id ?? null
      })
    } catch (error) {
      console.error('[Providers] load failed:', error)
      toast.error(t('loadProvidersFailed'))
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const selected = useMemo(
    () => providers.find((provider) => provider.id === selectedId) ?? null,
    [providers, selectedId]
  )

  const notifyAgent = () => {
    // 各工作区的 Agent 用新配置重建（会话本身不受影响）
    emitAppEvent('api-config-saved')
  }

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

  const oauthRefreshTimerRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (oauthRefreshTimerRef.current !== null) window.clearTimeout(oauthRefreshTimerRef.current)
    },
    []
  )

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
    // 登录结果通过 providers:auth-event 回来；成功后刷新列表
    if (oauthRefreshTimerRef.current !== null) window.clearTimeout(oauthRefreshTimerRef.current)
    oauthRefreshTimerRef.current = window.setTimeout(() => {
      oauthRefreshTimerRef.current = null
      void load().then(notifyAgent)
    }, 1500)
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

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const result = await api.providersRefresh(true)
      if (!result.success) {
        toast.error(
          t('providerRefreshFailed', {
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

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="m-0 type-reading text-ink-muted">{t('providerSettingsDesc')}</p>

      <Field label={t('providerLabel')}>
        <Select
          value={selectedId ?? ''}
          onChange={(event) => {
            setSelectedId(event.target.value)
            setApiKey('')
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
                        if (event.key === 'Enter') void handleSaveKey()
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

          {selected.models.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="type-label text-ink">{t('modelCapabilityTable')}</span>
              <SettingsTable
                columns={[
                  { label: t('modelColumn'), className: 'min-w-0 flex-1' },
                  { label: t('modelContextColumn'), className: 'w-24' },
                  { label: t('modelMaxTokensColumn'), className: 'w-24' },
                  { label: t('providerCapabilitiesColumn'), className: 'w-40' }
                ]}
              >
                <div className="max-h-72 overflow-y-auto">
                  {selected.models.map((model) => (
                    <SettingsTableRow key={model.id} selected={model.id === selected.model}>
                      <span
                        className="min-w-0 flex-1 truncate type-data text-ink"
                        title={model.id}
                      >
                        {model.id}
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
                          {limitOptions(model.limits.contextWindow).map((value) => (
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
                            Math.min(model.limits.maxTokens, model.limits.contextWindow)
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
                  ))}
                </div>
              </SettingsTable>
              <span className="type-caption text-ink-muted">{t('modelContextHint')}</span>
              <span className="type-caption text-ink-muted">{t('modelMaxTokensHint')}</span>
            </div>
          )}
        </>
      )}

      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          icon={RefreshCw}
          loading={refreshing}
          onClick={() => void handleRefresh()}
        >
          {t('providerRefreshCatalog')}
        </Button>
      </div>
    </div>
  )
}
