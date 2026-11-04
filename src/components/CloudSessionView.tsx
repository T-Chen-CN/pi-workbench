/** 云端会话页：左侧会话列表 + 右侧时间线与输入框 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Cloud,
  CloudOff,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  ImagePlus,
  RefreshCw,
  Search,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { filterSessions, isTerminalRun, useCloudStore } from '../store/cloudStore'
import { cloudApi } from '../api/cloud'
import { withImageDirectives } from '../utils/cloudImages'
import { distanceFromBottom, pinToBottom, shouldFollow } from '../hooks/chatScroll'
import { formatRelativeTime } from '../utils/relativeTime'
import { formatCost, firstLine, sessionCostUsd } from '../utils/cloudFormat'
import { formatTokenCount } from '../utils/chatPanelShared'
import type { CloudSession } from '../types/cloud'
import type { AppView } from '../types/navigation'
import {
  Button,
  Caption,
  DataText,
  EmptyState,
  IconButton,
  Input,
  Label,
  Modal,
  PopoverMenu,
  Spinner,
  Textarea,
} from './ui'
import { CloudSessionMetaLine, CloudTrace } from './CloudTrace'

/** 多端同步周期：后端没有事件推送也没有 ETag，只能低频拉一次首屏 */
const SYNC_INTERVAL_MS = 15_000
const SESSION_PREVIEW_CHARS = 90

