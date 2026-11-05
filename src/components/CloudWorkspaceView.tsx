/**
 * 云端 Agent 外壳：会话 / 控制台 / 任务 / 连接 四个常驻页签。
 *
 * 控制台是原生视图（盖在内容区上），所以它需要的东西（加载指示、重载、错误）
 * 都放在页签栏里 —— 那里不在原生层覆盖范围内。
 */

import React, { useEffect, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import { useCloudBridge } from '../hooks/useCloudBridge'
import { cloudApi } from '../api/cloud'
import type { AppView, CloudView } from '../types/navigation'
import { Caption, IconButton, Spinner } from './ui'
import { CloudSessionView } from './CloudSessionView'
import { CloudConsoleView } from './CloudConsoleView'
import { CloudJobsView } from './CloudJobsView'
import { CloudConnectionView } from './CloudConnectionView'
import { CloudHandoffDialog } from './CloudHandoffDialog'

const TABS: Array<{
  view: CloudView
  labelKey: 'cloudTabSession' | 'cloudTabConsole' | 'cloudTabJobs' | 'cloudTabConnection'
}> = [
  { view: 'cloud-session', labelKey: 'cloudTabSession' },
  { view: 'cloud-console', labelKey: 'cloudTabConsole' },
  { view: 'cloud-jobs', labelKey: 'cloudTabJobs' },
  { view: 'cloud-connection', labelKey: 'cloudTabConnection' },
]

export const CloudWorkspaceView: React.FC<{
  view: CloudView
  onNavigate: (view: AppView) => void
}> = ({ view, onNavigate }) => {
  const { t } = useI18nStore()
  const hydrate = useCloudStore((state) => state.hydrate)
  const hydrated = useCloudStore((state) => state.hydrated)
  const config = useCloudStore((state) => state.config)
  const connection = useCloudStore((state) => state.connection)
  const error = useCloudStore((state) => state.error)
  const capabilities = useCloudStore((state) => state.capabilities)
  const dashboard = useCloudStore((state) => state.dashboard)
  const reloadDashboard = useCloudStore((state) => state.reloadDashboard)
  const hideDashboard = useCloudStore((state) => state.hideDashboard)
  const landedRef = useRef(false)

  useCloudBridge()

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // 首次进入云端：没配好就直接落在「连接」页，配好了默认停在「会话」
  useEffect(() => {
    if (!hydrated || landedRef.current) return
    landedRef.current = true
    if (!config.hasDeviceToken && view === 'cloud-session') onNavigate('cloud-connection')
  }, [hydrated, config.hasDeviceToken, view, onNavigate])

  // 控制台里按 Esc：收起原生层并回到会话页
  useEffect(() => {
    return cloudApi.onDashboardClosed(() => {
      hideDashboard()
      if (view === 'cloud-console') onNavigate('cloud-session')
    })
  }, [view, onNavigate, hideDashboard])

  const tone =
    connection === 'connected'
      ? 'text-success'
      : connection === 'error'
        ? 'text-danger'
        : connection === 'connecting'
          ? 'text-accent'
          : 'text-ink-subtle'

  return (
    <div className="absolute inset-0 flex flex-col bg-surface">
      <div className="flex h-[34px] flex-shrink-0 items-center gap-0.5 border-b border-rule-divide px-2">
        {TABS.map((tab) => (
          <button
            key={tab.view}
            type="button"
            aria-current={view === tab.view || undefined}
            onClick={() => onNavigate(tab.view)}
            className={`h-full border-b-2 px-2.5 type-label transition-colors ${
              view === tab.view
                ? 'border-accent text-ink'
                : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}

        <span className="ml-auto flex items-center gap-2 pr-1">
          {view === 'cloud-console' && config.hasDeviceToken && (
            <>
              {dashboard.loading && (
                <span className="flex items-center gap-1.5">
                  <Spinner size={11} />
                  <Caption className="text-ink-muted">{t('cloudLoading')}</Caption>
                </span>
              )}
              <IconButton
                icon={RefreshCw}
                label={t('cloudRetry')}
                size="sm"
                onClick={() => void reloadDashboard()}
              />
            </>
          )}
          {error && connection === 'error' && (
            <Caption className="max-w-[360px] truncate text-danger">{error}</Caption>
          )}
          {capabilities?.model && (
            <Caption className="text-ink-subtle">{capabilities.model}</Caption>
          )}
          <span className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full bg-current ${tone}`} aria-hidden="true" />
            <Caption className={tone}>
              {connection === 'connected'
                ? t('cloudStateConnected')
                : connection === 'error'
                  ? t('cloudStateError')
                  : connection === 'connecting'
                    ? t('cloudStateConnecting')
                    : t('cloudStateUnconfigured')}
            </Caption>
          </span>
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <CloudSessionView active={view === 'cloud-session'} onNavigate={onNavigate} />
        <CloudConsoleView active={view === 'cloud-console'} onNavigate={onNavigate} />
        <CloudJobsView active={view === 'cloud-jobs'} onNavigate={onNavigate} />
        <CloudConnectionView active={view === 'cloud-connection'} />
      </div>

      {/* 导入预览框：挂在 inert 页面容器之外 */}
      <CloudHandoffDialog active={view === 'cloud-connection'} />
    </div>
  )
}
