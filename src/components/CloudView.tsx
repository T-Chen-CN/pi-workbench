import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Cloud, PenLine, RefreshCw, Send, Square, Trash2, Unplug } from 'lucide-react'
import { useCloudStore } from '../store/cloudStore'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { confirmDialog } from '../store/dialogStore'
import type { CloudTaskRow, CloudTaskStatusName, CloudUnitRow } from '../types/cloud'
import { Button, EmptyState, Field, Input, Modal, Select, Spinner, Textarea } from './ui'
import { Card, CardHeader, SectionHeader, StatusText } from './patterns'

/**
 * 云端页（F-27 / D-19）：独立视图，与工作区无关，保留顶栏与底部状态栏。
 *
 * 渲染自己写，不复用 chatStore / workspaceStore / diffStore：帧格式与状态模型
 * 与 Web 客户端共享，渲染各自实现，避免云端页被工作区生命周期牵扯。
 */

const TASK_STATUS_KEY: Record<CloudTaskStatusName, string> = {
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

const ACTIVE_STATUSES: CloudTaskStatusName[] = ['queued', 'assigned', 'running', 'waiting_human']

function formatTime(value?: number): string {
  if (!value) return ''
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatDuration(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest}s`
}

export const CloudView: React.FC<{ onBackHome: () => void }> = ({ onBackHome }) => {
  const { t } = useI18nStore()
  const store = useCloudStore()
  const [draft, setDraft] = useState('')
  const [authorizeOpen, setAuthorizeOpen] = useState(false)
  const [answerDraft, setAnswerDraft] = useState<Record<string, string>>({})
  const transcriptRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void store.init()
    // init 只跑一次；store 的方法引用稳定，不放进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 贴底：只有本来就在底部附近才跟随流式输出
  useEffect(() => {
    const element = transcriptRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    if (distance < 64) element.scrollTop = element.scrollHeight
  }, [store.messages])

  const statusLabel = useMemo(() => {
    switch (store.deviceState.status) {
      case 'online':
        return t('cloudStatusOnline')
      case 'connecting':
        return t('cloudStatusConnecting')
      case 'offline':
        return t('cloudStatusOffline')
      case 'error':
        return t('cloudStatusError')
      default:
        return t('cloudStatusUnlinked')
    }
  }, [store.deviceState.status, t])

  const running = store.tasks.filter((task) => ACTIVE_STATUSES.includes(task.status))
  const finished = store.tasks.filter((task) => !ACTIVE_STATUSES.includes(task.status))
  // 已被云端解绑（F-08 / A-15）：两个通道都已停手，这里必须明说，否则只会看到“连接中”
  const revoked =
    Boolean(store.deviceState.revoked) ||
    (store.clientState.status === 'error' && Boolean(store.clientState.revoked))
  // 服务端以 fatal 帧拒绝（协议版本不匹配等，F-47 / A-27）：重连不会成功，必须常驻提示
  const clientState = store.clientState
  const rejected =
    clientState.status === 'error' && !clientState.revoked && clientState.fatal
      ? clientState.error
      : null

  const send = () => {
    const body = draft.trim()
    if (!body) return
    setDraft('')
    void store.say(body)
  }

  const unpair = async () => {
    if (!(await confirmDialog({ message: t('cloudUnpairConfirm'), danger: true }))) return
    await store.unlink()
    toast.success(t('cloudUnpaired'))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <header className="flex h-11 flex-shrink-0 items-center gap-3 border-b border-rule-divide bg-panel px-4">
        <Button variant="ghost" size="sm" onClick={onBackHome}>
          <ArrowLeft size={14} />
          {t('backToHome')}
        </Button>
        <span className="flex items-center gap-2 type-label text-ink">
          <Cloud size={14} className="text-accent" />
          {t('cloudTitle')}
        </span>
        <StatusText
          tone={
            store.deviceState.status === 'online'
              ? 'accent'
              : store.deviceState.status === 'error'
                ? 'danger'
                : 'muted'
          }
        >
          {statusLabel}
          {store.deviceState.pending > 0
            ? ` · ${t('cloudPendingFrames', { count: store.deviceState.pending })}`
            : ''}
        </StatusText>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void store.refreshStatus()
              // 重报仓库清单：新开的 git 仓库不重报，云端就一直以为这台机器只有一个不可派活的目录
              void store.refreshWorkspaces()
            }}
          >
            <RefreshCw size={13} />
            {t('cloudRefresh')}
          </Button>
          {store.link.linked && (
            <Button variant="ghost" size="sm" onClick={() => void store.reconnect()}>
              {t('cloudReconnect')}
            </Button>
          )}
          {/* 解绑后（或被云端移除后）必须能从桌面端解除，否则只能重装：
              解绑才能回到配对页，重新配对才能恢复两个通道 */}
          {store.link.linked && (
            <Button variant="ghost" size="sm" onClick={() => void unpair()}>
              <Unplug size={13} />
              {t('cloudUnpair')}
            </Button>
          )}
        </div>
      </header>

      {revoked && (
        <p className="flex-shrink-0 border-b border-rule-divide bg-panel px-4 py-2 type-caption text-danger">
          {t('cloudRevoked')}
        </p>
      )}
      {rejected && (
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-rule-divide bg-panel px-4 py-2">
          <p className="flex-1 type-caption text-danger">
            {t('cloudRejected', { error: rejected })}
          </p>
          <Button variant="ghost" size="sm" onClick={() => void store.openClient()}>
            {t('cloudReconnectAction')}
          </Button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px]">
        <section className="flex min-h-0 flex-col border-r border-rule-divide">
          {store.link.linked ? (
            <>
              <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {!store.initialized || store.messages.length === 0 ? (
                  <EmptyState
                    icon={Cloud}
                    title={t('cloudSession')}
                    description={store.error ?? t('cloudSessionEmpty')}
                  />
                ) : (
                  <div className="flex flex-col gap-4">
                    {store.messages.map((message) => (
                      <article
                        key={message.id}
                        className={
                          message.role === 'user'
                            ? 'flex flex-col gap-1 border-l-2 border-accent pl-3'
                            : 'flex flex-col gap-1 border-l-2 border-rule-divide pl-3'
                        }
                      >
                        <div className="flex items-center gap-2 type-caption text-ink-muted">
                          <span>{message.role === 'user' ? 'YOU' : 'CLOUD'}</span>
                          <span>{formatTime(message.at)}</span>
                          {message.streaming && <span className="text-accent">···</span>}
                        </div>
                        {message.text && (
                          <p className="whitespace-pre-wrap break-words type-body text-ink">
                            {message.text}
                          </p>
                        )}
                        {message.traces.length > 0 && (
                          <details className="type-caption text-ink-muted">
                            <summary className="cursor-pointer select-none">
                              {message.traces.length} tool calls
                            </summary>
                            <ul className="mt-1 flex flex-col gap-0.5">
                              {message.traces.map((trace) => (
                                <li key={trace.id} className="truncate">
                                  <span
                                    className={
                                      trace.status === 'error' ? 'text-danger' : 'text-ink-muted'
                                    }
                                  >
                                    {trace.toolName}
                                  </span>{' '}
                                  {trace.summary}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {message.error && <p className="type-caption text-danger">{message.error}</p>}
                      </article>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-shrink-0 flex-col gap-2 border-t border-rule-divide bg-panel px-4 py-3">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={t('cloudSendPlaceholder')}
                  rows={3}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      send()
                    }
                  }}
                />
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="sm" onClick={send} disabled={!draft.trim()}>
                    <Send size={13} />
                    {t('cloudSend')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void store.stopReply()}
                    disabled={!store.canStopReply}
                  >
                    <Square size={13} />
                    {t('cloudStopReply')}
                  </Button>
                  <span className="ml-auto type-caption text-ink-muted">
                    {store.agentStatus === 'thinking' || store.agentStatus === 'replying'
                      ? store.agentStatus
                      : ''}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <PairingPane onBackHome={onBackHome} />
          )}
        </section>

        <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4">
          <TaskList
            title={t('cloudTasks')}
            tasks={[...running, ...finished]}
            onStop={(taskId) => void store.stopTask(taskId)}
            onAnswer={(taskId, text) => {
              void store.answerQuestion(taskId, text)
              setAnswerDraft((current) => ({ ...current, [taskId]: '' }))
            }}
            answerDraft={answerDraft}
            onAnswerDraft={(taskId, text) =>
              setAnswerDraft((current) => ({ ...current, [taskId]: text }))
            }
          />

          <UnitList
            units={store.units}
            onClose={(unitId) => {
              void store.closeUnit(unitId).then((sent) => {
                if (sent) toast.success(t('cloudUnitCloseSent'))
                else toast.error(t('cloudUnitCloseFailed'))
              })
            }}
          />

          <Card density="compact">
            <CardHeader title={t('cloudDevices')} />
            {store.devices.length === 0 ? (
              <p className="type-caption text-ink-muted">{t('cloudNoWorkspaces')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {store.devices.map((device) => (
                  <li key={device.id} className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-2 type-label text-ink">
                      <span
                        className={
                          device.online
                            ? 'h-1.5 w-1.5 rounded-full bg-accent'
                            : 'h-1.5 w-1.5 rounded-full bg-ink-subtle'
                        }
                        aria-hidden="true"
                      />
                      {device.name}
                      <span className="type-caption text-ink-muted">{device.platform}</span>
                    </span>
                    <span className="type-caption text-ink-muted">
                      {device.workspaces.length} workspace(s)
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card density="compact">
            <CardHeader
              title={t('cloudAuthorizations')}
              action={
                store.link.linked ? (
                  <Button variant="secondary" size="sm" onClick={() => setAuthorizeOpen(true)}>
                    <PenLine size={13} />
                    {t('cloudAuthorizeTitle')}
                  </Button>
                ) : undefined
              }
            />
            {store.authorizations.length === 0 ? (
              <p className="type-caption text-ink-muted">{t('cloudNoAuthorizations')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {store.authorizations.map((item) => (
                  <li key={item.id} className="flex flex-col gap-0.5">
                    <span className="type-label text-ink">
                      {t('cloudQuota', { used: item.used, quota: item.quota })}
                    </span>
                    <span className="truncate type-caption text-ink-muted">
                      {item.confirmedSummary}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <AuthorizeDialog open={authorizeOpen} onClose={() => setAuthorizeOpen(false)} />

          {store.link.linked && <CloudConfigCard />}

          {store.notices.length > 0 && (
            <Card density="compact">
              <CardHeader title={t('cloudNotices')} />
              <ul className="flex flex-col gap-1">
                {store.notices.slice(0, 6).map((notice, index) => (
                  <li
                    key={`${notice.at}-${index}`}
                    className={
                      notice.level === 'error'
                        ? 'type-caption text-danger'
                        : notice.level === 'warn'
                          ? 'type-caption text-warning'
                          : 'type-caption text-ink-muted'
                    }
                  >
                    {formatTime(notice.at)} {notice.text}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </div>
    </div>
  )
}

const PairingPane: React.FC<{ onBackHome: () => void }> = ({ onBackHome }) => {
  const { t } = useI18nStore()
  const store = useCloudStore()
  const [baseUrl, setBaseUrl] = useState('tchen-xiaoxiao.com')
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState('Pi Workbench')

  const submit = async () => {
    const ok = await store.pair({ baseUrl, code: code.trim(), deviceName })
    if (ok) toast.success(t('cloudStatusConnecting'))
  }

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-md flex-col gap-4">
        <SectionHeader title={t('cloudPairTitle')} />
        <p className="type-caption text-ink-muted">{t('cloudPairHint')}</p>
        <p className="type-caption text-ink-muted">{t('cloudConnectFirst')}</p>
        <Field label={t('cloudAddress')} htmlFor="cloud-base-url">
          <Input
            id="cloud-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://tchen-xiaoxiao.com"
          />
        </Field>
        <Field label={t('cloudCode')} htmlFor="cloud-code">
          <Input
            id="cloud-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            placeholder="000000"
          />
        </Field>
        <Field label={t('cloudDeviceName')} htmlFor="cloud-device-name">
          <Input
            id="cloud-device-name"
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
          />
        </Field>
        {store.error && <p className="type-caption text-danger">{store.error}</p>}
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void submit()}
            disabled={store.linking || code.length !== 6}
          >
            {store.linking ? <Spinner size={13} /> : <Unplug size={13} />}
            {t('cloudPairAction')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onBackHome}>
            {t('backToHome')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * 工作单元列表（F-19a / A-43）。
 *
 * 干净树在工单结束时就**自动回收**了，所以这里平时只有“使用中”的单元；
 * 出现「待处理」的一定是脏树（有未提交改动），那才需要手动结束。
 */
const UnitList: React.FC<{
  units: CloudUnitRow[]
  onClose: (unitId: string) => void
}> = ({ units, onClose }) => {
  const { t } = useI18nStore()
  return (
    <Card density="compact">
      <CardHeader title={t('cloudUnits')} />
      {units.length === 0 ? (
        <p className="type-caption text-ink-muted">{t('cloudNoUnits')}</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {units.slice(0, 8).map((unit) => {
            const closing = unit.closedAt === null && Boolean(unit.closeRequestedAt)
            const dirty = unit.closedAt === null && Boolean(unit.dirtyAt)
            const label =
              unit.closedAt !== null
                ? t('cloudUnitClosed')
                : closing
                  ? t('cloudUnitClosing')
                  : dirty
                    ? t('cloudUnitDirty')
                    : t('cloudUnitActive')
            return (
              <li key={unit.unitId} className="flex flex-col gap-1">
                <span className="flex items-center gap-2 type-label text-ink">
                  <span className="truncate" title={unit.unitId}>
                    {unit.branch ?? unit.unitId}
                  </span>
                  <span
                    className={
                      dirty ? 'type-caption text-warning' : 'type-caption text-ink-muted'
                    }
                  >
                    {label}
                  </span>
                </span>
                <span
                  className="truncate type-caption text-ink-muted"
                  title={unit.worktreePath ?? unit.workspacePath}
                >
                  {unit.worktreePath ?? unit.workspacePath}
                </span>
                {unit.closedAt === null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onClose(unit.unitId)}
                    disabled={closing}
                  >
                    <Trash2 size={13} />
                    {t('cloudUnitClose')}
                  </Button>
                )}
              </li>
            )
          })}
          <li className="type-caption text-ink-muted">{t('cloudUnitHint')}</li>
        </ul>
      )}
    </Card>
  )
}

const TaskList: React.FC<{
  title: string
  tasks: CloudTaskRow[]
  onStop: (taskId: string) => void
  onAnswer: (taskId: string, text: string) => void
  answerDraft: Record<string, string>
  onAnswerDraft: (taskId: string, text: string) => void
}> = ({ title, tasks, onStop, onAnswer, answerDraft, onAnswerDraft }) => {
  const { t } = useI18nStore()
  return (
    <Card density="compact">
      <CardHeader title={title} />
      {tasks.length === 0 ? (
        <p className="type-caption text-ink-muted">{t('cloudNoTasks')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {tasks.map((task) => {
            const active = ACTIVE_STATUSES.includes(task.status)
            const elapsed = task.startedAt
              ? formatDuration(task.startedAt, task.finishedAt ?? Date.now())
              : ''
            return (
              <li key={task.id} className="flex flex-col gap-1">
                <span className="flex items-center gap-2 type-label text-ink">
                  <span className="truncate">{task.title}</span>
                  <span className="ml-auto flex-shrink-0 type-caption text-ink-muted">
                    {t(TASK_STATUS_KEY[task.status] as Parameters<typeof t>[0])}
                  </span>
                </span>
                <span className="type-caption text-ink-muted">
                  {task.deviceId} · {task.workspacePath}
                  {elapsed ? ` · ${elapsed}` : ''}
                </span>
                {task.lastMilestone && (
                  <span className="truncate type-caption text-ink-muted">{task.lastMilestone}</span>
                )}
                {task.status === 'waiting_human' && task.question && (
                  <div className="flex flex-col gap-1">
                    <span className="type-caption text-warning">{t('cloudQuestionWaiting')}</span>
                    <p className="type-caption text-ink">{task.question.text}</p>
                    <div className="flex items-center gap-2">
                      <Input
                        value={answerDraft[task.id] ?? ''}
                        onChange={(event) => onAnswerDraft(task.id, event.target.value)}
                        placeholder={t('cloudAnswer')}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onAnswer(task.id, answerDraft[task.id] ?? '')}
                        disabled={!(answerDraft[task.id] ?? '').trim()}
                      >
                        {t('cloudSend')}
                      </Button>
                    </div>
                  </div>
                )}
                {task.result?.summary && (
                  <details className="type-caption text-ink-muted">
                    <summary className="cursor-pointer select-none">{t('cloudTaskDone')}</summary>
                    <p className="mt-1 whitespace-pre-wrap text-ink">{task.result.summary}</p>
                    {task.result.changedFiles.length > 0 && (
                      <p className="mt-1">
                        {t('cloudChangedFiles')}: {task.result.changedFiles.map((file) => file.path).join(', ')}
                      </p>
                    )}
                  </details>
                )}
                {task.error && <span className="type-caption text-danger">{task.error}</span>}
                {active && (
                  <Button variant="ghost" size="sm" onClick={() => onStop(task.id)}>
                    <Square size={12} />
                    {t('cloudStopTask')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

const CloudConfigCard: React.FC = () => {
  const { t } = useI18nStore()
  const [provider, setProvider] = useState('custom')
  const [apiUrl, setApiUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [mask, setMask] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [manualModel, setManualModel] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      const result = await apiGetConfig()
      if (!result?.configured) return
      setProvider(result.provider ?? 'custom')
      setApiUrl(result.apiUrl ?? '')
      setModel(result.model ?? '')
      setMask(result.apiKeyMasked ?? '')
    })()
  }, [])

  /** 拉清单：浏览器直连供应商会被 CORS 挡，所以走主进程代理（Key 不进渲染层日志） */
  const fetchModels = async () => {
    setFetching(true)
    try {
      const { api } = await import('../api')
      const result = await api.cloudFetchModels({ provider, apiUrl, apiKey })
      if (!result.success) {
        toast.error(t('cloudFetchModelsFailed', { error: result.error ?? t('unknownError') }))
        return
      }
      setModels(result.models)
      if (result.models.length === 0) {
        toast.info(t('cloudModelsHint', { count: 0 }))
        return
      }
      // 当前模型不在清单里（例如手填过）时，落到第一个，避免下拉显示为空
      if (!result.models.includes(model)) setModel(result.models[0])
    } finally {
      setFetching(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const { api } = await import('../api')
      const result = await api.cloudSaveConfig({ provider, apiUrl, model, apiKey })
      if (result.success) {
        toast.success(t('cloudSaved'))
        setApiKey('')
        const refreshed = await apiGetConfig()
        if (refreshed?.apiKeyMasked) setMask(refreshed.apiKeyMasked)
      } else {
        toast.error(result.error ?? t('unknownError'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card density="compact">
      <CardHeader title={t('cloudConfigTitle')} />
      <div className="flex flex-col gap-2">
        <Field label={t('cloudProvider')} htmlFor="cloud-provider">
          <Select
            id="cloud-provider"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            <option value="custom">custom</option>
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </Select>
        </Field>
        <Field label={t('cloudApiUrl')} htmlFor="cloud-api-url">
          <Input
            id="cloud-api-url"
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </Field>
        <Field
          label={t('cloudApiKey')}
          htmlFor="cloud-api-key"
          hint={mask ? t('cloudApiKeyHint', { mask }) : undefined}
        >
          <Input
            id="cloud-api-key"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            type="password"
            autoComplete="off"
          />
        </Field>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void fetchModels()} disabled={fetching}>
            {fetching ? <Spinner size={13} /> : null}
            {fetching ? t('cloudFetchingModels') : t('cloudFetchModels')}
          </Button>
          {models.length > 0 ? (
            <span className="type-caption text-ink-muted">
              {t('cloudModelsHint', { count: models.length })}
            </span>
          ) : null}
        </div>
        <Field label={t('cloudModel')} htmlFor="cloud-model">
          {/* 拿到清单就下拉；拿不到、或列表里没有想要的，就手填（不是所有代理商都实现 /models） */}
          {models.length > 0 && !manualModel ? (
            <Select id="cloud-model" value={model} onChange={(event) => setModel(event.target.value)}>
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id="cloud-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={t('cloudModelManual')}
            />
          )}
        </Field>
        {models.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setManualModel((prev) => !prev)}>
            {manualModel ? t('cloudModelUseList', { count: models.length }) : t('cloudModelUseManual')}
          </Button>
        ) : null}
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? <Spinner size={13} /> : null}
          {t('cloudSave')}
        </Button>
      </div>
    </Card>
  )
}

async function apiGetConfig() {
  const { api } = await import('../api')
  const result = await api.cloudGetConfig()
  return result.success ? result.config : undefined
}

/**
 * 确认方案并授权（F-16 / F-17 / F-18）。
 *
 * 这个动作**不派活**，只把「设备 × 仓库 + 额度」落成凭据；`dispatch_task` 时由服务端
 * 逐项校验（G9：模型自称“用户已同意”不算数）。桌面端与 Web 都是完整客户端（D-11），
 * 所以两端都必须有这个入口，否则只用桌面端根本派不出活。
 */
const AuthorizeDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { t } = useI18nStore()
  const store = useCloudStore()
  const [planText, setPlanText] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [quota, setQuota] = useState('5')
  const [sending, setSending] = useState(false)

  const device = store.devices.find((item) => item.id === deviceId) ?? store.devices[0]
  const repos = useMemo(
    () => (device?.workspaces ?? []).filter((workspace) => workspace.isGit !== false),
    [device]
  )

  // 打开时补默认值，但**不覆盖用户的手选**：整页重渲染（任何流式帧都会触发）不能让选择弹回去
  useEffect(() => {
    if (!open) return
    if (device && device.id !== deviceId) setDeviceId(device.id)
    if (repos.length > 0 && !repos.some((repo) => repo.path === workspacePath)) {
      setWorkspacePath(repos[0].path)
    }
  }, [open, device, deviceId, repos, workspacePath])

  const submit = async () => {
    const text = planText.trim()
    if (!text || !device || !workspacePath) return
    setSending(true)
    const ok = await store.confirmPlan({
      planText: text,
      items: [{ deviceId: device.id, workspacePath }],
      quota: Math.max(1, Math.min(50, Number(quota) || 5)),
    })
    setSending(false)
    if (!ok) {
      toast.error(t('cloudAuthorizeFailed'))
      return
    }
    toast.success(t('cloudAuthorizeSent'))
    setPlanText('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('cloudAuthorizeTitle')}
      size="md"
      closeLabel={t('close')}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void submit()}
            disabled={sending || !planText.trim() || !device || !workspacePath}
          >
            {sending ? <Spinner size={13} /> : null}
            {t('cloudAuthorizeAction')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <p className="type-caption text-ink-muted">{t('cloudAuthorizeHint')}</p>
        <Field label={t('cloudPlanText')} htmlFor="cloud-plan-text">
          <Textarea
            id="cloud-plan-text"
            rows={5}
            value={planText}
            onChange={(event) => setPlanText(event.target.value)}
            placeholder={t('cloudPlanTextPlaceholder')}
          />
        </Field>
        <Field label={t('cloudAuthorizeDevice')} htmlFor="cloud-plan-device">
          <Select
            id="cloud-plan-device"
            value={device?.id ?? ''}
            onChange={(event) => {
              setDeviceId(event.target.value)
              setWorkspacePath('')
            }}
          >
            {store.devices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('cloudAuthorizeRepo')} htmlFor="cloud-plan-repo">
          <Select
            id="cloud-plan-repo"
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
          >
            {repos.map((repo) => (
              <option key={repo.path} value={repo.path}>
                {repo.name}
              </option>
            ))}
          </Select>
        </Field>
        {repos.length === 0 && <p className="type-caption text-warning">{t('cloudNoGitRepo')}</p>}
        <Field label={t('cloudQuotaLabel')} htmlFor="cloud-plan-quota">
          <Input
            id="cloud-plan-quota"
            type="number"
            min={1}
            max={50}
            value={quota}
            onChange={(event) => setQuota(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}
