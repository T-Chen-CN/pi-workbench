import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import type { FleetTask, FleetTaskStatus } from '../types/electron'

interface FleetPanelProps {
  workspacePath: string
  open: boolean
  onClose: () => void
}

const STATUS_STYLES: Record<FleetTaskStatus, string> = {
  queued: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
  running: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  succeeded: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  failed: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  cancelled: 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400',
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

  const refresh = useCallback(async () => {
    const result = await api.fleetList(workspacePath)
    if (result.success) {
      setTasks(result.tasks)
    } else {
      setError(result.error || 'Failed to load Fleet tasks')
    }
  }, [workspacePath])

  useEffect(() => {
    if (!open) return

    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 2000)
    const unsubscribe = api.onFleetTaskUpdated(() => {
      void refresh()
    })

    return () => {
      clearInterval(timer)
      unsubscribe()
    }
  }, [open, refresh])

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
        setError(result.error || 'Failed to create task')
      }
    } finally {
      setBusy(false)
    }
  }

  const cancelTask = async (task: FleetTask) => {
    const result = await api.fleetCancel(task.id)
    if (!result.success) {
      toast.error(result.error || 'Failed to cancel task')
    }
    await refresh()
  }

  const cleanupTask = async (task: FleetTask) => {
    const result = await api.fleetCleanup(task.id)
    if (!result.success) {
      toast.error(result.error || 'Failed to remove worktree')
    } else {
      toast.success(t('fleetCleanupDone'))
    }
    await refresh()
  }

  if (!open) return null

  const selectedTask = tasks.find((task) => task.id === selectedId) ?? null

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white dark:bg-[#1e1e1e] border border-gray-300 dark:border-gray-700 rounded-lg w-11/12 h-5/6 max-w-4xl shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('fleetTasks')}
            <span className="ml-2 text-xs font-normal text-gray-500">
              {tasks.length}
            </span>
          </h3>
          <button
            onClick={onClose}
            title={t('close')}
            className="bg-none border-none cursor-pointer text-xl text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
          >
            ✕
          </button>
        </div>

        {/* Create form */}
        <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-700 flex flex-col gap-2 flex-shrink-0">
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('fleetNamePlaceholder')}
              className="flex-1 bg-gray-50 dark:bg-[#252526] text-sm text-gray-900 dark:text-gray-100 px-3 py-2 rounded border border-gray-300 dark:border-gray-700 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={() => void createTask()}
              disabled={busy || !name.trim() || !prompt.trim()}
              className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? t('fleetCreating') : t('fleetCreate')}
            </button>
          </div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('fleetPromptPlaceholder')}
            rows={2}
            className="w-full bg-gray-50 dark:bg-[#252526] text-sm text-gray-900 dark:text-gray-100 px-3 py-2 rounded border border-gray-300 dark:border-gray-700 focus:outline-none focus:border-blue-500 resize-none"
          />
          <p className="text-xs text-gray-500">{t('fleetHint')}</p>
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <div className="flex-1 overflow-y-auto">
          {tasks.length === 0 ? (
            <div className="px-5 py-10 text-sm text-center text-gray-500">{t('fleetEmpty')}</div>
          ) : (
            tasks.map((task) => (
              <div
                key={task.id}
                className="px-5 py-3 border-b border-gray-100 dark:border-gray-700/60"
              >
                <div className="flex items-center gap-3">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[task.status]}`}>
                    {t(STATUS_KEYS[task.status])}
                  </span>
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {task.name}
                  </span>
                  <span className="text-xs text-gray-500 truncate flex-1">{task.branch}</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setSelectedId(selectedId === task.id ? null : task.id)}
                      className="px-2 py-1 text-xs rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600"
                    >
                      {t('fleetViewLog')}
                    </button>
                    {(task.status === 'queued' || task.status === 'running') && (
                      <button
                        onClick={() => void cancelTask(task)}
                        className="px-2 py-1 text-xs rounded bg-red-600 text-white hover:bg-red-700"
                      >
                        {t('fleetCancel')}
                      </button>
                    )}
                    {task.status !== 'queued' &&
                      task.status !== 'running' &&
                      !task.worktreeRemoved && (
                        <button
                          onClick={() => void cleanupTask(task)}
                          className="px-2 py-1 text-xs rounded border border-gray-400 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                        >
                          {t('fleetCleanup')}
                        </button>
                      )}
                  </div>
                </div>

                <div className="mt-1 text-xs text-gray-500 truncate" title={task.worktree}>
                  {task.prompt}
                </div>
                {task.error && (
                  <div className="mt-1 text-xs text-red-600 dark:text-red-400">{task.error}</div>
                )}

                {selectedId === task.id && (
                  <pre className="mt-2 max-h-48 overflow-auto text-xs font-mono whitespace-pre-wrap bg-gray-50 dark:bg-[#252526] border border-gray-200 dark:border-gray-700 rounded p-2 text-gray-800 dark:text-gray-200">
                    {task.output || task.error || t('fleetLogEmpty')}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>

        {selectedTask && (
          <div className="px-5 py-2 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 flex-shrink-0">
            {selectedTask.worktreeRemoved ? t('fleetWorktreeRemoved') : selectedTask.worktree}
          </div>
        )}
      </div>
    </div>
  )
}
