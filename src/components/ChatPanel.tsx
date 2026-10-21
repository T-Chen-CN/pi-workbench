import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import {
  AlertCircle,
  Check,
  Copy,
  FileText,
  History,
  Paperclip,
  Send,
  Settings2,
  Square,
  X,
} from 'lucide-react'
import {
  conversationKey,
  useChatStore,
  type ChatMessage,
} from '../store/chatStore'
import {
  MAX_OPEN_SESSIONS,
  useSessionStore,
} from '../store/sessionStore'
import { useDiffStore } from '../store/diffStore'
import { useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { useSelectionStore } from '../store/selectionStore'
import { piAgentAPI } from '../api/piAgentAPI'
import { api } from '../api'
import { buildContextPrompt } from '../api/chatContext'
import { localizeError } from '../i18n/errors'
import { commandPaletteShortcut } from '../utils/shortcuts'
import { createDeltaBuffer } from '../utils/streamBuffer'
import { splitMarkdownBlocks } from '../utils/markdownBlocks'
import { toast } from '../store/toastStore'
import { confirmDialog, promptDialog } from '../store/dialogStore'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { SessionTabs } from './SessionTabs'
import { ChatSessionList } from './ChatSessionList'
import {
  Button,
  Caption,
  DataText,
  EmptyState,
  IconButton,
  Label,
  Spinner,
  Textarea,
} from './ui'
import type { SessionSummary } from '../types/electron'

interface ChatPanelProps {
  workspacePath: string
}

/** 单个附件与单条消息的上下文字符上限 */
const MAX_CONTEXT_FILE_CHARS = 120_000
const MAX_CONTEXT_SNIPPET_CHARS = 40_000
const MAX_CONTEXT_TOTAL_CHARS = 300_000

/** 代码块：带复制按钮 */
const CodeBlock: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const { t } = useI18nStore()
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    const text = preRef.current?.textContent ?? ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      console.error('Failed to copy code:', error)
    }
  }

  return (
    <div className="group/code relative">
      <pre ref={preRef}>{children}</pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t('copyCode')}
        className="absolute right-2 top-2 flex items-center gap-1 rounded border border-rule-control bg-raised px-1.5 py-1 type-caption text-ink-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/code:opacity-100 group-focus-within/code:opacity-100"
      >
        {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
        {copied ? t('copied') : t('copyCode')}
      </button>
    </div>
  )
}

const REMARK_PLUGINS = [remarkGfm]
const HIGHLIGHT_PLUGINS = [rehypeHighlight]
const NO_PLUGINS: [] = []

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
}

/**
 * 流式期间按顶层块拆分 Markdown，只有正在增长的尾块需要重新解析。
 * 引用式链接等跨块定义在流式阶段可能不完整，结束时整体重渲染一次即可恢复。
 */
const MarkdownBlock = React.memo(
  function MarkdownBlock({ content }: { content: string }) {
    return (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={NO_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    )
  },
  (prev, next) => prev.content === next.content
)

const StreamingBlocks = React.memo(function StreamingBlocks({ content }: { content: string }) {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content])
  return (
    <>
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} content={block} />
      ))}
    </>
  )
})

/** 流式消息：解析降到低优先级，点击/输入可以先被处理，长输出不会堵住整个面板 */
const StreamingMarkdown = React.memo(function StreamingMarkdown({ content }: { content: string }) {
  const deferred = useDeferredValue(content)
  return (
    <>
      <StreamingBlocks content={deferred} />
      <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-text-bottom" />
    </>
  )
})

/** 已完成消息：整段解析一次，保留完整 GFM 与代码高亮 */
const MarkdownBody = React.memo(function MarkdownBody({
  content,
  highlight,
}: {
  content: string
  highlight: boolean
}) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={highlight ? HIGHLIGHT_PLUGINS : NO_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  )
})

