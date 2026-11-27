import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  BookOpen,
  Cloud,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  RefreshCw,
  SlidersHorizontal,
  Unplug,
} from 'lucide-react'
import {
  CLOUD_ACTIVE_TASK_STATUSES,
  CLOUD_PROVIDER_PRESETS,
  CloudAuthorizationCard,
  CloudChatComposer,
  CloudConfigForm,
  CloudConfirmPlanModal,
  CloudDeviceList,
  CloudMemoryManager,
  CloudNoticeCard,
  CloudTaskCard,
  CloudTraceSection,
  CloudUnitCard,
  TaskResultSection,
  formatCloudTime,
} from '@pi-workbench/cloud-ui'
import { useCloudStore } from '../../store/cloudStore'
import { useI18nStore } from '../../store/i18nStore'
import { toast } from '../../store/toastStore'
import { confirmDialog } from '../../store/dialogStore'
import type {
  CloudChatRow,
  CloudDocItem,
  CloudDreamItem,
  CloudMemoryItem,
} from '../../types/cloud'
import type { CloudCatalogModel } from '../../types/electron'
import { api } from '../../api'
import { StreamingMarkdown } from '../chat/AgentMarkdown'
import { StreamingTranscript, type StreamingTranscriptHandle } from '../ui/StreamingTranscript'
import { Button, EmptyState, Field, IconButton, Input, Modal, Spinner } from '../ui/ui'
import { SectionHeader, StatusText } from '../ui/patterns'

/**
 * 云端页（F-27 / D-19）：独立视图，与工作区无关，保留顶栏与底部状态栏。
 *
 * 工单 / 工作单元 / 设备 / 授权 / 提示 / 确认授权弹窗 / 记忆与留存文档 / 模型配置 / 消息输入区
 * 统一复用 `@pi-workbench/cloud-ui`，桌面端仅负责接入 store / Electron IPC 与 toast。
 */

const ACTIVE_STATUSES = CLOUD_ACTIVE_TASK_STATUSES
const formatTime = (value?: number) => formatCloudTime(value, false)

