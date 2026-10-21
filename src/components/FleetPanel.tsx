import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FileDiff, FileText, Plus, Ship, X } from 'lucide-react'
import { api } from '../api'
import { useI18nStore } from '../store/i18nStore'
import { useEditorStore } from '../store/editorStore'
import { useDialogStore, confirmDialog } from '../store/dialogStore'
import { localizeError } from '../i18n/errors'
import { toast } from '../store/toastStore'
import { Button, EmptyState, IconButton, Input, Spinner, Textarea } from './ui'
import { StatusText, type StatusTone } from './patterns'
import { FleetDiffModal } from './FleetDiffModal'
import type { FleetTask, FleetTaskStatus } from '../types/electron'

interface FleetPanelProps {
  workspacePath: string
  open: boolean
  onClose: () => void
}

const STATUS_TONES: Record<FleetTaskStatus, StatusTone> = {
  queued: 'muted',
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'warning',
}

const STATUS_KEYS: Record<FleetTaskStatus, 'fleetQueued' | 'fleetRunning' | 'fleetSucceeded' | 'fleetFailed' | 'fleetCancelled'> = {
  queued: 'fleetQueued',
  running: 'fleetRunning',
  succeeded: 'fleetSucceeded',
  failed: 'fleetFailed',
  cancelled: 'fleetCancelled',
}