/** 单条消息；memo 保证流式追加只重渲染最后一条 */
const ChatMessageRow = React.memo(function ChatMessageRow({
  message,
}: {
  message: ChatMessage
}) {
  const { t, language } = useI18nStore()

  if (message.isStreaming && !message.content) return null
  const isUser = message.role === 'user'

  return (
    <div
      data-testid="chat-message"
      className="border-b border-rule-divide py-3 first:pt-0 last:border-b-0"
    >
      <div className="mb-1.5 flex items-baseline gap-2">
        <Label className="text-ink">{isUser ? t('roleYou') : t('piAgent')}</Label>
        <Caption className="text-ink-muted">
          {new Date(message.timestamp).toLocaleTimeString(
            language === 'zh' ? 'zh-CN' : 'en-US'
          )}
        </Caption>
      </div>
      {isUser ? (
        <div className="flex gap-2 type-reading text-ink">
          <span className="type-project text-accent">›</span>
          <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
      ) : (
        <div className="chat-markdown text-ink">
          {message.isStreaming ? (
            <StreamingMarkdown content={message.content} />
          ) : (
            <MarkdownBody
              content={message.content}
              highlight={message.content.length <= 20_000}
            />
          )}
          {message.usage && (
            <Caption className="mt-1 block text-ink-muted">
              {message.usage.totalTokens.toLocaleString()} tokens
              {message.usage.cost > 0 ? ` · $${message.usage.cost.toFixed(4)}` : ''}
            </Caption>
          )}
        </div>
      )}
    </div>
  )
})

const EMPTY_SESSIONS: SessionSummary[] = []
const EMPTY_MESSAGES: ChatMessage[] = []

