import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  BookOpen,
  Cloud,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  PenLine,
  Pin,
  RefreshCw,
  Send,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Unplug,
} from 'lucide-react'
import {
  CLOUD_ACTIVE_TASK_STATUSES,
  CLOUD_PROVIDER_PRESETS,
  CloudAuthorizationCard,
  CloudConfirmPlanModal,
  CloudNoticeCard,
  CloudTaskCard,
  CloudUnitCard,
  formatCloudTime,
  formatCloudTokens,
  parseCloudTagsInput,
} from '@pi-workbench/cloud-ui'
import { useCloudStore } from '../store/cloudStore'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { confirmDialog } from '../store/dialogStore'
import type {
  CloudDocItem,
  CloudDreamItem,
  CloudMemoryItem,
  CloudMemoryKind,
  CloudTaskStatusName,
} from '../types/cloud'
import type { CloudCatalogModel } from '../types/electron'
import { api } from '../api'
import { StreamingMarkdown } from './AgentMarkdown'
import { CloudTraceSection } from './CloudTraceSection'
import { TaskResultSection } from './TaskResultSection'
import { StreamingTranscript, type StreamingTranscriptHandle } from './StreamingTranscript'
import { Button, EmptyState, Field, IconButton, Input, Modal, Select, Spinner, Textarea } from './ui'
import { Card, CardHeader, SectionHeader, StatusText, Tab } from './patterns'

/**
 * 云端页（F-27 / D-19）：独立视图，与工作区无关，保留顶栏与底部状态栏。
 *
 * 工单 / 工作单元 / 授权 / 提示 / 确认授权弹窗统一复用 `@pi-workbench/cloud-ui`，
 * 桌面端通过 `t(...)` 注入中英文案，与云端 Web 共享同一套状态投影与组件契约。
 */

