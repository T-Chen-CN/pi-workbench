import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Cloud, Square } from 'lucide-react'
import { useCloudStore } from '../store/cloudStore'
import { useI18nStore } from '../store/i18nStore'
import type { CloudTaskRow, CloudTaskStatusName } from '../types/cloud'

const RUNNING_STATUSES: readonly CloudTaskStatusName[] = ['assigned', 'running', 'waiting_human']

const TASK_STATUS_LABEL_KEY: Record<CloudTaskStatusName, string> = {
  queued: 'cloudTaskQueued',
  assigned: 'cloudTaskAssigned',
  running: 'cloudTaskRunning',
  waiting_human: 'cloudTaskWaiting',
  done: 'cloudTaskDone',
  failed: 'cloudTaskFailed',
  cancelled: 'cloudTaskCancelled',
  interrupted: 'cloudTaskInterrupted',
  expired: 'cloudTaskExpired',
}

function formatElapsed(startedAt: number | undefined, now: number): string {
  if (!startedAt) return '00:00'
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/**
 * 底部状态栏的云端指示器（F-27 / F-30 / 4.6 / A-08）。
 *
 * 单工单显示「设备 · 标题 · 状态 · 已耗时」+ 停止入口；
 * 多工单显示「N 个执行中 · 最近：T-xxx 状态 mm:ss」，点开列出全部并提供逐条停止。
 * 只在有运行中工单时开 1s 计时器，空闲零开销。
 */
export const CloudStatusIndicator: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const { t } = useI18nStore()
  const linked = useCloudStore((store) => store.link.linked)
  const status = useCloudStore((store) => store.deviceState.status)
  const pending = useCloudStore((store) => store.deviceState.pending)
  const tasks = useCloudStore((store) => store.tasks)
  const devices = useCloudStore((store) => store.devices)
  const unreadCount = useCloudStore((store) => store.unreadCount)
  const stoppingTaskIds = useCloudStore((store) => store.stoppingTaskIds)
  const stopTask = useCloudStore((store) => store.stopTask)
  const init = useCloudStore((store) => store.init)

  const [popoverOpen, setPopoverOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void init()
    // 只跑一次：init 内部自己保证监听只挂一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runningTasks = useMemo(
    () =>
      tasks
        .filter((task) => RUNNING_STATUSES.includes(task.status))
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)),
    [tasks]
  )

  const deviceById = useMemo(() => {
    const map = new Map<string, { name: string; online: boolean }>()
    for (const device of devices) {
      map.set(device.id, { name: device.name, online: device.online })
    }
    return map
  }, [devices])

  // 只在存在活跃工单时推进耗时读数，空闲时不挂定时器
  useEffect(() => {
    if (runningTasks.length === 0) {
      setPopoverOpen(false)
      return
    }
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [runningTasks.length])

  // 点外部或按 Esc 收起多工单浮层
  useEffect(() => {
    if (!popoverOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setPopoverOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPopoverOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [popoverOpen])

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

  const statusText = (task: CloudTaskRow): string =>
    stoppingTaskIds[task.id]
      ? t('cloudStoppingTask')
      : t(TASK_STATUS_LABEL_KEY[task.status] as Parameters<typeof t>[0])

  const isDeviceOffline = (task: CloudTaskRow): boolean => {
    const device = deviceById.get(task.deviceId)
    return device ? !device.online : false
  }

  const deviceLabel = (task: CloudTaskRow): string =>
    deviceById.get(task.deviceId)?.name || task.deviceId

  const single = linked && runningTasks.length === 1 ? runningTasks[0] : null
  const multiLatest = linked && runningTasks.length > 1 ? runningTasks[0] : null

  return (
    <div ref={containerRef} className="relative flex items-center gap-1.5">
      {single ? (
        <>
          <button
            type="button"
            onClick={onOpen}
            className="flex items-center gap-1.5 transition-colors hover:text-ink"
            title={`${deviceLabel(single)} · ${single.title}`}
          >
            <Cloud size={12} className={tone} />
            <span className="max-w-xs truncate text-accent">
              {deviceLabel(single)} · {single.title} · {statusText(single)} ·{' '}
              <span className="tabular-nums">
                {formatElapsed(single.startedAt ?? single.createdAt, now)}
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              void stopTask(single.id)
            }}
            disabled={Boolean(stoppingTaskIds[single.id]) || isDeviceOffline(single)}
            className="flex items-center gap-1 rounded px-1 text-ink-muted transition-colors hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
            title={isDeviceOffline(single) ? t('cloudOfflineTaskCancelled') : t('cloudStopTask')}
            aria-label={t('cloudStopTask')}
          >
            <Square size={10} />
            <span>
              {stoppingTaskIds[single.id] ? t('cloudStoppingTask') : t('cloudStopTask')}
            </span>
          </button>
        </>
      ) : multiLatest ? (
        <button
          type="button"
          onClick={() => setPopoverOpen((open) => !open)}
          className="flex items-center gap-1.5 transition-colors hover:text-ink"
          aria-expanded={popoverOpen}
        >
          <Cloud size={12} className={tone} />
          <span className="tabular-nums text-accent">
            {t('cloudTasksRunningSummary', {
              count: runningTasks.length,
              latest: `${multiLatest.id} ${statusText(multiLatest)} ${formatElapsed(multiLatest.startedAt ?? multiLatest.createdAt, now)}`,
            })}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-1.5 transition-colors hover:text-ink"
          title={label}
        >
          <Cloud size={12} className={tone} />
          <span className={tone}>{label}</span>
          {linked && unreadCount > 0 && (
            <span className="tabular-nums text-accent">
              {t('cloudUnreadCount', { count: unreadCount })}
            </span>
          )}
          {linked && pending > 0 && (
            <span className="text-ink-muted">{t('cloudPendingFrames', { count: pending })}</span>
          )}
        </button>
      )}

      {popoverOpen && runningTasks.length > 1 && (
        <div
          role="dialog"
          aria-label={t('cloudTasks')}
          className="absolute bottom-full right-0 z-50 mb-1.5 flex w-80 flex-col gap-2 rounded border border-line bg-raised p-2.5 shadow-print"
        >
          <div className="flex items-center justify-between border-b border-rule-divide pb-1.5">
            <span className="type-label text-ink">
              {t('cloudTasks')} ({runningTasks.length})
            </span>
            <button
              type="button"
              onClick={() => {
                setPopoverOpen(false)
                onOpen()
              }}
              className="type-caption text-accent hover:underline"
            >
              {t('cloudOpenCloudView')}
            </button>
          </div>
          <ul className="flex max-h-60 flex-col gap-2 overflow-y-auto">
            {runningTasks.map((task) => {
              const offline = isDeviceOffline(task)
              const stopping = Boolean(stoppingTaskIds[task.id])
              return (
                <li key={task.id} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate type-label text-ink">
                      {task.id} · {task.title}
                    </div>
                    <div className="truncate tabular-nums type-caption text-ink-muted">
                      {deviceLabel(task)} · {statusText(task)} ·{' '}
                      {formatElapsed(task.startedAt ?? task.createdAt, now)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void stopTask(task.id)}
                    disabled={stopping || offline}
                    className="flex flex-shrink-0 items-center gap-1 rounded border border-rule-control px-1.5 py-0.5 type-caption text-ink-muted transition-colors hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
                    title={offline ? t('cloudOfflineTaskCancelled') : t('cloudStopTask')}
                  >
                    <Square size={10} />
                    <span>{stopping ? t('cloudStoppingTask') : t('cloudStopTask')}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
