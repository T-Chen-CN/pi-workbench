/** 云端 Agent 外壳：会话 / 配置两个页签，两页都常驻，切页不丢状态 */

import React, { useEffect } from 'react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import { useCloudBridge } from '../hooks/useCloudBridge'
import type { AppView, CloudView } from '../types/navigation'
import { Caption } from './ui'
import { CloudSessionView } from './CloudSessionView'
import { CloudConfigView } from './CloudConfigView'

const TABS: Array<{ view: CloudView; labelKey: 'cloudTabSession' | 'cloudTabConfig' }> = [
  { view: 'cloud-session', labelKey: 'cloudTabSession' },
  { view: 'cloud-config', labelKey: 'cloudTabConfig' },
]

export const CloudWorkspaceView: React.FC<{
  view: CloudView
  onNavigate: (view: AppView) => void
}> = ({ view, onNavigate }) => {
  const { t } = useI18nStore()
  const hydrate = useCloudStore((state) => state.hydrate)
  const connection = useCloudStore((state) => state.connection)
  const error = useCloudStore((state) => state.error)
  const capabilities = useCloudStore((state) => state.capabilities)

  useCloudBridge()

  useEffect(() => {
    void hydrate()
  }, [hydrate])

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
          {error && connection === 'error' && (
            <Caption className="max-w-[420px] truncate text-danger">{error}</Caption>
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
        <CloudSessionView active={view === 'cloud-session'} />
        <CloudConfigView active={view === 'cloud-config'} />
      </div>
    </div>
  )
}
