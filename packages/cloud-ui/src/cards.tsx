/**
 * 桌面端 CloudView 与云端 Web 共享的业务卡片与确认授权弹窗。
 *
 * 默认文案统一从 `@pi-workbench/i18n` 按 `language`（默认 `'zh'`）取词，同时支持调用方通过 `labels` 覆盖，
 * 零桌面 store / i18nStore / Electron 依赖。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Square, Trash2 } from 'lucide-react'
import { translate, type Language, type TranslationKey } from '@pi-workbench/i18n'
import { formatCloudDuration, formatCloudTime, summarizeCloudTaskPreview } from './format'
import {
  Button,
  Caption,
  Card,
  CardHeader,
  DataText,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
} from './primitives'
import {
  isCloudTaskActiveStatus,
  type CloudAuthorizationRow,
  type CloudDeviceRow,
  type CloudNotice,
  type CloudTaskRow,
  type CloudUnitRow,
} from './types'

const TASK_STATUS_I18N_KEY: Record<string, TranslationKey> = {
  queued: 'cloudTaskQueued',
  assigned: 'cloudTaskAssigned',
  running: 'cloudTaskRunning',
  waiting_human: 'cloudTaskWaiting',
  done: 'cloudTaskDone',
  failed: 'cloudTaskFailed',
  cancelled: 'cloudTaskCancelled',
  interrupted: 'cloudTaskInterrupted',
  expired: 'cloudTaskExpired',
  rejected: 'cloudTaskRejected',
}

export function getCloudTaskStatusLabel(status: string, language: Language = 'zh'): string {
  const key = TASK_STATUS_I18N_KEY[status]
  return key ? translate(language, key) : status
}

export const DEFAULT_CLOUD_TASK_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  assigned: '已派发',
  running: '执行中',
  waiting_human: '等你回答',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  expired: '已过期',
  rejected: '被拒绝',
}

export interface CloudTaskCardLabels {
  title: string
  empty: string
  stopping: string
  stopTask: string
  offlineCancelled: string
  questionWaiting: string
  answerPlaceholder: string
  send: string
  instructionPlaceholder: string
  sendInstruction: string
  statusLabel?: (status: string) => string
}

function defaultTaskCardLabels(language: Language): CloudTaskCardLabels {
  return {
    title: translate(language, 'cloudTasks'),
    empty: translate(language, 'cloudNoTasks'),
    stopping: translate(language, 'cloudStoppingTask'),
    stopTask: translate(language, 'cloudStopTask'),
    offlineCancelled: translate(language, 'cloudOfflineTaskCancelled'),
    questionWaiting: translate(language, 'cloudQuestionWaiting'),
    answerPlaceholder: translate(language, 'cloudAnswer'),
    send: translate(language, 'cloudSend'),
    instructionPlaceholder: translate(language, 'cloudSendInstructionPlaceholder'),
    sendInstruction: translate(language, 'cloudSendInstruction'),
    statusLabel: (status) => getCloudTaskStatusLabel(status, language),
  }
}

export interface CloudTaskCardProps {
  tasks: CloudTaskRow[]
  devices: Array<{ id: string; online: boolean }>
  stoppingTaskIds: Record<string, true>
  answerDrafts: Record<string, string>
  instructionDrafts: Record<string, string>
  compact?: boolean
  showCount?: boolean
  showElapsed?: boolean
  language?: Language
  labels?: Partial<CloudTaskCardLabels>
  onAnswerDraft: (taskId: string, value: string) => void
  onInstructionDraft: (taskId: string, value: string) => void
  onSendAnswer: (taskId: string, text: string) => void
  onSendInstruction: (taskId: string, text: string) => void
  onStopTask: (taskId: string) => void
  renderResult?: (task: CloudTaskRow) => React.ReactNode
}

export const CloudTaskCard: React.FC<CloudTaskCardProps> = ({
  tasks,
  devices,
  stoppingTaskIds,
  answerDrafts,
  instructionDrafts,
  compact = false,
  showCount = false,
  showElapsed = false,
  language = 'zh',
  labels,
  onAnswerDraft,
  onInstructionDraft,
  onSendAnswer,
  onSendInstruction,
  onStopTask,
  renderResult,
}) => {
  const text = { ...defaultTaskCardLabels(language), ...labels }
  const onlineById = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const device of devices) map.set(device.id, device.online)
    return map
  }, [devices])

  return (
    <Card density={compact ? 'compact' : 'default'}>
      <CardHeader
        title={text.title}
        status={showCount ? <Caption className="text-ink-muted">{tasks.length}</Caption> : undefined}
      />
      {tasks.length === 0 ? (
        <Caption className="mt-2 block text-ink-muted">{text.empty}</Caption>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-3 p-0">
          {tasks.map((task) => {
            const active = isCloudTaskActiveStatus(task.status)
            const offline = onlineById.get(task.deviceId) === false
            const stopping = Boolean(stoppingTaskIds[task.id])
            const elapsed =
              showElapsed && task.startedAt
                ? formatCloudDuration(task.startedAt, task.finishedAt ?? Date.now())
                : ''
            const summaryPreview = summarizeCloudTaskPreview(
              task.lastMilestone || task.result?.summary
            )
            const statusText = stopping
              ? text.stopping
              : text.statusLabel
                ? text.statusLabel(task.status)
                : getCloudTaskStatusLabel(task.status, language)

            return (
              <li
                key={task.id}
                className="flex flex-col gap-1.5 border-b border-rule-divide pb-2.5 last:border-b-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate type-value text-ink">
                    {task.title || task.id}
                  </span>
                  <span
                    className={`flex-shrink-0 type-caption ${
                      task.status === 'failed'
                        ? 'text-danger'
                        : task.status === 'waiting_human'
                          ? 'text-warning'
                          : 'text-ink-muted'
                    }`}
                  >
                    {statusText}
                  </span>
                </div>
                <DataText className="truncate text-ink-muted">
                  {task.deviceId} · {task.workspacePath}
                  {elapsed ? ` · ${elapsed}` : ''}
                </DataText>
                {summaryPreview && (
                  <Caption className="truncate text-ink-muted" title={summaryPreview}>
                    {summaryPreview}
                  </Caption>
                )}
                {task.status === 'waiting_human' && task.question && (
                  <div className="flex flex-col gap-1.5 border border-rule-hairline bg-sunken p-2">
                    <Caption className="text-warning">{text.questionWaiting}</Caption>
                    <span className="type-value text-ink">{task.question.text}</span>
                    <div className="flex items-center gap-1.5">
                      <Input
                        placeholder={text.answerPlaceholder}
                        value={answerDrafts[task.id] ?? ''}
                        onChange={(event) => onAnswerDraft(task.id, event.target.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key === 'Enter' &&
                            !event.nativeEvent.isComposing &&
                            event.keyCode !== 229
                          ) {
                            const val = (answerDrafts[task.id] ?? '').trim()
                            if (val) {
                              event.preventDefault()
                              onSendAnswer(task.id, val)
                            }
                          }
                        }}
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        className="flex-shrink-0"
                        disabled={!(answerDrafts[task.id] ?? '').trim()}
                        onClick={() => {
                          const val = (answerDrafts[task.id] ?? '').trim()
                          if (val) onSendAnswer(task.id, val)
                        }}
                      >
                        {text.send}
                      </Button>
                    </div>
                  </div>
                )}
                {task.status === 'running' && !offline && (
                  <div className="flex items-center gap-1.5">
                    <Input
                      placeholder={text.instructionPlaceholder}
                      value={instructionDrafts[task.id] ?? ''}
                      onChange={(event) => onInstructionDraft(task.id, event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter' &&
                          !event.nativeEvent.isComposing &&
                          event.keyCode !== 229
                        ) {
                          const val = (instructionDrafts[task.id] ?? '').trim()
                          if (val) {
                            event.preventDefault()
                            onSendInstruction(task.id, val)
                          }
                        }
                      }}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      className="flex-shrink-0"
                      disabled={!(instructionDrafts[task.id] ?? '').trim()}
                      onClick={() => {
                        const val = (instructionDrafts[task.id] ?? '').trim()
                        if (val) onSendInstruction(task.id, val)
                      }}
                    >
                      {text.sendInstruction}
                    </Button>
                  </div>
                )}
                {renderResult?.(task)}
                {task.error && <DataText className="text-danger">{task.error}</DataText>}
                {active && (
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={stopping || offline}
                      title={offline ? text.offlineCancelled : text.stopTask}
                      onClick={() => onStopTask(task.id)}
                    >
                      <Square size={12} />
                      {stopping
                        ? text.stopping
                        : offline
                          ? text.offlineCancelled
                          : text.stopTask}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

export interface CloudUnitCardLabels {
  title: string
  empty: string
  active: string
  closed: string
  closing: string
  dirty: string
  closeAction: string
  hint: string
}

function defaultUnitCardLabels(language: Language): CloudUnitCardLabels {
  return {
    title: translate(language, 'cloudUnits'),
    empty: translate(language, 'cloudNoUnits'),
    active: translate(language, 'cloudUnitActive'),
    closed: translate(language, 'cloudUnitClosed'),
    closing: translate(language, 'cloudUnitClosing'),
    dirty: translate(language, 'cloudUnitDirty'),
    closeAction: translate(language, 'cloudUnitClose'),
    hint: translate(language, 'cloudUnitHint'),
  }
}

export const CloudUnitCard: React.FC<{
  units: CloudUnitRow[]
  language?: Language
  labels?: Partial<CloudUnitCardLabels>
  onCloseUnit: (unitId: string) => void
}> = ({ units, language = 'zh', labels, onCloseUnit }) => {
  const text = { ...defaultUnitCardLabels(language), ...labels }
  const visible = units.slice(0, 8)
  return (
    <Card density="compact">
      <CardHeader title={text.title} />
      {visible.length === 0 ? (
        <Caption className="mt-2 block text-ink-muted">{text.empty}</Caption>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-2.5 p-0">
          {visible.map((unit) => {
            const closed = typeof unit.closedAt === 'number'
            const closing = !closed && Boolean(unit.closeRequestedAt)
            const dirty = !closed && Boolean(unit.dirtyAt)
            const label = closed
              ? text.closed
              : closing
                ? text.closing
                : dirty
                  ? text.dirty
                  : text.active
            return (
              <li
                key={unit.unitId}
                className="flex flex-col gap-1 border-b border-rule-divide pb-2 last:border-b-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <DataText className="min-w-0 truncate text-ink" title={unit.unitId}>
                    {unit.branch || unit.unitId}
                  </DataText>
                  <Caption
                    className={
                      dirty ? 'flex-shrink-0 text-warning' : 'flex-shrink-0 text-ink-muted'
                    }
                  >
                    {label}
                  </Caption>
                </div>
                <DataText
                  className="truncate text-ink-muted"
                  title={unit.worktreePath || unit.workspacePath || ''}
                >
                  {unit.worktreePath || unit.workspacePath || ''}
                </DataText>
                {!closed && (
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={closing}
                      onClick={() => onCloseUnit(unit.unitId)}
                    >
                      <Trash2 size={12} />
                      {closing ? text.closing : text.closeAction}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
          <li className="type-caption text-ink-muted">{text.hint}</li>
        </ul>
      )}
    </Card>
  )
}

export interface CloudNoticeCardLabels {
  title: string
  empty: string
}

function defaultNoticeCardLabels(language: Language): CloudNoticeCardLabels {
  return {
    title: translate(language, 'cloudNotices'),
    empty: translate(language, 'cloudNoticesEmpty'),
  }
}

export const CloudNoticeCard: React.FC<{
  notices: CloudNotice[]
  withSeconds?: boolean
  language?: Language
  labels?: Partial<CloudNoticeCardLabels>
}> = ({ notices, withSeconds = false, language = 'zh', labels }) => {
  const text = { ...defaultNoticeCardLabels(language), ...labels }
  return (
    <Card density="compact">
      <CardHeader title={text.title} />
      {notices.length === 0 ? (
        <Caption className="mt-2 block text-ink-muted">{text.empty}</Caption>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
          {notices.slice(0, 6).map((notice, idx) => (
            <li
              key={`${notice.at}-${idx}`}
              className={`type-caption ${
                notice.level === 'error'
                  ? 'text-danger'
                  : notice.level === 'warn'
                    ? 'text-warning'
                    : 'text-ink-muted'
              }`}
            >
              <span className="type-data">{formatCloudTime(notice.at, withSeconds)}</span>{' '}
              {notice.text}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export interface CloudAuthorizationCardLabels {
  title: string
  empty: string
  quotaText: (used: number, quota: number) => string
  expiresText?: (formattedTime: string) => string
  revokeLabel?: string
}

function defaultAuthCardLabels(language: Language): CloudAuthorizationCardLabels {
  return {
    title: translate(language, 'cloudAuthorizations'),
    empty: translate(language, 'cloudNoAuthorizations'),
    quotaText: (used, quota) => translate(language, 'cloudQuota', { used, quota }),
    expiresText: (formatted) => translate(language, 'cloudWebAuthExpires', { time: formatted }),
    revokeLabel: translate(language, 'cloudWebRevokeAuth'),
  }
}

export const CloudAuthorizationCard: React.FC<{
  authorizations: CloudAuthorizationRow[]
  action?: React.ReactNode
  onRevoke?: (id: string) => Promise<void> | void
  showTargets?: boolean
  language?: Language
  labels?: Partial<CloudAuthorizationCardLabels>
}> = ({ authorizations, action, onRevoke, showTargets = true, language = 'zh', labels }) => {
  const text = { ...defaultAuthCardLabels(language), ...labels }
  return (
    <Card density="compact">
      <CardHeader title={text.title} action={action} />
      {authorizations.length === 0 ? (
        <Caption className="mt-2 block text-ink-muted">{text.empty}</Caption>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-2.5 p-0">
          {authorizations.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-1 border-b border-rule-divide pb-2 last:border-b-0 last:pb-0"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="type-value text-ink">
                  {text.quotaText(item.used, item.quota)}
                </span>
                {text.expiresText && item.expiresAt > 0 && (
                  <Caption className="text-ink-muted">
                    {text.expiresText(formatCloudTime(item.expiresAt, true))}
                  </Caption>
                )}
              </div>
              <Caption className="truncate text-ink-muted">{item.confirmedSummary}</Caption>
              {showTargets && item.items.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  {item.items.map((target, idx) => (
                    <DataText
                      key={`${target.deviceId}-${target.workspacePath}-${idx}`}
                      className="truncate text-ink-muted"
                    >
                      {target.deviceId} → {target.workspacePath}
                    </DataText>
                  ))}
                </div>
              )}
              {onRevoke && (
                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger hover:bg-danger/10 hover:text-danger"
                    onClick={() => void onRevoke(item.id)}
                  >
                    {text.revokeLabel ?? translate(language, 'cloudWebRevokeAuth')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export interface CloudConfirmPlanModalLabels {
  title: string
  close: string
  cancel: string
  confirm: string
  hint: string
  planLabel: string
  planPlaceholder: string
  deviceLabel: string
  repoLabel: string
  noGitRepo: string
  quotaLabel: string
  missingPlanError: string
  missingTargetError: string
}

function defaultConfirmPlanLabels(language: Language): CloudConfirmPlanModalLabels {
  return {
    title: translate(language, 'cloudWebConfirmPlanModalTitle'),
    close: translate(language, 'close'),
    cancel: translate(language, 'cancel'),
    confirm: translate(language, 'confirm'),
    hint: translate(language, 'cloudAuthorizeHint'),
    planLabel: translate(language, 'cloudPlanText'),
    planPlaceholder: translate(language, 'cloudPlanTextPlaceholder'),
    deviceLabel: translate(language, 'cloudAuthorizeDevice'),
    repoLabel: translate(language, 'cloudAuthorizeRepo'),
    noGitRepo: translate(language, 'cloudNoGitRepo'),
    quotaLabel: translate(language, 'cloudQuotaLabel'),
    missingPlanError: translate(language, 'cloudWebConfirmPlanMissingPlan'),
    missingTargetError: translate(language, 'cloudWebConfirmPlanMissingTarget'),
  }
}

export const CloudConfirmPlanModal: React.FC<{
  open: boolean
  devices: CloudDeviceRow[]
  language?: Language
  labels?: Partial<CloudConfirmPlanModalLabels>
  showDeviceIdInOption?: boolean
  showRepoPathInOption?: boolean
  onClose: () => void
  onSubmit: (payload: {
    planText: string
    items: Array<{ deviceId: string; workspacePath: string }>
    quota: number
  }) => Promise<boolean> | boolean
}> = ({
  open,
  devices,
  language = 'zh',
  labels,
  showDeviceIdInOption = false,
  showRepoPathInOption = false,
  onClose,
  onSubmit,
}) => {
  const text = { ...defaultConfirmPlanLabels(language), ...labels }
  const [planText, setPlanText] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [quota, setQuota] = useState('5')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    const justOpened = !wasOpenRef.current
    wasOpenRef.current = true
    if (justOpened) setError('')
    // 仅在首次打开或当前已选设备/仓库消失时才回退默认值，避免 WS device 帧刷新重置用户表单
    const currentDevice = devices.find((item) => item.id === deviceId)
    if (justOpened || !currentDevice) {
      const nextDevice = devices[0]
      setDeviceId(nextDevice?.id ?? '')
      const nextGit = (nextDevice?.workspaces ?? []).filter((ws) => ws.isGit !== false)
      setWorkspacePath(nextGit[0]?.path ?? '')
      return
    }
    const currentGit = (currentDevice.workspaces ?? []).filter((ws) => ws.isGit !== false)
    if (workspacePath && !currentGit.some((ws) => ws.path === workspacePath)) {
      setWorkspacePath(currentGit[0]?.path ?? '')
    }
  }, [open, devices, deviceId, workspacePath])

  const selectedDevice = devices.find((item) => item.id === deviceId) ?? devices[0]
  const gitWorkspaces = useMemo(
    () => (selectedDevice?.workspaces ?? []).filter((ws) => ws.isGit !== false),
    [selectedDevice]
  )

  const handleConfirm = async () => {
    if (submitting) return
    const trimmed = planText.trim()
    if (!trimmed) {
      setError(text.missingPlanError)
      return
    }
    if (!selectedDevice || !workspacePath) {
      setError(text.missingTargetError)
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const ok = await onSubmit({
        planText: trimmed,
        items: [{ deviceId: selectedDevice.id, workspacePath }],
        quota: Math.max(1, Math.min(50, Number(quota) || 5)),
      })
      if (ok) {
        setPlanText('')
        onClose()
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={text.title}
      size="md"
      closeLabel={text.close}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {text.cancel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={submitting || !planText.trim() || !selectedDevice || !workspacePath}
            onClick={() => void handleConfirm()}
          >
            {submitting ? <Spinner size={13} /> : null}
            {text.confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <Caption className="text-ink-muted">{text.hint}</Caption>
        <Field label={text.planLabel} htmlFor="cloud-plan-text">
          <Textarea
            id="cloud-plan-text"
            rows={4}
            value={planText}
            placeholder={text.planPlaceholder}
            onChange={(event) => setPlanText(event.target.value)}
            autoFocus
          />
        </Field>
        <Field label={text.deviceLabel} htmlFor="cloud-plan-device">
          <Select
            id="cloud-plan-device"
            value={selectedDevice?.id ?? ''}
            onChange={(event) => {
              const nextId = event.target.value
              setDeviceId(nextId)
              const nextDevice = devices.find((item) => item.id === nextId)
              const nextRepos = (nextDevice?.workspaces ?? []).filter((ws) => ws.isGit !== false)
              setWorkspacePath(nextRepos[0]?.path ?? '')
            }}
          >
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {showDeviceIdInOption ? `${device.name} (${device.id})` : device.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={text.repoLabel} htmlFor="cloud-plan-repo">
          <Select
            id="cloud-plan-repo"
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
          >
            {gitWorkspaces.map((ws) => (
              <option key={ws.path} value={ws.path}>
                {showRepoPathInOption ? `${ws.name} — ${ws.path}` : ws.name}
              </option>
            ))}
          </Select>
        </Field>
        {gitWorkspaces.length === 0 && <Caption className="text-warning">{text.noGitRepo}</Caption>}
        <Field label={text.quotaLabel} htmlFor="cloud-plan-quota">
          <Input
            id="cloud-plan-quota"
            type="number"
            min={1}
            max={50}
            value={quota}
            onChange={(event) => setQuota(event.target.value)}
          />
        </Field>
        {error && <Caption className="text-danger">{error}</Caption>}
      </div>
    </Modal>
  )
}
