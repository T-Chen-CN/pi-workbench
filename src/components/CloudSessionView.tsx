/** 云端会话页：左侧会话列表 + 右侧时间线与输入框 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Cloud, CloudOff, MessageSquarePlus, RefreshCw, Send, Square } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { isTerminalRun, useCloudStore } from '../store/cloudStore'
import { distanceFromBottom, pinToBottom, shouldFollow } from '../hooks/chatScroll'
import { formatRelativeTime } from '../utils/relativeTime'
import { formatCost, firstLine, sessionCostUsd } from '../utils/cloudFormat'
import { formatTokenCount } from '../utils/chatPanelShared'
import type { CloudSession } from '../types/cloud'
import { Button, Caption, DataText, EmptyState, IconButton, Label, Spinner, Textarea } from './ui'
import { CloudSessionMetaLine, CloudTrace } from './CloudTrace'

const SESSION_PREVIEW_CHARS = 90

const SessionRow: React.FC<{ session: CloudSession; selected: boolean; onSelect: () => void }> = ({
  session,
  selected,
  onSelect,
}) => {
  const { t, language } = useI18nStore()
  const tokens = session.inputTokens + session.outputTokens
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={onSelect}
      className={`flex w-full flex-col gap-1 border-b border-rule-hairline px-2.5 py-2 text-left transition-colors ${
        selected ? 'bg-active' : 'hover:bg-hover'
      }`}
    >
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate type-value text-ink">
          {session.title || t('untitledSession')}
        </span>
        <Caption className="flex-shrink-0 text-ink-subtle">
          {formatRelativeTime(session.lastActive, language)}
        </Caption>
      </span>
      {session.preview && (
        <Caption className="truncate text-ink-muted">
          {firstLine(session.preview, SESSION_PREVIEW_CHARS)}
        </Caption>
      )}
      <span className="flex items-center gap-2">
        <Caption className="text-ink-subtle">{`${session.messageCount} ${t('cloudMessagesLabel')}`}</Caption>
        <Caption className="text-ink-subtle">{`${session.toolCallCount} ${t('cloudToolsLabel')}`}</Caption>
        {tokens > 0 && (
          <Caption className="text-ink-subtle">
            {`${formatTokenCount(tokens)} ${t('cloudTokensLabel')}`}
          </Caption>
        )}
        <Caption className="ml-auto flex-shrink-0 text-ink-muted">
          {formatCost(sessionCostUsd(session))}
        </Caption>
      </span>
    </button>
  )
}

export const CloudSessionView: React.FC<{ active: boolean }> = ({ active }) => {
  const { t } = useI18nStore()

  const connection = useCloudStore((state) => state.connection)
  const bridgeAvailable = useCloudStore((state) => state.bridgeAvailable)
  const sessions = useCloudStore((state) => state.sessions)
  const sessionsLoading = useCloudStore((state) => state.sessionsLoading)
  const sessionsError = useCloudStore((state) => state.sessionsError)
  const refreshSessions = useCloudStore((state) => state.refreshSessions)
  const activeSessionId = useCloudStore((state) => state.activeSessionId)
  const sessionMeta = useCloudStore((state) => state.sessionMeta)
  const openSession = useCloudStore((state) => state.openSession)
  const newSession = useCloudStore((state) => state.newSession)
  const parts = useCloudStore((state) => state.parts)
  const partsLoading = useCloudStore((state) => state.partsLoading)
  const partsError = useCloudStore((state) => state.partsError)
  const runState = useCloudStore((state) => state.runState)
  const runError = useCloudStore((state) => state.runError)
  const draft = useCloudStore((state) => state.draft)
  const setDraft = useCloudStore((state) => state.setDraft)
  const send = useCloudStore((state) => state.send)
  const stop = useCloudStore((state) => state.stop)

  const [stopping, setStopping] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const busy = runState !== null && !isTerminalRun(runState)
  const connected = connection === 'connected'

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    if (followRef.current) pinToBottom(element)
  }, [parts, activeSessionId])

  // 停止请求返回 / 本轮收尾后按钮回到「发送」
  useEffect(() => {
    if (!busy) setStopping(false)
  }, [busy])

  if (!bridgeAvailable) {
    return (
      <div className="absolute inset-0 flex items-center justify-center p-8">
        <EmptyState icon={CloudOff} title={t('cloudBridgeMissing')} description={t('cloudNoSessionHint')} />
      </div>
    )
  }

  const handleScroll = () => {
    const element = scrollRef.current
    if (!element) return
    followRef.current = shouldFollow(
      distanceFromBottom({
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
      })
    )
  }

  const submit = () => {
    if (!draft.trim() || busy) return
    followRef.current = true
    void send()
  }

  const handleStop = () => {
    if (!busy) return
    setStopping(true)
    void stop()
  }

  const showEmptyTranscript = !activeSessionId && parts.length === 0 && !busy

  return (
    <div
      aria-hidden={!active}
      inert={!active}
      className={`absolute inset-0 flex ${
        active ? 'visible' : 'pointer-events-none invisible'
      }`}
    >
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-rule-divide">
        <div className="flex h-8 flex-shrink-0 items-center gap-1 border-b border-rule-divide px-2">
          <Label className="text-ink-muted">{t('cloudSessionsTitle')}</Label>
          <span className="ml-auto flex items-center gap-0.5">
            <IconButton
              icon={RefreshCw}
              label={t('cloudRefresh')}
              size="sm"
              disabled={!connected || sessionsLoading}
              onClick={() => void refreshSessions()}
            />
            <IconButton
              icon={MessageSquarePlus}
              label={t('cloudNewSession')}
              size="sm"
              onClick={() => {
                newSession()
                inputRef.current?.focus()
              }}
            />
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sessionsLoading && sessions.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-3 type-caption text-ink-muted">
              <Spinner size={12} />
              {t('cloudLoading')}
            </div>
          )}
          {sessionsError && (
            <div className="px-3 py-3 type-caption text-danger">{sessionsError}</div>
          )}
          {!sessionsLoading && !sessionsError && sessions.length === 0 && (
            <div className="px-3 py-3 type-caption text-ink-muted">
              {t('cloudSessionsEmpty')}
            </div>
          )}
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={session.id === activeSessionId}
              onSelect={() => {
                if (session.id === activeSessionId) return
                followRef.current = true
                void openSession(session.id)
              }}
            />
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-8 flex-shrink-0 items-center gap-3 border-b border-rule-divide px-3">
          <DataText className="min-w-0 truncate text-ink">
            {sessionMeta?.title || t('cloudNoSession')}
          </DataText>
          {sessionMeta && (
            <div className="ml-auto flex min-w-0 items-center">
              <CloudSessionMetaLine
                model={sessionMeta.model}
                inputTokens={sessionMeta.inputTokens}
                outputTokens={sessionMeta.outputTokens}
                cost={formatCost(sessionCostUsd(sessionMeta))}
                messageCount={sessionMeta.messageCount}
                toolCallCount={sessionMeta.toolCallCount}
              />
            </div>
          )}
          {busy && (
            <span className="flex flex-shrink-0 items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              <Caption className="text-accent">{t('cloudToolRunning')}</Caption>
            </span>
          )}
        </div>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        >
          {partsLoading && (
            <div className="flex items-center gap-2 py-2 type-caption text-ink-muted">
              <Spinner size={12} />
              {t('cloudLoading')}
            </div>
          )}
          {partsError && <div className="py-2 type-caption text-danger">{partsError}</div>}
          {showEmptyTranscript && (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                icon={Cloud}
                title={t('cloudNoSession')}
                description={t('cloudNoSessionHint')}
              />
            </div>
          )}
          <CloudTrace parts={parts} streaming={busy} />
          {runError && !busy && (
            <div className="py-2 type-caption text-danger">
              {t('cloudRunError', { error: runError })}
            </div>
          )}
        </div>

        <div className="flex-shrink-0 border-t border-rule-divide p-2">
          <div className="flex items-end gap-2">
            <Textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  submit()
                }
              }}
              rows={2}
              placeholder={t('cloudInputPlaceholder')}
              aria-label={t('cloudInputPlaceholder')}
              disabled={!connected}
              className="min-h-[52px] flex-1"
            />
            {busy ? (
              <Button
                variant="danger"
                size="sm"
                icon={Square}
                loading={stopping}
                onClick={handleStop}
              >
                {stopping ? t('cloudStopping') : t('cloudStop')}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon={Send}
                disabled={!connected || !draft.trim()}
                onClick={submit}
              >
                {t('cloudSend')}
              </Button>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <Caption className="text-ink-subtle">
              {connected ? t('cloudStateConnected') : t('cloudStateUnconfigured')}
            </Caption>
          </div>
        </div>
      </section>
    </div>
  )
}
