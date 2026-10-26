import React, { useCallback, useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { api } from '../api'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import { emitAppEvent } from '../utils/appEvents'
import {
  WEB_SEARCH_PROVIDER_OPTIONS,
  findWebSearchProvider,
} from '../utils/webSearchProviders'
import type { WebSearchConfig, WebSearchProviderId } from '../types/electron'
import { Button, Field, Input, Select } from './ui'

const EMPTY_CONFIG: WebSearchConfig = { provider: null, endpoint: 'china', keys: {} }

/**
 * 联网搜索配置（设置页）。
 * 同一时刻只启用一家来源；已保存的 Key 在切换时保留，只是不再下发。
 */
export const WebSearchSettings: React.FC = () => {
  const { t } = useI18nStore()
  const [config, setConfig] = useState<WebSearchConfig>(EMPTY_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const result = await api.webSearchGet()
      if (result.success && result.config) setConfig(result.config)
    } catch (error) {
      console.error('[WebSearchSettings] Failed to load config:', error)
      toast.error(t('webSearchLoadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const selected = config.provider
    ? findWebSearchProvider(config.provider)
    : undefined

  const selectProvider = (provider: WebSearchProviderId | null) => {
    setConfig((prev) => ({ ...prev, provider }))
  }

  const updateKey = (provider: WebSearchProviderId, value: string) => {
    setConfig((prev) => ({
      ...prev,
      keys: { ...prev.keys, [provider]: value },
    }))
  }

  const handleSave = async () => {
    if (selected?.requiresKey && !config.keys[selected.id]?.trim()) {
      toast.error(t('webSearchKeyRequired'))
      return
    }
    setSaving(true)
    try {
      const result = await api.webSearchSave(config)
      if (result.success) {
        toast.success(t('webSearchSaved'))
        emitAppEvent('web-search-saved')
      } else {
        toast.error(
          t('webSearchSaveFailed', {
            error: localizeError(result.error) || t('unknownError'),
          })
        )
      }
    } catch (error) {
      console.error('[WebSearchSettings] Save failed:', error)
      toast.error(t('webSearchSaveFailed', { error: localizeError(String(error)) }))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <p className="m-0 type-value text-ink-muted">{t('loading')}</p>
  }

  return (
    <div className="flex max-w-lg flex-col gap-4">
      <p className="m-0 type-reading text-ink-muted">{t('webSearchDesc')}</p>

      <Field label={t('webSearchProviderLabel')} hint={t('webSearchProviderHint')}>
        <div className="border border-rule-hairline bg-raised">
          <label className="flex items-start gap-2 border-b border-rule-divide px-3 py-2">
            <input
              type="radio"
              name="web-search-provider"
              className="mt-0.5 h-3 w-3 flex-shrink-0 accent-[rgb(var(--accent))]"
              checked={config.provider === null}
              onChange={() => selectProvider(null)}
            />
            <span className="min-w-0 flex-1">
              <span className="block type-value text-ink">
                {t('webSearchProviderDefault')}
              </span>
              <span className="block type-caption text-ink-subtle">
                {t('webSearchDefaultHint')}
              </span>
            </span>
          </label>
          {WEB_SEARCH_PROVIDER_OPTIONS.map((provider) => (
            <label
              key={provider.id}
              className="flex items-start gap-2 border-b border-rule-divide px-3 py-2 last:border-b-0"
            >
              <input
                type="radio"
                name="web-search-provider"
                className="mt-0.5 h-3 w-3 flex-shrink-0 accent-[rgb(var(--accent))]"
                checked={config.provider === provider.id}
                onChange={() => selectProvider(provider.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block type-value text-ink">{t(provider.labelKey)}</span>
                <span className="block type-caption text-ink-subtle">{t(provider.noteKey)}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      {selected?.keyField && (
        <Field
          label={t('webSearchApiKey')}
          hint={t('webSearchApiKeyHint')}
          htmlFor="web-search-api-key"
        >
          <Input
            id="web-search-api-key"
            type="password"
            value={config.keys[selected.id] ?? ''}
            onChange={(event) => updateKey(selected.id, event.target.value)}
            placeholder={selected.requiresKey ? 'sk-...' : t('webSearchApiKeyOptional')}
            className="type-code"
          />
        </Field>
      )}

      {selected?.endpoint && (
        <Field label={t('webSearchEndpoint')} htmlFor="web-search-endpoint">
          <Select
            id="web-search-endpoint"
            value={config.endpoint}
            onChange={(event) =>
              setConfig((prev) => ({
                ...prev,
                endpoint: event.target.value === 'global' ? 'global' : 'china',
              }))
            }
          >
            <option value="china">{t('webSearchEndpointChina')}</option>
            <option value="global">{t('webSearchEndpointGlobal')}</option>
          </Select>
        </Field>
      )}

      <div className="flex items-center gap-3">
        <Button icon={Save} loading={saving} onClick={() => void handleSave()}>
          {saving ? t('saving') : t('webSearchSave')}
        </Button>
      </div>

      <p className="m-0 type-caption text-ink-muted">{t('webSearchRestartHint')}</p>
    </div>
  )
}
