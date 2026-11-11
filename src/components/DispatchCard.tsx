/**
 * 「云端 → 派活」卡片：开关 + 工作区白名单 + 运行态 + 急停 + 最近任务。
 *
 * 界面只显示本机路径给用户自己看；上云的只有「名字 + 说明」。
 * 三件必须让人一眼看到的事：开关状态、网关连没连上、现在在跑什么。
 */

import React, { useEffect, useState } from 'react'
import { FolderPlus, PowerOff, Radio, Trash2 } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useDispatchStore, type DispatchRecentTask } from '../store/dispatchStore'
import { dispatchApi } from '../api/dispatch'
import { formatRelativeTime } from '../utils/relativeTime'
import { Button, Caption, DataText, Input, Modal, Spinner } from './ui'
import { Card, CardHeader, StatusText } from './patterns'

const RECENT_SHOW = 5

export const DispatchCard: React.FC<{ connected: boolean }> = ({ connected }) => {
  const { t, language } = useI18nStore()
  const config = useDispatchStore((state) => state.config)
  const loading = useDispatchStore((state) => state.loading)
  const busy = useDispatchStore((state) => state.busy)
  const error = useDispatchStore((state) => state.error)
  const recent = useDispatchStore((state) => state.recent)
  const load = useDispatchStore((state) => state.load)
  const setEnabled = useDispatchStore((state) => state.setEnabled)
  const addWorkspace = useDispatchStore((state) => state.addWorkspace)
  const updateWorkspace = useDispatchStore((state) => state.updateWorkspace)
  const removeWorkspace = useDispatchStore((state) => state.removeWorkspace)
  const stop = useDispatchStore((state) => state.stop)
  const applyState = useDispatchStore((state) => state.applyState)

  const [editing, setEditing] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftDescription, setDraftDescription] = useState('')
  const [confirmStop, setConfirmStop] = useState(false)
  /** 打开完整报告的那一条（账本里一行放不下，全文在这里看） */
  const [report, setReport] = useState<DispatchRecentTask | null>(null)

  useEffect(() => {
    if (!dispatchApi.hasBridge()) return
    void load()
    return dispatchApi.onState((payload) => applyState(payload))
  }, [applyState, load])

  if (!dispatchApi.hasBridge()) {
    return (
      <Card>
        <CardHeader title={t('cloudDispatchTitle')} />
        <Caption className="pt-3 text-ink-subtle">{t('cloudDispatchLocalOnly')}</Caption>
      </Card>
    )
  }

  const { state } = config
  const running = state.runningTaskId !== null
  const statusTone = !config.enabled ? 'muted' : state.connected ? 'success' : 'warning'
  const statusText = !config.enabled
    ? t('cloudDispatchOff')
    : state.connected
      ? t('cloudDispatchConnected')
      : t('cloudDispatchDisconnected')

  const beginEdit = (id: string, label: string, description: string) => {
    setEditing(id)
    setDraftLabel(label)
    setDraftDescription(description)
  }

  const commitEdit = async () => {
    if (!editing) return
    await updateWorkspace({ id: editing, label: draftLabel, description: draftDescription })
    setEditing(null)
  }

  return (
    <Card>
      <CardHeader
        title={t('cloudDispatchTitle')}
        action={
          <Button
            size="sm"
            icon={Radio}
            variant={config.enabled ? 'ghost' : 'primary'}
            loading={busy || loading}
            disabled={busy || (!config.enabled && config.workspaces.length === 0)}
            onClick={() => void setEnabled(!config.enabled)}
          >
            {/* 按钮写「动作」，状态写「结果」：开启时按钮不能显示「已关闭」 */}
            {config.enabled ? t('cloudDispatchDisable') : t('cloudDispatchEnable')}
          </Button>
        }
      />

      <div className="flex flex-col gap-3 pt-3">
        <div className="flex items-center justify-between gap-3">
          <Caption className="text-ink-muted">{t('cloudDispatchEnable')}</Caption>
          <StatusText tone={statusTone}>{statusText}</StatusText>
        </div>

        {!connected && config.enabled && (
          <Caption className="text-ink-subtle">{t('cloudDispatchDisconnected')}</Caption>
        )}

        {running && (
          <div className="flex items-center justify-between gap-3 rounded-sm border border-rule-hairline px-3 py-2">
            <div className="flex flex-col gap-0.5">
              <StatusText tone="accent">
                {t('cloudDispatchRunning', { workspace: state.runningWorkspace ?? '' })}
              </StatusText>
              {state.question && (
                <Caption className="text-ink-subtle">
                  {t('cloudDispatchQuestion', { question: state.question })}
                </Caption>
              )}
              {state.queued > 0 && (
                <Caption className="text-ink-subtle">
                  {t('cloudDispatchQueued', { count: state.queued })}
                </Caption>
              )}
            </div>
            <Button size="sm" icon={PowerOff} variant="danger" onClick={() => setConfirmStop(true)}>
              {t('cloudDispatchStop')}
            </Button>
          </div>
        )}

        {config.workspaces.length === 0 ? (
          <Caption className="text-ink-subtle">{t('cloudDispatchEmpty')}</Caption>
        ) : (
          <div className="flex flex-col gap-2">
            {config.workspaces.map((workspace) => (
              <div
                key={workspace.id}
                className="flex flex-col gap-1.5 rounded-sm border border-rule-hairline px-3 py-2"
              >
                {editing === workspace.id ? (
                  <div className="flex flex-col gap-2">
                    <Input
                      value={draftLabel}
                      onChange={(event) => setDraftLabel(event.target.value)}
                      placeholder={t('cloudDispatchLabel')}
                      maxLength={120}
                    />
                    <Input
                      value={draftDescription}
                      onChange={(event) => setDraftDescription(event.target.value)}
                      placeholder={t('cloudDispatchDescription')}
                      maxLength={400}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" loading={busy} onClick={() => void commitEdit()}>
                        {t('save')}
                      </Button>
                      <Button size="sm" onClick={() => setEditing(null)}>
                        {t('cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <DataText className="truncate text-ink">{workspace.label}</DataText>
                        {workspace.description && (
                          <Caption className="text-ink-subtle">{workspace.description}</Caption>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {!workspace.exists ? (
                          <StatusText tone="danger">{t('cloudDispatchMissing')}</StatusText>
                        ) : workspace.published ? (
                          <StatusText tone="success">{t('cloudDispatchOn')}</StatusText>
                        ) : (
                          <StatusText tone="muted">{t('cloudDispatchPublishing')}</StatusText>
                        )}
                        <button
                          type="button"
                          className="type-caption px-1 text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
                          onClick={() =>
                            beginEdit(workspace.id, workspace.label, workspace.description)
                          }
                        >
                          {t('cloudDispatchRename')}
                        </button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={Trash2}
                          disabled={busy}
                          onClick={() => void removeWorkspace(workspace.id)}
                        >
                          {t('cloudDispatchRemove')}
                        </Button>
                      </div>
                    </div>
                    <DataText className="truncate text-ink-subtle">{workspace.path}</DataText>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={FolderPlus} loading={busy} onClick={() => void addWorkspace()}>
            {t('cloudDispatchAdd')}
          </Button>
          {busy && <Spinner size={14} />}
        </div>

        <Caption className="text-ink-subtle">{t('cloudDispatchPathHidden')}</Caption>
        <Caption className="text-ink-subtle">{t('cloudDispatchHint')}</Caption>
        {error && <Caption className="text-danger">{error}</Caption>}

        <div className="flex flex-col gap-1.5 border-t border-rule-divide pt-2">
          <Caption className="text-ink-muted">{t('cloudDispatchRecent')}</Caption>
          {recent.length === 0 ? (
            <Caption className="text-ink-subtle">{t('cloudDispatchRecentEmpty')}</Caption>
          ) : (
            recent.slice(0, RECENT_SHOW).map((entry) => (
              <button
                key={`${entry.taskId}-${entry.at}`}
                type="button"
                className="flex w-full flex-col gap-0.5 rounded-sm text-left transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                title={t('cloudDispatchReportOpen')}
                onClick={() => setReport(entry)}
              >
                <span className="flex w-full items-center justify-between gap-3">
                  <DataText className="truncate text-ink">{entry.workspaceLabel}</DataText>
                  <StatusText
                    tone={
                      entry.state === 'completed'
                        ? 'success'
                        : entry.state === 'canceled'
                          ? 'muted'
                          : 'danger'
                    }
                  >
                    {entry.state === 'completed'
                      ? t('cloudDispatchStateCompleted')
                      : entry.state === 'canceled'
                        ? t('cloudDispatchStateCanceled')
                        : t('cloudDispatchStateFailed')}
                  </StatusText>
                </span>
                {/* 一行预览：全文放不下，点开看报告 */}
                <span className="w-full truncate type-caption text-ink-subtle">
                  {entry.summary || t('cloudDispatchReportEmpty')}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      <Modal
        open={report !== null}
        title={t('cloudDispatchReportTitle')}
        size="lg"
        onClose={() => setReport(null)}
        footer={<Button onClick={() => setReport(null)}>{t('close')}</Button>}
      >
        {report && (
          <div className="flex min-h-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <DataText className="text-ink">{report.workspaceLabel}</DataText>
              <Caption className="text-ink-muted">
                {formatRelativeTime(report.at, language)}
              </Caption>
              {report.sessionId && (
                <Caption className="text-ink-subtle">
                  {t('cloudDispatchReportSession', { session: report.sessionId.slice(0, 8) })}
                </Caption>
              )}
            </div>
            {report.summary ? (
              <pre className="m-0 max-h-[55vh] overflow-auto whitespace-pre-wrap break-words border border-rule-hairline bg-sunken p-2 type-data text-ink">
                {report.summary}
              </pre>
            ) : (
              <Caption className="text-ink-subtle">{t('cloudDispatchReportEmpty')}</Caption>
            )}
            {report.truncated && (
              <Caption className="text-ink-subtle">{t('cloudDispatchReportTruncated')}</Caption>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={confirmStop}
        title={t('cloudDispatchStop')}
        onClose={() => setConfirmStop(false)}
        footer={
          <>
            <Button onClick={() => setConfirmStop(false)}>{t('cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmStop(false)
                void stop()
              }}
            >
              {t('cloudDispatchStop')}
            </Button>
          </>
        }
      >
        <p className="m-0 type-caption text-ink-muted">{t('cloudDispatchStopConfirm')}</p>
        <p className="m-0 type-caption text-ink-subtle">{t('cloudDispatchStopHint')}</p>
      </Modal>
    </Card>
  )
}
