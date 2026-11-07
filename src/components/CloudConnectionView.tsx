/** 云端连接页：配对（连接码）/ 网关状态 / 连通性 / 能力回显（独立成页，不塞进控制台） */

import React, { useEffect, useState } from 'react'
import { Copy, Link2, Link2Off, RefreshCw } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import { toast } from '../store/toastStore'
import { copyText } from '../utils/clipboard'
import { parsePairingInput } from '../utils/cloudPairing'
import { HERMES_BOOTSTRAP_PROMPT } from '../utils/hermesPrompt'
import { PLACEHOLDER_GATEWAY_URL } from '../api/cloud'
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
  const connect = useCloudStore((state) => state.connect)
  const disconnect = useCloudStore((state) => state.disconnect)
  const device = useCloudStore((state) => state.device)
  const deviceBusy = useCloudStore((state) => state.deviceBusy)
  const deviceError = useCloudStore((state) => state.deviceError)
  const setDeviceName = useCloudStore((state) => state.setDeviceName)
  const loadDevice = useCloudStore((state) => state.loadDevice)
  const reprobeDeviceName = useCloudStore((state) => state.reprobeDeviceName)
  const gateway = useCloudStore((state) => state.gateway)
  const gatewayBusy = useCloudStore((state) => state.gatewayBusy)
  const gatewayError = useCloudStore((state) => state.gatewayError)
  const gatewayNotice = useCloudStore((state) => state.gatewayNotice)
  const pairBusy = useCloudStore((state) => state.pairBusy)
  const pairError = useCloudStore((state) => state.pairError)
  const pairErrorCode = useCloudStore((state) => state.pairErrorCode)
  const loadGateway = useCloudStore((state) => state.loadGateway)
  const pairGateway = useCloudStore((state) => state.pairGateway)
  const revokeGateway = useCloudStore((state) => state.revokeGateway)
  const heartbeat = useCloudStore((state) => state.heartbeat)

  const [busy, setBusy] = useState<'save' | 'connect' | null>(null)
  const [deviceName, setDeviceNameDraft] = useState('')
  const [pairCode, setPairCode] = useState('')
  const [pairGatewayDraft, setPairGatewayDraft] = useState('')
  const [pairInputError, setPairInputError] = useState<'missing_code' | 'bad_gateway' | null>(null)
  /**
   * 上次配对用的网关地址（本地落盘，注销不会清）。
   * 它只做**输入框的占位提示**，不是内置默认值 —— 界面上要明确说出来，
   * 否则看起来就像代码里写死了作者自己的域名。
   */
  const lastGateway = (gateway?.gatewayUrl || config.gatewayUrl || '').trim()

  useEffect(() => {
    setDeviceNameDraft(device?.name ?? '')
  }, [device?.name])

  // 心跳推送：卡片上要能看出「这台机器还连着云端」
  useEffect(() => {
    const unwatch = useCloudStore.getState().watchHeartbeat()
    return unwatch
  }, [])

  /** 明确按「保存」才写盘：清空输入等于恢复系统默认名（主进程那边的约定） */
  const handleSaveDeviceName = async (value: string) => {
    if (!device) return
    const ok = await setDeviceName(value)
    if (ok) {
      toast.success(t('cloudDeviceSaved'))
      return
    }
    toast.error(t('cloudDeviceSaveFailed'))
    setDeviceNameDraft(device.name)
  }

  const deviceDirty = device ? deviceName.trim() !== device.name : false
  const canRestore = device ? device.name !== device.defaultName : false

  /** 跟随系统改名：自动探测只做一次，所以跟一次要用户点一次 */
  const handleReprobeDeviceName = async () => {
    if (await reprobeDeviceName()) toast.success(t('cloudDeviceReprobed'))
    else toast.error(t('cloudDeviceReprobeFailed'))
  }

  const handleCopyDeviceId = async () => {
    if (!device) return
    if (await copyText(device.id)) toast.success(t('cloudDeviceIdCopied'))
    else toast.error(t('cloudDeviceCopyFailed'))
  }

  const handleReconnect = async () => {
    setBusy('connect')
    await connect()
    setBusy(null)
  }

  /** 连接码可以是纯码，也可以是插件给出的完整链接（#pair=CODE） */
  const handlePair = async () => {
    setPairInputError(null)
    const fallbackGateway = pairGatewayDraft.trim() || gateway?.gatewayUrl || config.gatewayUrl
    const parsed = parsePairingInput(pairCode, fallbackGateway)
    if (!parsed.ok) {
      setPairInputError(parsed.reason)
      return
    }
    const ok = await pairGateway({
      code: parsed.code,
      gatewayUrl: parsed.gatewayUrl,
    })
    if (ok) {
      setPairCode('')
      setPairGatewayDraft('')
    }
  }

  const pairErrorText =
    pairInputError === 'missing_code'
      ? t('cloudPairMissingCode')
      : pairInputError === 'bad_gateway'
        ? t('cloudPairBadGateway')
        : pairErrorCode === 'pairing_expired'
          ? t('cloudPairExpired')
          : pairErrorCode === 'pairing_not_found'
            ? t('cloudPairNotFound')
            : pairErrorCode === 'pairing_used'
              ? t('cloudPairUsed')
              : pairErrorCode === 'rate_limited'
                ? t('cloudPairRateLimited')
                : pairErrorCode === 'pairing_disabled'
                  ? t('cloudPairDisabled')
                  : pairErrorCode === 'pairing_unsupported'
                    ? t('cloudPairPluginOutdated')
                    : pairError

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
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                icon={RefreshCw}
                loading={busy === 'connect'}
                disabled={!config.hasDeviceToken}
                onClick={() => void handleReconnect()}
              >
                {t('cloudReconnect')}
              </Button>
              <Button
                size="sm"
                icon={Link2Off}
                disabled={!config.hasDeviceToken || connection === 'unconfigured'}
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
            <div className="flex flex-wrap items-center gap-2 pt-3">
              <Caption className={deviceError ? 'text-danger' : 'text-ink-subtle'}>
                {deviceError ?? t('cloudDeviceLoading')}
              </Caption>
              {deviceError && (
                <Button size="sm" icon={RefreshCw} onClick={() => void loadDevice()}>
                  {t('cloudDeviceRetry')}
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 pt-3">
              <Field label={t('cloudDeviceName')} htmlFor="cloud-device-name">
                <Input
                  id="cloud-device-name"
                  value={deviceName}
                  // 只防手滑贴长文本：真正的上限是主进程按**码点**截 40 字
                  // （这里数的是 UTF-16 单元，窄写成 40 会连 emoji 一起挡掉）
                  maxLength={80}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={deviceBusy}
                  onChange={(event) => setDeviceNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && deviceDirty) void handleSaveDeviceName(deviceName)
                    if (event.key === 'Escape') setDeviceNameDraft(device.name)
                  }}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  loading={deviceBusy}
                  disabled={!deviceDirty}
                  onClick={() => void handleSaveDeviceName(deviceName)}
                >
                  {t('cloudDeviceSave')}
                </Button>
                <Button
                  size="sm"
                  disabled={!canRestore || deviceBusy}
                  onClick={() => void handleSaveDeviceName('')}
                >
                  {t('cloudDeviceRestore')}
                </Button>
                <Button
                  size="sm"
                  icon={RefreshCw}
                  disabled={deviceBusy}
                  onClick={() => void handleReprobeDeviceName()}
                >
                  {t('cloudDeviceReprobe')}
                </Button>
              </div>
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
          <CardHeader title={t('cloudGatewayTitle')} />
          <div className="flex flex-col gap-3 pt-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-ink-muted">{t('cloudGatewayUrl')}</Label>
              {/* 没有内置默认地址：没配对且没填过就是空，如实说「未设置」 */}
              <DataText className="select-all break-all text-ink-subtle">
                {gateway?.gatewayUrl || config.gatewayUrl || t('cloudGatewayNotSet')}
              </DataText>
            </div>

            {gateway?.registered ? (
              <>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <StatusText tone={gateway.online === false ? 'danger' : 'success'}>
                    {gateway.online === false
                      ? t('cloudGatewayUpstreamDown')
                      : t('cloudGatewayRegistered')}
                  </StatusText>
                  <Caption className="text-ink-subtle">
                    {t('cloudGatewayScopes')}: {(gateway.scopes ?? []).join(' / ') || '—'}
                  </Caption>
                  {gateway.upstreamVersion && (
                    <Caption className="text-ink-subtle">
                      {t('cloudGatewayUpstream')}: {gateway.upstreamVersion}
                    </Caption>
                  )}
                  <Caption
                    className={heartbeat?.lastError ? 'text-danger' : 'text-ink-subtle'}
                  >
                    {heartbeat?.stoppedBecauseRevoked
                      ? t('cloudGatewayHeartbeatRevoked')
                      : heartbeat?.lastError
                        ? `${t('cloudGatewayHeartbeatFailed')}: ${heartbeat.lastError}`
                        : heartbeat?.lastOkAt
                          ? `${t('cloudGatewayHeartbeatOk')} · ${t('cloudGatewayHeartbeatJustNow')}`
                          : t('cloudGatewayHeartbeatPending')}
                  </Caption>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-ink-muted">{t('cloudDeviceId')}</Label>
                  <DataText className="select-all break-all text-ink-subtle">
                    {gateway.deviceId}
                  </DataText>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" icon={RefreshCw} disabled={gatewayBusy} loading={gatewayBusy}
                    onClick={() => void loadGateway()}>
                    {t('cloudGatewayRefresh')}
                  </Button>
                  <Button size="sm" icon={Link2Off} disabled={gatewayBusy}
                    onClick={() => void revokeGateway()}>
                    {t('cloudGatewayRevoke')}
                  </Button>
                </div>
                <Caption className="text-ink-subtle">{t('cloudPairRevokeHint')}</Caption>
              </>
            ) : (
              <>
                <Field
                  label={t('cloudPairGatewayAdvanced')}
                  hint={t('cloudPairGatewayHint')}
                  htmlFor="cloud-pair-gateway"
                >
                  <Input
                    id="cloud-pair-gateway"
                    value={pairGatewayDraft}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={lastGateway || PLACEHOLDER_GATEWAY_URL}
                    onChange={(event) => {
                      setPairGatewayDraft(event.target.value)
                      setPairInputError(null)
                    }}
                  />
                  {lastGateway && !pairGatewayDraft.trim() && (
                    <span className="flex items-center gap-2">
                      <Caption className="text-ink-subtle">{t('cloudPairGatewayLastUsed')}</Caption>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setPairGatewayDraft(lastGateway)
                          setPairInputError(null)
                        }}
                      >
                        {t('cloudPairGatewayUseLast')}
                      </Button>
                    </span>
                  )}
                </Field>
                <Field
                  label={t('cloudPairCode')}
                  hint={t('cloudPairCodeHint')}
                  htmlFor="cloud-pair-code"
                >
                  <Input
                    id="cloud-pair-code"
                    value={pairCode}
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="characters"
                    placeholder="XXXXX-XXXXX"
                    onChange={(event) => {
                      setPairCode(event.target.value)
                      setPairInputError(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && pairCode.trim() && !pairBusy) {
                        void handlePair()
                      }
                    }}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={Link2}
                    disabled={pairBusy || !pairCode.trim()}
                    loading={pairBusy}
                    onClick={() => void handlePair()}
                  >
                    {pairBusy ? t('cloudPairing') : t('cloudPairConnect')}
                  </Button>
                  <Button size="sm" icon={RefreshCw} disabled={gatewayBusy}
                    onClick={() => void loadGateway()}>
                    {t('cloudGatewayRefresh')}
                  </Button>
                </div>
                <Caption className="text-ink-subtle">{t('cloudPairHint')}</Caption>
                {pairErrorText && <Caption className="text-danger">{pairErrorText}</Caption>}
              </>
            )}

            {gatewayNotice && <Caption className="text-success">{gatewayNotice}</Caption>}
            {(gatewayError || gateway?.error) && (
              <Caption className="text-danger">{gatewayError ?? gateway?.error}</Caption>
            )}
          </div>
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
