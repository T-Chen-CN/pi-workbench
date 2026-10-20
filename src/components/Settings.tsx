import React, { useCallback, useEffect, useState } from 'react'
import { Info, KeyRound, RefreshCw, Save, SlidersHorizontal } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useThemeStore, type ThemeMode } from '../store/themeStore'
import { api } from '../api'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import type { ApiConfig } from '../types/electron'
import { Button, Field, Input, Select } from './ui'

type Section = 'general' | 'api' | 'about'

interface SettingsProps {
  onClose?: () => void
}

export const Settings: React.FC<SettingsProps> = () => {
  const { language, setLanguage, t } = useI18nStore()
  const { mode, setMode } = useThemeStore()
  const [section, setSection] = useState<Section>('general')

  const [apiConfig, setApiConfig] = useState<ApiConfig>({
    provider: 'custom',
    apiUrl: '',
    apiKey: '',
    availableModels: [],
    selectedModel: '',
  })

  const [isSaving, setIsSaving] = useState(false)
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')

  type UpdateState = {
    status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'latest' | 'error'
    version?: string
    percent?: number
    error?: string
  }
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })

  useEffect(() => {
    return api.onUpdateStatus((status) => {
      if (status.type === 'checking') {
        setUpdateState({ status: 'checking' })
      } else if (status.type === 'available') {
        setUpdateState({ status: 'available', version: status.version })
      } else if (status.type === 'not-available') {
        setUpdateState({ status: 'latest' })
      } else if (status.type === 'error') {
        setUpdateState({ status: 'error', error: status.message })
      } else if (status.type === 'download-progress') {
        setUpdateState({ status: 'downloading', percent: Math.round(status.percent) })
      } else if (status.type === 'downloaded') {
        setUpdateState({ status: 'downloaded', version: status.version })
      }
    })
  }, [])

  const handleCheckUpdate = async () => {
    setUpdateState({ status: 'checking' })
    const result = await api.updateCheck()
    if (!result.success) {
      setUpdateState({ status: 'error', error: result.error })
    } else if (result.update) {
      setUpdateState({ status: 'available', version: result.update.version })
    } else {
      setUpdateState({ status: 'latest' })
    }
  }

  const handleDownloadUpdate = async () => {
    setUpdateState({ status: 'downloading', percent: 0 })
    const result = await api.updateDownload()
    if (!result.success) {
      setUpdateState({ status: 'error', error: result.error })
    }
  }

  const updateStatusText = (() => {
    switch (updateState.status) {
      case 'checking':
        return t('checkingUpdates')
      case 'available':
        return t('updateAvailable', { version: updateState.version ?? '' })
      case 'downloading':
        return t('updateDownloading', { percent: updateState.percent ?? 0 })
      case 'downloaded':
        return t('updateDownloaded')
      case 'latest':
        return t('updateLatest')
      case 'error':
        return t('updateFailed', { error: localizeError(updateState.error) || t('unknownError') })
      default:
        return ''
    }
  })()

  const persistSettings = async (patch: Record<string, unknown>) => {
    try {
      const current = await api.getSettings()
      const settings = current.success && current.settings ? current.settings : {}
      await api.saveSettings({ ...settings, ...patch })
    } catch (error) {
      console.error('Failed to persist settings:', error)
    }
  }

  const handleLanguageChange = (next: 'zh' | 'en') => {
    setLanguage(next)
    void persistSettings({ language: next })
  }

  const handleThemeChange = (next: ThemeMode) => {
    setMode(next)
    void persistSettings({ theme: next })
  }

  const loadApiConfig = useCallback(async () => {
    try {
      const result = await api.apiConfigGet()
      if (result.success && result.config) {
        // 只支持 OpenAI 兼容渠道，旧配置一律按兼容模式处理
        setApiConfig({ ...result.config, provider: 'custom' })
      }
    } catch (error) {
      console.error('[Settings] Failed to load API config:', error)
      toast.error(t('loadApiConfigFailed'))
    }
  }, [t])

  useEffect(() => {
    void loadApiConfig()
  }, [loadApiConfig])

  const handleFetchModels = async () => {
    if (!apiConfig.apiUrl.trim()) {
      toast.error(t('enterApiUrlFirst'))
      return
    }
    if (!apiConfig.apiKey) {
      toast.error(t('enterApiKeyFirst'))
      return
    }

    setIsFetchingModels(true)
    try {
      const result = await api.apiConfigFetchModels(apiConfig.apiUrl, apiConfig.apiKey, 'custom')

      if (result.success && result.models && result.models.length > 0) {
        setApiConfig((prev) => ({
          ...prev,
          availableModels: result.models!,
          selectedModel: result.models!.includes(prev.selectedModel)
            ? prev.selectedModel
            : result.models![0],
        }))
        toast.success(t('fetchedModels', { count: result.models.length }))
      } else if (result.success) {
        toast.warning(t('emptyModelList'))
      } else {
        toast.error(
          t('fetchModelsFailed', { error: localizeError(result.error) || t('unknownError') })
        )
      }
    } catch (error) {
      console.error('[Settings] Fetch models error:', error)
      toast.error(t('fetchModelsFailed', { error: localizeError(String(error)) }))
    } finally {
      setIsFetchingModels(false)
    }
  }

  const handleSaveConfig = async () => {
    if (!apiConfig.apiKey) {
      toast.error(t('apiKeyRequired'))
      return
    }
    if (!apiConfig.selectedModel) {
      toast.error(t('selectModelFirst'))
      return
    }

    setIsSaving(true)
    setSaveStatus('idle')

    try {
      const result = await api.apiConfigSave(apiConfig)
      if (result.success) {
        setSaveStatus('success')
        toast.success(t('apiConfigSaved'))
        // 通知 ChatPanel 用新配置重新初始化 Agent
        window.dispatchEvent(new CustomEvent('api-config-saved'))
        setTimeout(() => setSaveStatus('idle'), 2000)
      } else {
        setSaveStatus('error')
        toast.error(t('saveConfigFailed', { error: localizeError(result.error) || t('unknownError') }))
      }
    } catch (error) {
      console.error('[Settings] Save config error:', error)
      setSaveStatus('error')
      toast.error(t('saveConfigFailed', { error: localizeError(String(error)) }))
    } finally {
      setIsSaving(false)
    }
  }

  const navItems: Array<{ id: Section; label: string; icon: typeof Info }> = [
    { id: 'general', label: t('general'), icon: SlidersHorizontal },
    { id: 'api', label: t('apiConfiguration'), icon: KeyRound },
    { id: 'about', label: t('about'), icon: Info },
  ]

  return (
    <div className="flex min-h-[420px]">
      {/* Section nav */}
      <nav className="w-40 flex-shrink-0 border-r border-line bg-surface p-2">
        <div className="flex flex-col gap-0.5">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              className={`flex items-center gap-2 border-l-2 px-2.5 py-1.5 text-left font-mono text-[10px] uppercase tracking-[0.1em] transition-colors ${
                section === id
                  ? 'border-accent bg-accent/[0.06] text-ink'
                  : 'border-transparent text-ink-muted hover:bg-hover hover:text-ink'
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        {section === 'general' && (
          <div className="flex max-w-sm flex-col gap-5">
            <Field label={t('language')}>
              <Select
                value={language}
                onChange={(e) => handleLanguageChange(e.target.value as 'zh' | 'en')}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </Select>
            </Field>

            <Field label={t('theme')}>
              <Select
                value={mode}
                onChange={(e) => handleThemeChange(e.target.value as ThemeMode)}
              >
                <option value="system">{t('themeSystem')}</option>
                <option value="dark">{t('themeDark')}</option>
                <option value="light">{t('themeLight')}</option>
              </Select>
            </Field>
          </div>
        )}

        {section === 'api' && (
          <div className="flex max-w-lg flex-col gap-4">
            <p className="m-0 font-reading text-[13px] leading-[1.75] text-ink-muted">
              {t('apiConfigurationDesc')}
            </p>

            <Field label={t('apiUrl')}>
              <Input
                type="text"
                value={apiConfig.apiUrl}
                onChange={(e) => setApiConfig((prev) => ({ ...prev, apiUrl: e.target.value }))}
                placeholder="https://your-api-endpoint/v1"
                className="font-mono"
              />
            </Field>

            <Field label={t('apiKey')} hint={t('apiKeyHint')}>
              <Input
                type="password"
                value={apiConfig.apiKey}
                onChange={(e) => setApiConfig((prev) => ({ ...prev, apiKey: e.target.value }))}
                placeholder="sk-..."
                className="font-mono"
              />
            </Field>

            <div>
              <Button
                variant="secondary"
                size="sm"
                icon={RefreshCw}
                loading={isFetchingModels}
                onClick={() => void handleFetchModels()}
              >
                {isFetchingModels ? t('fetching') : t('fetchModels')}
              </Button>
            </div>

            <Field
              label={t('model')}
              hint={t('modelsAvailable', { count: apiConfig.availableModels.length })}
            >
              <Select
                value={apiConfig.selectedModel}
                onChange={(e) =>
                  setApiConfig((prev) => ({ ...prev, selectedModel: e.target.value }))
                }
                disabled={apiConfig.availableModels.length === 0}
              >
                {apiConfig.availableModels.length === 0 ? (
                  <option value="">{t('noModelsAvailable')}</option>
                ) : (
                  apiConfig.availableModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))
                )}
              </Select>
            </Field>

            <div className="mt-1 flex items-center gap-3">
              <Button
                variant="primary"
                size="sm"
                icon={Save}
                loading={isSaving}
                onClick={() => void handleSaveConfig()}
              >
                {isSaving ? t('saving') : t('saveConfiguration')}
              </Button>
              {saveStatus === 'success' && (
                <span className="text-xs text-success">{t('savedSuccessfully')}</span>
              )}
              {saveStatus === 'error' && (
                <span className="text-xs text-danger">{t('saveFailedShort')}</span>
              )}
            </div>
          </div>
        )}

        {section === 'about' && (
          <div className="flex max-w-lg flex-col gap-3 text-xs text-ink-muted">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center border border-line bg-raised font-display text-xl text-accent">
                Pi
              </div>
              <div>
                <p className="m-0 text-sm font-medium text-ink">Pi Workbench</p>
                <p className="m-0 text-ink-subtle">{t('infoVersion')}</p>
              </div>
            </div>
            <dl className="m-0 mt-2 grid grid-cols-[120px_1fr] gap-x-3 gap-y-2">
              <dt className="text-ink-subtle">{t('aboutFramework')}</dt>
              <dd className="m-0 text-ink">{t('infoFramework')}</dd>
              <dt className="text-ink-subtle">{t('aboutArchitecture')}</dt>
              <dd className="m-0 text-ink">{t('infoArchitecture')}</dd>
              <dt className="text-ink-subtle">{t('aboutApiSupport')}</dt>
              <dd className="m-0 text-ink">{t('infoApiSupport')}</dd>
            </dl>

            <div className="mt-4 border-t border-line pt-4">
              <p className="m-0 text-xs text-ink-subtle">{t('updates')}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {(updateState.status === 'idle' ||
                  updateState.status === 'latest' ||
                  updateState.status === 'error') && (
                  <Button size="sm" icon={RefreshCw} onClick={() => void handleCheckUpdate()}>
                    {t('checkForUpdates')}
                  </Button>
                )}
                {updateState.status === 'available' && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleDownloadUpdate()}
                  >
                    {t('downloadUpdate')}
                  </Button>
                )}
                {updateState.status === 'downloaded' && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void api.updateInstall()}
                  >
                    {t('restartToInstall')}
                  </Button>
                )}
                {updateStatusText && (
                  <span
                    className={
                      updateState.status === 'error' ? 'text-xs text-danger' : 'text-xs text-ink-muted'
                    }
                  >
                    {updateStatusText}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