const TASK_STATUS_KEY: Partial<Record<CloudTaskStatusName, string>> = {
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

const ACTIVE_STATUSES = CLOUD_ACTIVE_TASK_STATUSES

const MEMORY_KIND_KEY: Record<CloudMemoryKind, string> = {
  fact: 'cloudMemoryKindFact',
  preference: 'cloudMemoryKindPreference',
  project: 'cloudMemoryKindProject',
  decision: 'cloudMemoryKindDecision',
  todo: 'cloudMemoryKindTodo',
}

const formatTime = (value?: number) => formatCloudTime(value, false)
const formatTokens = formatCloudTokens
const parseTagsInput = parseCloudTagsInput

const CloudMessageItem = React.memo(function CloudMessageItem({
  message,
  language,
}: {
  message: import('../types/cloud').CloudChatRow
  language: 'zh' | 'en'
}) {
  return (
    <article
      className={
        message.role === 'user'
          ? 'flex flex-col gap-1 border-l-2 border-accent pl-3'
          : 'flex flex-col gap-1 border-l-2 border-rule-divide pl-3'
      }
    >
      <div className="flex items-center gap-2 type-caption text-ink-muted">
        <span className="type-eyebrow">{message.role === 'user' ? 'YOU' : 'CLOUD'}</span>
        <span className="type-data">{formatTime(message.at)}</span>
        {message.streaming && (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
          />
        )}
      </div>
      {message.role === 'assistant' && (
        <CloudTraceSection
          messageId={message.id}
          thinking={message.thinking}
          thinkingRedacted={message.thinkingRedacted}
          thinkingDurationMs={message.thinkingDurationMs}
          traces={message.traces}
          isStreaming={Boolean(message.streaming)}
          hasBodyText={Boolean(message.text.trim())}
          language={language}
        />
      )}
      {message.text &&
        (message.role === 'user' ? (
          <p className="whitespace-pre-wrap break-words type-body text-ink">{message.text}</p>
        ) : (
          <div className="chat-markdown text-ink">
            <StreamingMarkdown
              content={message.text}
              isStreaming={Boolean(message.streaming)}
              showCursor={Boolean(message.streaming)}
              highlight={message.text.length <= 20_000}
            />
          </div>
        ))}
      {message.error && <p className="type-data text-danger">{message.error}</p>}
    </article>
  )
})

export const CloudView: React.FC<{ onBackHome: () => void }> = ({ onBackHome }) => {
  const t = useI18nStore((state) => state.t)
  const language = useI18nStore((state) => state.language)
  const linked = useCloudStore((state) => state.link.linked)
  const deviceState = useCloudStore((state) => state.deviceState)
  const clientState = useCloudStore((state) => state.clientState)
  const initialized = useCloudStore((state) => state.initialized)
  const error = useCloudStore((state) => state.error)
  const messages = useCloudStore((state) => state.messages)
  const awaySummary = useCloudStore((state) => state.awaySummary)
  const tasks = useCloudStore((state) => state.tasks)
  const units = useCloudStore((state) => state.units)
  const devices = useCloudStore((state) => state.devices)
  const authorizations = useCloudStore((state) => state.authorizations)
  const notices = useCloudStore((state) => state.notices)
  const stoppingTaskIds = useCloudStore((state) => state.stoppingTaskIds)
  const agentStatus = useCloudStore((state) => state.agentStatus)
  const canStopReply = useCloudStore((state) => state.canStopReply)
  const unreadCount = useCloudStore((state) => state.unreadCount)

  const init = useCloudStore((state) => state.init)
  const markRead = useCloudStore((state) => state.markRead)
  const refreshStatus = useCloudStore((state) => state.refreshStatus)
  const refreshWorkspaces = useCloudStore((state) => state.refreshWorkspaces)
  const reconnect = useCloudStore((state) => state.reconnect)
  const openClient = useCloudStore((state) => state.openClient)
  const unlink = useCloudStore((state) => state.unlink)
  const say = useCloudStore((state) => state.say)
  const stopReply = useCloudStore((state) => state.stopReply)
  const stopTask = useCloudStore((state) => state.stopTask)
  const answerQuestion = useCloudStore((state) => state.answerQuestion)
  const sendTaskMessage = useCloudStore((state) => state.sendTaskMessage)
  const closeUnit = useCloudStore((state) => state.closeUnit)

  const [draft, setDraft] = useState('')
  const [authorizeOpen, setAuthorizeOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [asideCollapsed, setAsideCollapsed] = useState(false)
  const [answerDraft, setAnswerDraft] = useState<Record<string, string>>({})
  const [instructionDraft, setInstructionDraft] = useState<Record<string, string>>({})
  const transcriptHandleRef = useRef<StreamingTranscriptHandle | null>(null)
  const composingRef = useRef(false)
  const collapseRailRef = useRef<HTMLButtonElement | null>(null)
  const expandRailRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    void init()
  }, [init])

  // 云端页处于可见态且确实存在未读时上报已读：绝不能用 lastSeq > lastReadSeq 触发，否则 read_state 广播自身递增 seq 会引发无限风暴
  useEffect(() => {
    if (clientState.status !== 'open') return
    if (unreadCount > 0 && (typeof document === 'undefined' || !document.hidden)) {
      void markRead()
    }
    const onVisible = () => {
      const current = useCloudStore.getState()
      if (!document.hidden && current.unreadCount > 0) void current.markRead()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [clientState.status, unreadCount, markRead])

  const statusLabel = useMemo(() => {
    switch (deviceState.status) {
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
  }, [deviceState.status, t])

  const running = useMemo(
    () => tasks.filter((task) => ACTIVE_STATUSES.includes(task.status)),
    [tasks]
  )
  const finished = useMemo(
    () => tasks.filter((task) => !ACTIVE_STATUSES.includes(task.status)),
    [tasks]
  )
  // 已被云端解绑（F-08 / A-15）：两个通道都已停手，这里必须明说，否则只会看到“连接中”
  const revoked =
    Boolean(deviceState.revoked) ||
    (clientState.status === 'error' && Boolean(clientState.revoked))
  // 服务端以 fatal 帧拒绝（协议版本不匹配等，F-47 / A-27）：重连不会成功，必须常驻提示
  const rejected =
    clientState.status === 'error' && !clientState.revoked && clientState.fatal
      ? clientState.error
      : null

  const send = () => {
    const body = draft.trim()
    if (!body) return
    transcriptHandleRef.current?.scrollToBottom()
    setDraft('')
    void say(body)
  }

  const unpair = async () => {
    if (!(await confirmDialog({ message: t('cloudUnpairConfirm'), danger: true }))) return
    await unlink()
    toast.success(t('cloudUnpaired'))
  }

  const collapseAside = () => {
    setAsideCollapsed(true)
    window.requestAnimationFrame(() => expandRailRef.current?.focus())
  }

  const expandAside = () => {
    setAsideCollapsed(false)
    window.requestAnimationFrame(() => collapseRailRef.current?.focus())
  }

  const agentStatusText =
    agentStatus === 'thinking'
      ? t('cloudAgentThinking')
      : agentStatus === 'replying'
        ? t('cloudAgentReplying')
        : ''

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
            deviceState.status === 'online'
              ? 'accent'
              : deviceState.status === 'error'
                ? 'danger'
                : 'muted'
          }
          dot
        >
          {statusLabel}
          {deviceState.pending > 0
            ? ` · ${t('cloudPendingFrames', { count: deviceState.pending })}`
            : ''}
        </StatusText>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void refreshStatus()
              // 重报仓库清单：新开的 git 仓库不重报，云端就一直以为这台机器只有一个不可派活的目录
              void refreshWorkspaces()
            }}
          >
            <RefreshCw size={13} />
            {t('cloudRefresh')}
          </Button>
          {linked && (
            <Button variant="ghost" size="sm" onClick={() => setConfigOpen(true)}>
              <SlidersHorizontal size={13} />
              {t('cloudConfigTitle')}
            </Button>
          )}
          {linked && (
            <Button variant="ghost" size="sm" onClick={() => setMemoryOpen(true)}>
              <BookOpen size={13} />
              {t('cloudMemorySection')}
            </Button>
          )}
          {linked && (
            <Button variant="ghost" size="sm" onClick={() => void reconnect()}>
              {t('cloudReconnect')}
            </Button>
          )}
          {/* 解绑后（或被云端移除后）必须能从桌面端解除，否则只能重装：
              解绑才能回到配对页，重新配对才能恢复两个通道 */}
          {linked && (
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
          <Button variant="ghost" size="sm" onClick={() => void openClient()}>
            {t('cloudReconnectAction')}
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {linked ? (
            <>
              <StreamingTranscript
                ref={transcriptHandleRef}
                messageCount={messages.length}
                scrollToBottomLabel={t('scrollToBottom')}
                newMessagesLabel={(count) => t('newMessages', { count })}
              >
                {awaySummary && (
                  <div
                    role="status"
                    className="rounded border border-rule-divide bg-panel px-3 py-2"
                  >
                    <p className="type-label text-ink">{t('cloudAwaySummaryTitle')}</p>
                    <p className="mt-0.5 type-caption text-ink-muted">{awaySummary.text}</p>
                  </div>
                )}
                {!initialized || messages.length === 0 ? (
                  <EmptyState
                    icon={Cloud}
                    title={t('cloudSession')}
                    description={error ?? t('cloudSessionEmpty')}
                  />
                ) : (
                  messages.map((message) => (
                    <CloudMessageItem key={message.id} message={message} language={language} />
                  ))
                )}
              </StreamingTranscript>

              <div className="flex flex-shrink-0 flex-col gap-2 border-t border-rule-divide bg-panel px-4 py-3">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={t('cloudSendPlaceholder')}
                  rows={3}
                  onCompositionStart={() => {
                    composingRef.current = true
                  }}
                  onCompositionEnd={() => {
                    composingRef.current = false
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !composingRef.current &&
                      !event.nativeEvent.isComposing &&
                      event.keyCode !== 229
                    ) {
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
                    onClick={() => void stopReply()}
                    disabled={!canStopReply}
                  >
                    <Square size={13} />
                    {t('cloudStopReply')}
                  </Button>
                  <span className="type-caption text-ink-muted">{t('cloudSendShortcutHint')}</span>
                  <span className="ml-auto type-caption text-ink-muted">{agentStatusText}</span>
                </div>
              </div>
            </>
          ) : (
            <PairingPane onBackHome={onBackHome} />
          )}
        </section>

        {!asideCollapsed ? (
          <aside
            id="cloud-side-rail"
            className="flex min-h-0 w-[360px] flex-shrink-0 flex-col border-l border-rule-divide bg-panel"
          >
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-rule-divide px-2 py-1.5">
              <IconButton
                ref={collapseRailRef}
                icon={PanelRightClose}
                label={t('cloudCollapseAside')}
                size="sm"
                aria-controls="cloud-side-rail"
                aria-expanded={true}
                onClick={collapseAside}
              />
              <span className="type-label text-ink">{t('cloudAsideTitle')}</span>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
              <CloudTaskCard
                compact
                showElapsed
                tasks={[...running, ...finished]}
                devices={devices}
                stoppingTaskIds={stoppingTaskIds}
                answerDrafts={answerDraft}
                instructionDrafts={instructionDraft}
                labels={{
                  title: t('cloudTasks'),
                  empty: t('cloudNoTasks'),
                  stopping: t('cloudStoppingTask'),
                  stopTask: t('cloudStopTask'),
                  offlineCancelled: t('cloudOfflineTaskCancelled'),
                  questionWaiting: t('cloudQuestionWaiting'),
                  answerPlaceholder: t('cloudAnswer'),
                  send: t('cloudSend'),
                  instructionPlaceholder: t('cloudSendInstructionPlaceholder'),
                  sendInstruction: t('cloudSendInstruction'),
                  statusLabel: (status) => {
                    const key = TASK_STATUS_KEY[status as CloudTaskStatusName]
                    return key ? t(key as Parameters<typeof t>[0]) : status
                  },
                }}
                onStopTask={(taskId) => void stopTask(taskId)}
                onSendAnswer={(taskId, text) => {
                  void answerQuestion(taskId, text)
                  setAnswerDraft((current) => ({ ...current, [taskId]: '' }))
                }}
                onAnswerDraft={(taskId, text) =>
                  setAnswerDraft((current) => ({ ...current, [taskId]: text }))
                }
                onSendInstruction={(taskId, text) => {
                  void sendTaskMessage(taskId, text)
                  setInstructionDraft((current) => ({ ...current, [taskId]: '' }))
                }}
                onInstructionDraft={(taskId, text) =>
                  setInstructionDraft((current) => ({ ...current, [taskId]: text }))
                }
                renderResult={(task) => (
                  <TaskResultSection
                    taskId={task.id}
                    summary={task.result?.summary}
                    changedFiles={task.changedFiles ?? task.result?.changedFiles ?? []}
                    secretHits={task.secretHits ?? task.result?.secretHits ?? []}
                    compact
                    language={language}
                  />
                )}
              />

              <CloudUnitCard
                units={units}
                labels={{
                  title: t('cloudUnits'),
                  empty: t('cloudNoUnits'),
                  active: t('cloudUnitActive'),
                  closed: t('cloudUnitClosed'),
                  closing: t('cloudUnitClosing'),
                  dirty: t('cloudUnitDirty'),
                  closeAction: t('cloudUnitClose'),
                  hint: t('cloudUnitHint'),
                }}
                onCloseUnit={(unitId) => {
                  void closeUnit(unitId).then((sent) => {
                    if (sent) toast.success(t('cloudUnitCloseSent'))
                    else toast.error(t('cloudUnitCloseFailed'))
                  })
                }}
              />

              <Card density="compact">
                <CardHeader title={t('cloudDevices')} />
                {devices.length === 0 ? (
                  <p className="mt-2 type-caption text-ink-muted">{t('cloudNoWorkspaces')}</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-2">
                    {devices.map((device) => (
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
                          <span className="type-data text-ink-muted">{device.platform}</span>
                        </span>
                        <span className="type-caption text-ink-muted">
                          {t('cloudWorkspaceCount', { count: device.workspaces.length })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <CloudAuthorizationCard
                authorizations={authorizations}
                showTargets={false}
                action={
                  linked ? (
                    <Button variant="secondary" size="sm" onClick={() => setAuthorizeOpen(true)}>
                      <PenLine size={13} />
                      {t('cloudAuthorizeTitle')}
                    </Button>
                  ) : undefined
                }
                labels={{
                  title: t('cloudAuthorizations'),
                  empty: t('cloudNoAuthorizations'),
                  quotaText: (used, quota) => t('cloudQuota', { used, quota }),
                  expiresText: undefined,
                }}
              />

              {notices.length > 0 && (
                <CloudNoticeCard
                  notices={notices}
                  labels={{
                    title: t('cloudNotices'),
                    empty: '',
                  }}
                />
              )}
            </div>
          </aside>
        ) : (
          <button
            ref={expandRailRef}
            type="button"
            aria-label={t('cloudExpandAside')}
            title={t('cloudExpandAside')}
            aria-controls="cloud-side-rail"
            aria-expanded={false}
            onClick={expandAside}
            className="flex w-[26px] flex-shrink-0 items-center justify-center self-stretch border-l border-rule-divide bg-panel text-ink-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline-offset-[-2px]"
          >
            <PanelRightOpen size={14} />
          </button>
        )}
      </div>

      <AuthorizeDialog open={authorizeOpen} onClose={() => setAuthorizeOpen(false)} />
      <CloudMemoryModal open={memoryOpen} onClose={() => setMemoryOpen(false)} />
      <CloudConfigModal open={configOpen} onClose={() => setConfigOpen(false)} />
    </div>
  )
}

const PairingPane: React.FC<{ onBackHome: () => void }> = ({ onBackHome }) => {
  const t = useI18nStore((state) => state.t)
  const pair = useCloudStore((state) => state.pair)
  const error = useCloudStore((state) => state.error)
  const linking = useCloudStore((state) => state.linking)
  const [baseUrl, setBaseUrl] = useState('')
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState('Pi Workbench')

  const submit = async () => {
    const ok = await pair({ baseUrl: baseUrl.trim(), code: code.trim(), deviceName })
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
            placeholder="https://cloud.example.com"
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
        {error && <p className="type-caption text-danger">{error}</p>}
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void submit()}
            disabled={linking || !baseUrl.trim() || code.length !== 6}
          >
            {linking ? <Spinner size={13} /> : <Unplug size={13} />}
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
 * 云端模型配置弹窗（F-01 / U-04）：对齐 0.11.x 8 家供应商白名单与 Pi catalog。
 * 从右栏收进顶栏弹窗，避免窄窗口下右栏过度拥挤。
 */
const CloudConfigModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const t = useI18nStore((state) => state.t)
  const [providerId, setProviderId] = useState('deepseek')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [mask, setMask] = useState('')
  const [catalog, setCatalog] = useState<CloudCatalogModel[]>([])
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  const catalogReqRef = useRef(0)

  const loadCatalog = useCallback(
    async (targetProviderId: string, preferredModel?: string) => {
      const reqId = ++catalogReqRef.current
      setFetching(true)
      try {
        const result = await api.cloudFetchModels({ providerId: targetProviderId })
        if (reqId !== catalogReqRef.current) return
        if (!result.success) {
          setCatalog([])
          setModel('')
          toast.error(t('cloudFetchModelsFailed', { error: result.error ?? t('unknownError') }))
          return
        }
        const entries: CloudCatalogModel[] =
          result.catalog && result.catalog.length > 0
            ? result.catalog
            : result.models.map((id) => ({ id }))
        setCatalog(entries)
        setModel((current) => {
          const desired = preferredModel ?? current
          if (desired && entries.some((entry) => entry.id === desired)) return desired
          return entries[0]?.id ?? ''
        })
      } finally {
        if (reqId === catalogReqRef.current) setFetching(false)
      }
    },
    [t]
  )

  useEffect(() => {
    if (!open) {
      catalogReqRef.current += 1
      return
    }
    let cancelled = false
    void (async () => {
      const result = await api.cloudGetConfig()
      if (cancelled) return
      const nextProvider =
        result.success &&
        result.config?.configured &&
        result.config.providerId &&
        CLOUD_PROVIDER_PRESETS.some((item) => item.id === result.config?.providerId)
          ? result.config.providerId
          : 'deepseek'
      const savedModel =
        result.success && result.config?.configured ? (result.config.model ?? '') : ''
      setProviderId(nextProvider)
      setModel(savedModel)
      setMask(result.success && result.config?.configured ? (result.config.apiKeyMasked ?? '') : '')
      setApiKey('')
      await loadCatalog(nextProvider, savedModel)
    })()
    return () => {
      cancelled = true
      catalogReqRef.current += 1
    }
  }, [open, loadCatalog])

  const selectedEntry = useMemo(
    () => catalog.find((entry) => entry.id === model) ?? null,
    [catalog, model]
  )

  const capabilitySummary = useMemo(() => {
    if (!selectedEntry) return ''
    const parts: string[] = []
    if (selectedEntry.contextWindow) {
      parts.push(`${t('modelContextColumn')} ${formatTokens(selectedEntry.contextWindow)}`)
    }
    if (selectedEntry.maxTokens) {
      parts.push(`${t('modelMaxTokensColumn')} ${formatTokens(selectedEntry.maxTokens)}`)
    }
    if (selectedEntry.reasoning !== undefined) {
      parts.push(selectedEntry.reasoning ? t('providerReasoningYes') : t('providerReasoningNo'))
    }
    if (selectedEntry.vision !== undefined) {
      parts.push(selectedEntry.vision ? t('providerVisionYes') : t('providerVisionNo'))
    }
    return parts.join(' · ')
  }, [selectedEntry, t])

  const save = async () => {
    const cleanKey = apiKey.trim()
    if (!providerId.trim() || !model.trim()) return
    if (!cleanKey) {
      toast.error(t('cloudApiKeyRequired'))
      return
    }
    setSaving(true)
    try {
      const result = await api.cloudSaveConfig({
        providerId: providerId.trim(),
        model: model.trim(),
        apiKey: cleanKey,
      })
      if (result.success) {
        const warning = result.result?.warning
        toast.success(warning ? `${t('cloudSaved')} (${warning})` : t('cloudSaved'))
        setApiKey('')
        if (result.result?.apiKeyMasked) {
          setMask(result.result.apiKeyMasked)
        } else {
          const refreshed = await api.cloudGetConfig()
          if (refreshed.success && refreshed.config?.apiKeyMasked) {
            setMask(refreshed.config.apiKeyMasked)
          }
        }
      } else {
        toast.error(result.error ?? t('unknownError'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('cloudConfigTitle')}
      size="md"
      closeLabel={t('close')}
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadCatalog(providerId)}
            disabled={fetching}
          >
            {fetching ? <Spinner size={13} /> : <RefreshCw size={13} />}
            {fetching ? t('cloudFetchingModels') : t('cloudFetchModels')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('close')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={saving || !providerId.trim() || !model.trim()}
          >
            {saving ? <Spinner size={13} /> : null}
            {t('cloudSave')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <p className="type-caption text-ink-muted">{t('cloudConfigDesc')}</p>
        <Field label={t('cloudProvider')} htmlFor="cloud-provider">
          <Select
            id="cloud-provider"
            value={providerId}
            onChange={(event) => {
              const next = event.target.value
              setProviderId(next)
              setModel('')
              void loadCatalog(next, '')
            }}
          >
            {CLOUD_PROVIDER_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </Select>
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
            placeholder="sk-..."
          />
        </Field>
        <Field
          label={t('cloudModel')}
          htmlFor="cloud-model"
          hint={catalog.length > 0 ? t('cloudModelsHint', { count: catalog.length }) : undefined}
        >
          {catalog.length > 0 ? (
            <Select id="cloud-model" value={model} onChange={(event) => setModel(event.target.value)}>
              {catalog.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name ? `${entry.name} (${entry.id})` : entry.id}
                </option>
              ))}
            </Select>
          ) : (
            <p className="type-caption text-ink-muted">
              {fetching ? t('cloudFetchingModels') : t('cloudNoCatalogModels')}
            </p>
          )}
        </Field>
        {capabilitySummary && <p className="type-caption text-ink-muted">{capabilitySummary}</p>}
      </div>
    </Modal>
  )
}

/**
 * 确认方案并授权（F-16 / F-17 / F-18）：薄包装 `@pi-workbench/cloud-ui` 的 `CloudConfirmPlanModal`，
 * 负责接入桌面端 store、双语文案与 toast 提示。
 */
const AuthorizeDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const t = useI18nStore((state) => state.t)
  const devices = useCloudStore((state) => state.devices)
  const confirmPlan = useCloudStore((state) => state.confirmPlan)

  return (
    <CloudConfirmPlanModal
      open={open}
      devices={devices}
      onClose={onClose}
      labels={{
        title: t('cloudAuthorizeTitle'),
        close: t('close'),
        cancel: t('cancel'),
        confirm: t('cloudAuthorizeAction'),
        hint: t('cloudAuthorizeHint'),
        planLabel: t('cloudPlanText'),
        planPlaceholder: t('cloudPlanTextPlaceholder'),
        deviceLabel: t('cloudAuthorizeDevice'),
        repoLabel: t('cloudAuthorizeRepo'),
        noGitRepo: t('cloudNoGitRepo'),
        quotaLabel: t('cloudQuotaLabel'),
      }}
      onSubmit={async (payload) => {
        const ok = await confirmPlan(payload)
        if (!ok) {
          toast.error(t('cloudAuthorizeFailed'))
          return false
        }
        toast.success(t('cloudAuthorizeSent'))
        return true
      }}
    />
  )
}

/**
 * 云端记忆、留存文档（AGENTS.md / SOUL.md）与梦境整理弹窗（F-39 / F-41 / C-03a）。
 * 所有云端落盘文件透明可见、可编辑，手工记忆永不被自动抽取或梦境覆盖。
 */
const CloudMemoryModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const t = useI18nStore((state) => state.t)
  const [tab, setTab] = useState<'memories' | 'docs' | 'dreams'>('memories')
  const [loading, setLoading] = useState(false)
  const [memories, setMemories] = useState<CloudMemoryItem[]>([])
  const [docs, setDocs] = useState<CloudDocItem[]>([])
  const [dreams, setDreams] = useState<CloudDreamItem[]>([])
  const [kind, setKind] = useState<CloudMemoryKind>('fact')
  const [content, setContent] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editKind, setEditKind] = useState<CloudMemoryKind>('fact')
  const [editContent, setEditContent] = useState('')
  const [editTags, setEditTags] = useState('')
  const [selectedDoc, setSelectedDoc] = useState<'AGENTS.md' | 'SOUL.md'>('AGENTS.md')
  // docDrafts 仅存用户动手改过的脏草稿；未修改文档刷新时直接读服务端最新内容
  const [docDrafts, setDocDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.cloudGetMemoryData()
      if (res.success) {
        setMemories(res.memories ?? [])
        setDocs(res.docs ?? [])
        setDreams(res.dreams ?? [])
      } else if (res.error) {
        toast.error(res.error)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
    else setEditingId(null)
  }, [open, refresh])

  const addMemory = async () => {
    if (busy) return
    const trimmed = content.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      const res = await api.cloudAddMemory({ kind, content: trimmed })
      if (res.success && res.memory) {
        setMemories((prev) => [res.memory!, ...prev])
        setContent('')
        toast.success(t('cloudSaved'))
      } else {
        toast.error(res.error ?? t('unknownError'))
      }
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (item: CloudMemoryItem) => {
    setEditingId(item.id)
    setEditKind(item.kind)
    setEditContent(item.content)
    setEditTags((item.tags ?? []).join(', '))
  }

  const saveEdit = async () => {
    if (!editingId || busy) return
    const trimmed = editContent.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      const res = await api.cloudUpdateMemory({
        id: editingId,
        kind: editKind,
        content: trimmed,
        tags: parseTagsInput(editTags),
      })
      if (res.success && res.memory) {
        setMemories((prev) => prev.map((entry) => (entry.id === editingId ? res.memory! : entry)))
        setEditingId(null)
        toast.success(t('cloudMemoryEditHint'))
      } else if (res.error) {
        toast.error(res.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const togglePin = async (item: CloudMemoryItem) => {
    const res = await api.cloudUpdateMemory({ id: item.id, pinned: !item.pinned })
    if (res.success && res.memory) {
      setMemories((prev) => prev.map((entry) => (entry.id === item.id ? res.memory! : entry)))
    } else if (res.error) {
      toast.error(res.error)
    }
  }

  const removeMemory = async (id: string) => {
    const res = await api.cloudDeleteMemory(id)
    if (res.success) {
      if (editingId === id) setEditingId(null)
      setMemories((prev) => prev.filter((entry) => entry.id !== id))
    } else if (res.error) {
      toast.error(res.error)
    }
  }

  const saveDoc = async () => {
    if (busy) return
    setBusy(true)
    try {
      const current = docs.find((d) => d.name === selectedDoc)
      const nextContent =
        selectedDoc in docDrafts ? docDrafts[selectedDoc] : (current?.content ?? '')
      const res = await api.cloudSaveDoc({
        name: selectedDoc,
        content: nextContent,
      })
      if (res.success && res.doc) {
        const saved = res.doc
        setDocs((prev) =>
          prev.some((d) => d.name === saved.name)
            ? prev.map((d) => (d.name === saved.name ? saved : d))
            : [...prev, saved]
        )
        setDocDrafts((prev) => {
          const next = { ...prev }
          delete next[saved.name]
          return next
        })
        toast.success(t('cloudDocSaved'))
      } else {
        toast.error(res.error ?? t('unknownError'))
      }
    } finally {
      setBusy(false)
    }
  }

  const runDream = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.cloudRunDream()
      if (res.success) {
        await refresh()
        toast.success(res.dream?.summary || t('cloudSaved'))
      } else {
        toast.error(res.error ?? t('unknownError'))
      }
    } finally {
      setBusy(false)
    }
  }

  const currentDoc = docs.find((d) => d.name === selectedDoc)
  const currentDocValue =
    selectedDoc in docDrafts ? docDrafts[selectedDoc] : (currentDoc?.content ?? '')
  const memorySourceLabel = (source: CloudMemoryItem['source']) =>
    source === 'manual'
      ? t('cloudMemorySourceManual')
      : source === 'dream'
        ? t('cloudMemorySourceDream')
        : t('cloudMemorySourceAuto')

  return (
    <Modal open={open} onClose={onClose} title={t('cloudMemorySection')} size="lg" closeLabel={t('close')}>
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-center gap-2 border-b border-rule-divide">
          <div role="tablist" aria-label={t('cloudMemorySection')} className="flex items-center gap-1">
            <Tab
              size="sm"
              active={tab === 'memories'}
              label={`${t('cloudMemoryItemsTab')} (${memories.length})`}
              onSelect={() => setTab('memories')}
            />
            <Tab
              size="sm"
              active={tab === 'docs'}
              label={t('cloudMemoryDocsTab')}
              onSelect={() => setTab('docs')}
            />
            <Tab
              size="sm"
              active={tab === 'dreams'}
              label={`${t('cloudMemoryDreamsTab')} (${dreams.length})`}
              onSelect={() => setTab('dreams')}
            />
          </div>
          <div className="ml-auto pb-1">
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
              {t('cloudRefresh')}
            </Button>
          </div>
        </div>

        {tab === 'memories' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="w-28 flex-shrink-0">
                <Select
                  value={kind}
                  onChange={(event) => setKind(event.target.value as CloudMemoryKind)}
                >
                  {(['fact', 'preference', 'project', 'decision', 'todo'] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(MEMORY_KIND_KEY[value] as Parameters<typeof t>[0])}
                    </option>
                  ))}
                </Select>
              </div>
              <Input
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder={t('cloudMemoryAddPlaceholder')}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229 &&
                    !busy &&
                    content.trim()
                  ) {
                    event.preventDefault()
                    void addMemory()
                  }
                }}
              />
              <Button
                variant="primary"
                size="sm"
                className="flex-shrink-0"
                onClick={() => void addMemory()}
                disabled={busy || !content.trim()}
              >
                {t('cloudMemoryAdd')}
              </Button>
            </div>
            {memories.length === 0 ? (
              <p className="type-caption text-ink-muted">{t('cloudMemoryEmpty')}</p>
            ) : (
              <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                {memories.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-col gap-1.5 rounded border border-rule-divide bg-panel px-3 py-2"
                  >
                    {editingId === item.id ? (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="type-caption text-ink-muted">
                            {t('cloudMemoryEditHint')}
                          </span>
                          <div className="w-28 flex-shrink-0">
                            <Select
                              value={editKind}
                              onChange={(event) => setEditKind(event.target.value as CloudMemoryKind)}
                            >
                              {(['fact', 'preference', 'project', 'decision', 'todo'] as const).map(
                                (value) => (
                                  <option key={value} value={value}>
                                    {t(MEMORY_KIND_KEY[value] as Parameters<typeof t>[0])}
                                  </option>
                                )
                              )}
                            </Select>
                          </div>
                        </div>
                        <Textarea
                          rows={3}
                          value={editContent}
                          onChange={(event) => setEditContent(event.target.value)}
                        />
                        <Input
                          value={editTags}
                          onChange={(event) => setEditTags(event.target.value)}
                          placeholder={t('cloudMemoryTagsPlaceholder')}
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void saveEdit()}
                            disabled={busy || !editContent.trim()}
                          >
                            {t('cloudSave')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingId(null)}
                            disabled={busy}
                          >
                            {t('cancel')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="type-caption text-ink-muted">
                            {t(MEMORY_KIND_KEY[item.kind] as Parameters<typeof t>[0])} ·{' '}
                            {memorySourceLabel(item.source)}
                          </span>
                          <div className="ml-auto flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => startEdit(item)}
                              title={t('cloudMemoryEdit')}
                              aria-label={t('cloudMemoryEdit')}
                            >
                              <Pencil size={12} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void togglePin(item)}
                              title={item.pinned ? t('cloudMemoryUnpin') : t('cloudMemoryPin')}
                              aria-label={item.pinned ? t('cloudMemoryUnpin') : t('cloudMemoryPin')}
                            >
                              <Pin size={12} className={item.pinned ? 'text-accent' : undefined} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void removeMemory(item.id)}
                              title={t('delete')}
                              aria-label={t('delete')}
                            >
                              <Trash2 size={12} />
                            </Button>
                          </div>
                        </div>
                        <p className="type-body text-ink">{item.content}</p>
                        {item.tags && item.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {item.tags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded border border-rule-divide bg-sunken px-1.5 py-0.5 type-caption text-ink-muted"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === 'docs' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              {(['AGENTS.md', 'SOUL.md'] as const).map((name) => (
                <Button
                  key={name}
                  variant={selectedDoc === name ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setSelectedDoc(name)}
                >
                  {name}
                </Button>
              ))}
              <span className="ml-auto type-caption text-ink-muted">
                {currentDoc?.updatedAt
                  ? new Date(currentDoc.updatedAt).toLocaleString()
                  : t('cloudDocUnsaved')}
              </span>
            </div>
            <Textarea
              rows={12}
              value={currentDocValue}
              onChange={(event) =>
                setDocDrafts((prev) => ({ ...prev, [selectedDoc]: event.target.value }))
              }
              placeholder={t('cloudDocPlaceholder')}
            />
            <div className="flex justify-end">
              <Button variant="primary" size="sm" onClick={() => void saveDoc()} disabled={busy}>
                {busy ? <Spinner size={13} /> : null}
                {t('cloudDocSave')}
              </Button>
            </div>
          </div>
        )}

        {tab === 'dreams' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="type-caption text-ink-muted">
                {dreams.length === 0 ? t('cloudDreamsEmpty') : ''}
              </span>
              <Button variant="secondary" size="sm" onClick={() => void runDream()} disabled={busy}>
                {busy ? <Spinner size={13} /> : <Sparkles size={13} />}
                {t('cloudMemoryRunDream')}
              </Button>
            </div>
            {dreams.length > 0 && (
              <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                {dreams.map((dream) => (
                  <li
                    key={dream.id}
                    className="flex flex-col gap-1 rounded border border-rule-divide bg-panel px-3 py-2"
                  >
                    <div className="flex items-center gap-2 type-caption text-ink-muted">
                      <span className="type-data">{new Date(dream.at).toLocaleString()}</span>
                      <span>
                        ·{' '}
                        {dream.trigger === 'manual'
                          ? t('cloudDreamTriggerManual')
                          : t('cloudDreamTriggerIdle')}
                      </span>
                      <span className="ml-auto type-data">
                        +{dream.added} / -{dream.removed}
                      </span>
                    </div>
                    <p className="type-body text-ink">{dream.summary}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
