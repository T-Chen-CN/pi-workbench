import React, { useState, useEffect, useCallback } from 'react'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import type { ApiConfig } from '../types/electron'

interface SettingsProps {
  onClose?: () => void
}

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
  const { language, setLanguage, t } = useI18nStore()

  const handleLanguageChange = async (next: 'zh' | 'en') => {
    setLanguage(next)
    try {
      const current = await api.getSettings()
      const settings = current.success && current.settings ? current.settings : {}
      await api.saveSettings({ ...settings, language: next })
    } catch (error) {
      console.error('Failed to persist language setting:', error)
    }
  }

  const [apiConfig, setApiConfig] = useState<ApiConfig>({
    provider: 'custom',
    apiUrl: '',
    apiKey: '',
    availableModels: [],
    selectedModel: ''
  })

  const [isSaving, setIsSaving] = useState(false)
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')

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
      const result = await api.apiConfigFetchModels(
        apiConfig.apiUrl,
        apiConfig.apiKey,
        'custom'
      )

      if (result.success && result.models && result.models.length > 0) {
        setApiConfig(prev => ({
          ...prev,
          availableModels: result.models!,
          selectedModel: result.models!.includes(prev.selectedModel)
            ? prev.selectedModel
            : result.models![0]
        }))
        toast.success(t('fetchedModels', { count: result.models.length }))
      } else if (result.success) {
        toast.warning(t('emptyModelList'))
      } else {
        toast.error(t('fetchModelsFailed', { error: localizeError(result.error) || t('unknownError') }))
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

  return (
    <div className="p-6 bg-gray-900 text-gray-100 h-full overflow-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">{t('settings')}</h2>
        {onClose && (
          <button
            onClick={onClose}
            className="bg-none border-none text-gray-400 hover:text-gray-100 text-2xl cursor-pointer p-1"
            title={t('close')}
          >
            ×
          </button>
        )}
      </div>

      {/* Language Settings */}
      <div className="mb-8">
        <h3 className="text-lg font-semibold mb-3">{t('language')}</h3>
        <select
          value={language}
          onChange={(e) => void handleLanguageChange(e.target.value as 'zh' | 'en')}
          className="bg-gray-800 text-gray-100 px-4 py-2 rounded border border-gray-700 focus:outline-none focus:border-blue-500"
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </div>

      {/* API Configuration */}
      <div className="mb-8 border-t border-gray-700 pt-6">
        <h3 className="text-lg font-semibold mb-3">{t('apiConfiguration')}</h3>
        <p className="text-sm text-gray-400 mb-4">
          {t('apiConfigurationDesc')}
        </p>

        {/* API URL */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">
            {t('apiUrl')}
          </label>
          <input
            type="text"
            value={apiConfig.apiUrl}
            onChange={(e) => setApiConfig(prev => ({ ...prev, apiUrl: e.target.value }))}
            placeholder="https://your-api-endpoint/v1"
            className="w-full bg-gray-800 text-gray-100 px-4 py-2 rounded border border-gray-700 focus:outline-none focus:border-blue-500 font-mono text-sm"
          />
        </div>

        {/* API Key */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">
            {t('apiKey')}
            <span className="text-gray-500 text-xs ml-2">{t('apiKeyHint')}</span>
          </label>
          <input
            type="password"
            value={apiConfig.apiKey}
            onChange={(e) => setApiConfig(prev => ({ ...prev, apiKey: e.target.value }))}
            placeholder="sk-..."
            className="w-full bg-gray-800 text-gray-100 px-4 py-2 rounded border border-gray-700 focus:outline-none focus:border-blue-500 font-mono text-sm"
          />
        </div>

        {/* Fetch Models Button */}
        <div className="mb-4">
          <button
            onClick={handleFetchModels}
            disabled={isFetchingModels}
            className={`px-4 py-2 rounded font-medium transition-colors ${
              isFetchingModels
                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-700 text-white'
            }`}
          >
            {isFetchingModels ? t('fetching') : t('fetchModels')}
          </button>
        </div>

        {/* Model Selection */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">
            {t('model')}
            <span className="text-gray-500 text-xs ml-2">
              {t('modelsAvailable', { count: apiConfig.availableModels.length })}
            </span>
          </label>
          <select
            value={apiConfig.selectedModel}
            onChange={(e) => setApiConfig(prev => ({ ...prev, selectedModel: e.target.value }))}
            disabled={apiConfig.availableModels.length === 0}
            className="w-full bg-gray-800 text-gray-100 px-4 py-2 rounded border border-gray-700 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {apiConfig.availableModels.length === 0 ? (
              <option value="">{t('noModelsAvailable')}</option>
            ) : (
              apiConfig.availableModels.map(model => (
                <option key={model} value={model}>{model}</option>
              ))
            )}
          </select>
        </div>

        {/* Save Button */}
        <div className="flex items-center gap-3 mt-6">
          <button
            onClick={handleSaveConfig}
            disabled={isSaving}
            className={`px-6 py-2 rounded font-medium transition-colors ${
              isSaving
                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {isSaving ? t('saving') : t('saveConfiguration')}
          </button>

          {saveStatus === 'success' && (
            <span className="text-green-400 text-sm">{t('savedSuccessfully')}</span>
          )}
          {saveStatus === 'error' && (
            <span className="text-red-400 text-sm">{t('saveFailedShort')}</span>
          )}
        </div>
      </div>

      {/* Application Info */}
      <div className="border-t border-gray-700 pt-6">
        <h3 className="text-lg font-semibold mb-3">{t('applicationInfo')}</h3>
        <div className="text-sm text-gray-400 space-y-1">
          <p>{t('infoVersion')}</p>
          <p>{t('infoFramework')}</p>
          <p>{t('infoArchitecture')}</p>
          <p>{t('infoApiSupport')}</p>
        </div>
      </div>
    </div>
  )
}
