import React, { useEffect } from 'react'
import { Cloud } from 'lucide-react'
import { useCloudStore } from '../store/cloudStore'
import { useI18nStore } from '../store/i18nStore'

/**
 * 底部状态栏的云端指示器（F-27 / 4.6）。
 *
 * 只订阅必要的字段：状态栏在每一次按键时都会重渲染，不能挂整个 store。
 */
export const CloudStatusIndicator: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const { t } = useI18nStore()
  const linked = useCloudStore((store) => store.link.linked)
  const status = useCloudStore((store) => store.deviceState.status)
  const pending = useCloudStore((store) => store.deviceState.pending)
  const runningCount = useCloudStore(
    (store) =>
      store.tasks.filter(
        (task) => task.status === 'running' || task.status === 'assigned' || task.status === 'waiting_human'
      ).length
  )
  const init = useCloudStore((store) => store.init)

  useEffect(() => {
    void init()
    // 只跑一次：init 内部自己保证监听只挂一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const label = !linked
    ? t('cloudStatusUnlinked')
    : status === 'online'
      ? t('cloudStatusOnline')
      : status === 'error'
        ? t('cloudStatusError')
        : status === 'connecting'
          ? t('cloudStatusConnecting')
          : t('cloudStatusOffline')

  const tone = !linked
    ? 'text-ink-muted'
    : status === 'online'
      ? 'text-accent'
      : status === 'error'
        ? 'text-danger'
        : 'text-warning'

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-1.5 transition-colors hover:text-ink"
      title={label}
    >
      <Cloud size={12} className={tone} />
      <span className={tone}>{label}</span>
      {linked && runningCount > 0 && (
        <span className="text-accent">
          {runningCount} · {t('cloudTasks')}
        </span>
      )}
      {linked && pending > 0 && (
        <span className="text-ink-muted">{t('cloudPendingFrames', { count: pending })}</span>
      )}
    </button>
  )
}
