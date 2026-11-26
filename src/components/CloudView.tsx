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
import { useCloudStore } from '../store/cloudStore'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { confirmDialog } from '../store/dialogStore'
import type {
  CloudDocItem,
  CloudDreamItem,
  CloudMemoryItem,
  CloudMemoryKind,
  CloudTaskRow,
  CloudTaskStatusName,
  CloudUnitRow,
} from '../types/cloud'
import type { CloudCatalogModel } from '../types/electron'
import { api } from '../api'
import { MarkdownBody, StreamingMarkdown } from './AgentMarkdown'
import { Button, EmptyState, Field, IconButton, Input, Modal, Select, Spinner, Textarea } from './ui'
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

/** 固定供应商白名单（与云端 Web 及桌面端预设一致；模型能力来自 Pi catalog） */
const CLOUD_PROVIDER_PRESETS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'google', label: 'Google' },
  { id: 'xai', label: 'xAI' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'xiaomi', label: '小米 MiMo' },
  { id: 'xiaomi-token-plan-cn', label: '小米（Token 套餐）' },
  { id: 'openai-codex', label: 'OpenAI Codex' },
]

const MEMORY_KIND_KEY: Record<CloudMemoryKind, string> = {
  fact: 'cloudMemoryKindFact',
  preference: 'cloudMemoryKindPreference',
  project: 'cloudMemoryKindProject',
  decision: 'cloudMemoryKindDecision',
  todo: 'cloudMemoryKindTodo',
}

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

