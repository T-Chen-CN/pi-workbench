import React, { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { api } from '../api'
import { localizeError } from '../i18n/errors'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { useUpdaterStore } from '../store/updaterStore'
import { Meter } from './patterns'

/**
 * 状态栏右侧的版本号与更新提示。
 * 有新版本时显示在版本号旁边；点击版本号打开设置页的“关于”分节。
 */
export const UpdateStatusIndicator: React.FC<{ onOpenSettings: () => void }> = ({
  onOpenSettings,
}) => {
  const { t } = useI18nStore()
  const state = useUpdaterStore((store) => store.state)
  const requestPrompt = useUpdaterStore((store) => store.requestPrompt)
  const [opening, setOpening] = useState(false)

  const openDownloadPage = async () => {
    if (opening) return
    setOpening(true)
    try {
      const result = await api.updateOpenDownload()
      if (!result.success) {
        toast.error(
          t('updateFailed', { error: localizeError(result.error) || t('unknownError') })
        )
      }
    } finally {
      setOpening(false)
    }
  }

  const version = state.currentVersion ? `v${state.currentVersion}` : ''

  return (
    <span className="flex items-center gap-3">
      {state.status === 'downloading' && (
        <span className="flex items-center gap-2 text-ink-muted">
          <span>{t('updateDownloadingShort', { percent: state.percent ?? 0 })}</span>
          <Meter value={state.percent ?? 0} label={t('updates')} className="w-12" />
        </span>
      )}

      {state.status === 'downloaded' && (
        <button
          type="button"
          onClick={requestPrompt}
          className="text-accent transition-colors hover:text-ink"
        >
          {t('updateInstallReadyShort')}
        </button>
      )}

      {state.status === 'available' && state.canAutoInstall && (
        <span className="text-accent">
          {t('updateAvailableShort', { version: state.version ?? '' })}
        </span>
      )}

      {state.status === 'available' && !state.canAutoInstall && (
        <button
          type="button"
          onClick={() => void openDownloadPage()}
          className="inline-flex items-center gap-1 text-accent transition-colors hover:text-ink"
        >
          <ExternalLink size={11} aria-hidden="true" />
          {t('updateOpenDownloadShort')}
        </button>
      )}

      {version && (
        <button
          type="button"
          onClick={onOpenSettings}
          title={t('about')}
          className="text-ink-muted transition-colors hover:text-ink"
        >
          {version}
        </button>
      )}
    </span>
  )
}
