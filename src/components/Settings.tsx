import React, { useState, useEffect } from 'react'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { useErrorStore } from '../store/errorStore'

export const Settings: React.FC = () => {
  const { language, setLanguage, t } = useI18nStore()
  const { addError } = useErrorStore()
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({
    anthropic: '',
  })
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')

  useEffect(() => {
    loadApiKeys()
  }, [])

  const loadApiKeys = async () => {
    try {
      const result = await api.apiKeysGet()
      if (result.success && result.apiKeys) {
        setApiKeys(result.apiKeys)
      }
    } catch (error) {
      console.error('Failed to load API keys:', error)
      addError('Failed to load API keys')
    }
  }

  const handleApiKeyChange = (provider: string, value: string) => {
    setApiKeys(prev => ({
      ...prev,
      [provider]: value,
    }))
    setSaveStatus('idle')
  }

  const handleSaveApiKeys = async () => {
    setIsSaving(true)
    setSaveStatus('idle')

    try {
      const result = await api.apiKeysSave(apiKeys)
      if (result.success) {
        setSaveStatus('success')
        setTimeout(() => setSaveStatus('idle'), 2000)
      } else {
        setSaveStatus('error')
        addError(result.error || 'Failed to save API keys')
      }
    } catch (error) {
      console.error('Failed to save API keys:', error)
      setSaveStatus('error')
      addError('Failed to save API keys')
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

      {/* API Keys Configuration */}
      <div className="mb-8 border-t border-gray-700 pt-6">
        <h3 className="text-lg font-semibold mb-3">API Keys Configuration</h3>
        <p className="text-sm text-gray-400 mb-4">
          Configure API keys for AI providers. Keys are encrypted and stored locally in the application directory.
        </p>

        {/* Anthropic API Key */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">
            Anthropic API Key
            <span className="text-gray-500 text-xs ml-2">(Required for Pi Agent)</span>
          </label>
          <input
            type="password"
            value={apiKeys.anthropic || ''}
            onChange={(e) => handleApiKeyChange('anthropic', e.target.value)}
            placeholder="sk-ant-..."
            className="w-full bg-gray-800 text-gray-100 px-4 py-2 rounded border border-gray-700 focus:outline-none focus:border-blue-500 font-mono text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            Get your API key from{' '}
            <a
              href="https://console.anthropic.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            >
              console.anthropic.com
            </a>
          </p>
        </div>

        {/* Save Button */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSaveApiKeys}
            disabled={isSaving}
            className={`px-6 py-2 rounded font-medium transition-colors ${
              isSaving
                ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {isSaving ? 'Saving...' : 'Save API Keys'}
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
          <p>Version: 0.1.0 (MVP)</p>
          <p>Framework: Electron 28 + React 19</p>
          <p>Architecture: Portable (self-contained)</p>
        </div>
      </div>
    </div>
  )
}
