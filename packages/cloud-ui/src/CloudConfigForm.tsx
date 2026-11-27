import React, { useMemo } from 'react'
import { translate, type Language } from '@pi-workbench/i18n'
import { Caption, Field, Input, Select } from '@pi-workbench/ui'
import { formatCloudTokens } from './format'
import { CLOUD_PROVIDER_PRESETS, type CloudCatalogModel } from './types'

export interface CloudConfigFormProps {
  providerId: string
  model: string
  apiKey: string
  apiKeyMasked?: string
  models: CloudCatalogModel[]
  fetching?: boolean
  feedback?: string
  feedbackTone?: 'info' | 'error'
  language?: Language
  idPrefix?: string
  /** 桌面弹窗把已保存掩码放在 Field hint；Web 卡片放在 Input placeholder */
  showMaskedKeyInHint?: boolean
  /** Web 卡片把模型计数拼在标签中；桌面弹窗放在 Field hint */
  showModelCountInLabel?: boolean
  /** 模型下拉项是否附加 `(id)` 后缀 */
  showModelIdInOption?: boolean
  onProviderChange: (providerId: string) => void
  onModelChange: (modelId: string) => void
  onApiKeyChange: (apiKey: string) => void
  actions?: React.ReactNode
  className?: string
}

/**
 * 桌面端 CloudView 弹窗与云端 Web 设置卡共用的云端模型配置表单：
 * 固定 8 家内置供应商白名单 + Pi catalog 模型探测与能力摘要 + API Key 加密轮换提示。
 */
export const CloudConfigForm: React.FC<CloudConfigFormProps> = ({
  providerId,
  model,
  apiKey,
  apiKeyMasked,
  models,
  fetching = false,
  feedback,
  feedbackTone = 'info',
  language = 'zh',
  idPrefix = 'cloud-config',
  showMaskedKeyInHint = false,
  showModelCountInLabel = false,
  showModelIdInOption = false,
  onProviderChange,
  onModelChange,
  onApiKeyChange,
  actions,
  className = '',
}) => {
  const selectedEntry = useMemo(
    () => models.find((entry) => entry.id === model) ?? models[0] ?? null,
    [models, model]
  )

  const capabilitySummary = useMemo(() => {
    if (!selectedEntry) return ''
    const parts: string[] = []
    if (selectedEntry.contextWindow) {
      parts.push(
        translate(language, 'cloudWebConfigContextShort', {
          tokens: formatCloudTokens(selectedEntry.contextWindow),
        })
      )
    }
    if (selectedEntry.maxTokens) {
      parts.push(
        translate(language, 'cloudWebConfigOutputShort', {
          tokens: formatCloudTokens(selectedEntry.maxTokens),
        })
      )
    }
    if (selectedEntry.reasoning !== undefined) {
      parts.push(
        translate(language, selectedEntry.reasoning ? 'providerReasoningYes' : 'providerReasoningNo')
      )
    }
    if (selectedEntry.vision !== undefined) {
      parts.push(
        translate(language, selectedEntry.vision ? 'providerVisionYes' : 'providerVisionNo')
      )
    }
    return parts.join(' · ')
  }, [selectedEntry, language])

  const maskedHintText = apiKeyMasked
    ? translate(language, 'cloudApiKeyHint', { mask: apiKeyMasked })
    : undefined

  const modelLabel = showModelCountInLabel
    ? translate(language, 'cloudWebConfigModelLabelWithCount', { count: models.length })
    : translate(language, 'cloudModel')

  const modelHint =
    !showModelCountInLabel && models.length > 0
      ? translate(language, 'cloudModelsHint', { count: models.length })
      : undefined

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      <Caption className="text-ink-muted">{translate(language, 'cloudConfigDesc')}</Caption>

      <Field label={translate(language, 'cloudProvider')} htmlFor={`${idPrefix}-provider`}>
        <Select
          id={`${idPrefix}-provider`}
          value={providerId}
          onChange={(event) => onProviderChange(event.target.value)}
        >
          {CLOUD_PROVIDER_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label={translate(language, 'cloudApiKey')}
        htmlFor={`${idPrefix}-api-key`}
        hint={showMaskedKeyInHint ? maskedHintText : undefined}
      >
        <Input
          id={`${idPrefix}-api-key`}
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder={!showMaskedKeyInHint && maskedHintText ? maskedHintText : 'sk-...'}
          onChange={(event) => onApiKeyChange(event.target.value)}
        />
      </Field>

      <Field label={modelLabel} htmlFor={`${idPrefix}-model`} hint={modelHint}>
        {models.length > 0 ? (
          <Select
            id={`${idPrefix}-model`}
            value={model || selectedEntry?.id || ''}
            onChange={(event) => onModelChange(event.target.value)}
          >
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {showModelIdInOption
                  ? entry.name
                    ? `${entry.name} (${entry.id})`
                    : entry.id
                  : entry.name || entry.id}
              </option>
            ))}
          </Select>
        ) : (
          <Caption className="text-ink-muted">
            {fetching
              ? translate(language, 'cloudFetchingModels')
              : translate(language, 'cloudNoCatalogModels')}
          </Caption>
        )}
      </Field>

      {capabilitySummary && <Caption className="text-ink-muted">{capabilitySummary}</Caption>}

      {feedback && (
        <Caption className={feedbackTone === 'error' ? 'text-danger' : 'text-accent'}>
          {feedback}
        </Caption>
      )}

      {actions}
    </div>
  )
}
