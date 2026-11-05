/** 云端连接页：API 地址 / 密钥 / 连通性 / 能力回显（独立成页，不塞进控制台） */

import React, { useEffect, useState } from 'react'
import { Copy, FileUp, Link2Off, RefreshCw } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import { toast } from '../store/toastStore'
import { copyText } from '../utils/clipboard'
import { HERMES_BOOTSTRAP_PROMPT } from '../utils/hermesPrompt'
import { Button, Caption, DataText, Field, Input, Label } from './ui'
import { Card, CardHeader, StatusText } from './patterns'
import { CloudDiagnosticsPanel } from './CloudDiagnosticsPanel'
import { CloudModeSwitch } from './CloudModeSwitch'

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
  const pickHandoff = useCloudStore((state) => state.pickHandoff)
  const handoffBusy = useCloudStore((state) => state.handoffBusy)
  const connect = useCloudStore((state) => state.connect)
  const disconnect = useCloudStore((state) => state.disconnect)
  const device = useCloudStore((state) => state.device)
  const deviceBusy = useCloudStore((state) => state.deviceBusy)
  const deviceError = useCloudStore((state) => state.deviceError)
  const setDeviceName = useCloudStore((state) => state.setDeviceName)

  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [dashboardToken, setDashboardToken] = useState('')
  const [busy, setBusy] = useState<'save' | 'connect' | null>(null)
  const [deviceName, setDeviceNameDraft] = useState('')

  useEffect(() => {
    setBaseUrl(config.baseUrl)
  }, [config.baseUrl])

  useEffect(() => {
    setDeviceNameDraft(device?.name ?? '')
  }, [device?.name])

  /** 失焦 / 回车提交。值没变就什么也不做，避免每次点过输入框都写一遍盘。 */
  const handleCommitDeviceName = async () => {
    if (!device) return
    if (deviceName.trim() === device.name) return
    const ok = await setDeviceName(deviceName)
    if (ok) {
      toast.success(t('cloudDeviceSaved'))
      return
    }
    toast.error(t('cloudDeviceSaveFailed'))
    setDeviceNameDraft(device.name)
  }

  const handleCopyDeviceId = async () => {
    if (!device) return
    if (await copyText(device.id)) toast.success(t('cloudDeviceIdCopied'))
    else toast.error(t('cloudDeviceCopyFailed'))
  }

  const handleSave = async () => {
    setBusy('save')
    const ok = await saveConfig({
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim() || undefined,
      dashboardToken: dashboardToken.trim() || undefined,
    })
    setBusy(null)
    if (ok) {
      setApiKey('')
      setDashboardToken('')
    }
  }

  const handleReconnect = async () => {
    setBusy('connect')
    await connect()
    setBusy(null)
  }

  /** 自举 Prompt 由文档构建时内联（见 utils/hermesPrompt.ts），这里只负责写入剪贴板 */
  const handleCopyPrompt = async () => {
    if (await copyText(HERMES_BOOTSTRAP_PROMPT)) toast.success(t('cloudBootstrapCopied'))
    else toast.error(t('cloudBootstrapCopyFailed'))
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
            <Field
              label={t('cloudDashboardToken')}
              hint={
                config.hasDashboardToken
                  ? t('cloudDashboardTokenSavedHint')
                  : t('cloudDashboardTokenHint')
              }
              htmlFor="cloud-dashboard-token"
            >
              <Input
                id="cloud-dashboard-token"
                type="password"
                value={dashboardToken}
                spellCheck={false}
                autoComplete="off"
                placeholder={t('cloudDashboardTokenPlaceholder')}
                onChange={(event) => setDashboardToken(event.target.value)}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                icon={FileUp}
                disabled={!bridgeAvailable}
                loading={handoffBusy === 'pick'}
                onClick={() => void pickHandoff()}
              >
                {t('cloudImportFromFile')}
              </Button>
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
          <CardHeader title={t('cloudDeviceTitle')} />
          {!device ? (
            <div className="pt-3">
              <Caption className="text-ink-subtle">{t('cloudDeviceLoading')}</Caption>
            </div>
          ) : (
            <div className="flex flex-col gap-3 pt-3">
              <Field label={t('cloudDeviceName')} htmlFor="cloud-device-name">
                <Input
                  id="cloud-device-name"
                  value={deviceName}
                  maxLength={40}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={deviceBusy}
                  onChange={(event) => setDeviceNameDraft(event.target.value)}
                  onBlur={() => void handleCommitDeviceName()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      setDeviceNameDraft(device.name)
                      event.currentTarget.blur()
                    }
                  }}
                />
              </Field>
              <Caption className="text-ink-subtle">{t('cloudDeviceNameHint')}</Caption>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-ink-muted">{t('cloudDeviceId')}</Label>
                  <Button size="sm" icon={Copy} onClick={() => void handleCopyDeviceId()}>
                    {t('copyCode')}
                  </Button>
                </div>
                <DataText className="select-all break-all text-ink-subtle">{device.id}</DataText>
              </div>
              <Caption className="text-ink-subtle">{t('cloudDeviceIdHint')}</Caption>
              {deviceError && <Caption className="text-danger">{deviceError}</Caption>}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title={t('cloudBootstrapTitle')} />
          <div className="flex flex-col gap-2 pt-3">
            <p className="m-0 type-caption text-ink-muted">{t('cloudBootstrapBody')}</p>
            <Caption className="text-ink-subtle">{t('cloudBootstrapSteps')}</Caption>
            <div className="flex items-center gap-2">
              <Button size="sm" icon={Copy} onClick={() => void handleCopyPrompt()}>
                {t('cloudBootstrapCopy')}
              </Button>
            </div>
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

        <CloudDiagnosticsPanel connected={connection === 'connected'} />

        <CloudPolicyCard connected={connection === 'connected'} />
      </div>
    </div>
  )
}

/**
 * 审批策略：档位控件 + 当前生效值 + 已知的两处盲区。
 *
 * 盲区必须写出来（决策 5 的代价）：`approvals.deny` 保持 Hermes 默认空，
 * 危险模式表里没有纯 `sudo`，文件写入根本没有审批路径。不说清楚，
 * 「开了审批」会给人一种「什么都拦住了」的错觉。
 */
const CloudPolicyCard: React.FC<{ connected: boolean }> = ({ connected }) => {
  const { t } = useI18nStore()
  const policy = useCloudStore((state) => state.policy)

  return (
    <Card>
      <CardHeader title={t('cloudPolicyTitle')} />
      <div className="flex flex-col gap-2 pt-3">
        <CloudModeSwitch disabled={!connected} />
        {policy && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <Caption className="text-ink-muted">{t('cloudPolicyTimeout')}</Caption>
              <DataText className="text-ink">
                {policy.timeoutSeconds === null
                  ? t('cloudPolicyUnknown')
                  : t('cloudPolicySeconds', { seconds: policy.timeoutSeconds })}
              </DataText>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Caption className="text-ink-muted">{t('cloudPolicyDenyList')}</Caption>
              <DataText className="text-ink">
                {t('cloudPolicyDenyCount', { count: policy.denyCount })}
              </DataText>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Caption className="text-ink-muted">{t('cloudPolicyDisabled')}</Caption>
              <DataText className="text-ink">
                {policy.disabledToolsets.length > 0
                  ? policy.disabledToolsets.join(', ')
                  : t('cloudPolicyNone')}
              </DataText>
            </div>
          </div>
        )}
        <Caption className="text-ink-subtle">{t('cloudPolicyRisk')}</Caption>
      </div>
    </Card>
  )
}