function upsertSession(
  sessions: SessionSummary[],
  summary: SessionSummary | undefined
): SessionSummary[] {
  if (!summary) return sessions
  const existing = sessions.findIndex((session) => session.id === summary.id)
  if (existing === -1) return [summary, ...sessions]
  return sessions.map((session, index) =>
    index === existing ? { ...session, ...summary } : session
  )
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ workspacePath }) => {
  const { t } = useI18nStore()
  const sessionsState = useSessionStore((state) => state.byWorkspace[workspacePath])
  const sessions = sessionsState?.sessions ?? EMPTY_SESSIONS
  const activeSessionId = sessionsState?.active ?? null
  const panelOpen = sessionsState?.panelOpen ?? false
  const activeKey = activeSessionId
    ? conversationKey(workspacePath, activeSessionId)
    : null

  const conversation = useChatStore((state) =>
    activeKey ? state.conversations[activeKey] : undefined
  )
  const messages = conversation?.messages ?? EMPTY_MESSAGES
  const isLoading = conversation?.isLoading ?? false
  const error = conversation?.error ?? null
  const attachments = conversation?.attachments ?? []
  const input = conversation?.draftInput ?? ''

  const openFiles = useEditorStore((state) => state.openFiles)
  const selection = useSelectionStore((state) => state.selection)
  const openEdits = useDiffStore((state) => state.openEdits)

  const [initialized, setInitialized] = useState(false)
  const [needsApiKey, setNeedsApiKey] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [configVersion, setConfigVersion] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const initSeqRef = useRef(0)
  const stickToBottomRef = useRef(true)
  const stoppedRef = useRef(false)
  const { parentRef: transcriptRef, virtualizer } = useVirtualRows({
    count: messages.length,
    estimateSize: 96,
    overscan: 8,
  })

  const setDraft = useCallback(
    (value: string) => {
      if (activeKey) useChatStore.getState().setDraftInput(activeKey, value)
    },
    [activeKey]
  )

  const persistTabs = useCallback(() => {
    const state = useSessionStore.getState().byWorkspace[workspacePath]
    if (!state) return
    void piAgentAPI
      .sessionsSetTabs(workspacePath, { open: state.open, active: state.active })
      .catch(() => undefined)
  }, [workspacePath])

  const refreshSessions = useCallback(async () => {
    const result = await piAgentAPI.sessionsList(workspacePath)
    if (result.success && result.sessions) {
      useSessionStore.getState().setSessions(workspacePath, result.sessions)
    }
  }, [workspacePath])

  const ensureConversation = useCallback((sessionId: string) => {
    const key = conversationKey(workspacePath, sessionId)
    useChatStore.getState().ensureConversation(key)
    return key
  }, [workspacePath])

  const loadHistory = useCallback(
    (
      session: SessionSummary | undefined,
      history: Array<Omit<ChatMessage, 'id'>> | undefined
    ) => {
      if (!session) return
      const key = ensureConversation(session.id)
      const existing = useChatStore.getState().conversations[key]
      if (!existing || existing.messages.length === 0) {
        useChatStore.getState().setMessages(key, history ?? [])
      }
    },
    [ensureConversation]
  )

  useEffect(() => {
    const onConfigSaved = () => setConfigVersion((version) => version + 1)
    window.addEventListener('api-config-saved', onConfigSaved)
    return () => window.removeEventListener('api-config-saved', onConfigSaved)
  }, [])

  // 初始化 Agent 并恢复标签 / 激活会话
  useEffect(() => {
    const seq = ++initSeqRef.current

    const run = async () => {
      setInitialized(false)
      setNeedsApiKey(false)
      setFatalError(null)
      try {
        const configResult = await api.apiConfigGet()
        if (seq !== initSeqRef.current) return
        if (!configResult.success || !configResult.config || !configResult.config.apiKey) {
          setNeedsApiKey(true)
          return
        }

        const initResult = await piAgentAPI.initialize({
          workspaceDir: workspacePath,
          apiConfig: configResult.config,
        })
        if (seq !== initSeqRef.current) return
        if (!initResult.success) {
          setFatalError(initResult.error ? localizeError(initResult.error) : t('agentInitFailed'))
          setNeedsApiKey(true)
          return
        }

        const [listResult, tabsResult] = await Promise.all([
          piAgentAPI.sessionsList(workspacePath),
          piAgentAPI.sessionsGetTabs(workspacePath),
        ])
        if (seq !== initSeqRef.current) return

        let listed = listResult.success ? listResult.sessions ?? [] : []
        const storedOpen = (tabsResult.success ? tabsResult.tabs?.open ?? [] : []).filter((id) =>
          listed.some((session) => session.id === id)
        )
        let open = storedOpen
        let active =
          tabsResult.success &&
          tabsResult.tabs?.active &&
          open.includes(tabsResult.tabs.active)
            ? tabsResult.tabs.active
            : open[open.length - 1] ?? null

        useSessionStore.getState().setSessions(workspacePath, listed)

        if (!active) {
          const opened =
            listed.length > 0
              ? await piAgentAPI.sessionsOpen(workspacePath)
              : await piAgentAPI.sessionsCreate(workspacePath)
          if (seq !== initSeqRef.current) return
          if (!opened.success || !opened.session) {
            setFatalError(
              opened.error
                ? localizeError(opened.error)
                : t('sessionOpenFailed', { error: '' })
            )
            return
          }
          active = opened.session.id
          open = [active]
          listed = upsertSession(listed, opened.session)
          useSessionStore.getState().setSessions(workspacePath, listed)
          useSessionStore.getState().setOpen(workspacePath, open, active)
          loadHistory(opened.session, opened.history)
        } else {
          useSessionStore.getState().setOpen(workspacePath, open, active)
          const opened = await piAgentAPI.sessionsOpen(workspacePath, active)
          if (seq !== initSeqRef.current) return
          if (opened.success && opened.session) {
            listed = upsertSession(listed, opened.session)
            useSessionStore.getState().setSessions(workspacePath, listed)
            loadHistory(opened.session, opened.history)
          } else if (opened.error) {
            setFatalError(localizeError(opened.error))
          }
        }

        setInitialized(true)
        persistTabs()

        const pending = useChatStore.getState().pendingDraft
        if (pending && active) {
          const key = conversationKey(workspacePath, active)
          useChatStore.getState().setDraftInput(key, pending)
          useChatStore.getState().clearPendingDraft()
          inputRef.current?.focus()
        }
      } catch (err) {
        if (seq !== initSeqRef.current) return
        const message = err instanceof Error ? err.message : String(err)
        setFatalError(localizeError(message))
        console.error('[ChatPanel] Initialize error:', err)
      }
    }

    void run()

    const offTitle = piAgentAPI.onSessionTitle(({ workspaceDir, sessionId, title }) => {
      if (workspaceDir !== workspacePath) return
      useSessionStore.getState().updateSession(workspacePath, sessionId, { title })
    })

    return () => {
      // 使旧的初始化流程失效（含 StrictMode 的双重挂载）
      // eslint-disable-next-line react-hooks/exhaustive-deps
      initSeqRef.current++
      offTitle()
    }
  }, [workspacePath, loadHistory, persistTabs, t, configVersion])

  // 激活会话切换时回到最新位置
  useEffect(() => {
    stickToBottomRef.current = true
    const key = activeKey
    if (!key) return
    useSessionStore.getState().markUnread(workspacePath, activeSessionId!, false)
    setShowAttachMenu(false)
  }, [activeKey, activeSessionId, workspacePath])

  // 贴底时才跟随新消息
  useEffect(() => {
    if (!stickToBottomRef.current || messages.length === 0) return
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, virtualizer, activeKey])

  const handleTranscriptScroll = () => {
    const element = transcriptRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    stickToBottomRef.current = distance < 64
  }

  useEffect(() => {
    inputRef.current?.focus()
  }, [activeSessionId])

  const openSessionById = useCallback(
    async (sessionId: string, showError = true): Promise<boolean> => {
      const state = useSessionStore.getState().byWorkspace[workspacePath]
      const alreadyOpen = state?.open.includes(sessionId) ?? false
      const opened = await piAgentAPI.sessionsOpen(workspacePath, sessionId)
      if (!opened.success || !opened.session) {
        if (showError) {
          toast.error(
            t('sessionOpenFailed', {
              error: localizeError(opened.error || ''),
            })
          )
        }
        return false
      }

      const added = useSessionStore
        .getState()
        .addOpen(workspacePath, sessionId, opened.session)
      if (!added) {
        if (!alreadyOpen) void piAgentAPI.sessionsClose(workspacePath, sessionId)
        toast.error(t('sessionLimitReached', { count: MAX_OPEN_SESSIONS }))
        return false
      }
      useSessionStore.getState().updateSession(workspacePath, sessionId, opened.session)
      loadHistory(opened.session, opened.history)
      useSessionStore.getState().markUnread(workspacePath, sessionId, false)
      persistTabs()
      return true
    },
    [loadHistory, persistTabs, t, workspacePath]
  )

  const handleNewSession = useCallback(async () => {
    const created = await piAgentAPI.sessionsCreate(workspacePath)
    if (!created.success || !created.session) {
      toast.error(
        t('sessionCreateFailed', {
          error: localizeError(created.error || ''),
        })
      )
      return
    }
    const key = ensureConversation(created.session.id)
    useChatStore.getState().setMessages(key, [])
    const added = useSessionStore
      .getState()
      .addOpen(workspacePath, created.session.id, created.session)
    if (!added) {
      void piAgentAPI.sessionsClose(workspacePath, created.session.id)
      toast.error(t('sessionLimitReached', { count: MAX_OPEN_SESSIONS }))
      return
    }
    useSessionStore.getState().setPanelOpen(workspacePath, false)
    persistTabs()
    void refreshSessions()
  }, [ensureConversation, persistTabs, refreshSessions, t, workspacePath])

  const handleSelectSession = useCallback(
    async (session: SessionSummary) => {
      if (session.id === activeSessionId) {
        useSessionStore.getState().setPanelOpen(workspacePath, false)
        return
      }
      const ok = await openSessionById(session.id)
      if (ok) useSessionStore.getState().setPanelOpen(workspacePath, false)
    },
    [activeSessionId, openSessionById, workspacePath]
  )

  const handleCloseTab = useCallback(
    async (sessionId: string) => {
      const key = conversationKey(workspacePath, sessionId)
      const streaming = useSessionStore.getState().streaming[key]
      if (streaming) {
        const ok = await confirmDialog({
          message: t('closeRunningSessionConfirm'),
          danger: true,
        })
        if (!ok) return
      }
      await piAgentAPI.sessionsClose(workspacePath, sessionId)
      useChatStore.getState().removeConversation(key)
      useSessionStore.getState().markStreaming(workspacePath, sessionId, false)
      useSessionStore.getState().markUnread(workspacePath, sessionId, false)
      useSessionStore.getState().markError(workspacePath, sessionId, null)
      useSessionStore.getState().markNeedsAction(workspacePath, sessionId, null)
      const next = useSessionStore.getState().closeOpen(workspacePath, sessionId)
      persistTabs()
      if (!next) {
        await handleNewSession()
      } else {
        const nextKey = conversationKey(workspacePath, next)
        if (!useChatStore.getState().conversations[nextKey]) {
          await openSessionById(next)
        }
      }
      void refreshSessions()
    },
    [handleNewSession, openSessionById, persistTabs, refreshSessions, t, workspacePath]
  )

  const handleRenameSession = useCallback(
    async (session: SessionSummary) => {
      const name = await promptDialog({
        title: t('renameSession'),
        message: t('renamePrompt'),
        defaultValue: session.title,
        confirmLabel: t('rename'),
      })
      if (!name || name.trim() === session.title) return
      const result = await piAgentAPI.sessionsRename(workspacePath, session.id, name.trim())
      if (!result.success) {
        toast.error(
          t('sessionRenameFailed', {
            error: localizeError(result.error || ''),
          })
        )
        return
      }
      useSessionStore
        .getState()
        .updateSession(workspacePath, session.id, { title: name.trim() })
      void refreshSessions()
    },
    [refreshSessions, t, workspacePath]
  )

  const handleDeleteSession = useCallback(
    async (session: SessionSummary) => {
      const ok = await confirmDialog({
        title: t('deleteSession'),
        message: t('deleteSessionConfirm', {
          name: session.title || t('untitledSession'),
        }),
        confirmLabel: t('delete'),
        danger: true,
      })
      if (!ok) return
      const result = await piAgentAPI.sessionsDelete(workspacePath, session.id)
      if (!result.success) {
        toast.error(
          t('sessionDeleteFailed', {
            error: localizeError(result.error || ''),
          })
        )
        return
      }
      const key = conversationKey(workspacePath, session.id)
      useChatStore.getState().removeConversation(key)
      useSessionStore.getState().markStreaming(workspacePath, session.id, false)
      useSessionStore.getState().markUnread(workspacePath, session.id, false)
      useSessionStore.getState().markError(workspacePath, session.id, null)
      useSessionStore.getState().markNeedsAction(workspacePath, session.id, null)
      const next = useSessionStore.getState().removeSession(workspacePath, session.id)
      persistTabs()
      if (!next) {
        await handleNewSession()
      } else {
        const nextKey = conversationKey(workspacePath, next)
        if (!useChatStore.getState().conversations[nextKey]) {
          await openSessionById(next)
        }
      }
      void refreshSessions()
    },
    [handleNewSession, openSessionById, persistTabs, refreshSessions, t, workspacePath]
  )

  // 命令面板入口
  useEffect(() => {
    const active = sessions.find((session) => session.id === activeSessionId) ?? null
    const onNew = () => void handleNewSession()
    const onList = () => useSessionStore.getState().setPanelOpen(workspacePath, true)
    const onRename = () => {
      if (active) void handleRenameSession(active)
    }
    const onDelete = () => {
      if (active) void handleDeleteSession(active)
    }
    const onClose = () => {
      if (activeSessionId) void handleCloseTab(activeSessionId)
    }
    window.addEventListener('session-new', onNew)
    window.addEventListener('session-list', onList)
    window.addEventListener('session-rename', onRename)
    window.addEventListener('session-delete', onDelete)
    window.addEventListener('session-close', onClose)
    return () => {
      window.removeEventListener('session-new', onNew)
      window.removeEventListener('session-list', onList)
      window.removeEventListener('session-rename', onRename)
      window.removeEventListener('session-delete', onDelete)
      window.removeEventListener('session-close', onClose)
    }
  }, [
    activeSessionId,
    handleCloseTab,
    handleDeleteSession,
    handleNewSession,
    handleRenameSession,
    sessions,
    workspacePath,
  ])

  // 命令面板：把当前选区附加到对话
  useEffect(() => {
    const onAttachSelection = () => {
      const key = activeKey
      const current = useSelectionStore.getState().selection
      if (!key) {
        toast.error(t('noActiveSession'))
        return
      }
      if (!current) {
        toast.error(t('selectionEmpty'))
        return
      }
      useChatStore.getState().addAttachment(key, {
        kind: 'snippet',
        path: current.path,
        name: current.name,
        startLine: current.startLine,
        endLine: current.endLine,
        content: current.text,
      })
      toast.success(t('selectionAttached'))
    }
    window.addEventListener('attach-selection', onAttachSelection)
    return () => window.removeEventListener('attach-selection', onAttachSelection)
  }, [activeKey, t])

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()

    const sessionId = activeSessionId
    const key = activeKey
    if (!sessionId || !key || !input.trim() || isLoading) return

    const userMessage = input.trim()
    const chat = useChatStore.getState()
    stoppedRef.current = false
    useSessionStore.getState().markError(workspacePath, sessionId, null)
    useSessionStore.getState().markUnread(workspacePath, sessionId, false)
    chat.setDraftInput(key, '')
    chat.addMessage(key, { role: 'user', content: userMessage })
    setShowAttachMenu(false)
    chat.setLoading(key, true)
    useSessionStore.getState().markStreaming(workspacePath, sessionId, true)

    const assistantId = chat.startStreamingMessage(key)
    // 高频增量先合并，避免每个 token 都触发 store 更新与整条消息重渲染
    const deltaBuffer = createDeltaBuffer((delta) =>
      useChatStore.getState().appendToMessage(key, assistantId, delta)
    )
    const sessionAttachments = chat.conversations[key]?.attachments ?? []
    let succeeded = false

    try {
      // 读取附件内容并注入本轮 prompt；用户气泡只显示原始文本
      const contextFiles: Array<{
        path: string
        content: string
        startLine?: number
        endLine?: number
      }> = []
      let totalChars = 0
      for (const attachment of sessionAttachments) {
        let content: string
        if (attachment.kind === 'snippet') {
          content = attachment.content ?? ''
          if (!content) continue
          if (content.length > MAX_CONTEXT_SNIPPET_CHARS) {
            toast.error(`${t('contextTooLarge')}: ${attachment.name}`)
            continue
          }
        } else {
          const file = await api.readFile(attachment.path)
          if (!file.success || typeof file.content !== 'string') {
            toast.error(`${t('contextReadFailed')}: ${attachment.name}`)
            continue
          }
          if (file.content.length > MAX_CONTEXT_FILE_CHARS) {
            toast.error(`${t('contextTooLarge')}: ${attachment.name}`)
            continue
          }
          content = file.content
        }
        if (totalChars + content.length > MAX_CONTEXT_TOTAL_CHARS) {
          toast.error(t('contextTotalTooLarge'))
          break
        }
        totalChars += content.length
        contextFiles.push({
          path: attachment.path,
          content,
          startLine: attachment.startLine,
          endLine: attachment.endLine,
        })
      }
      const prompt = buildContextPrompt(userMessage, contextFiles)

      const result = await piAgentAPI.chat(
        prompt,
        deltaBuffer.push,
        workspacePath,
        sessionId
      )
      // 收尾前把剩余增量交给 store；成功时随后会被完整响应覆盖，不会重复
      deltaBuffer.flush()

      if (result.success && result.response) {
        succeeded = true
        chat.setError(key, null)
        useSessionStore.getState().markError(workspacePath, sessionId, null)
        chat.finishStreamingMessage(key, assistantId, result.response)
        if (result.usage) chat.setMessageUsage(key, assistantId, result.usage)
        if (result.edits && result.edits.length > 0) {
          openEdits(result.edits)
          toast.info(t('agentModifiedFiles', { count: result.edits.length }))
        }
      } else {
        const errorMessage = result.error
          ? localizeError(result.error)
          : t('agentResponseFailed')
        if (stoppedRef.current) {
          chat.setError(key, null)
          chat.finishStreamingMessage(key, assistantId)
        } else {
          chat.setError(key, errorMessage)
          useSessionStore.getState().markError(workspacePath, sessionId, errorMessage)
          chat.finishStreamingMessage(
            key,
            assistantId,
            t('errorPrefix', { message: errorMessage })
          )
        }
      }
    } catch (err) {
      deltaBuffer.flush()
      const errorMsg = localizeError(err instanceof Error ? err.message : String(err))
      if (stoppedRef.current) {
        chat.setError(key, null)
        chat.finishStreamingMessage(key, assistantId)
      } else {
        chat.setError(key, errorMsg)
        useSessionStore.getState().markError(workspacePath, sessionId, errorMsg)
        chat.finishStreamingMessage(key, assistantId, t('errorPrefix', { message: errorMsg }))
      }
    } finally {
      deltaBuffer.dispose()
      useChatStore.getState().setLoading(key, false)
      useChatStore.getState().clearAttachments(key)
      useSessionStore.getState().markStreaming(workspacePath, sessionId, false)
      const activeNow = useSessionStore.getState().byWorkspace[workspacePath]?.active
      if (succeeded) {
        if (activeNow && activeNow !== sessionId) {
          useSessionStore.getState().markUnread(workspacePath, sessionId, true)
        } else {
          useSessionStore.getState().markUnread(workspacePath, sessionId, false)
          inputRef.current?.focus()
        }
      } else {
        // 错误优先于未读；用户主动停止不保留错误标记
        useSessionStore.getState().markUnread(workspacePath, sessionId, false)
        if (activeNow === sessionId) inputRef.current?.focus()
      }
      const currentMessages = useChatStore.getState().conversations[key]?.messages.length ?? 0
      useSessionStore.getState().updateSession(workspacePath, sessionId, {
        messageCount: currentMessages,
        updatedAt: Date.now(),
      })
      void refreshSessions()
      // 自动标题是异步生成的；稍后再拉一次列表，Web 模式也能显示标题
      window.setTimeout(() => void refreshSessions(), 1500)
    }
  }

  const handleStop = async () => {
    if (!activeSessionId) return
    stoppedRef.current = true
    await piAgentAPI.abort(workspacePath, activeSessionId)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  if (needsApiKey) {
    return (
      <div className="flex h-full flex-col bg-panel">
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState
            icon={Settings2}
            title={t('apiConfigRequired')}
            description={
              fatalError ? `${t('agentInitFailed')}: ${fatalError}` : t('apiConfigRequiredDesc')
            }
            action={
              <Button
                variant="primary"
                size="sm"
                icon={Settings2}
                onClick={() => window.dispatchEvent(new CustomEvent('open-settings'))}
              >
                {t('goToSettings')}
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col bg-panel">
      {/* Header */}
      <div className="flex h-[38px] flex-shrink-0 items-center justify-between border-b border-rule-divide px-3.5">
        <div className="flex items-center gap-2.5">
          <h3 className="m-0 type-label text-ink-muted">{t('agentChatTitle')}</h3>
          <span className="flex items-center gap-1.5 type-caption text-ink-muted">
            <span
              className={`h-1 w-1 rounded-full ${
                initialized ? 'bg-success' : 'animate-pulse bg-warning'
              }`}
            />
            {initialized ? t('agentReadyStatus') : t('agentInitializingStatus')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="border border-rule-control px-1.5 py-0.5 type-key text-ink-muted">
            {commandPaletteShortcut()}
          </span>
          <IconButton
            icon={Settings2}
            label={t('settings')}
            size="sm"
            onClick={() => window.dispatchEvent(new CustomEvent('open-settings'))}
          />
        </div>
      </div>

      <SessionTabs
        workspacePath={workspacePath}
        sessions={sessions}
        onSelect={(id) => {
          const session = sessions.find((item) => item.id === id)
          if (session) void handleSelectSession(session)
        }}
        onNew={() => void handleNewSession()}
        onClose={(id) => void handleCloseTab(id)}
        onOpenList={() => useSessionStore.getState().setPanelOpen(workspacePath, true)}
      />

      {/* Transcript */}
      {!activeSessionId ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState
            icon={History}
            title={t('sessionsEmpty')}
            action={
              <Button variant="primary" size="sm" onClick={() => void handleNewSession()}>
                {t('newSession')}
              </Button>
            }
          />
        </div>
      ) : (
        <div
          ref={transcriptRef}
          onScroll={handleTranscriptScroll}
          data-testid="chat-transcript"
          className="flex-1 overflow-y-auto px-3.5 py-3"
        >
          {messages.length === 0 && !isLoading ? (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                compact
                icon={History}
                title={t('agentChatTitle')}
                description={initialized ? t('agentReadyStatus') : t('agentInitializingStatus')}
              />
            </div>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().length > 0
                ? virtualizer.getVirtualItems().map((virtualRow) => {
                    const msg = messages[virtualRow.index]
                    if (!msg) return null
                    return (
                      <div
                        key={msg.id}
                        data-index={virtualRow.index}
                        ref={
                          typeof ResizeObserver !== 'undefined'
                            ? virtualizer.measureElement
                            : undefined
                        }
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <ChatMessageRow message={msg} />
                      </div>
                    )
                  })
                : messages
                    .slice(0, 30)
                    .map((msg) => <ChatMessageRow key={msg.id} message={msg} />)}
            </div>
          )}

          {isLoading && !messages.some((msg) => msg.isStreaming && msg.content) && (
            <div className="flex items-center gap-2 border-b border-rule-divide py-3 type-value text-ink-muted last:border-b-0">
              <Spinner size={12} />
              {t('thinking')}
            </div>
          )}

          {(error || fatalError) && (
            <div className="mt-3 flex items-start gap-2 border-l-2 border-danger bg-danger/5 py-2 pl-3 type-caption text-danger">
              <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{fatalError || error}</span>
            </div>
          )}
        </div>
      )}

      {/* Composer */}
      {activeSessionId && (
        <div className="flex-shrink-0 p-2.5">
          {attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {attachments.map((attachment) => {
                const label =
                  attachment.kind === 'snippet'
                    ? `${attachment.name}:${attachment.startLine}–${attachment.endLine}`
                    : attachment.name
                return (
                  <span
                    key={attachment.id}
                    className="inline-flex items-center gap-1 border border-rule-control bg-sunken px-2 py-1 type-data text-ink-muted"
                    title={
                      attachment.kind === 'snippet'
                        ? `${attachment.path}:${attachment.startLine}-${attachment.endLine}`
                        : attachment.path
                    }
                  >
                    <FileText size={10} className="text-ink-muted" />
                    {label}
                    <button
                      type="button"
                      onClick={() =>
                        activeKey &&
                        useChatStore.getState().removeAttachment(activeKey, attachment.id)
                      }
                      title={t('removeAttachment')}
                      aria-label={t('removeAttachment')}
                      className="ml-0.5 p-0.5 text-ink-muted hover:text-ink"
                    >
                      <X size={10} />
                    </button>
                  </span>
                )
              })}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="border border-rule-control bg-sunken transition-colors focus-within:border-accent"
          >
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('inputPlaceholder')}
              disabled={!initialized || isLoading}
              rows={3}
              className="min-h-[68px] max-h-40 border-none bg-transparent px-3 py-2 focus:ring-0"
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-2">
              <div className="relative flex items-center gap-1">
                <IconButton
                  icon={Paperclip}
                  label={t('attachContext')}
                  size="sm"
                  disabled={!initialized || isLoading}
                  onClick={() => setShowAttachMenu((open) => !open)}
                />
                {showAttachMenu && activeKey && (
                  <div className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-72 overflow-y-auto border border-line bg-raised py-1 shadow-print">
                    <div className="px-3 py-1.5 type-label text-ink-muted">
                      {t('attachContext')}
                    </div>
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
                              useChatStore
                                .getState()
                                .addAttachment(activeKey, {
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
                              <DataText className="truncate text-ink-muted">
                                {file.path}
                              </DataText>
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                )}
              </div>
              {isLoading ? (
                <Button variant="danger" size="sm" icon={Square} onClick={() => void handleStop()}>
                  {t('stop')}
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  icon={Send}
                  disabled={!initialized || !input.trim()}
                >
                  {t('send')}
                </Button>
              )}
            </div>
          </form>
          <p className="mb-0 mt-1.5 px-0.5 type-caption text-ink-muted">
            {t('chatInputHint')}
          </p>
        </div>
      )}

      <ChatSessionList
        workspacePath={workspacePath}
        open={panelOpen}
        sessions={sessions}
        onClose={() => useSessionStore.getState().setPanelOpen(workspacePath, false)}
        onSelect={(session) => void handleSelectSession(session)}
        onNew={() => void handleNewSession()}
        onRename={(session) => void handleRenameSession(session)}
        onDelete={(session) => void handleDeleteSession(session)}
      />
    </div>
  )
}