function formatTokens(value?: number): string {
  if (!value) return '-'
  if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`
  return `${Math.round(value / 1024)}K`
}

function parseTagsInput(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12)
}

export const CloudView: React.FC<{ onBackHome: () => void }> = ({ onBackHome }) => {
  const { t } = useI18nStore()
  const store = useCloudStore()
  const [draft, setDraft] = useState('')
  const [authorizeOpen, setAuthorizeOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [asideCollapsed, setAsideCollapsed] = useState(false)
  const [answerDraft, setAnswerDraft] = useState<Record<string, string>>({})
  const [instructionDraft, setInstructionDraft] = useState<Record<string, string>>({})
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const composingRef = useRef(false)
  const collapseRailRef = useRef<HTMLButtonElement | null>(null)
  const expandRailRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    void store.init()
    // init 只跑一次；store 的方法引用稳定，不放进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 云端页处于可见态时自动上报已读（多端同步清零未读数，F-52 / C-03c）
  useEffect(() => {
    if (store.clientState.status !== 'open') return
    if (store.unreadCount > 0 || store.lastSeq > store.lastReadSeq) {
      if (typeof document === 'undefined' || !document.hidden) {
        void store.markRead()
      }
    }
    const onVisible = () => {
      if (!document.hidden) void useCloudStore.getState().markRead()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.clientState.status, store.unreadCount, store.lastSeq, store.lastReadSeq])

  // 贴底：按滚动事件提前记录是否在底部附近，避免单条 >64px 消息更新后才测量导致断跟随
  useEffect(() => {
    const element = transcriptRef.current
    if (!element) return
    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight
      stickToBottomRef.current = distance < 64
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const element = transcriptRef.current
    if (!element || !stickToBottomRef.current) return
    element.scrollTop = element.scrollHeight
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
    stickToBottomRef.current = true
    setDraft('')
    void store.say(body)
  }

  const unpair = async () => {
    if (!(await confirmDialog({ message: t('cloudUnpairConfirm'), danger: true }))) return
    await store.unlink()
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
          dot
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
            <Button variant="ghost" size="sm" onClick={() => setConfigOpen(true)}>
              <SlidersHorizontal size={13} />
              {t('cloudConfigTitle')}
            </Button>
          )}
          {store.link.linked && (
            <Button variant="ghost" size="sm" onClick={() => setMemoryOpen(true)}>
              <BookOpen size={13} />
              {t('cloudMemorySection')}
            </Button>
          )}
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

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {store.link.linked ? (
            <>
              <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {store.awaySummary && (
                  <div
                    role="status"
                    className="mb-4 rounded border border-rule-divide bg-panel px-3 py-2"
                  >
                    <p className="type-label text-ink">{t('cloudAwaySummaryTitle')}</p>
                    <p className="mt-0.5 type-caption text-ink-muted">
                      {store.awaySummary.text}
                    </p>
                  </div>
                )}
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
                        {message.text &&
                          (message.role === 'user' ? (
                            <p className="whitespace-pre-wrap break-words type-body text-ink">
                              {message.text}
                            </p>
                          ) : (
                            <div className="chat-markdown text-ink">
                              {message.streaming ? (
                                <StreamingMarkdown content={message.text} />
                              ) : (
                                <MarkdownBody
                                  content={message.text}
                                  highlight={message.text.length <= 20_000}
                                />
                              )}
                            </div>
                          ))}
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
                    onClick={() => void store.stopReply()}
                    disabled={!store.canStopReply}
                  >
                    <Square size={13} />
                    {t('cloudStopReply')}
                  </Button>
                  <span className="type-caption text-ink-muted">{t('cloudSendShortcutHint')}</span>
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
              <TaskList
                title={t('cloudTasks')}
                tasks={[...running, ...finished]}
                devices={store.devices}
                stoppingTaskIds={store.stoppingTaskIds}
                onStop={(taskId) => void store.stopTask(taskId)}
                onAnswer={(taskId, text) => {
                  void store.answerQuestion(taskId, text)
                  setAnswerDraft((current) => ({ ...current, [taskId]: '' }))
                }}
                answerDraft={answerDraft}
                onAnswerDraft={(taskId, text) =>
                  setAnswerDraft((current) => ({ ...current, [taskId]: text }))
                }
                onSendInstruction={(taskId, text) => {
                  void store.sendTaskMessage(taskId, text)
                  setInstructionDraft((current) => ({ ...current, [taskId]: '' }))
                }}
                instructionDraft={instructionDraft}
                onInstructionDraft={(taskId, text) =>
                  setInstructionDraft((current) => ({ ...current, [taskId]: text }))
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
  devices: Array<{ id: string; online: boolean }>
  stoppingTaskIds: Record<string, true>
  onStop: (taskId: string) => void
  onAnswer: (taskId: string, text: string) => void
  answerDraft: Record<string, string>
  onAnswerDraft: (taskId: string, text: string) => void
  onSendInstruction: (taskId: string, text: string) => void
  instructionDraft: Record<string, string>
  onInstructionDraft: (taskId: string, text: string) => void
}> = ({
  title,
  tasks,
  devices,
  stoppingTaskIds,
  onStop,
  onAnswer,
  answerDraft,
  onAnswerDraft,
  onSendInstruction,
  instructionDraft,
  onInstructionDraft,
}) => {
  const { t } = useI18nStore()
  const onlineById = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const device of devices) map.set(device.id, device.online)
    return map
  }, [devices])

  return (
    <Card density="compact">
      <CardHeader title={title} />
      {tasks.length === 0 ? (
        <p className="type-caption text-ink-muted">{t('cloudNoTasks')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {tasks.map((task) => {
            const active = ACTIVE_STATUSES.includes(task.status)
            const deviceOffline = onlineById.get(task.deviceId) === false
            const stopping = Boolean(stoppingTaskIds[task.id])
            const elapsed = task.startedAt
              ? formatDuration(task.startedAt, task.finishedAt ?? Date.now())
              : ''
            const changedFiles = task.changedFiles ?? task.result?.changedFiles ?? []
            const attentionFiles = changedFiles.filter((file) => Boolean(file.attention))
            const normalFiles = changedFiles.filter((file) => !file.attention)
            const secretHits = task.secretHits ?? task.result?.secretHits ?? []
            const hasDetails =
              Boolean(task.result?.summary) || changedFiles.length > 0 || secretHits.length > 0

            return (
              <li key={task.id} className="flex flex-col gap-1">
                <span className="flex items-center gap-2 type-label text-ink">
                  <span className="truncate">{task.title}</span>
                  <span className="ml-auto flex-shrink-0 type-caption text-ink-muted">
                    {stopping
                      ? t('cloudStoppingTask')
                      : t(TASK_STATUS_KEY[task.status] as Parameters<typeof t>[0])}
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
                {task.status === 'running' && !deviceOffline && (
                  <div className="flex items-center gap-2">
                    <Input
                      value={instructionDraft[task.id] ?? ''}
                      onChange={(event) => onInstructionDraft(task.id, event.target.value)}
                      placeholder={t('cloudSendInstructionPlaceholder')}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && (instructionDraft[task.id] ?? '').trim()) {
                          event.preventDefault()
                          onSendInstruction(task.id, instructionDraft[task.id] ?? '')
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onSendInstruction(task.id, instructionDraft[task.id] ?? '')}
                      disabled={!(instructionDraft[task.id] ?? '').trim()}
                    >
                      {t('cloudSendInstruction')}
                    </Button>
                  </div>
                )}
                {hasDetails && (
                  <details className="type-caption text-ink-muted">
                    <summary className="cursor-pointer select-none">{t('cloudChangedFiles')}</summary>
                    {task.result?.summary && (
                      <p className="mt-1 whitespace-pre-wrap text-ink">{task.result.summary}</p>
                    )}
                    {attentionFiles.length > 0 && (
                      <p className="mt-1 text-warning">
                        {t('cloudChangedAttention')}:{' '}
                        {attentionFiles
                          .map((file) => `${file.path} (${file.attention})`)
                          .join(', ')}
                      </p>
                    )}
                    {normalFiles.length > 0 && (
                      <p className="mt-1">
                        {t('cloudChangedNormal')}: {normalFiles.map((file) => file.path).join(', ')}
                      </p>
                    )}
                    {secretHits.length > 0 && (
                      <p className="mt-1 text-danger">
                        {t('cloudSecretHits')}:{' '}
                        {secretHits.map((hit) => `${hit.path}:${hit.line} (${hit.kind})`).join(', ')}
                      </p>
                    )}
                  </details>
                )}
                {task.error && <span className="type-caption text-danger">{task.error}</span>}
                {active && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onStop(task.id)}
                    disabled={stopping || deviceOffline}
                    title={deviceOffline ? t('cloudOfflineTaskCancelled') : t('cloudStopTask')}
                  >
                    <Square size={12} />
                    {stopping
                      ? t('cloudStoppingTask')
                      : deviceOffline
                        ? t('cloudOfflineTaskCancelled')
                        : t('cloudStopTask')}
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

/**
 * 云端模型配置弹窗（F-01 / U-04）：对齐 0.11.x 8 家供应商白名单与 Pi catalog。
 * 从右栏收进顶栏弹窗，避免窄窗口下右栏过度拥挤。
 */
const CloudConfigModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { t } = useI18nStore()
  const [providerId, setProviderId] = useState('deepseek')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [mask, setMask] = useState('')
  const [catalog, setCatalog] = useState<CloudCatalogModel[]>([])
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadCatalog = useCallback(
    async (targetProviderId: string, preferredModel?: string) => {
      setFetching(true)
      try {
        const result = await api.cloudFetchModels({ providerId: targetProviderId })
        if (!result.success) {
          setCatalog([])
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
        setFetching(false)
      }
    },
    [t]
  )

  useEffect(() => {
    if (!open) return
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

/**
 * 云端记忆、留存文档（AGENTS.md / SOUL.md）与梦境整理弹窗（F-39 / F-41 / C-03a）。
 * 所有云端落盘文件透明可见、可编辑，手工记忆永不被自动抽取或梦境覆盖。
 */
const CloudMemoryModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { t } = useI18nStore()
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
  const [docDrafts, setDocDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try {
      const res = await api.cloudGetMemoryData()
      if (res.success) {
        setMemories(res.memories ?? [])
        const nextDocs = res.docs ?? []
        setDocs(nextDocs)
        setDocDrafts((prev) => {
          const updated = { ...prev }
          for (const doc of nextDocs) {
            if (!(doc.name in updated)) updated[doc.name] = doc.content
          }
          return updated
        })
        setDreams(res.dreams ?? [])
      } else if (res.error) {
        toast.error(res.error)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void refresh()
    else setEditingId(null)
  }, [open])

  const addMemory = async () => {
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
    if (!editingId) return
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
    setBusy(true)
    try {
      const res = await api.cloudSaveDoc({
        name: selectedDoc,
        content: docDrafts[selectedDoc] ?? '',
      })
      if (res.success && res.doc) {
        const saved = res.doc
        setDocs((prev) =>
          prev.some((d) => d.name === saved.name)
            ? prev.map((d) => (d.name === saved.name ? saved : d))
            : [...prev, saved]
        )
        setDocDrafts((prev) => ({ ...prev, [saved.name]: saved.content }))
        toast.success(t('cloudDocSaved'))
      } else {
        toast.error(res.error ?? t('unknownError'))
      }
    } finally {
      setBusy(false)
    }
  }

  const runDream = async () => {
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
  const memorySourceLabel = (source: CloudMemoryItem['source']) =>
    source === 'manual'
      ? t('cloudMemorySourceManual')
      : source === 'dream'
        ? t('cloudMemorySourceDream')
        : t('cloudMemorySourceAuto')

  return (
    <Modal open={open} onClose={onClose} title={t('cloudMemorySection')} size="lg" closeLabel={t('close')}>
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-center gap-2 border-b border-rule-divide pb-2">
          <Button
            variant={tab === 'memories' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setTab('memories')}
          >
            {t('cloudMemoryItemsTab')} ({memories.length})
          </Button>
          <Button
            variant={tab === 'docs' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setTab('docs')}
          >
            {t('cloudMemoryDocsTab')}
          </Button>
          <Button
            variant={tab === 'dreams' ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setTab('dreams')}
          >
            {t('cloudMemoryDreamsTab')} ({dreams.length})
          </Button>
          <div className="ml-auto">
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
              {t('cloudRefresh')}
            </Button>
          </div>
        </div>

        {tab === 'memories' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Select
                value={kind}
                onChange={(event) => setKind(event.target.value as CloudMemoryKind)}
                className="w-28"
              >
                {(['fact', 'preference', 'project', 'decision', 'todo'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(MEMORY_KIND_KEY[value] as Parameters<typeof t>[0])}
                  </option>
                ))}
              </Select>
              <Input
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder={t('cloudMemoryAddPlaceholder')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && content.trim()) {
                    event.preventDefault()
                    void addMemory()
                  }
                }}
              />
              <Button
                variant="primary"
                size="sm"
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
                          <Select
                            value={editKind}
                            onChange={(event) => setEditKind(event.target.value as CloudMemoryKind)}
                            className="w-28"
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
              value={docDrafts[selectedDoc] ?? currentDoc?.content ?? ''}
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
              <span className="type-caption text-ink-muted">{t('cloudDreamsEmpty')}</span>
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
                      <span>{new Date(dream.at).toLocaleString()}</span>
                      <span>· {dream.trigger}</span>
                      <span className="ml-auto">
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