export const FleetPanel: React.FC<FleetPanelProps> = ({ workspacePath, open, onClose }) => {
  const { t } = useI18nStore()
  const [tasks, setTasks] = useState<FleetTask[]>([])
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [diffTaskId, setDiffTaskId] = useState<string | null>(null)
  const [mergingId, setMergingId] = useState<string | null>(null)
  const refreshingRef = useRef(false)
  const pendingRefreshRef = useRef(false)

  const refresh = useCallback(async () => {
    // 轮询与任务事件可能同时触发：进行中时记一个待刷新，结束后再补一次
    if (refreshingRef.current) {
      pendingRefreshRef.current = true
      return
    }
    refreshingRef.current = true
    try {
      const result = await api.fleetList(workspacePath)
      if (result.success) {
        setTasks(result.tasks)
      } else {
        setError(t('fleetLoadFailed', { error: localizeError(result.error) || t('unknownError') }))
      }
    } finally {
      refreshingRef.current = false
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false
        void refresh()
      }
    }
  }, [workspacePath, t])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // 有 diff 弹窗或确认对话框时，Esc 只关闭上层
      if (diffTaskId || useDialogStore.getState().current) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose, diffTaskId])

  useEffect(() => {
    if (!open) return

    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 5000)
    const unsubscribe = api.onFleetTaskUpdated(() => {
      void refresh()
    })

    return () => {
      clearInterval(timer)
      unsubscribe()
    }
  }, [open, refresh])

  const selectTask = async (id: string) => {
    const next = selectedId === id ? null : id
    setSelectedId(next)
    if (!next) return

    // 展开时拉取一次最新详情，避免依赖列表快照里的旧输出
    const result = await api.fleetGet(next)
    const detail = result.task
    if (result.success && detail) {
      setTasks((previous) =>
        previous.map((task) => (task.id === next ? detail : task))
      )
    }
  }

  const createTask = async () => {
    if (!name.trim() || !prompt.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.fleetCreate(workspacePath, name.trim(), prompt.trim())
      if (result.success && result.task) {
        setName('')
        setPrompt('')
        setSelectedId(result.task.id)
        toast.success(t('fleetCreated'))
        await refresh()
      } else {
        setError(t('fleetCreateFailed', { error: localizeError(result.error) || t('unknownError') }))
      }
    } finally {
      setBusy(false)
    }
  }

  const cancelTask = async (task: FleetTask) => {
    const result = await api.fleetCancel(task.id, workspacePath)
    if (!result.success) {
      toast.error(t('fleetCancelFailed', { error: localizeError(result.error) || t('unknownError') }))
    }
    await refresh()
  }

  const cleanupTask = async (task: FleetTask) => {
    const result = await api.fleetCleanup(task.id, workspacePath)
    if (!result.success) {
      toast.error(t('fleetCleanupFailed', { error: localizeError(result.error) || t('unknownError') }))
    } else {
      toast.success(t('fleetCleanupDone'))
    }
    await refresh()
  }

  const mergeTask = async (task: FleetTask) => {
    if (useEditorStore.getState().hasDirtyFiles()) {
      toast.error(t('fleetMergeSaveFirst'))
      return
    }

    const confirmed = await confirmDialog({
      title: t('fleetMerge'),
      message: t('fleetMergeConfirm', { name: task.name }),
      confirmLabel: t('fleetMerge'),
    })
    if (!confirmed) return

    setMergingId(task.id)
    try {
      const result = await api.fleetMerge(task.id, workspacePath)
      if (!result.success) {
        if (result.conflictFiles && result.conflictFiles.length > 0) {
          toast.error(t('fleetMergeConflict', { files: result.conflictFiles.join(', ') }))
        } else {
          toast.error(
            t('fleetMergeFailed', {
              error: localizeError(result.error) || t('unknownError'),
            })
          )
        }
        return
      }

      toast.success(t('fleetMergeSuccess'))
      await refresh()
    } finally {
      setMergingId(null)
    }
  }

  if (!open) return null

  const selectedTask = tasks.find((task) => task.id === selectedId) ?? null
  const diffTask = diffTaskId ? tasks.find((task) => task.id === diffTaskId) ?? null : null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
    >
      <div className="absolute inset-0 bg-overlay/50" onClick={onClose} />
      <div className="relative flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden border border-line bg-raised shadow-print">
        <div className="flex h-11 flex-shrink-0 items-center justify-between border-b border-rule-divide px-4">
          <div className="flex items-center gap-2">
            <Ship size={15} className="text-accent" />
            <h3 className="m-0 type-label text-ink">{t('fleetTasks')}</h3>
            <span className="border border-rule-control px-1.5 py-0.5 type-caption text-ink-muted">
              {tasks.length}
            </span>
          </div>
          <IconButton icon={X} label={t('close')} size="sm" onClick={onClose} />
        </div>

        {/* Create form */}
        <div className="flex flex-shrink-0 flex-col gap-2 border-b border-rule-divide p-3">
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('fleetNamePlaceholder')}
              className="flex-1"
            />
            <Button
              variant="primary"
              size="sm"
              icon={Plus}
              onClick={() => void createTask()}
              disabled={busy || !name.trim() || !prompt.trim()}
            >
              {busy ? t('fleetCreating') : t('fleetCreate')}
            </Button>
          </div>
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('fleetPromptPlaceholder')}
            rows={2}
          />
          <p className="m-0 type-caption text-ink-muted">{t('fleetHint')}</p>
          {error && <p className="m-0 type-caption text-danger">{error}</p>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tasks.length === 0 ? (
            <EmptyState icon={Ship} title={t('fleetEmpty')} description={t('fleetHint')} />
          ) : (
            tasks.map((task) => (
              <div
                key={task.id}
                className="border-b border-rule-divide px-4 py-2.5 transition-colors hover:bg-hover/40"
              >
                <div className="flex items-center gap-2.5">
                  <StatusText
                    tone={STATUS_TONES[task.status]}
                    dot
                    className="w-[64px] flex-shrink-0"
                  >
                    {t(STATUS_KEYS[task.status])}
                  </StatusText>
                  <span className="truncate type-value text-ink">{task.name}</span>
                  <span className="flex-1 truncate type-data text-ink-muted">
                    {task.branch}
                  </span>
                  <div className="flex flex-shrink-0 items-center gap-1">
                    {task.mergedAt && (
                      <span className="type-caption text-success">{t('fleetMerged')}</span>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={FileText}
                      onClick={() => void selectTask(task.id)}
                    >
                      {t('fleetViewLog')}
                    </Button>
                    {task.status !== 'queued' &&
                      task.status !== 'running' &&
                      !task.worktreeRemoved && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={FileDiff}
                          onClick={() => setDiffTaskId(task.id)}
                        >
                          {t('fleetViewChanges')}
                        </Button>
                      )}
                    {task.status === 'succeeded' &&
                      !task.worktreeRemoved &&
                      !task.mergedAt && (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={mergingId === task.id}
                          disabled={Boolean(mergingId)}
                          onClick={() => void mergeTask(task)}
                        >
                          {t('fleetMerge')}
                        </Button>
                      )}
                    {(task.status === 'queued' || task.status === 'running') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:bg-danger/10 hover:text-danger"
                        onClick={() => void cancelTask(task)}
                      >
                        {t('fleetCancel')}
                      </Button>
                    )}
                    {task.status !== 'queued' &&
                      task.status !== 'running' &&
                      !task.worktreeRemoved && (
                        <Button variant="ghost" size="sm" onClick={() => void cleanupTask(task)}>
                          {t('fleetCleanup')}
                        </Button>
                      )}
                  </div>
                </div>

                <div className="mt-1 truncate type-caption text-ink-muted" title={task.worktree}>
                  {task.prompt}
                </div>
                {task.error && (
                  <div className="mt-1 type-caption text-danger">{task.error}</div>
                )}

                {selectedId === task.id && (
                  <pre className="m-0 mt-2 max-h-48 overflow-auto whitespace-pre-wrap border border-rule-control bg-sunken p-2 type-code text-ink-muted">
                    {task.output || task.error || t('fleetLogEmpty')}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>

        {selectedTask && (
          <div className="flex flex-shrink-0 items-center gap-2 border-t border-rule-divide px-4 py-1.5 type-caption text-ink-muted">
            {busy && <Spinner size={11} />}
            <span className="truncate type-data">
              {selectedTask.worktreeRemoved ? t('fleetWorktreeRemoved') : selectedTask.worktree}
            </span>
          </div>
        )}
      </div>

      {diffTask && (
        <FleetDiffModal
          task={diffTask}
          workspacePath={workspacePath}
          onClose={() => setDiffTaskId(null)}
        />
      )}
    </div>
  )
}
