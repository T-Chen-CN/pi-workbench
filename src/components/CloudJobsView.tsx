/**
 * 任务页：云端定时任务（cron）。
 *
 * 只做四件事：看列表、立刻跑一次、暂停、恢复。**不给新建也不给删除**——
 * 新建等于把一段 prompt 交给调度器，那该在对话里让 Agent 建；删除是不可逆动作，
 * 这里只留暂停（想删就暂停，人再去服务器上删）。
 */

import React, { useEffect, useState } from 'react'
import { AlertCircle, CalendarClock, Loader2, Pause, Play, RefreshCw, RotateCw } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import type { CloudJob } from '../types/cloud'
import { Button, Caption, DataText, EmptyState, IconButton, Label, Spinner } from './ui'
import { formatRelativeTime } from '../utils/relativeTime'

/** 服务端 `effective_job_state` 的四种取值 */
function stateLabelKey(state: string): 'cloudJobStateScheduled' | 'cloudJobStatePaused' | 'cloudJobStateCompleted' | 'cloudJobStateError' {
  if (state === 'paused') return 'cloudJobStatePaused'
  if (state === 'completed') return 'cloudJobStateCompleted'
  if (state === 'error') return 'cloudJobStateError'
  return 'cloudJobStateScheduled'
}

const Row: React.FC<{
  job: CloudJob
  connected: boolean
  pending: boolean
  onRun: () => void
  onPause: () => void
  onResume: () => void
}> = ({ job, connected, pending, onRun, onPause, onResume }) => {
  const { t, language } = useI18nStore()
  const paused = job.state === 'paused' || !job.enabled
  const tone =
    job.state === 'error' ? 'text-danger' : paused ? 'text-ink-muted' : 'text-success'
  const live = Boolean(job.liveExecution)
  const last = job.latestExecution

  return (
    <div className="border-b border-rule-divide px-4 py-3 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <DataText className="min-w-0 flex-1 truncate text-ink">{job.name || job.id}</DataText>
        <Label className={tone}>{t(stateLabelKey(job.state))}</Label>
        {live && <Caption className="text-accent">{t('cloudJobRunning')}</Caption>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Caption className="text-ink-muted">{job.scheduleDisplay || job.schedule}</Caption>
        {job.nextRunAt && (
          <Caption className="text-ink-subtle">
            {t('cloudJobNextRun', { time: formatRelativeTime(job.nextRunAt, language) })}
          </Caption>
        )}
        {!job.nextRunAt && job.state === 'completed' && (
          <Caption className="text-ink-subtle">{t('cloudJobNoNextRun')}</Caption>
        )}
        {last?.status && (
          <Caption className={last.error ? 'text-danger' : 'text-ink-subtle'}>
            {t('cloudJobLastRun', {
              status: last.status,
              time: formatRelativeTime(last.finishedAt ?? last.claimedAt ?? job.lastRunAt ?? '', language),
            })}
          </Caption>
        )}
        {typeof job.repeat === 'number' && (
          <Caption className="text-ink-subtle">{t('cloudJobRepeat', { count: job.repeat })}</Caption>
        )}
      </div>
      {job.prompt && (
        <pre className="m-0 mt-1.5 max-h-20 overflow-auto whitespace-pre-wrap break-words type-caption text-ink-muted">
          {job.prompt}
        </pre>
      )}
      {job.pausedReason && (
        <div className="mt-1 type-caption text-ink-subtle">
          {t('cloudJobPausedReason', { reason: job.pausedReason })}
        </div>
      )}
      {last?.error && (
        <div className="mt-1 flex items-start gap-1 type-caption text-danger">
          <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
          <span className="min-w-0 break-words">{last.error}</span>
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <Button size="sm" icon={Play} disabled={!connected || pending} onClick={onRun}>
          {t('cloudJobRunNow')}
        </Button>
        {paused ? (
          <Button size="sm" icon={RotateCw} disabled={!connected || pending} onClick={onResume}>
            {t('cloudJobResume')}
          </Button>
        ) : (
          <Button size="sm" icon={Pause} disabled={!connected || pending} onClick={onPause}>
            {t('cloudJobPause')}
          </Button>
        )}
        {pending && <Spinner size={12} />}
      </div>
    </div>
  )
}

export const CloudJobsView: React.FC<{ active: boolean; onNavigate?: (view: 'cloud-connection') => void }> = ({
  active,
  onNavigate,
}) => {
  const { t } = useI18nStore()
  const jobs = useCloudStore((state) => state.jobs)
  const loading = useCloudStore((state) => state.jobsLoading)
  const error = useCloudStore((state) => state.jobsError)
  const pending = useCloudStore((state) => state.jobActionPending)
  const connection = useCloudStore((state) => state.connection)
  const loadJobs = useCloudStore((state) => state.loadJobs)
  const runJob = useCloudStore((state) => state.runJob)
  const pauseJob = useCloudStore((state) => state.pauseJob)
  const resumeJob = useCloudStore((state) => state.resumeJob)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const connected = connection === 'connected'

  // 只有切到这一页（或已连接后首次进入）才拉：任务列表不参与会话页的轮询
  useEffect(() => {
    if (!active || !connected) return
    setLoadedOnce(true)
    void loadJobs()
  }, [active, connected, loadJobs])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 flex-shrink-0 items-center gap-2 border-b border-rule-divide px-3">
        <CalendarClock size={12} className="flex-shrink-0 text-ink-subtle" />
        <span className="type-caption text-ink">{t('cloudTabJobs')}</span>
        {jobs.length > 0 && (
          <Caption className="text-ink-subtle">{t('cloudJobCount', { count: jobs.length })}</Caption>
        )}
        <span className="flex-1" />
        {loading && <Loader2 size={12} className="animate-spin text-ink-subtle" />}
        <IconButton
          icon={RefreshCw}
          label={t('cloudJobRefresh')}
          size="sm"
          disabled={!connected || loading}
          onClick={() => void loadJobs()}
        />
      </div>

      {error && (
        <div className="flex-shrink-0 border-b border-rule-divide px-3 py-1.5 type-caption text-danger">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!connected && (
          <EmptyState
            icon={CalendarClock}
            title={t('cloudJobNeedsConnection')}
            description={t('cloudJobNeedsConnectionHint')}
            action={
              onNavigate ? (
                <Button size="sm" onClick={() => onNavigate('cloud-connection')}>
                  {t('cloudGoToConnection')}
                </Button>
              ) : undefined
            }
          />
        )}
        {connected && loading && jobs.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <Spinner size={16} />
          </div>
        )}
        {connected && loadedOnce && !loading && jobs.length === 0 && (
          <EmptyState
            icon={CalendarClock}
            title={t('cloudJobEmpty')}
            description={t('cloudJobEmptyHint')}
          />
        )}
        {connected &&
          jobs.map((job) => (
            <Row
              key={job.id}
              job={job}
              connected={connected}
              pending={pending === job.id}
              onRun={() => void runJob(job.id)}
              onPause={() => void pauseJob(job.id)}
              onResume={() => void resumeJob(job.id)}
            />
          ))}
      </div>

      <div className="flex-shrink-0 border-t border-rule-divide px-3 py-1.5">
        <Caption className="text-ink-subtle">{t('cloudJobFootnote')}</Caption>
      </div>
    </div>
  )
}
