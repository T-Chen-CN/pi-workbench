import React, { useState, useEffect } from 'react'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { toast } from '../store/toastStore'
import type { ApiConfig, ApiProvider } from '../types/electron'

const DEFAULT_URLS: Record<ApiProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  custom: '',
}

interface SettingsProps {
  onClose?: () => void
}

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
  const { language, setLanguage, t } = useI18nStore()

  const [apiConfig, setApiConfig] = useState<ApiConfig>({
    provider: 'anthropic',
    apiUrl: DEFAULT_URLS.anthropic,
    apiKey: '',
    availableModels: [],
    selectedModel: ''
  })

  const [isSaving, setIsSaving] = useState(false)
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')

  useEffect(() => {
    loadApiConfig()
  }, [])

  const loadApiConfig = async () => {
    try {
      const result = await api.apiConfigGet()
      if (result.success && result.config) {
        setApiConfig(result.config)
      }
    } catch (error) {
      console.error('[Settings] Failed to load API config:', error)
      toast.error('Failed to load API configuration')
    }
  }

  const handleProviderChange = (provider: ApiProvider) => {
    setApiConfig(prev => ({
      ...prev,
      provider,
      apiUrl: DEFAULT_URLS[provider],
      availableModels: [],  // 切换供应商后必须重新拉取
      selectedModel: ''
    }))
    setSaveStatus('idle')
  }

  const handleFetchModels = async () => {
    if (!apiConfig.apiUrl.trim()) {
      toast.error('Please enter API URL first')
      return
    }
    if (!apiConfig.apiKey) {
      toast.error('Please enter API Key first')
      return
    }

    setIsFetchingModels(true)
    try {
      const result = await api.apiConfigFetchModels(
        apiConfig.apiUrl,
        apiConfig.apiKey,
        apiConfig.provider
      )

      if (result.success && result.models && result.models.length > 0) {
        setApiConfig(prev => ({
          ...prev,
          availableModels: result.models!,
          selectedModel: result.models!.includes(prev.selectedModel)
            ? prev.selectedModel
            : result.models![0]
        }))
        toast.success(`Fetched ${result.models.length} models`)
      } else if (result.success) {
        toast.warning('The API returned an empty model list')
      } else {
        toast.error(`Failed to fetch models: ${result.error || 'Unknown error'}`)
      }
    } catch (error) {
      console.error('[Settings] Fetch models error:', error)
      toast.error('Failed to fetch models: ' + String(error))
    } finally {
      setIsFetchingModels(false)
    }
  }

  const handleSaveConfig = async () => {
    if (!apiConfig.apiKey) {
      toast.error('API Key is required')
      return
    }
    if (!apiConfig.selectedModel) {
      toast.error('Please fetch and select a model first')
      return
    }

    setIsSaving(true)
    setSaveStatus('idle')

    try {
      const result = await api.apiConfigSave(apiConfig)
      if (result.success) {
        setSaveStatus('success')
        toast.success('API configuration saved')
        // 通知 ChatPanel 用新配置重新初始化 Agent
        window.dispatchEvent(new CustomEvent('api-config-saved'))
        setTimeout(() => setSaveStatus('idle'), 2000)
      } else {
        setSaveStatus('error')
        toast.error(result.error || 'Failed to save configuration')
      }
    } catch (error) {
      console.error('[Settings] Save config error:', error)
      setSaveStatus('error')
      toast.error('Failed to save configuration: ' + String(error))
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
            title="Close"
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
          onChange={(e) => setLanguage(e.target.value as 'zh' | 'en')}
          className="bg-gray-800 text-gray-100 px-4 py-2 rounded border border-gray-700 focus:outline-none focus:border-blue-500"
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </div>

      {/* API Configuration */}
      <div className="mb-8 border-t border-gray-700 pt-6">
        <h3 className="text-lg font-semibold mb-3">API Configuration</h3>
        <p className="text-sm text-gray-400 mb-4">
          Configure AI model provider. Supports Anthropic, OpenAI, and OpenAI-compatible APIs.
        </p>

        {/* Provider Selection */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">Provider</label>
          <select
            value={apiConfig.provider}
            onChange={(e) => handleProviderChange(e.target.value as ApiProvider)}
            className="w-full bg-gray-800 text-gray-100 px-4 py-2 rounded border border-gray-700 focus:outline-none focus:border-blue-500"
          >
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (GPT)</option>
            <option value="custom">Custom (OpenAI-compatible)</option>
          </select>
        </div>

        {/* API URL */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">
            API URL
            <span className="text-gray-500 text-xs ml-2">(Base endpoint, e.g. https://api.deepseek.com/v1)</span>
          </label>
          <input
            type="text"
            value={apiConfig.apiUrl}
            onChange={(e) => setApiConfig(prev => ({ ...prev, apiUrl: e.target.value }))}
            placeholder="https://api.anthropic.com/v1"
            className="w-full bg-gray-800 text-gray-100 px-4 py-2 rounded border border-gray-700 focus:outline-none focus:border-blue-500 font-mono text-sm"
          />
        </div>

        {/* API Key */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">
            API Key
            <span className="text-gray-500 text-xs ml-2">(Encrypted at rest on desktop)</span>
          </label>
          <input
            type="password"
            value={apiConfig.apiKey}
            onChange={(e) => setApiConfig(prev => ({ ...prev, apiKey: e.target.value }))}
            placeholder="sk-ant-... or sk-..."
            className="w-full bg-gray-800 text-gray-100 px-4 py-2 rounded border border-gray-700 focus:outline-none focus:border-blue-500 font-mono text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            {apiConfig.provider === 'anthropic' && (
              <>Get from <a href="https://console.anthropic.com/" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">console.anthropic.com</a></>
            )}
            {apiConfig.provider === 'openai' && (
              <>Get from <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">platform.openai.com</a></>
            )}
            {apiConfig.provider === 'custom' && 'Enter your custom API key'}
          </p>
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
            {isFetchingModels ? 'Fetching...' : 'Fetch Available Models'}
          </button>
          <p className="text-xs text-gray-500 mt-1">
            Retrieves the model list from {apiConfig.apiUrl || 'the API'}/models
          </p>
        </div>

        {/* Model Selection */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">
            Model
            <span className="text-gray-500 text-xs ml-2">
              ({apiConfig.availableModels.length} available)
            </span>
          </label>
          <select
            value={apiConfig.selectedModel}
            onChange={(e) => setApiConfig(prev => ({ ...prev, selectedModel: e.target.value }))}
            disabled={apiConfig.availableModels.length === 0}
            className="w-full bg-gray-800 text-gray-100 px-4 py-2 rounded border border-gray-700 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {apiConfig.availableModels.length === 0 ? (
              <option value="">No models available - fetch first</option>
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
            {isSaving ? 'Saving...' : 'Save Configuration'}
          </button>

          {saveStatus === 'success' && (
            <span className="text-green-400 text-sm">✓ Saved successfully</span>
          )}
          {saveStatus === 'error' && (
            <span className="text-red-400 text-sm">✗ Failed to save</span>
          )}
        </div>
      </div>

      {/* Application Info */}
      <div className="border-t border-gray-700 pt-6">
        <h3 className="text-lg font-semibold mb-3">Application Info</h3>
        <div className="text-sm text-gray-400 space-y-1">
          <p>Version: 0.1.0 (Phase 1 Complete)</p>
          <p>Framework: Electron 44 + React 19</p>
          <p>Architecture: Portable (self-contained)</p>
          <p>API Support: Anthropic, OpenAI, Custom</p>
        </div>
      </div>
    </div>
  )
}
