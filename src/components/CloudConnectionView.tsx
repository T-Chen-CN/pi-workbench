/** 云端连接页：API 地址 / 密钥 / 连通性 / 能力回显（独立成页，不塞进控制台） */

import React, { useEffect, useState } from 'react'
import { Link2Off, RefreshCw } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import { Button, Caption, DataText, Field, Input, Label } from './ui'
import { Card, CardHeader, StatusText } from './patterns'

const CAPABILITY_KEYS = [
  { key: 'runStop', labelKey: 'cloudCapStop' },
  { key: 'approvalEvents', labelKey: 'cloudCapApprovals' },
  { key: 'runApprovalResponse', labelKey: 'cloudCapApprovalResponse' },
  { key: 'runSteer', labelKey: 'cloudCapSteer' },
] as const

export const CloudConnectionView: React.FC<{ active: boolean }> = ({ active }) => {
  const { t } = useI18nStore()

  const config = useCloudStore((state) => state.config)
  const connection = useCloudStore((state) => state.connection)
  const error = useCloudStore((state) => state.error)
  const capabilities = useCloudStore((state) => state.capabilities)
  const bridgeAvailable = useCloudStore((state) => state.bridgeAvailable)
  const saveConfig = useCloudStore((state) => state.saveConfig)
  const connect = useCloudStore((state) => state.connect)
  const disconnect = useCloudStore((state) => state.disconnect)

  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'connect' | null>(null)

  useEffect(() => {
    setBaseUrl(config.baseUrl)
  }, [config.baseUrl])

  const handleSave = async () => {
    setBusy('save')
    const ok = await saveConfig({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined })
    setBusy(null)
    if (ok) setApiKey('')
  }

  const handleReconnect = async () => {
    setBusy('connect')
    await connect()
    setBusy(null)
  }

  const tone =
    connection === 'connected'
      ? 'success'
      : connection === 'error'
        ? 'danger'
        : connection === 'connecting'
          ? 'accent'
          : 'muted'
  const stateText =
    connection === 'connected'
      ? t('cloudStateConnected')
      : connection === 'error'
        ? t('cloudStateError')
        : connection === 'connecting'
          ? t('cloudStateConnecting')
          : t('cloudStateUnconfigured')

  return (
    <div
      aria-hidden={!active}
      inert={!active}
      className={`absolute inset-0 overflow-y-auto px-4 py-5 ${
        active ? 'visible' : 'pointer-events-none invisible'
      }`}
    >
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
        {!bridgeAvailable && (
          <div className="border border-rule-control bg-raised px-3 py-2 type-caption text-ink-muted">
            {t('cloudBridgeMissing')}
          </div>
        )}

        <Card>
          <CardHeader
            title={t('cloudConnection')}
            status={
              <span className="flex items-center gap-3">
                <StatusText tone={tone} dot>
                  {stateText}
                </StatusText>
                {capabilities?.model && (
                  <Caption className="text-ink-subtle">{capabilities.model}</Caption>
                )}
              </span>
            }
          />
          <div className="flex flex-col gap-3 pt-3">
            <Field label={t('cloudBaseUrl')} hint={t('cloudBaseUrlHint')} htmlFor="cloud-base-url">
              <Input
                id="cloud-base-url"
                value={baseUrl}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>
            <Field
              label={t('cloudApiKey')}
              hint={config.hasToken ? t('cloudApiKeySavedHint') : undefined}
              htmlFor="cloud-api-key"
            >
              <Input
                id="cloud-api-key"
                type="password"
                value={apiKey}
                spellCheck={false}
                autoComplete="off"
                placeholder={t('cloudApiKeyPlaceholder')}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                loading={busy === 'save'}
                onClick={() => void handleSave()}
              >
                {t('cloudSave')}
              </Button>
              <Button
                size="sm"
                icon={RefreshCw}
                loading={busy === 'connect'}
                disabled={!config.hasToken}
                onClick={() => void handleReconnect()}
              >
                {t('cloudReconnect')}
              </Button>
              <Button
                size="sm"
                icon={Link2Off}
                disabled={!config.hasToken || connection === 'unconfigured'}
                onClick={() => void disconnect()}
                className="ml-auto"
              >
                {t('cloudDisconnect')}
              </Button>
            </div>
            {error && (
              <div className="border border-danger/30 bg-danger/10 px-2.5 py-2">
                <Label className="text-danger">{t('cloudLastError')}</Label>
                <p className="m-0 mt-1 whitespace-pre-wrap break-words type-data text-danger">
                  {error}
                </p>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title={t('cloudCapabilities')} />
          <div className="flex flex-col gap-2 pt-3">
            <div className="flex flex-col gap-1.5">
              {CAPABILITY_KEYS.map(({ key, labelKey }) => {
                const enabled = Boolean(capabilities?.[key])
                return (
                  <div key={key} className="flex items-center justify-between gap-3">
                    <Caption className="text-ink-muted">{t(labelKey)}</Caption>
                    <DataText className={enabled ? 'text-success' : 'text-ink-subtle'}>
                      {enabled ? t('cloudCapYes') : t('cloudCapNo')}
                    </DataText>
                  </div>
                )
              })}
            </div>
            <Caption className="text-ink-subtle">{t('cloudCapabilitiesHint')}</Caption>
          </div>
        </Card>
      </div>
    </div>
  )
}