const SessionRow: React.FC<{
  session: CloudSession
  selected: boolean
  pending: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onTogglePin: () => void
  onDelete: () => void
}> = ({ session, selected, pending, onSelect, onRename, onTogglePin, onDelete }) => {
  const { t, language } = useI18nStore()
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(session.title)
  const renameRef = useRef<HTMLInputElement | null>(null)
  const tokens = session.inputTokens + session.outputTokens

  useEffect(() => {
    if (!editing) return
    renameRef.current?.focus()
    renameRef.current?.select()
  }, [editing])

  const startRename = () => {
    setDraftTitle(session.title)
    setEditing(true)
  }

  const commitRename = () => {
    if (!editing) return
    setEditing(false)
    const next = draftTitle.trim()
    if (next && next !== session.title) onRename(next)
  }

  return (
    <div
      className={`group relative flex items-start gap-1 border-b border-rule-hairline transition-colors ${
        selected ? 'bg-active' : 'hover:bg-hover'
      }`}
    >
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center px-2 py-1.5">
          <Input
            ref={renameRef}
            value={draftTitle}
            aria-label={t('cloudRename')}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitRename()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setEditing(false)
              }
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          aria-current={selected || undefined}
          onClick={onSelect}
          className="flex min-w-0 flex-1 flex-col gap-1 px-2.5 py-2 text-left"
        >
          <span className="flex items-baseline gap-2">
            {session.pinned && <Pin size={11} aria-hidden="true" className="text-accent" />}
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
      )}

      {!editing && (
        <div className="relative flex items-center pr-1 pt-1">
          {pending ? (
            <span className="flex h-6 w-6 items-center justify-center">
              <Spinner size={11} />
            </span>
          ) : (
            <IconButton
              icon={MoreHorizontal}
              label={t('cloudSessionActions')}
              size="sm"
              onClick={() => setMenuOpen((open) => !open)}
              className={`transition-opacity ${
                menuOpen || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            />
          )}
          <PopoverMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            label={t('cloudSessionActions')}
            placement="down"
            className="min-w-[160px]"
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink hover:bg-hover"
              onClick={() => {
                setMenuOpen(false)
                startRename()
              }}
            >
              <Pencil size={13} className="text-ink-muted" />
              {t('cloudRename')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink hover:bg-hover"
              onClick={() => {
                setMenuOpen(false)
                onTogglePin()
              }}
            >
              {session.pinned ? (
                <PinOff size={13} className="text-ink-muted" />
              ) : (
                <Pin size={13} className="text-ink-muted" />
              )}
              {session.pinned ? t('cloudUnpin') : t('cloudPin')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-danger hover:bg-hover"
              onClick={() => {
                setMenuOpen(false)
                onDelete()
              }}
            >
              <Trash2 size={13} />
              {t('cloudDelete')}
            </button>
          </PopoverMenu>
        </div>
      )}
    </div>
  )
}

export const CloudSessionView: React.FC<{
  active: boolean
  onNavigate?: (view: AppView) => void
}> = ({ active, onNavigate }) => {
  const { t, language } = useI18nStore()

  const connection = useCloudStore((state) => state.connection)
  const bridgeAvailable = useCloudStore((state) => state.bridgeAvailable)
  const sessions = useCloudStore((state) => state.sessions)
  const sessionsLoading = useCloudStore((state) => state.sessionsLoading)
  const sessionsError = useCloudStore((state) => state.sessionsError)
  const sessionsHasMore = useCloudStore((state) => state.sessionsHasMore)
  const sessionsLoadingMore = useCloudStore((state) => state.sessionsLoadingMore)
  const sessionQuery = useCloudStore((state) => state.sessionQuery)
  const setSessionQuery = useCloudStore((state) => state.setSessionQuery)
  const loadMoreSessions = useCloudStore((state) => state.loadMoreSessions)
  const syncSessions = useCloudStore((state) => state.syncSessions)
  const sessionsSyncedAt = useCloudStore((state) => state.sessionsSyncedAt)
  const refreshSessions = useCloudStore((state) => state.refreshSessions)
  const activeSessionId = useCloudStore((state) => state.activeSessionId)
  const sessionMeta = useCloudStore((state) => state.sessionMeta)
  const openSession = useCloudStore((state) => state.openSession)
  const newSession = useCloudStore((state) => state.newSession)
  const renameSession = useCloudStore((state) => state.renameSession)
  const togglePinned = useCloudStore((state) => state.togglePinned)
  const deleteSession = useCloudStore((state) => state.deleteSession)
  const sessionActionPending = useCloudStore((state) => state.sessionActionPending)
  const parts = useCloudStore((state) => state.parts)
  const partsLoading = useCloudStore((state) => state.partsLoading)
  const partsError = useCloudStore((state) => state.partsError)
  const runState = useCloudStore((state) => state.runState)
  const runError = useCloudStore((state) => state.runError)
  const steerError = useCloudStore((state) => state.steerError)
  const steer = useCloudStore((state) => state.steer)
  const draft = useCloudStore((state) => state.draft)
  const setDraft = useCloudStore((state) => state.setDraft)
  const send = useCloudStore((state) => state.send)
  const stop = useCloudStore((state) => state.stop)

  const [stopping, setStopping] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CloudSession | null>(null)
  const [attachments, setAttachments] = useState<
    Array<{ path: string; name: string; preview: string }>
  >([])
  const [imageBusy, setImageBusy] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const hasDashboardToken = useCloudStore((state) => state.config.hasDashboardToken)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      void syncSessions()
    }, SYNC_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [active, syncSessions])

  const visibleSessions = useMemo(
    () => filterSessions(sessions, sessionQuery),
    [sessions, sessionQuery]
  )
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
    if ((!draft.trim() && attachments.length === 0) || busy) return
    if (attachments.length > 0) {
      // 平台的取图方式是文本指令，发出去和用户手打 `/image <path>` 完全一样
      setDraft(withImageDirectives(draft, attachments.map((item) => item.path)))
      setAttachments([])
    }
    followRef.current = true
    void send()
  }

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
      reader.readAsDataURL(file)
    })

  const attachFiles = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) return
    if (!hasDashboardToken) {
      setImageError(t('cloudImageTokenMissing'))
      return
    }
    setImageBusy(true)
    setImageError(null)
    for (const file of images) {
      try {
        const dataUrl = await readFileAsDataUrl(file)
        const uploaded = await cloudApi.uploadImage({ dataUrl, filename: file.name })
        if (!uploaded.success || !uploaded.image) {
          setImageError(t('cloudImageUploadFailed', { error: uploaded.error ?? 'unknown' }))
          continue
        }
        setAttachments((current) => [
          ...current,
          { path: uploaded.image!.path, name: uploaded.image!.name || file.name, preview: dataUrl },
        ])
      } catch (error) {
        setImageError(
          t('cloudImageUploadFailed', {
            error: error instanceof Error ? error.message : String(error),
          })
        )
      }
    }
    setImageBusy(false)
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
        <div className="flex h-8 flex-shrink-0 items-center gap-1.5 border-b border-rule-divide px-2">
          <Search size={12} aria-hidden="true" className="flex-shrink-0 text-ink-subtle" />
          <Input
            value={sessionQuery}
            placeholder={t('cloudSearchSessions')}
            aria-label={t('cloudSearchSessions')}
            onChange={(event) => setSessionQuery(event.target.value)}
            className="h-6 border-0 bg-transparent px-0"
          />
          {sessionQuery && (
            <IconButton
              icon={X}
              label={t('cloudClearSearch')}
              size="sm"
              onClick={() => setSessionQuery('')}
            />
          )}
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(event) => {
            if (sessionQuery) return
            const element = event.currentTarget
            if (element.scrollHeight - element.scrollTop - element.clientHeight < 120) {
              void loadMoreSessions()
            }
          }}
        >
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
          {sessions.length > 0 && visibleSessions.length === 0 && (
            <div className="px-3 py-3 type-caption text-ink-muted">
              {t('cloudSearchEmpty')}
            </div>
          )}
          {visibleSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={session.id === activeSessionId}
              pending={sessionActionPending === session.id}
              onSelect={() => {
                if (session.id === activeSessionId) return
                followRef.current = true
                void openSession(session.id)
              }}
              onRename={(title) => void renameSession(session.id, title)}
              onTogglePin={() => void togglePinned(session.id)}
              onDelete={() => setDeleteTarget(session)}
            />
          ))}
          {sessionQuery ? (
            <div className="px-3 py-2">
              <Caption className="text-ink-subtle">
                {t('cloudSearchScope')
                  .replace('{matched}', String(visibleSessions.length))
                  .replace('{loaded}', String(sessions.length))}
              </Caption>
            </div>
          ) : sessionsHasMore ? (
            <div className="flex items-center justify-center px-3 py-2">
              {sessionsLoadingMore ? (
                <Spinner size={12} />
              ) : (
                <Button size="sm" onClick={() => void loadMoreSessions()}>
                  {t('cloudLoadMore')}
                </Button>
              )}
            </div>
          ) : (
            sessions.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-2">
                <Caption className="text-ink-subtle">{t('cloudAllLoaded')}</Caption>
                {sessionsSyncedAt && (
                  <Caption className="text-ink-subtle">
                    · {t('cloudSyncedAgo', { time: formatRelativeTime(sessionsSyncedAt, language) })}
                  </Caption>
                )}
              </div>
            )
          )}
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
                action={
                  !connected && onNavigate ? (
                    <Button size="sm" onClick={() => onNavigate('cloud-connection')}>
                      {t('cloudGoToConnection')}
                    </Button>
                  ) : undefined
                }
              />
            </div>
          )}
          <CloudTrace parts={parts} streaming={busy} />
          {runError && !busy && (
            <div className="py-2 type-caption text-danger">
              {t('cloudRunError', { error: runError })}
            </div>
          )}
          {steerError && (
            <div className="py-2 type-caption text-danger">
              {t('cloudSteerFailed', { error: steerError })}
            </div>
          )}
        </div>

        <div
          className="flex-shrink-0 border-t border-rule-divide p-2"
          onDragOver={(event) => {
            if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
          }}
          onDrop={(event) => {
            const files = Array.from(event.dataTransfer?.files ?? [])
            if (files.length === 0) return
            event.preventDefault()
            void attachFiles(files)
          }}
        >
          {(attachments.length > 0 || imageBusy) && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {attachments.map((item) => (
                <div
                  key={item.path}
                  className="group relative h-14 w-14 overflow-hidden border border-rule-control"
                >
                  <img src={item.preview} alt={item.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    aria-label={t('cloudRemoveImage')}
                    onClick={() =>
                      setAttachments((current) => current.filter((row) => row.path !== item.path))
                    }
                    className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-canvas-base text-ink-muted opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
              {imageBusy && (
                <span className="flex items-center gap-1.5 type-caption text-ink-muted">
                  <Spinner size={12} />
                  {t('cloudUploadingImage')}
                </span>
              )}
            </div>
          )}
          {imageError && <div className="mb-2 type-caption text-danger">{imageError}</div>}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              void attachFiles(files)
            }}
          />
          <div className="flex items-end gap-2">
            <Textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  if (busy) void steer()
                  else submit()
                }
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData?.files ?? [])
                if (files.some((file) => file.type.startsWith('image/'))) {
                  event.preventDefault()
                  void attachFiles(files)
                }
              }}
              rows={2}
              placeholder={t('cloudInputPlaceholder')}
              aria-label={t('cloudInputPlaceholder')}
              disabled={!connected}
              className="min-h-[52px] flex-1"
            />
            <div className="flex flex-col items-center gap-1">
              <IconButton
                icon={ImagePlus}
                label={t('cloudAttachImage')}
                size="sm"
                disabled={!connected || imageBusy}
                onClick={() => {
                  if (!hasDashboardToken) {
                    setImageError(t('cloudImageTokenMissing'))
                    return
                  }
                  fileInputRef.current?.click()
                }}
              />
            </div>
            {busy ? (
              <div className="flex flex-col gap-1">
                <Button
                  variant="primary"
                  size="sm"
                  icon={MessageSquarePlus}
                  disabled={!connected || !draft.trim()}
                  title={t('cloudSteerHint')}
                  onClick={() => void steer()}
                >
                  {t('cloudSteer')}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  icon={Square}
                  loading={stopping}
                  onClick={handleStop}
                >
                  {stopping ? t('cloudStopping') : t('cloudStop')}
                </Button>
              </div>
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

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('cloudDeleteTitle')}
        size="sm"
        closeLabel={t('cloudCancel')}
        footer={
          <>
            <Button size="sm" onClick={() => setDeleteTarget(null)}>
              {t('cloudCancel')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={Trash2}
              onClick={() => {
                const target = deleteTarget
                setDeleteTarget(null)
                if (target) void deleteSession(target.id)
              }}
            >
              {t('cloudDeleteConfirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 px-5 py-4">
          <p className="m-0 type-value text-ink">
            {deleteTarget?.title || t('untitledSession')}
          </p>
          <Caption className="text-ink-muted">{t('cloudDeleteBody')}</Caption>
        </div>
      </Modal>
    </div>
  )
}