const CloudMessageItem = React.memo(function CloudMessageItem({
  message,
  language,
}: {
  message: CloudChatRow
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

              <CloudChatComposer
                value={draft}
                onChange={setDraft}
                onSend={send}
                canStopReply={canStopReply}
                onStopReply={() => void stopReply()}
                agentStatus={agentStatus}
                language={language}
                showIcons
                stopButtonVariant="ghost"
              />
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
                language={language}
                tasks={[...running, ...finished]}
                devices={devices}
                stoppingTaskIds={stoppingTaskIds}
                answerDrafts={answerDraft}
                instructionDrafts={instructionDraft}
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
                language={language}
                onCloseUnit={(unitId) => {
                  void closeUnit(unitId).then((sent) => {
                    if (sent) toast.success(t('cloudUnitCloseSent'))
                    else toast.error(t('cloudUnitCloseFailed'))
                  })
                }}
              />

              <CloudDeviceList
                devices={devices}
                language={language}
                showDetails={false}
                onlineTone="accent"
                emptyLabel={t('cloudNoWorkspaces')}
              />

              <CloudAuthorizationCard
                authorizations={authorizations}
                showTargets={false}
                language={language}
                action={
                  linked ? (
                    <Button variant="secondary" size="sm" onClick={() => setAuthorizeOpen(true)}>
                      <PenLine size={13} />
                      {t('cloudAuthorizeTitle')}
                    </Button>
                  ) : undefined
                }
                labels={{ expiresText: undefined }}
              />

              {notices.length > 0 && (
                <CloudNoticeCard notices={notices} language={language} labels={{ empty: '' }} />
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
 * 云端模型配置弹窗（F-01 / U-04）：薄包装 `@pi-workbench/cloud-ui` 的 `CloudConfigForm`。
 */
const CloudConfigModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const t = useI18nStore((state) => state.t)
  const language = useI18nStore((state) => state.language)
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
      <CloudConfigForm
        className="px-5 py-4"
        idPrefix="cloud"
        providerId={providerId}
        model={model}
        apiKey={apiKey}
        apiKeyMasked={mask}
        models={catalog}
        fetching={fetching}
        language={language}
        showMaskedKeyInHint
        showModelIdInOption
        onProviderChange={(next) => {
          setProviderId(next)
          setModel('')
          void loadCatalog(next, '')
        }}
        onModelChange={setModel}
        onApiKeyChange={setApiKey}
      />
    </Modal>
  )
}

/**
 * 确认方案并授权（F-16 / F-17 / F-18）：薄包装 `@pi-workbench/cloud-ui` 的 `CloudConfirmPlanModal`，
 * 负责接入桌面端 store、双语文案与 toast 提示。
 */
const AuthorizeDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const t = useI18nStore((state) => state.t)
  const language = useI18nStore((state) => state.language)
  const devices = useCloudStore((state) => state.devices)
  const confirmPlan = useCloudStore((state) => state.confirmPlan)

  return (
    <CloudConfirmPlanModal
      open={open}
      devices={devices}
      language={language}
      onClose={onClose}
      labels={{
        title: t('cloudAuthorizeTitle'),
        confirm: t('cloudAuthorizeAction'),
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
 * 云端记忆、留存文档（AGENTS.md / SOUL.md）与梦境整理弹窗（F-39 / F-41 / C-03a）：
 * 薄包装 `@pi-workbench/cloud-ui` 的 `CloudMemoryManager`，接入桌面 IPC 与 toast。
 */
const CloudMemoryModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const t = useI18nStore((state) => state.t)
  const language = useI18nStore((state) => state.language)
  const [loading, setLoading] = useState(false)
  const [memories, setMemories] = useState<CloudMemoryItem[]>([])
  const [docs, setDocs] = useState<CloudDocItem[]>([])
  const [dreams, setDreams] = useState<CloudDreamItem[]>([])
  const [docDrafts, setDocDrafts] = useState<Record<string, string>>({})

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
  }, [open, refresh])

  return (
    <Modal open={open} onClose={onClose} title={t('cloudMemorySection')} size="lg" closeLabel={t('close')}>
      {open && (
        <CloudMemoryManager
          memories={memories}
          docs={docs}
          dreams={dreams}
          docDrafts={docDrafts}
          loading={loading}
          language={language}
          layout="tabs"
          confirmDelete={false}
          showKindFilter
          onDocDraftChange={(name, value) =>
            setDocDrafts((prev) => ({ ...prev, [name]: value }))
          }
          onRefresh={refresh}
          onAddMemory={async ({ kind, content }) => {
            const res = await api.cloudAddMemory({ kind, content })
            if (res.success && res.memory) {
              setMemories((prev) => [res.memory!, ...prev])
              toast.success(t('cloudSaved'))
              return { ok: true }
            }
            const err = res.error ?? t('unknownError')
            toast.error(err)
            return { ok: false, error: err }
          }}
          onUpdateMemory={async (payload) => {
            const res = await api.cloudUpdateMemory(payload)
            if (res.success && res.memory) {
              setMemories((prev) =>
                prev.map((entry) => (entry.id === payload.id ? res.memory! : entry))
              )
              if (payload.content !== undefined) toast.success(t('cloudMemoryEditHint'))
              return { ok: true }
            }
            if (res.error) toast.error(res.error)
            return { ok: false, error: res.error }
          }}
          onDeleteMemory={async (id) => {
            const res = await api.cloudDeleteMemory(id)
            if (res.success) {
              setMemories((prev) => prev.filter((entry) => entry.id !== id))
              return { ok: true }
            }
            if (res.error) toast.error(res.error)
            return { ok: false, error: res.error }
          }}
          onSaveDoc={async ({ name, content }) => {
            const res = await api.cloudSaveDoc({ name, content })
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
              return { ok: true }
            }
            const err = res.error ?? t('unknownError')
            toast.error(err)
            return { ok: false, error: err }
          }}
          onRunDream={async () => {
            const res = await api.cloudRunDream()
            if (res.success) {
              await refresh()
              toast.success(res.dream?.summary || t('cloudSaved'))
              return { ok: true, summary: res.dream?.summary }
            }
            const err = res.error ?? t('unknownError')
            toast.error(err)
            return { ok: false, error: err }
          }}
        />
      )}
    </Modal>
  )
}
