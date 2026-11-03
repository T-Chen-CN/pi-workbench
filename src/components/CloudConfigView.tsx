/** 云端配置页：API 连接表单 + 程序内打开的控制台视图容器 */

import React, { useEffect, useRef, useState } from 'react'
import { ExternalLink, Monitor, RefreshCw } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import { Button, Caption, EmptyState, Field, Input, Label, Spinner } from './ui'
import { Card, CardHeader, StatusText } from './patterns'

/** 控制台视图在窗口里的位置：渲染层量 DOM，主进程按同一坐标系 setBounds */
const DASHBOARD_MIN_HEIGHT = 240

export const CloudConfigView: React.FC<{ active: boolean }> = ({ active }) => {
  const { t } = useI18nStore()

  const config = useCloudStore((state) => state.config)
  const connection = useCloudStore((state) => state.connection)
  const error = useCloudStore((state) => state.error)
  const capabilities = useCloudStore((state) => state.capabilities)
  const bridgeAvailable = useCloudStore((state) => state.bridgeAvailable)
  const saveConfig = useCloudStore((state) => state.saveConfig)
  const connect = useCloudStore((state) => state.connect)
  const dashboard = useCloudStore((state) => state.dashboard)
  const openDashboard = useCloudStore((state) => state.openDashboard)
  const closeDashboard = useCloudStore((state) => state.closeDashboard)
  const setDashboardBounds = useCloudStore((state) => state.setDashboardBounds)
  const reloadDashboard = useCloudStore((state) => state.reloadDashboard)

  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setBaseUrl(config.baseUrl)
  }, [config.baseUrl])

  // 原生视图盖在 web 内容之上：位置必须由渲染层实测后上报，且切页 / 改尺寸都要同步
  useEffect(() => {
    if (!dashboard.visible) return
    const element = hostRef.current
    if (!element) return

    const push = () => {
      const rect = element.getBoundingClientRect()
      const visible = active && rect.width > 0 && rect.height > 0
      void setDashboardBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible,
      })
    }

    push()
    const observer = new ResizeObserver(push)
    observer.observe(element)
    window.addEventListener('resize', push)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', push)
    }
  }, [dashboard.visible, active, setDashboardBounds])

  const handleSave = async () => {
    setSaving(true)
    const ok = await saveConfig({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined })
    setSaving(false)
    if (ok) setApiKey('')
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
      className={`absolute inset-0 overflow-y-auto p-4 ${
        active ? 'visible' : 'pointer-events-none invisible'
      }`}
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        {!bridgeAvailable && (
          <div className="border border-rule-control bg-raised px-3 py-2 type-caption text-ink-muted">
            {t('cloudBridgeMissing')}
          </div>
        )}

        <Card>
          <CardHeader title={t('cloudConnection')} />
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
              <Button variant="primary" size="sm" loading={saving} onClick={() => void handleSave()}>
                {t('cloudSave')}
              </Button>
              <Button
                size="sm"
                icon={RefreshCw}
                disabled={saving || !config.hasToken}
                onClick={() => void connect()}
              >
                {t('cloudReconnect')}
              </Button>
              <span className="ml-auto flex items-center gap-2">
                <StatusText tone={tone} dot>
                  {stateText}
                </StatusText>
                {capabilities?.model && (
                  <Caption className="text-ink-subtle">{capabilities.model}</Caption>
                )}
              </span>
            </div>
            {error && <div className="type-caption text-danger">{error}</div>}
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t('cloudDashboard')}
            action={
              <span className="flex items-center gap-1">
                {dashboard.visible ? (
                  <>
                    <Button size="sm" icon={RefreshCw} onClick={() => void reloadDashboard()}>
                      {t('cloudRetry')}
                    </Button>
                    <Button size="sm" onClick={() => void closeDashboard()}>
                      {t('cloudDashboardClose')}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    icon={ExternalLink}
                    disabled={!config.hasToken}
                    onClick={() => void openDashboard()}
                  >
                    {t('cloudDashboardOpen')}
                  </Button>
                )}
              </span>
            }
          />
          <div className="flex flex-col gap-2 pt-3">
            <Caption className="text-ink-muted">{t('cloudDashboardHint')}</Caption>
            <div
              ref={hostRef}
              className="relative flex items-center justify-center border border-rule-divide bg-sunken"
              style={{ minHeight: DASHBOARD_MIN_HEIGHT }}
            >
              {!dashboard.visible && (
                <div className="p-6">
                  <EmptyState
                    icon={Monitor}
                    title={
                      config.hasToken ? t('cloudDashboard') : t('cloudStateUnconfigured')
                    }
                    description={
                      config.hasToken
                        ? t('cloudDashboardHint')
                        : t('cloudDashboardNeedsToken')
                    }
                    compact
                  />
                </div>
              )}
              {dashboard.loading && dashboard.visible && (
                <span className="absolute right-3 top-3 flex items-center gap-1.5">
                  <Spinner size={12} />
                  <Caption className="text-ink-muted">{t('cloudLoading')}</Caption>
                </span>
              )}
              {dashboard.error && (
                <div className="absolute inset-x-0 bottom-0 border-t border-rule-divide bg-raised px-3 py-1.5">
                  <Label className="text-danger">
                    {t('cloudDashboardLoadFailed', { error: dashboard.error })}
                  </Label>
                </div>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
