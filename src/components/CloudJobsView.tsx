/**
 * 任务页：云端定时任务（cron）。
 *
 * 做五件事：看列表、新建、立刻跑一次、暂停、恢复。**不给删除**——删除是不可逆动作，
 * 这里只留暂停（想删就暂停，人再去服务器上删）。
 */

import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, CalendarClock, Loader2, Pause, Play, Plus, RefreshCw, RotateCw } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import type { CloudJob } from '../types/cloud'
import { Button, Caption, DataText, EmptyState, Field, IconButton, Input, Label, Modal, Spinner, Textarea } from './ui'
import { formatRelativeTime } from '../utils/relativeTime'

/** 调度快捷项：覆盖「间隔 / 每天 / 工作日」三种最常见意图，也能自己敲 */
const SCHEDULE_PRESETS = ['every 30m', 'every 2h', 'every day at 9am', '0 9 * * 1-5']

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
  const createJob = useCloudStore((state) => state.createJob)
  const creating = useCloudStore((state) => state.jobCreatePending)
  const [loadedOnce, setLoadedOnce] = useState(false)
  /** 暂停任务点「现在跑一次」要先说清楚：服务端会顺手把它恢复成排期 */
  const [runTarget, setRunTarget] = useState<CloudJob | null>(null)
  /** 新建表单：存在组件里就够，关掉即丢弃（不落盘、不跨页面） */
  const [createOpen, setCreateOpen] = useState(false)
  const [draft, setDraft] = useState({ name: '', schedule: '', prompt: '', repeat: '' })
  const draftReady = Boolean(draft.name.trim() && draft.schedule.trim() && draft.prompt.trim())
  const pollRef = useRef<number | null>(null)
  const connected = connection === 'connected'

  const openCreate = () => {
    setDraft({ name: '', schedule: '', prompt: '', repeat: '' })
    setCreateOpen(true)
  }

  const submitCreate = () => {
    if (!draftReady) return
    const repeat = draft.repeat.trim() ? Number(draft.repeat.trim()) : undefined
    void createJob({
      name: draft.name.trim(),
      schedule: draft.schedule.trim(),
      prompt: draft.prompt.trim(),
      ...(typeof repeat === 'number' && Number.isInteger(repeat) && repeat > 0 ? { repeat } : {}),
    }).then((ok) => {
      if (ok) setCreateOpen(false)
    })
  }

  /**
   * 跑一次之后隔几秒补两次刷新。
   * 服务端是先置 due 再调度，点完立刻看只会看到「已排期」，几秒后才有「上次 completed」。
   */
  const refreshAfterRun = () => {
    if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    let tries = 0
    const tick = () => {
      tries += 1
      void loadJobs().then(() => {
        if (tries < 3) pollRef.current = window.setTimeout(tick, 4000)
      })
    }
    pollRef.current = window.setTimeout(tick, 3000)
  }

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    }
  }, [])

  // 只有切到这一页（或已连接后首次进入）才拉：任务列表不参与会话页的轮询
  useEffect(() => {
    if (!active || !connected) return
    setLoadedOnce(true)
    void loadJobs()
  }, [active, connected, loadJobs])

  return (
    // 四个云端页面是叠放的常驻视图：必须 absolute inset-0 + 非激活时 inert，
    // 否则会跑进文档流、盖在别的页面上（真机上出现过）
    <div
      aria-hidden={!active}
      inert={!active}
      className={`absolute inset-0 flex flex-col ${
        active ? 'visible' : 'pointer-events-none invisible'
      }`}
    >
      <div className="flex h-8 flex-shrink-0 items-center gap-2 border-b border-rule-divide px-3">
        <CalendarClock size={12} className="flex-shrink-0 text-ink-subtle" />
        <span className="type-caption text-ink">{t('cloudTabJobs')}</span>
        {jobs.length > 0 && (
          <Caption className="text-ink-subtle">{t('cloudJobCount', { count: jobs.length })}</Caption>
        )}
        <span className="flex-1" />
        {loading && <Loader2 size={12} className="animate-spin text-ink-subtle" />}
        <IconButton icon={Plus} label={t('cloudJobCreate')} size="sm" disabled={!connected} onClick={openCreate} />
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
            action={
              <Button size="sm" icon={Plus} onClick={openCreate}>
                {t('cloudJobCreate')}
              </Button>
            }
          />
        )}
        {connected &&
          jobs.map((job) => (
            <Row
              key={job.id}
              job={job}
              connected={connected}
              pending={pending === job.id}
              onRun={() => {
                if (job.state === 'paused' || !job.enabled) {
                  setRunTarget(job)
                  return
                }
                void runJob(job.id).then((ok) => {
                  if (ok) refreshAfterRun()
                })
              }}
              onPause={() => void pauseJob(job.id)}
              onResume={() => void resumeJob(job.id)}
            />
          ))}
      </div>

      <div className="flex-shrink-0 border-t border-rule-divide px-3 py-1.5">
        <Caption className="text-ink-subtle">{t('cloudJobFootnote')}</Caption>
      </div>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('cloudJobCreateTitle')}
        footer={
          <>
            <Button size="sm" onClick={() => setCreateOpen(false)}>
              {t('cloudCancel')}
            </Button>
            <Button size="sm" variant="primary" disabled={!draftReady || creating} onClick={submitCreate}>
              {t('cloudJobCreateSubmit')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          <Field label={t('cloudJobCreateName')} htmlFor="cloud-job-name">
            <Input
              id="cloud-job-name"
              value={draft.name}
              maxLength={200}
              placeholder={t('cloudJobCreateNamePlaceholder')}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            />
          </Field>
          <Field label={t('cloudJobCreateSchedule')} htmlFor="cloud-job-schedule">
            <Input
              id="cloud-job-schedule"
              value={draft.schedule}
              maxLength={120}
              placeholder={t('cloudJobCreateSchedulePlaceholder')}
              onChange={(event) => setDraft((prev) => ({ ...prev, schedule: event.target.value }))}
            />
          </Field>
          <div className="-mt-1 flex flex-wrap gap-1.5">
            {SCHEDULE_PRESETS.map((preset) => (
              <Button
                key={preset}
                size="sm"
                onClick={() => setDraft((prev) => ({ ...prev, schedule: preset }))}
              >
                {preset}
              </Button>
            ))}
          </div>
          <Caption className="text-ink-subtle">{t('cloudJobCreateScheduleHint')}</Caption>
          <Field label={t('cloudJobCreatePrompt')} htmlFor="cloud-job-prompt">
            <Textarea
              id="cloud-job-prompt"
              rows={4}
              value={draft.prompt}
              maxLength={5000}
              placeholder={t('cloudJobCreatePromptPlaceholder')}
              onChange={(event) => setDraft((prev) => ({ ...prev, prompt: event.target.value }))}
            />
          </Field>
          <Field
            label={t('cloudJobCreateRepeat')}
            htmlFor="cloud-job-repeat"
            hint={t('cloudJobCreateRepeatOptional')}
          >
            <Input
              id="cloud-job-repeat"
              type="number"
              min={1}
              value={draft.repeat}
              placeholder={t('cloudJobCreateRepeatPlaceholder')}
              onChange={(event) => setDraft((prev) => ({ ...prev, repeat: event.target.value }))}
            />
          </Field>
          {error && <div className="type-caption text-danger">{error}</div>}
        </div>
      </Modal>

      <Modal
        open={Boolean(runTarget)}
        onClose={() => setRunTarget(null)}
        title={t('cloudJobRunPausedTitle')}
        footer={
          <>
            <Button size="sm" onClick={() => setRunTarget(null)}>
              {t('cloudCancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const target = runTarget
                setRunTarget(null)
                if (target) void runJob(target.id).then((ok) => ok && refreshAfterRun())
              }}
            >
              {t('cloudJobRunPausedConfirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 px-5 py-4">
          <Caption className="text-ink-muted">{t('cloudJobRunPausedBody')}</Caption>
        </div>
      </Modal>
    </div>
  )
}
