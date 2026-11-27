/**
 * 独立聊天输入区（窄订阅 + React.memo）：
 * 隔离草稿击键、附件与符号菜单、图片预处理、待发送队列、斜杠与 `@` 文件补全菜单以及重试倒计时，
 * 确保打字、选区变动或展开菜单绝不触发 ChatPanel 与消息列表重渲染。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { BookMarked, FileText, FolderOpen, Paperclip, Send, Square, X } from 'lucide-react'
import {
  useChatStore,
  type ChatAttachment,
  type ConversationState,
  type PendingMessage,
} from '../../store/chatStore'
import { sameOpenFileTabs, useEditorStore } from '../../store/editorStore'
import { selectionForWorkspace, useSelectionStore } from '../../store/selectionStore'
import { useI18nStore } from '../../store/i18nStore'
import { api } from '../../api'
import { piAgentAPI } from '../../api/piAgentAPI'
import { retrySecondsRemaining } from '../../utils/retryCountdown'
import { basename, joinPath } from '../../utils/filePath'
import { formatBytes } from '../../utils/formatBytes'
import { useChatAttachments } from '../../hooks/useChatAttachments'
import type { ChatSubmitOptions } from '../../workspace/chatTurnControl'
import type { PromptTemplateInfo, SkillInfo } from '../../types/electron'
import type { ChatTranslate } from './chatTurnController'
import { Button, Caption, DataText, IconButton, PopoverMenu, Spinner, Textarea } from '../ui/ui'

type ActiveRetryStatus = NonNullable<ConversationState['retryStatus']>

const EMPTY_ATTACHMENTS: ChatAttachment[] = []
const EMPTY_PENDING: PendingMessage[] = []

/** 隔离自动重试的 250ms 倒计时时钟，避免每秒 4 次触发外层输入区重渲染 */
const RetryStatusBanner: React.FC<{ retryStatus: ActiveRetryStatus }> = React.memo(
  function RetryStatusBanner({ retryStatus }) {
    const t = useI18nStore((state) => state.t)
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
      setNow(Date.now())
      const timer = window.setInterval(() => setNow(Date.now()), 250)
      return () => window.clearInterval(timer)
    }, [retryStatus])

    const remaining = retrySecondsRemaining(retryStatus, now)
    return (
      <div className="mb-2 flex items-center gap-2 type-caption text-warning">
        <Spinner size={10} />
        <span>
          {remaining > 0
            ? t('retryInProgress', {
                attempt: retryStatus.attempt,
                max: retryStatus.maxAttempts,
                seconds: remaining,
              })
            : t('retryStarting', {
                attempt: retryStatus.attempt,
                max: retryStatus.maxAttempts,
              })}
        </span>
        {retryStatus.message && (
          <span className="min-w-0 truncate text-ink-muted">{retryStatus.message}</span>
        )}
      </div>
    )
  }
)

export interface ChatComposerProps {
  workspacePath: string
  viewRoot?: string
  activeKey: string | null
  activeSessionId: string
  initialized: boolean
  imagesAllowed: boolean
  stopping: boolean
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  imageProcessingCountRef: React.MutableRefObject<number>
  hideAttachMenuRef?: React.MutableRefObject<(() => void) | null>
  onSubmit: (
    event?: React.FormEvent,
    override?: string,
    options?: ChatSubmitOptions
  ) => void | Promise<void>
  onStop: () => void | Promise<void>
  onSteer: (sessionId: string, key: string, item: PendingMessage) => void | Promise<unknown>
  syncPromptResources: (next: { templates: PromptTemplateInfo[]; skills: SkillInfo[] }) => void
  t?: ChatTranslate
}

