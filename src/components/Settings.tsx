import React, { useState, useEffect } from 'react'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { useErrorStore } from '../store/errorStore'
import type { ApiConfig, ApiProvider } from '../types/electron'

export const Settings: React.FC = () => {
  const { language, setLanguage, t } = useI18nStore()
  const { addError } = useErrorStore()

  const [apiConfig, setApiConfig] = useState<ApiConfig>({
    provider: 'anthropic',
    apiUrl: 'https://api.anthropic.com/v1',
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
      console.error('Failed to load API config:', error)
      addError('Failed to load API configuration')
    }
  }

  const handleProviderChange = (provider: ApiProvider) => {
    // Update URL based on provider
    let defaultUrl = ''
    let defaultModels: string[] = []

    switch (provider) {
      case 'anthropic':
        defaultUrl = 'https://api.anthropic.com/v1'
        defaultModels = ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229']
        break
      case 'openai':
        defaultUrl = 'https://api.openai.com/v1'
        defaultModels = ['gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo']
        break
      case 'custom':
        defaultUrl = 'https://your-api-endpoint.com/v1'
        defaultModels = []
        break
    }

    setApiConfig(prev => ({
      ...prev,
      provider,
      apiUrl: defaultUrl,
      availableModels: defaultModels,
      selectedModel: defaultModels[0] || ''
    }))
    setSaveStatus('idle')
  }

  const handleFetchModels = async () => {
    if (!apiConfig.apiKey) {
      addError('Please enter API key first')
      return
    }

    setIsFetchingModels(true)
    try {
      const result = await api.apiConfigFetchModels(
        apiConfig.apiUrl,
        apiConfig.apiKey,
        apiConfig.provider
      )

      if (result.success && result.models) {
        setApiConfig(prev => ({
          ...prev,
          availableModels: result.models!,
          selectedModel: result.models![0] || ''
        }))
        addError('Models fetched successfully')
      } else {
        addError(result.error || 'Failed to fetch models')
      }
    } catch (error) {
      console.error('Failed to fetch models:', error)
      addError('Failed to fetch models')
    } finally {
      setIsFetchingModels(false)
    }
  }

  const handleSaveConfig = async () => {
    if (!apiConfig.apiKey) {
      addError('API key is required')
      return
    }

    if (!apiConfig.selectedModel) {
      addError('Please select a model')
      return
    }

    setIsSaving(true)
    setSaveStatus('idle')

    try {
      const result = await api.apiConfigSave(apiConfig)
      if (result.success) {
        setSaveStatus('success')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } else {
        setSaveStatus('error')
        addError(result.error || 'Failed to save configuration')
      }
    } catch (error) {
      console.error('Failed to save config:', error)
      setSaveStatus('error')
      addError('Failed to save configuration')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="p-6 bg-gray-900 text-gray-100 h-full overflow-auto">
      <h2 className="text-2xl font-bold mb-6">{t('settings.title')}</h2>

      {/* Language Settings */}
      <div className="mb-8">
        <h3 className="text-lg font-semibold mb-3">{t('settings.language')}</h3>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value as 'zh-CN' | 'en')}
          className="bg-gray-800 text-gray-100 px-4 py-2 rounded border border-gray-700 focus:outline-none focus:border-blue-500"
        >
          <option value="zh-CN">中文</option>
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
            <span className="text-gray-500 text-xs ml-2">(Base endpoint)</span>
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
            <span className="text-gray-500 text-xs ml-2">(Encrypted storage)</span>
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
            disabled={isFetchingModels || !apiConfig.apiKey}
            className={`px-4 py-2 rounded font-medium transition-colors ${
              isFetchingModels || !apiConfig.apiKey
                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                : 'bg-green-600 hover:bg-green-700 text-white'
            }`}
          >
            {isFetchingModels ? 'Fetching...' : 'Fetch Available Models'}
          </button>
          <p className="text-xs text-gray-500 mt-1">
            Click to retrieve available models from the API
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
          <p>Framework: Electron 28 + React 19</p>
          <p>Architecture: Portable (self-contained)</p>
          <p>API Support: Anthropic, OpenAI, Custom</p>
        </div>
      </div>
    </div>
  )
}