export const ChatComposer: React.FC<ChatComposerProps> = React.memo(function ChatComposer({
  workspacePath,
  viewRoot,
  activeKey,
  activeSessionId,
  initialized,
  imagesAllowed,
  stopping,
  inputRef,
  imageProcessingCountRef,
  hideAttachMenuRef,
  onSubmit,
  onStop,
  onSteer,
  syncPromptResources,
  t: tProp,
}) {
  const storeT = useI18nStore((state) => state.t)
  const t = tProp ?? storeT
  const editorRoot = viewRoot ?? workspacePath

  const {
    input,
    attachments,
    pendingMessages,
    quoteCurrentFile,
    isLoading,
    isCompacting,
    retryStatus,
  } = useChatStore(
    useShallow((state) => {
      const conv = activeKey ? state.conversations[activeKey] : undefined
      return {
        input: activeKey ? (state.draftInputs[activeKey] ?? '') : '',
        attachments: conv?.attachments ?? EMPTY_ATTACHMENTS,
        pendingMessages: conv?.pending ?? EMPTY_PENDING,
        quoteCurrentFile: conv?.quoteCurrentFile ?? false,
        isLoading: conv?.isLoading ?? false,
        isCompacting: conv?.isCompacting ?? false,
        retryStatus: conv?.retryStatus ?? null,
      }
    })
  )

  const openFiles = useEditorStore(editorRoot, (state) => state.openFiles, sameOpenFileTabs)
  const currentEditorPath = useEditorStore(editorRoot, (state) => state.currentFile?.path ?? null)
  const currentEditorName = useEditorStore(editorRoot, (state) => state.currentFile?.name ?? '')
  const selection = useSelectionStore((state) => selectionForWorkspace(state, workspacePath))

  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [attachMode, setAttachMode] = useState<'files' | 'symbols'>('files')
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [mention, setMention] = useState<{
    start: number
    query: string
    results: string[]
  } | null>(null)
  const [promptResources, setPromptResources] = useState<{
    templates: PromptTemplateInfo[]
    skills: SkillInfo[]
  }>({ templates: [], skills: [] })

  const mentionTimer = useRef<number | null>(null)
  const mentionSeqRef = useRef(0)
  const activeSlashOptionRef = useRef<HTMLButtonElement | null>(null)
  const activeMentionOptionRef = useRef<HTMLButtonElement | null>(null)

  const closeAttachMenu = useCallback(() => setShowAttachMenu(false), [])

  useEffect(() => {
    if (!hideAttachMenuRef) return
    hideAttachMenuRef.current = closeAttachMenu
    return () => {
      if (hideAttachMenuRef.current === closeAttachMenu) {
        hideAttachMenuRef.current = null
      }
    }
  }, [hideAttachMenuRef, closeAttachMenu])

  useEffect(() => {
    setShowAttachMenu(false)
  }, [activeSessionId])

  const {
    imageProcessing,
    imageProcessingRef,
    currentSymbols,
    attachSymbol,
    handlePaste,
    handlePickFiles,
    handleDropFiles,
  } = useChatAttachments({
    workspacePath,
    viewRoot,
    editorRoot,
    activeKey,
    imagesAllowed,
    symbolsActive: showAttachMenu && attachMode === 'symbols',
    t,
    setShowAttachMenu,
    setAttachMode,
  })

  // 把同步计数镜像给外层轮次控制器，避免发送时与预处理中的图片竞争
  imageProcessingCountRef.current = imageProcessingRef.current
  useEffect(() => {
    imageProcessingCountRef.current = imageProcessing
  }, [imageProcessing, imageProcessingCountRef])

  const toggleQuoteCurrentFile = useCallback(() => {
    if (!activeKey) return
    const chat = useChatStore.getState()
    chat.setQuoteCurrentFile(
      activeKey,
      !(chat.conversations[activeKey]?.quoteCurrentFile ?? false)
    )
  }, [activeKey])

  useEffect(
    () => () => {
      if (mentionTimer.current) window.clearTimeout(mentionTimer.current)
    },
    []
  )

  const searchMention = useCallback(
    (query: string, start: number) => {
      if (mentionTimer.current) window.clearTimeout(mentionTimer.current)
      const seq = ++mentionSeqRef.current
      mentionTimer.current = window.setTimeout(async () => {
        const result = await api.searchWorkspaceFiles(viewRoot ?? workspacePath, query, 12)
        if (mentionSeqRef.current !== seq || !result.success) return
        setMention((current) =>
          current && current.start === start
            ? { ...current, results: result.files ?? [] }
            : current
        )
      }, 120)
    },
    [workspacePath, viewRoot]
  )

  const handleDraftChange = (value: string, caret: number) => {
    if (activeKey) useChatStore.getState().setDraftInput(activeKey, value)
    const before = value.slice(0, caret)
    const match = before.match(/(^|\s)@([\w./\\-]{0,60})$/)
    if (!match) {
      setMention(null)
      return
    }
    const start = caret - match[2].length - 1
    setMention({ start, query: match[2], results: [] })
    searchMention(match[2], start)
  }

  const addMention = (relative: string) => {
    if (!activeKey || !mention) return
    const value = useChatStore.getState().draftInputs[activeKey] ?? ''
    const tokenEnd = mention.start + 1 + mention.query.length
    const next = `${value.slice(0, mention.start)}@${relative} ${value.slice(tokenEnd)}`
    useChatStore.getState().setDraftInput(activeKey, next)
    // 搜索以会话工作树根为基准，附件路径必须落在同一根上（否则 Agent 读不到）
    useChatStore.getState().addAttachment(activeKey, {
      kind: 'file',
      path: joinPath(viewRoot ?? workspacePath, relative),
      name: relative.split('/').pop() || relative,
    })
    setMention(null)
    inputRef.current?.focus()
  }

  const slashActive =
    initialized && input.startsWith('/') && !input.includes(' ') && !input.includes('\n')
  const slashQuery = slashActive ? input.slice(1).toLowerCase() : ''
  const slashItems = useMemo(() => {
    if (!slashActive) return []
    const builtIns = [
      { id: 'help', insert: '/help ', label: '/help', description: t('slashCommandHelp') },
      { id: 'plan', insert: '/plan', label: '/plan', description: t('slashCommandPlan') },
      { id: 'act', insert: '/act', label: '/act', description: t('slashCommandAct') },
      {
        id: 'compact',
        insert: '/compact',
        label: '/compact',
        description: t('slashCommandCompact'),
      },
      { id: 'clear', insert: '/clear ', label: '/clear', description: t('slashCommandClear') },
      { id: 'model', insert: '/model ', label: '/model', description: t('slashCommandModel') },
    ]
    const templates = promptResources.templates.map((template) => ({
      id: `template:${template.name}`,
      insert: `/${template.name} `,
      label: `/${template.name}`,
      description: template.description || t('slashTemplate'),
    }))
    const skills = promptResources.skills.map((skill) => ({
      id: `skill:${skill.name}`,
      insert: `/skill:${skill.name} `,
      label: `/skill:${skill.name}`,
      description: skill.description || t('slashSkill'),
    }))
    return [...builtIns, ...templates, ...skills].filter((item) =>
      item.label.slice(1).toLowerCase().startsWith(slashQuery)
    )
  }, [slashActive, slashQuery, promptResources, t])

  const insertSlashItem = (insert: string) => {
    if (!activeKey) return
    useChatStore.getState().setDraftInput(activeKey, insert)
    inputRef.current?.focus()
  }

  // 打开斜杠菜单时重新扫描模板 / 技能文件，新增文件无需重启
  useEffect(() => {
    if (!slashActive || !activeSessionId) return
    let cancelled = false
    void piAgentAPI.listPromptResources(workspacePath, activeSessionId).then((result) => {
      if (cancelled) return
      if (result.success) {
        const next = { templates: result.templates ?? [], skills: result.skills ?? [] }
        setPromptResources(next)
        syncPromptResources(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [slashActive, workspacePath, activeSessionId, syncPromptResources])

  const showSlashMenu = slashActive && slashItems.length > 0 && !slashDismissed
  const showMentionMenu =
    !showSlashMenu && Boolean(mention && mention.results.length > 0) && !mentionDismissed
  const clampedSlashIndex =
    slashItems.length > 0 ? Math.min(slashIndex, slashItems.length - 1) : 0
  const clampedMentionIndex =
    mention && mention.results.length > 0
      ? Math.min(mentionIndex, mention.results.length - 1)
      : 0

  useEffect(() => {
    setSlashIndex(0)
    setSlashDismissed(false)
  }, [input])

  useEffect(() => {
    setMentionIndex(0)
    setMentionDismissed(false)
  }, [mention])

  useEffect(() => {
    if (showSlashMenu) {
      activeSlashOptionRef.current?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [showSlashMenu, clampedSlashIndex])

  useEffect(() => {
    if (showMentionMenu) {
      activeMentionOptionRef.current?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [showMentionMenu, clampedMentionIndex])

  const handleFormSubmit = (event?: React.FormEvent) => {
    setShowAttachMenu(false)
    void onSubmit(event)
  }

  const handleComposerKeyDown = (event: React.KeyboardEvent) => {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229
    if (showSlashMenu) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashIndex((index) => (index + 1) % slashItems.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashIndex((index) => (index - 1 + slashItems.length) % slashItems.length)
        return
      }
      if ((event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) && !composing) {
        event.preventDefault()
        const target = slashItems[clampedSlashIndex]
        if (target) insertSlashItem(target.insert)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setSlashDismissed(true)
        return
      }
    }
    if (showMentionMenu && mention) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionIndex((index) => (index + 1) % mention.results.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex((index) => (index - 1 + mention.results.length) % mention.results.length)
        return
      }
      if ((event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) && !composing) {
        event.preventDefault()
        const target = mention.results[clampedMentionIndex]
        if (target) addMention(target)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setMentionDismissed(true)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault()
      handleFormSubmit()
    }
  }

  // 纯图片 / 纯附件（无文本）也可以发送；预处理中的图片不算可发送内容
  const hasSendableInput = Boolean(input.trim()) || attachments.length > 0

  return (
    <>
      {retryStatus && <RetryStatusBanner retryStatus={retryStatus} />}

      {pendingMessages.length > 0 && (
        <div className="mb-2 flex flex-col gap-1.5">
          {pendingMessages.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 border border-rule-hairline bg-raised px-3 py-1.5"
            >
              <span className="type-caption text-ink-muted">
                {isLoading ? t('pendingNextTurn') : t('pendingIdle')}
              </span>
              <span
                className="min-w-0 flex-1 truncate type-value text-ink"
                title={item.text || undefined}
              >
                {item.text || t('pendingImageCount', { count: item.images?.length ?? 0 })}
              </span>
              {isLoading ? (
                <button
                  type="button"
                  disabled={isCompacting}
                  onClick={() => {
                    if (!activeKey || !activeSessionId || isCompacting) return
                    void onSteer(activeSessionId, activeKey, item)
                  }}
                  className="type-caption text-ink-muted transition-colors enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t('insertNow')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (!activeKey) return
                    useChatStore.getState().removePending(activeKey, item.id)
                    void onSubmit(undefined, item.text, {
                      images: item.images,
                      attachments: item.attachments,
                      consumeAttachments: false,
                    })
                  }}
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-hover hover:text-ink"
                  aria-label={t('sendNow')}
                  title={t('sendNow')}
                >
                  <Send size={11} />
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  activeKey && useChatStore.getState().removePending(activeKey, item.id)
                }
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-hover hover:text-ink"
                aria-label={t('removePending')}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {imageProcessing > 0 && (
        <div className="mb-1.5 flex items-center gap-1.5 type-caption text-ink-muted">
          <Spinner size={10} />
          {t('imageOptimizing')}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {attachments.map((attachment) => {
            if (attachment.kind === 'image') {
              return (
                <span
                  key={attachment.id}
                  className="inline-flex items-center gap-1 border border-rule-control bg-sunken p-1 type-data text-ink-muted"
                  title={`${attachment.name} · ${formatBytes(attachment.size ?? 0)}`}
                >
                  <img
                    src={`data:${attachment.mimeType};base64,${attachment.data}`}
                    alt={attachment.name}
                    className="h-10 w-10 rounded-sm object-cover"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      activeKey &&
                      useChatStore.getState().removeAttachment(activeKey, attachment.id)
                    }
                    title={t('removeAttachment')}
                    aria-label={t('removeAttachment')}
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-hover hover:text-ink"
                  >
                    <X size={10} />
                  </button>
                </span>
              )
            }
            const label =
              attachment.kind === 'snippet'
                ? attachment.startLine !== undefined && attachment.endLine !== undefined
                  ? `${attachment.name}:${attachment.startLine}–${attachment.endLine}`
                  : (attachment.label ?? attachment.name)
                : attachment.name
            return (
              <span
                key={attachment.id}
                className="inline-flex items-center gap-1 border border-rule-control bg-sunken px-2 py-1 type-data text-ink-muted"
                title={
                  attachment.kind === 'snippet' &&
                  attachment.startLine !== undefined &&
                  attachment.endLine !== undefined
                    ? `${attachment.path}:${attachment.startLine}-${attachment.endLine}`
                    : [
                        attachment.path || attachment.label || attachment.name,
                        attachment.size !== undefined ? formatBytes(attachment.size) : null,
                        attachment.external ? t('attachmentExternal') : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                }
              >
                <FileText size={10} className="text-ink-muted" />
                {label}
                {attachment.external && (
                  <span className="type-caption text-ink-subtle">{t('attachmentExternal')}</span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    activeKey &&
                    useChatStore.getState().removeAttachment(activeKey, attachment.id)
                  }
                  title={t('removeAttachment')}
                  aria-label={t('removeAttachment')}
                  className="ml-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  <X size={10} />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {showSlashMenu && (
        <div
          role="listbox"
          className="mb-1 max-h-60 overflow-y-auto border border-rule-control bg-raised shadow-print"
        >
          {slashItems.map((item, index) => {
            const selected = index === clampedSlashIndex
            return (
              <button
                key={item.id}
                ref={selected ? activeSlashOptionRef : null}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setSlashIndex(index)}
                onClick={() => insertSlashItem(item.insert)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                  selected ? 'bg-hover' : 'hover:bg-hover'
                }`}
              >
                <span className="flex-shrink-0 type-data text-ink">{item.label}</span>
                <span className="min-w-0 truncate type-caption text-ink-muted">
                  {item.description}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {showMentionMenu && mention && (
        <div
          role="listbox"
          className="mb-1 max-h-52 overflow-y-auto border border-rule-control bg-raised shadow-print"
        >
          {mention.results.map((file, index) => {
            const selected = index === clampedMentionIndex
            return (
              <button
                key={file}
                ref={selected ? activeMentionOptionRef : null}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setMentionIndex(index)}
                onClick={() => addMention(file)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left type-data text-ink transition-colors ${
                  selected ? 'bg-hover' : 'hover:bg-hover'
                }`}
              >
                <FileText size={11} className="flex-shrink-0 text-ink-muted" />
                <span className="truncate">{file}</span>
              </button>
            )
          })}
        </div>
      )}

      <form
        onSubmit={handleFormSubmit}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDropFiles}
        className="border border-rule-control bg-sunken transition-colors focus-within:border-accent"
      >
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(event) =>
            handleDraftChange(event.target.value, event.target.selectionStart ?? 0)
          }
          onKeyDown={handleComposerKeyDown}
          onPaste={handlePaste}
          placeholder={t('inputPlaceholder')}
          disabled={!initialized}
          rows={3}
          className="min-h-[68px] max-h-40 border-none bg-transparent px-3 py-2 focus:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex items-center gap-1">
            <span className="relative flex items-center">
              <IconButton
                icon={Paperclip}
                label={t('attachContext')}
                size="sm"
                disabled={!initialized || isLoading}
                onClick={() => {
                  setShowAttachMenu((open) => !open)
                  setAttachMode('files')
                }}
              />
              <PopoverMenu
                open={showAttachMenu && Boolean(activeKey)}
                onClose={closeAttachMenu}
                role="dialog"
                label={t('attachContext')}
                className="max-h-64 w-72 overflow-y-auto py-1"
              >
                <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="type-label text-ink-muted">{t('attachContext')}</span>
                  {currentEditorPath && (
                    <button
                      type="button"
                      onClick={() =>
                        setAttachMode((mode) => (mode === 'files' ? 'symbols' : 'files'))
                      }
                      className="type-caption text-ink-muted transition-colors hover:text-ink"
                    >
                      {attachMode === 'symbols' ? t('attachFile') : t('attachSymbol')}
                    </button>
                  )}
                </div>
                {attachMode === 'symbols' ? (
                  currentSymbols.length === 0 ? (
                    <div className="px-3 py-2 type-caption text-ink-muted">
                      {t('noSymbols')}
                    </div>
                  ) : (
                    currentSymbols.map((symbol) => (
                      <button
                        key={`${symbol.name}-${symbol.startLine}`}
                        type="button"
                        onClick={() => attachSymbol(symbol)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-hover"
                      >
                        <span className="flex-shrink-0 type-caption text-ink-muted">
                          {symbol.kind}
                        </span>
                        <span className="min-w-0 flex-1 truncate type-value text-ink">
                          {symbol.name}
                        </span>
                        <DataText className="flex-shrink-0 text-ink-muted">
                          L{symbol.startLine}–L{symbol.endLine}
                        </DataText>
                      </button>
                    ))
                  )
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void handlePickFiles()}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink hover:bg-hover"
                    >
                      <FolderOpen size={12} className="flex-shrink-0 text-ink-muted" />
                      <span className="flex min-w-0 flex-col">
                        <span>{t('attachLocalFile')}</span>
                        <Caption className="truncate text-ink-muted">
                          {t('attachLocalFileHint')}
                        </Caption>
                      </span>
                    </button>
                    <div className="my-1 border-t border-rule-divide" />
                    <button
                      type="button"
                      disabled={!selection}
                      onClick={() => {
                        if (!selection || !activeKey) return
                        useChatStore.getState().addAttachment(activeKey, {
                          kind: 'snippet',
                          path: selection.path,
                          name: selection.name,
                          startLine: selection.startLine,
                          endLine: selection.endLine,
                          content: selection.text,
                        })
                        setShowAttachMenu(false)
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink hover:bg-hover disabled:opacity-40"
                    >
                      <FileText size={12} className="flex-shrink-0 text-ink-muted" />
                      <span className="flex min-w-0 flex-col">
                        <span>{t('attachSelection')}</span>
                        <DataText className="truncate text-ink-muted">
                          {selection
                            ? `${selection.name}:${selection.startLine}–${selection.endLine}`
                            : t('noSelection')}
                        </DataText>
                      </span>
                    </button>
                    <div className="my-1 border-t border-rule-divide" />
                    {openFiles.length === 0 && !selection ? (
                      <div className="px-3 py-2 type-caption text-ink-muted">
                        {t('noOpenFiles')}
                      </div>
                    ) : (
                      openFiles.map((file) => {
                        const attached = attachments.some(
                          (item) => item.kind === 'file' && item.path === file.path
                        )
                        return (
                          <button
                            key={file.path}
                            type="button"
                            disabled={attached}
                            onClick={() => {
                              if (!activeKey) return
                              useChatStore.getState().addAttachment(activeKey, {
                                kind: 'file',
                                path: file.path,
                                name: file.name,
                              })
                              setShowAttachMenu(false)
                            }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink hover:bg-hover disabled:opacity-40"
                          >
                            <FileText size={12} className="flex-shrink-0 text-ink-muted" />
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{file.name}</span>
                              <DataText className="truncate text-ink-muted">{file.path}</DataText>
                            </span>
                          </button>
                        )
                      })
                    )}
                  </>
                )}
              </PopoverMenu>
            </span>

            {/* 引用当前正在查看的文件：始终显示文件名（无打开文件时显示引导并禁用） */}
            <button
              type="button"
              onClick={toggleQuoteCurrentFile}
              disabled={!initialized || !currentEditorPath}
              aria-pressed={quoteCurrentFile || undefined}
              aria-label={
                currentEditorPath
                  ? `${quoteCurrentFile ? t('quoteCurrentFileOn') : t('quoteCurrentFileNamed')} · ${
                      currentEditorName
                    }`
                  : t('quoteCurrentFileEmpty')
              }
              title={currentEditorPath ? currentEditorPath : t('quoteCurrentDocHint')}
              className={`inline-flex h-7 items-center gap-1.5 rounded-sm border px-2.5 type-label transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                !currentEditorPath
                  ? 'border-rule-control text-ink-subtle'
                  : quoteCurrentFile
                    ? 'border-accent bg-active text-ink'
                    : 'border-rule-control text-ink-muted hover:bg-hover hover:text-ink'
              }`}
            >
              <BookMarked size={12} className="flex-shrink-0" />
              <span className="max-w-[16rem] truncate">
                {currentEditorPath
                  ? basename(currentEditorPath) || currentEditorName
                  : t('quoteCurrentFileEmpty')}
              </span>
            </button>
          </div>

          {isLoading && !isCompacting && !hasSendableInput ? (
            <Button
              variant="ghost"
              size="sm"
              icon={Square}
              disabled={stopping}
              className="text-danger hover:bg-danger/10 hover:text-danger [&_svg]:fill-current"
              onClick={() => void onStop()}
            >
              {t('stop')}
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon={Send}
              disabled={!initialized || !hasSendableInput || imageProcessing > 0}
            >
              {t('send')}
            </Button>
          )}
        </div>
      </form>
    </>
  )
})
