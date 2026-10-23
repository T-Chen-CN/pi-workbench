import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  History,
  Paperclip,
  Pencil,
  RotateCcw,
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
import { useApprovalStore } from '../store/approvalStore'
import { useSettingsStore } from '../store/settingsStore'
import { piAgentAPI } from '../api/piAgentAPI'
import { api } from '../api'
import { buildContextPrompt } from '../api/chatContext'
import { localizeError } from '../i18n/errors'
import { commandPaletteShortcut } from '../utils/shortcuts'
import { createTraceBuffer } from '../utils/streamBuffer'
import { revertFileEdit } from '../utils/revertFile'
import { extractSymbols, sliceSymbol, type ExtractedSymbol } from '../utils/symbols'
import { toast } from '../store/toastStore'
import { confirmDialog, promptDialog } from '../store/dialogStore'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { SessionTabs } from './SessionTabs'
import { ChatSessionList } from './ChatSessionList'
import { ApprovalCard } from './ApprovalCard'
import { ToolResultViewer } from './ToolResultViewer'
import { Meter } from './patterns'
import { AgentParts } from './AgentTrace'
import { MarkdownBody, StreamingMarkdown } from './AgentMarkdown'
import {
  Button,
  Caption,
  DataText,
  EmptyState,
  IconButton,
  Label,
  Select,
  Spinner,
  Textarea,
} from './ui'
import type {
  SessionSummary,
  CheckpointSummary,
  SessionMeta,
  PendingMessagesMap,
} from '../types/electron'

interface ChatPanelProps {
  workspacePath: string
}

/** 单个附件与单条消息的上下文字符上限 */
const MAX_CONTEXT_FILE_CHARS = 120_000
const MAX_CONTEXT_SNIPPET_CHARS = 40_000
const MAX_CONTEXT_TOTAL_CHARS = 300_000
/** 图像附件：最多 4 张、单张 5MB，仅常见位图格式 */
const MAX_IMAGE_COUNT = 4
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** 1.2k / 12k / 96k */
function formatTokenCount(value: number): string {
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 本轮任务列表（AF-12）：由助手消息里的工具步骤派生 */
const TurnTaskList: React.FC<{ parts: import('../types/electron').AgentTracePart[] }> = ({
  parts,
}) => {
  const { t } = useI18nStore()
  const [open, setOpen] = useState(false)
  const tools = parts.filter(
    (part): part is Extract<import('../types/electron').AgentTracePart, { type: 'tool' }> =>
      part.type === 'tool'
  )
  if (tools.length === 0) return null
  const done = tools.filter((tool) => tool.status !== 'running').length
  const running = done < tools.length

  return (
    <div className="border border-rule-hairline bg-raised">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <ChevronRight
          size={12}
          className={`flex-shrink-0 text-ink-muted transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="type-label text-ink">{t('currentTasks')}</span>
        <span className="type-caption text-ink-muted">
          {t('taskProgress', { done, total: tools.length })}
        </span>
        {running && <Spinner size={10} />}
      </button>
      {open && (
        <div className="border-t border-rule-divide">
          {tools.map((tool) => (
            <div
              key={tool.id}
              className="flex items-center gap-2 border-b border-rule-divide px-3 py-1 last:border-b-0"
            >
              <span
                className={`h-1 w-1 flex-shrink-0 rounded-full ${
                  tool.status === 'running'
                    ? 'animate-pulse bg-accent'
                    : tool.isError || tool.status === 'error'
                      ? 'bg-danger'
                      : 'bg-success'
                }`}
              />
              <span className="type-label text-ink">{tool.toolName}</span>
              <span className="min-w-0 flex-1 truncate type-data text-ink-muted">
                {tool.argsSummary}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 一轮修改的内联变更卡（AF-10）：逐文件查看 / 还原 */
const TurnEditSummary: React.FC<{
  edits: import('../types/electron').FileEdit[]
  messageKey: string
  messageId: string
}> = ({ edits, messageKey, messageId }) => {
  const { t } = useI18nStore()
  const [busy, setBusy] = useState(false)

  const describeFailure = (
    result: Awaited<ReturnType<typeof revertFileEdit>>,
    target: string
  ): string => {
    if (result.ok) return ''
    if (result.reason === 'dirty') return t('revertBlockedDirty')
    if (result.reason === 'conflict') return t('revertConflict')
    return `${t('revertFailed')}: ${localizeError(result.error ?? '') || target}`
  }

  const revertOne = async (edit: import('../types/electron').FileEdit): Promise<boolean> => {
    const result = await revertFileEdit(edit)
    if (!result.ok) {
      toast.error(describeFailure(result, edit.path))
      return false
    }
    useChatStore.getState().removeMessageEdit(messageKey, messageId, edit.path)
    return true
  }

  const handleRevert = async (edit: import('../types/electron').FileEdit) => {
    if (!(await confirmDialog({ message: t('revertConfirm'), danger: true }))) return
    setBusy(true)
    try {
      if (await revertOne(edit)) toast.success(t('reverted'))
    } finally {
      setBusy(false)
    }
  }

  const handleRevertAll = async () => {
    if (!(await confirmDialog({ message: t('revertAllConfirm'), danger: true }))) return
    setBusy(true)
    try {
      let reverted = 0
      for (const edit of edits) {
        if (await revertOne(edit)) reverted++
      }
      if (reverted > 0) toast.success(t('reverted'))
    } finally {
      setBusy(false)
    }
  }

  if (edits.length === 0) return null
  const fileName = (target: string) => target.split(/[\\/]/).pop() || target

  return (
    <div className="mt-2 border border-rule-hairline bg-raised">
      <div className="flex items-center justify-between gap-2 border-b border-rule-divide px-3 py-1.5">
        <span className="type-label text-ink">{t('turnChanges', { count: edits.length })}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleRevertAll()}
          className="type-caption text-ink-muted transition-colors hover:text-danger disabled:opacity-40"
        >
          {t('revertAll')}
        </button>
      </div>
      {edits.map((edit) => (
        <div
          key={edit.path}
          className="flex items-center gap-2 border-b border-rule-divide px-3 py-1 last:border-b-0"
        >
          <span className="min-w-0 flex-1 truncate type-data text-ink-muted" title={edit.path}>
            {fileName(edit.path)}
          </span>
          <button
            type="button"
            onClick={() => useDiffStore.getState().openEdits([edit])}
            className="type-caption text-ink-muted transition-colors hover:text-ink"
          >
            {t('viewChanges')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleRevert(edit)}
            className="type-caption text-ink-muted transition-colors hover:text-danger disabled:opacity-40"
          >
            {t('revertFile')}
          </button>
        </div>
      ))}
    </div>
  )
}

/** 单条消息；memo 保证流式追加只重渲染最后一条 */
const ChatMessageRow = React.memo(function ChatMessageRow({
  message,
  diffToolIds,
  onOpenDiff,
  onCopy,
  onRetry,
  onEdit,
  onSwitchBranch,
  onOpenToolResult,
  conversationKey,
}: {
  message: ChatMessage
  diffToolIds?: Set<string>
  onOpenDiff?: (toolCallId: string) => void
  onCopy?: (text: string) => void
  onRetry?: () => void
  onEdit?: () => void
  onSwitchBranch?: (entryId: string) => void
  onOpenToolResult?: (toolCallId: string, toolName: string) => void
  conversationKey?: string
}) {
  const { t, language } = useI18nStore()

  if (message.isStreaming && !message.content && !message.parts?.length) return null
  const isUser = message.role === 'user'
  const hasActions = Boolean(onCopy || onRetry || onEdit)

  return (
    <div
      data-testid="chat-message"
      className="group border-b border-rule-divide py-3 first:pt-0 last:border-b-0"
    >
      <div className="mb-1.5 flex items-baseline gap-2">
        <Label className="text-ink">{isUser ? t('roleYou') : t('piAgent')}</Label>
        <Caption className="text-ink-muted">
          {new Date(message.timestamp).toLocaleTimeString(
            language === 'zh' ? 'zh-CN' : 'en-US'
          )}
        </Caption>
        {message.branch && message.branch.entryIds.length > 1 && (
          <span className="flex items-center gap-0.5">
            <IconButton
              icon={ChevronLeft}
              label={t('previousBranch')}
              size="sm"
              disabled={message.branch.activeIndex <= 0}
              onClick={() => {
                const branch = message.branch
                if (branch) onSwitchBranch?.(branch.entryIds[branch.activeIndex - 1])
              }}
            />
            <Caption className="text-ink-muted">
              {message.branch.activeIndex + 1}/{message.branch.entryIds.length}
            </Caption>
            <IconButton
              icon={ChevronRight}
              label={t('nextBranch')}
              size="sm"
              disabled={
                message.branch.activeIndex >= message.branch.entryIds.length - 1
              }
              onClick={() => {
                const branch = message.branch
                if (branch) onSwitchBranch?.(branch.entryIds[branch.activeIndex + 1])
              }}
            />
          </span>
        )}
        {hasActions && (
          <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {onCopy && (
              <IconButton
                icon={Copy}
                label={t('copyMessage')}
                size="sm"
                onClick={() => onCopy(message.content)}
              />
            )}
            {onRetry && (
              <IconButton
                icon={RotateCcw}
                label={t('retryMessage')}
                size="sm"
                onClick={onRetry}
              />
            )}
            {onEdit && (
              <IconButton
                icon={Pencil}
                label={t('editMessage')}
                size="sm"
                onClick={onEdit}
              />
            )}
          </span>
        )}
      </div>
      {isUser ? (
        <div className="flex gap-2 type-reading text-ink">
          <span className="type-project text-accent">›</span>
          <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
      ) : (
        <div className="text-ink">
          {message.parts?.length ? (
            <AgentParts
              parts={message.parts}
              isStreaming={Boolean(message.isStreaming)}
              diffToolIds={diffToolIds}
              onOpenDiff={onOpenDiff}
              onOpenToolResult={onOpenToolResult}
            />
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
            </div>
          )}
          {message.usage && (
            <Caption className="mt-1 block text-ink-muted">
              {message.usage.totalTokens.toLocaleString()} tokens
              {message.usage.cost > 0 ? ` · $${message.usage.cost.toFixed(4)}` : ''}
            </Caption>
          )}
          {message.edits && message.edits.length > 0 && conversationKey && (
            <TurnEditSummary
              edits={message.edits}
              messageKey={conversationKey}
              messageId={message.id}
            />
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
  const { t, language } = useI18nStore()
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
  const pendingMessages = conversation?.pending ?? []
  const contextUsage = conversation?.contextUsage ?? null
  const contextPercent = contextUsage?.percent ?? null
  const sessionSettings = conversation?.sessionSettings ?? null
  const sessionStats = conversation?.sessionStats ?? null
  const retryStatus = conversation?.retryStatus ?? null
  let lastAssistantMessage: ChatMessage | null = null
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant') {
      lastAssistantMessage = messages[index]
      break
    }
  }
  const [availableModels, setAvailableModels] = useState<string[]>([])
  let lastUserMessageId: string | null = null
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') {
      lastUserMessageId = messages[index].id
      break
    }
  }
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null
  const error = conversation?.error ?? null
  const attachments = conversation?.attachments ?? []
  const input = conversation?.draftInput ?? ''
  const mode = conversation?.mode ?? 'act'

  const openFiles = useEditorStore((state) => state.openFiles)
  const currentEditorFile = useEditorStore((state) => state.currentFile)
  const selection = useSelectionStore((state) => state.selection)
  const approvalRequests = useApprovalStore((state) => state.requests)
  const pendingApprovals = useMemo(
    () =>
      approvalRequests.filter(
        (request) =>
          request.workspaceDir === workspacePath && request.sessionId === activeSessionId
      ),
    [approvalRequests, workspacePath, activeSessionId]
  )
  const diffEdits = useDiffStore((state) => state.edits)
  const diffToolIds = useMemo(
    () =>
      new Set(
        diffEdits
          .map((edit) => edit.toolCallId)
          .filter((id): id is string => Boolean(id))
      ),
    [diffEdits]
  )
  const openToolDiff = useCallback(
    async (toolCallId: string) => {
      const edit = useDiffStore.getState().edits.find((item) => item.toolCallId === toolCallId)
      if (edit) {
        useDiffStore.getState().openEdits([edit])
        return
      }
      if (!activeSessionId) return
      const result = await piAgentAPI.getToolEdit(workspacePath, activeSessionId, toolCallId)
      if (!result.success || !result.edit) {
        toast.error(t('historicalDiffMissing'))
        return
      }
      useDiffStore.getState().openEdits([{ ...result.edit, toolCallId }])
    },
    [activeSessionId, workspacePath, t]
  )

  const [initialized, setInitialized] = useState(false)
  const [needsApiKey, setNeedsApiKey] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [attachMode, setAttachMode] = useState<'files' | 'symbols'>('files')
  const [pendingBehavior, setPendingBehavior] = useState<'queue' | 'steer'>('queue')
  const [showCheckpoints, setShowCheckpoints] = useState(false)
  /** 工具结果全量查看（R-20） */
  const [toolResultView, setToolResultView] = useState<{
    toolCallId: string
    toolName: string
    sessionId: string
  } | null>(null)
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([])
  const [sessionMeta, setSessionMeta] = useState<SessionMeta>({ pinned: [], archived: [] })
  const [showArchived, setShowArchived] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [newMessageCount, setNewMessageCount] = useState(0)
  const lastMessageCountRef = useRef(0)
  const [mention, setMention] = useState<{
    start: number
    query: string
    results: string[]
  } | null>(null)
  const mentionTimer = useRef<number | null>(null)
  const [configVersion, setConfigVersion] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const forceSendRef = useRef(false)
  const budgetWarnedRef = useRef(false)
  const initSeqRef = useRef(0)
  const pendingHydratedRef = useRef(false)
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

  /** @ 文件搜索（防抖），结果落到 mention 弹层 */
  const searchMention = useCallback(
    (query: string, start: number) => {
      if (mentionTimer.current) window.clearTimeout(mentionTimer.current)
      mentionTimer.current = window.setTimeout(async () => {
        const result = await api.searchWorkspaceFiles(workspacePath, query, 12)
        if (!result.success) return
        setMention((current) =>
          current && current.start === start
            ? { ...current, results: result.files ?? [] }
            : current
        )
      }, 120)
    },
    [workspacePath]
  )

  const handleDraftChange = (value: string, caret: number) => {
    setDraft(value)
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

  /** 选择 @ 文件：插入引用文本并作为附件附加 */
  const addMention = (relative: string) => {
    if (!activeKey || !mention) return
    const value = useChatStore.getState().conversations[activeKey]?.draftInput ?? ''
    const tokenEnd = mention.start + 1 + mention.query.length
    const next = `${value.slice(0, mention.start)}@${relative} ${value.slice(tokenEnd)}`
    useChatStore.getState().setDraftInput(activeKey, next)
    useChatStore.getState().addAttachment(activeKey, {
      kind: 'file',
      path: `${workspacePath}/${relative}`,
      name: relative.split('/').pop() || relative,
    })
    setMention(null)
    inputRef.current?.focus()
  }

  const currentSymbols = useMemo(
    () =>
      currentEditorFile ? extractSymbols(currentEditorFile.content, currentEditorFile.name) : [],
    [currentEditorFile]
  )

  /** 附加单个符号（函数 / 类等）作为上下文 */
  const attachSymbol = (symbol: ExtractedSymbol) => {
    if (!activeKey || !currentEditorFile) return
    useChatStore.getState().addAttachment(activeKey, {
      kind: 'snippet',
      path: currentEditorFile.path,
      name: `${currentEditorFile.name}#${symbol.name}`,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      content: sliceSymbol(currentEditorFile.content, symbol),
    })
    setShowAttachMenu(false)
    setAttachMode('files')
  }

  /** 图像附件：读取为 base64 后进入附件区（不写入上下文文本） */
  const addImageFiles = (files: File[]): void => {
    if (!activeKey) return
    const current = useChatStore.getState().conversations[activeKey]?.attachments ?? []
    let imageCount = current.filter((attachment) => attachment.kind === 'image').length
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
        toast.error(t('imageUnsupported'))
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error(t('imageTooLarge', { size: formatBytes(MAX_IMAGE_BYTES) }))
        continue
      }
      if (imageCount >= MAX_IMAGE_COUNT) {
        toast.error(t('imageLimit', { count: MAX_IMAGE_COUNT }))
        break
      }
      imageCount++
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result ?? '')
        const comma = result.indexOf(',')
        if (comma < 0) return
        useChatStore.getState().addAttachment(activeKey, {
          kind: 'image',
          path: '',
          name: file.name || `image-${Date.now()}.${file.type.split('/')[1] || 'png'}`,
          mimeType: file.type,
          data: result.slice(comma + 1),
          size: file.size,
        })
      }
      reader.readAsDataURL(file)
    }
  }

  /** 粘贴截图作为图像附件 */
  const handlePaste = (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith('image/')
    )
    if (files.length === 0) return
    event.preventDefault()
    addImageFiles(files)
  }

  /** 拖入文件作为附件 */
  const handleDropFiles = (event: React.DragEvent) => {
    event.preventDefault()
    if (!activeKey) return
    const images: File[] = []
    for (const file of Array.from(event.dataTransfer.files)) {
      if (file.type.startsWith('image/')) {
        images.push(file)
        continue
      }
      const target = api.getPathForFile(file)
      if (!target) continue
      useChatStore.getState().addAttachment(activeKey, {
        kind: 'file',
        path: target,
        name: file.name,
      })
    }
    if (images.length > 0) addImageFiles(images)
  }

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

  /** 重新读取回复分支分组（R-03），每次加载 / 生成后刷新 */
  const refreshBranches = useCallback(
    async (sessionId: string) => {
      const result = await piAgentAPI.listBranches(workspacePath, sessionId).catch(() => null)
      if (!result?.success || !result.groups) return
      useChatStore
        .getState()
        .setMessageBranches(conversationKey(workspacePath, sessionId), result.groups)
    },
    [workspacePath]
  )

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
      void refreshBranches(session.id)
    },
    [ensureConversation, refreshBranches]
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

        // 恢复上次未发送的排队消息（R-02）；每个工作区只恢复一次
        if (!pendingHydratedRef.current) {
          const storedPending = await api.getPendingMessages(workspacePath)
          if (seq !== initSeqRef.current) return
          if (storedPending.success && storedPending.sessions) {
            const chat = useChatStore.getState()
            for (const [storedSessionId, items] of Object.entries(storedPending.sessions)) {
              if (items.length === 0) continue
              const key = conversationKey(workspacePath, storedSessionId)
              chat.ensureConversation(key)
              chat.setPending(key, items)
            }
          }
          pendingHydratedRef.current = true
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

  // 排队消息变化时写入工作区（R-02）；关闭标签或删除会话后快照里自然不再包含它
  useEffect(() => {
    const prefix = `${workspacePath}\u0000`
    const snapshot = (
      conversations: Record<
        string,
        { pending: Array<{ id: string; text: string; behavior: 'queue' | 'steer' }> }
      >
    ): PendingMessagesMap => {
      const sessions: PendingMessagesMap = {}
      for (const [key, conversation] of Object.entries(conversations)) {
        if (!key.startsWith(prefix) || conversation.pending.length === 0) continue
        sessions[key.slice(prefix.length)] = conversation.pending.map(({ id, text, behavior }) => ({
          id,
          text,
          behavior,
        }))
      }
      return sessions
    }
    let timer: number | null = null
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (!pendingHydratedRef.current) return
      if (JSON.stringify(snapshot(state.conversations)) === JSON.stringify(snapshot(previous.conversations))) {
        return
      }
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        void api.setPendingMessages(
          workspacePath,
          snapshot(useChatStore.getState().conversations)
        )
      }, 300)
    })
    return () => {
      unsubscribe()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [workspacePath])

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

  /** 打开工具结果全量查看器（只读） */
  const handleOpenToolResult = useCallback(
    (toolCallId: string, toolName: string) => {
      if (!activeSessionId) return
      setToolResultView({ toolCallId, toolName, sessionId: activeSessionId })
    },
    [activeSessionId]
  )

  const handleTranscriptScroll = () => {
    const element = transcriptRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    stickToBottomRef.current = distance < 64
    setShowScrollButton(distance > 120)
    if (distance < 64) setNewMessageCount(0)
  }

  /** 回到底部并恢复跟随 */
  const scrollToBottom = () => {
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
    }
    stickToBottomRef.current = true
    setShowScrollButton(false)
    setNewMessageCount(0)
  }

  useEffect(() => {
    const previous = lastMessageCountRef.current
    lastMessageCountRef.current = messages.length
    if (messages.length > previous && previous > 0 && !stickToBottomRef.current) {
      setNewMessageCount((count) => count + (messages.length - previous))
    }
  }, [messages.length])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault()
        scrollToBottom()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

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

  // 桌面通知点击后激活目标会话（工作区已由 App 切换）
  useEffect(() => {
    const pending = useSessionStore.getState().pendingActivation
    if (!pending || pending.workspaceDir !== workspacePath || !initialized) return
    if (!sessions.some((session) => session.id === pending.sessionId)) {
      useSessionStore.getState().clearPendingActivation()
      return
    }
    useSessionStore.getState().setActive(workspacePath, pending.sessionId)
    useSessionStore.getState().clearPendingActivation()
  }, [initialized, sessions, workspacePath])

  /** 运行中插话：把消息注入当前轮 */
  const sendSteer = async (
    sessionId: string,
    key: string,
    item: import('../store/chatStore').PendingMessage
  ) => {
    const result = await piAgentAPI.steer(workspacePath, sessionId, item.text)
    const chat = useChatStore.getState()
    if (result.success) {
      chat.removePending(key, item.id)
      chat.addMessage(key, { role: 'user', content: item.text })
      toast.info(t('steerSent'))
    } else {
      toast.error(t('steerFailed', { error: localizeError(result.error ?? '') }))
    }
  }

  /** 斜杠命令（AF-14）：在发送前拦截 */
  const handleSlashCommand = async (inputValue: string): Promise<boolean> => {
    const [rawCommand, ...rest] = inputValue.trim().split(/\s+/)
    const command = rawCommand.toLowerCase()
    if (!command.startsWith('/')) return false
    const argument = rest.join(' ').trim()

    switch (command) {
      case '/help':
        toast.info(t('slashHelp'))
        return true
      case '/plan':
        await handleModeChange('plan')
        return true
      case '/act':
        await handleModeChange('act')
        return true
      case '/compact':
        await handleCompact()
        return true
      case '/clear':
        if (await confirmDialog({ message: t('slashClearConfirm'), danger: true })) {
          await handleNewSession()
        }
        return true
      case '/model': {
        if (!argument) {
          toast.info(t('slashCurrentModel', { model: sessionSettings?.modelId ?? '—' }))
          return true
        }
        const match = availableModels.find(
          (model) => model.toLowerCase() === argument.toLowerCase()
        )
        if (!match) {
          toast.error(t('slashUnknownModel', { model: argument }))
          return true
        }
        await handleModelChange(match)
        return true
      }
      default:
        toast.error(t('slashUnknownCommand', { command }))
        return true
    }
  }

  const handleSubmit = async (
    e?: React.FormEvent,
    override?: string,
    options?: { skipUserMessage?: boolean }
  ) => {
    e?.preventDefault()

    const sessionId = activeSessionId
    const key = activeKey
    const userMessage = (override ?? input).trim()
    if (!sessionId || !key || !userMessage) return

    const chat = useChatStore.getState()

    // 斜杠命令不进入对话
    if (!options?.skipUserMessage && userMessage.startsWith('/')) {
      chat.setDraftInput(key, '')
      if (await handleSlashCommand(userMessage)) return
    }

    // 运行中：进入待发送队列；steer 立即注入当前轮
    if (isLoading && !forceSendRef.current) {
      chat.setDraftInput(key, '')
      const item = chat.addPending(key, userMessage, pendingBehavior)
      if (pendingBehavior === 'steer') void sendSteer(sessionId, key, item)
      return
    }
    forceSendRef.current = false
    budgetWarnedRef.current = false

    stoppedRef.current = false
    useSessionStore.getState().markError(workspacePath, sessionId, null)
    useSessionStore.getState().markUnread(workspacePath, sessionId, false)
    chat.setDraftInput(key, '')
    if (!options?.skipUserMessage) {
      chat.addMessage(key, { role: 'user', content: userMessage })
    }
    setShowAttachMenu(false)
    chat.setLoading(key, true)
    useSessionStore.getState().markStreaming(workspacePath, sessionId, true)

    const assistantId = chat.startStreamingMessage(key)
    // 文本 / 思考 / 工具事件共用一条有序缓冲，50ms 合并，保证 parts 顺序
    const traceBuffer = createTraceBuffer((events) => {
      const store = useChatStore.getState()
      for (const event of events) {
        switch (event.type) {
          case 'text_delta':
            store.appendTextPart(key, assistantId, event.delta)
            break
          case 'thinking_delta':
            store.appendThinkingPart(key, assistantId, event.delta)
            break
          case 'thinking_redacted':
            store.appendThinkingPart(key, assistantId, '', { redacted: true })
            break
          case 'tool_start':
            store.startToolPart(key, assistantId, event)
            break
          case 'tool_update':
            store.updateToolPart(key, assistantId, event)
            break
          case 'tool_end':
            store.endToolPart(key, assistantId, event)
            break
          case 'retry_start':
            store.setRetryStatus(key, {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              message: event.message,
            })
            break
          case 'retry_end':
            if (event.success) store.setRetryStatus(key, null)
            break
        }
      }
    })
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
        if (attachment.kind === 'image') continue
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

      const imageAttachments = sessionAttachments
        .filter(
          (attachment): attachment is typeof attachment & { data: string; mimeType: string } =>
            attachment.kind === 'image' &&
            typeof attachment.data === 'string' &&
            typeof attachment.mimeType === 'string'
        )
        .map((attachment) => ({ data: attachment.data, mimeType: attachment.mimeType }))

      const result = await piAgentAPI.chat(
        prompt,
        { onTrace: traceBuffer.push },
        workspacePath,
        sessionId,
        imageAttachments.length > 0 ? imageAttachments : undefined
      )
      // 收尾前按到达顺序输出剩余事件；有 parts 时不会再用最终文本覆盖
      traceBuffer.flush()

      if (result.success && result.response) {
        succeeded = true
        chat.setError(key, null)
        useSessionStore.getState().markError(workspacePath, sessionId, null)
        chat.finishStreamingMessage(key, assistantId, result.response)
        if (result.usage) chat.setMessageUsage(key, assistantId, result.usage)
        if (result.edits && result.edits.length > 0) {
          chat.setMessageEdits(key, assistantId, result.edits)
          // Agent 直接写盘，不经过编辑器 IPC；通知文件树主动刷新
          window.dispatchEvent(new CustomEvent('pi:refresh-files'))
          toast.info(t('agentModifiedFiles', { count: result.edits.length }))
        }
        // 重新生成会产生新的回复分支（R-03）
        void refreshBranches(sessionId)
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
          chat.finishStreamingMessage(key, assistantId)
        }
      }
    } catch (err) {
      traceBuffer.flush()
      const errorMsg = localizeError(err instanceof Error ? err.message : String(err))
      if (stoppedRef.current) {
        chat.setError(key, null)
        chat.finishStreamingMessage(key, assistantId)
      } else {
        chat.setError(key, errorMsg)
        useSessionStore.getState().markError(workspacePath, sessionId, errorMsg)
        chat.finishStreamingMessage(key, assistantId)
      }
    } finally {
      traceBuffer.dispose()
      useChatStore.getState().setLoading(key, false)
      useChatStore.getState().clearAttachments(key)
      useSessionStore.getState().markStreaming(workspacePath, sessionId, false)
      useChatStore.getState().setRetryStatus(key, null)
      void refreshContextUsage(sessionId)
      void refreshSessionStats(sessionId)

      // 本轮结束：自动发送下一条排队消息（用户主动停止时不自动发送）
      const queued = useChatStore
        .getState()
        .conversations[key]?.pending.find((item) => item.behavior === 'queue')
      if (queued && !stoppedRef.current) {
        useChatStore.getState().removePending(key, queued.id)
        forceSendRef.current = true
        window.setTimeout(() => void handleSubmit(undefined, queued.text), 0)
      }
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

  /** 切换 Plan / Act；失败时回滚本地状态 */
  const handleModeChange = async (next: 'plan' | 'act') => {
    const sessionId = activeSessionId
    const key = activeKey
    if (!sessionId || !key || next === mode || isLoading) return
    useChatStore.getState().setMode(key, next)
    const result = await piAgentAPI.sessionsSetMode(workspacePath, sessionId, next)
    if (!result.success) {
      useChatStore.getState().setMode(key, mode)
      toast.error(t('modeSwitchFailed', { error: localizeError(result.error ?? '') }))
    }
  }

  /** Plan 模式下批准计划：切回 Act 并让 Agent 执行 */
  const handleExecutePlan = async () => {
    if (!activeSessionId || !activeKey || isLoading) return
    await handleModeChange('act')
    void handleSubmit(undefined, 'Execute the plan above step by step.')
  }

  /** 读取上下文占用（每轮结束与会话切换后刷新） */
  const refreshContextUsage = useCallback(
    async (sessionId: string) => {
      const key = conversationKey(workspacePath, sessionId)
      const result = await piAgentAPI.getContextUsage(workspacePath, sessionId)
      if (result.success) {
        useChatStore.getState().setContextUsage(key, result.usage ?? null)
      }
    },
    [workspacePath]
  )

  /** 读取会话级模型与思考级别 */
  const refreshSessionSettings = useCallback(
    async (sessionId: string) => {
      const key = conversationKey(workspacePath, sessionId)
      const result = await piAgentAPI.getSessionSettings(workspacePath, sessionId)
      if (result.success) {
        useChatStore.getState().setSessionSettings(key, {
          modelId: result.modelId,
          thinkingLevel: result.thinkingLevel,
        })
      }
    },
    [workspacePath]
  )

  /** 读取会话累计用量并检查预算 */
  const refreshSessionStats = useCallback(
    async (sessionId: string) => {
      const key = conversationKey(workspacePath, sessionId)
      const result = await piAgentAPI.getSessionStats(workspacePath, sessionId)
      if (!result.success || !result.stats) return
      useChatStore.getState().setSessionStats(key, result.stats)
      const budget = useSettingsStore.getState().budgetUsd
      if (budget > 0 && result.stats.cost >= budget && !budgetWarnedRef.current) {
        budgetWarnedRef.current = true
        toast.warning(
          t('budgetExceeded', {
            cost: result.stats.cost.toFixed(2),
            budget: budget.toFixed(2),
          })
        )
      }
    },
    [workspacePath, t]
  )

  useEffect(() => {
    if (!initialized || !activeSessionId) return
    void refreshContextUsage(activeSessionId)
    void refreshSessionSettings(activeSessionId)
    void refreshSessionStats(activeSessionId)
  }, [
    initialized,
    activeSessionId,
    configVersion,
    refreshContextUsage,
    refreshSessionSettings,
    refreshSessionStats,
  ])

  useEffect(() => {
    let cancelled = false
    void api.apiConfigGet().then((result) => {
      if (cancelled || !result.success) return
      setAvailableModels(result.config?.availableModels ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [configVersion])

  const handleModelChange = async (modelId: string) => {
    if (!activeSessionId || !activeKey || !modelId || isLoading) return
    const previous = useChatStore.getState().conversations[activeKey]?.sessionSettings ?? null
    useChatStore
      .getState()
      .setSessionSettings(activeKey, { ...previous, modelId })
    const result = await piAgentAPI.setSessionModel(workspacePath, activeSessionId, modelId)
    if (!result.success) {
      useChatStore.getState().setSessionSettings(activeKey, previous)
      toast.error(t('modelSwitchFailed', { error: localizeError(result.error ?? '') }))
      return
    }
    void refreshContextUsage(activeSessionId)
  }

  const handleThinkingChange = async (level: string) => {
    if (!activeSessionId || !activeKey || !level || isLoading) return
    const previous = useChatStore.getState().conversations[activeKey]?.sessionSettings ?? null
    useChatStore
      .getState()
      .setSessionSettings(activeKey, { ...previous, thinkingLevel: level })
    const result = await piAgentAPI.setSessionThinking(workspacePath, activeSessionId, level)
    if (!result.success) {
      useChatStore.getState().setSessionSettings(activeKey, previous)
      toast.error(t('thinkingSwitchFailed', { error: localizeError(result.error ?? '') }))
    }
  }

  /** 手动压缩上下文；运行中不允许 */
  const handleCompact = async () => {
    if (!activeSessionId || isLoading) return
    const confirmed = await confirmDialog({ message: t('compactConfirm') })
    if (!confirmed) return
    const result = await piAgentAPI.compactContext(workspacePath, activeSessionId)
    if (result.success) {
      toast.info(t('compactDone'))
      void refreshContextUsage(activeSessionId)
    } else {
      toast.error(t('compactFailed', { error: localizeError(result.error ?? '') }))
    }
  }

  /** 会话置顶 / 归档元数据 */
  useEffect(() => {
    let cancelled = false
    if (typeof api.getSessionMeta !== 'function') return
    void api.getSessionMeta(workspacePath).then((result) => {
      if (cancelled || !result.success || !result.meta) return
      setSessionMeta(result.meta)
    })
    return () => {
      cancelled = true
    }
  }, [workspacePath, configVersion])

  const persistSessionMeta = async (next: SessionMeta) => {
    setSessionMeta(next)
    if (typeof api.setSessionMeta !== 'function') return
    const result = await api.setSessionMeta(workspacePath, next)
    if (!result.success) {
      const detail = 'error' in result && typeof result.error === 'string' ? result.error : ''
      toast.error(t('sessionMetaFailed', { error: localizeError(detail) }))
    }
  }

  const togglePin = (session: SessionSummary) => {
    const pinned = sessionMeta.pinned.includes(session.id)
      ? sessionMeta.pinned.filter((id) => id !== session.id)
      : [...sessionMeta.pinned, session.id]
    void persistSessionMeta({ ...sessionMeta, pinned })
  }

  const toggleArchive = (session: SessionSummary) => {
    const archived = sessionMeta.archived.includes(session.id)
      ? sessionMeta.archived.filter((id) => id !== session.id)
      : [...sessionMeta.archived, session.id]
    void persistSessionMeta({ ...sessionMeta, archived })
  }

  /** 导出会话（R-10）：Markdown / HTML / 原始 JSONL，由主进程写盘 */
  const exportSession = async (
    session: SessionSummary,
    format: import('../types/electron').ExportSessionFormat = 'md'
  ) => {
    const result = await piAgentAPI.exportSession(workspacePath, session.id, format, language)
    if (result.success && !result.canceled) {
      toast.info(t('exportDone'))
    } else if (!result.success) {
      toast.error(t('exportFailed', { error: localizeError(result.error ?? '') }))
    }
  }

  /** 读取检查点列表（当前会话） */
  const loadCheckpoints = async () => {
    if (!activeSessionId) return
    const result = await piAgentAPI.listCheckpoints(workspacePath, activeSessionId)
    if (result.success) setCheckpoints(result.checkpoints ?? [])
  }

  /** 回退到检查点；对话回退后重新加载历史 */
  const handleRestoreCheckpoint = async (
    checkpointId: string,
    options: { files?: boolean; conversation?: boolean }
  ) => {
    if (!activeSessionId) return
    const action =
      options.files && options.conversation
        ? t('restoreBoth')
        : options.files
          ? t('restoreCode')
          : t('restoreConversation')
    const confirmed = await confirmDialog({
      message: t('restoreCheckpointConfirm', { action }),
      danger: Boolean(options.files),
    })
    if (!confirmed) return

    const result = await piAgentAPI.restoreCheckpoint(
      workspacePath,
      activeSessionId,
      checkpointId,
      options
    )
    if (!result.success) {
      toast.error(t('restoreCheckpointFailed', { error: localizeError(result.error ?? '') }))
      return
    }
    toast.info(t('restoreCheckpointDone', { count: result.restoredFiles ?? 0 }))
    setShowCheckpoints(false)
    if (options.files) {
      window.dispatchEvent(new CustomEvent('pi:refresh-files'))
    }

    if (options.conversation) {
      const history = await piAgentAPI.getHistory(workspacePath, activeSessionId)
      if (history.success) {
        const key = conversationKey(workspacePath, activeSessionId)
        useChatStore.getState().setMessages(key, history.history ?? [])
        void refreshContextUsage(activeSessionId)
      }
    }
  }

  /** 复制整条消息 */
  const handleCopyMessage = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.info(t('copied'))
    } catch (error) {
      toast.error(t('copyFailed', { error: String(error) }))
    }
  }

  /** 重新生成：回退到最后一条用户消息并重新发送 */
  const handleRetryMessage = async (message: ChatMessage) => {
    if (!activeSessionId || !activeKey || isLoading) return
    const result = await piAgentAPI.rewindLastUser(workspacePath, activeSessionId)
    if (!result.success || !result.text) {
      toast.error(t('retryFailed', { error: localizeError(result.error ?? '') }))
      return
    }
    useChatStore.getState().removeMessage(activeKey, message.id)
    await handleSubmit(undefined, result.text, { skipUserMessage: true })
  }

  /** 切换同一问题的另一条回复（R-03）：只移动会话树，不动工作区文件 */
  const handleSwitchBranch = useCallback(
    async (entryId: string) => {
      if (!activeSessionId || !activeKey || isLoading) return
      const result = await piAgentAPI.switchBranch(workspacePath, activeSessionId, entryId)
      if (!result.success || !result.history) {
        toast.error(t('branchSwitchFailed', { error: localizeError(result.error ?? '') }))
        return
      }
      useChatStore.getState().setMessages(activeKey, result.history)
      await refreshBranches(activeSessionId)
      stickToBottomRef.current = true
    },
    [activeSessionId, activeKey, isLoading, workspacePath, refreshBranches, t]
  )

  /** 编辑最后一条用户消息并重发 */
  const handleEditMessage = async (message: ChatMessage) => {
    if (!activeSessionId || !activeKey || isLoading) return
    const next = await promptDialog({
      title: t('editMessage'),
      message: t('editMessagePrompt'),
      defaultValue: message.content,
      confirmLabel: t('send'),
    })
    if (!next || !next.trim()) return
    const result = await piAgentAPI.rewindLastUser(workspacePath, activeSessionId, next.trim())
    if (!result.success) {
      toast.error(t('retryFailed', { error: localizeError(result.error ?? '') }))
      return
    }
    useChatStore.getState().truncateLastTurn(activeKey)
    await handleSubmit(undefined, next.trim())
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  /** 审批响应：成功即从队列移除并清除会话的待操作标记 */
  const handleApprovalResponse = async (
    requestId: string,
    decision: import('../types/electron').ApprovalDecision
  ) => {
    const result = await piAgentAPI.respondApproval(requestId, decision)
    if (!result.success) {
      toast.error(
        t('approvalRespondFailed', { error: localizeError(result.error ?? '') })
      )
      // 请求可能已超时 / 被中止；无论如何都移除卡片，避免残留
      const stale = useApprovalStore
        .getState()
        .requests.find((item) => item.requestId === requestId)
      useApprovalStore.getState().remove(requestId)
      if (stale) {
        useSessionStore.getState().markNeedsAction(stale.workspaceDir, stale.sessionId, null)
      }
      return
    }
    const request = useApprovalStore
      .getState()
      .requests.find((item) => item.requestId === requestId)
    useApprovalStore.getState().remove(requestId)
    if (request) {
      useSessionStore.getState().markNeedsAction(request.workspaceDir, request.sessionId, null)
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
          <div className="relative">
            <IconButton
              icon={RotateCcw}
              label={t('checkpoints')}
              size="sm"
              active={showCheckpoints}
              onClick={() => {
                const next = !showCheckpoints
                setShowCheckpoints(next)
                if (next) void loadCheckpoints()
              }}
            />
            {showCheckpoints && (
              <div className="absolute right-0 top-full z-20 mt-1 w-80 border border-line bg-raised shadow-print">
                <div className="border-b border-rule-divide px-3 py-1.5 type-label text-ink-muted">
                  {t('checkpoints')}
                </div>
                {checkpoints.length === 0 ? (
                  <div className="px-3 py-2 type-caption text-ink-muted">
                    {t('checkpointsEmpty')}
                  </div>
                ) : (
                  checkpoints.map((checkpoint) => (
                    <div
                      key={checkpoint.id}
                      className="flex flex-col gap-1.5 border-b border-rule-divide px-3 py-2 last:border-b-0"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="type-value text-ink">
                          {new Date(checkpoint.createdAt).toLocaleTimeString()}
                        </span>
                        <span className="type-caption text-ink-muted">
                          {t('checkpointFiles', { count: checkpoint.fileCount })}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            void handleRestoreCheckpoint(checkpoint.id, { files: true })
                          }
                          className="border border-rule-control px-1.5 py-0.5 type-caption text-ink-muted transition-colors hover:text-ink"
                        >
                          {t('restoreCode')}
                        </button>
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() =>
                            void handleRestoreCheckpoint(checkpoint.id, { conversation: true })
                          }
                          className="border border-rule-control px-1.5 py-0.5 type-caption text-ink-muted transition-colors hover:text-ink disabled:opacity-40"
                        >
                          {t('restoreConversation')}
                        </button>
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() =>
                            void handleRestoreCheckpoint(checkpoint.id, {
                              files: true,
                              conversation: true,
                            })
                          }
                          className="border border-rule-control px-1.5 py-0.5 type-caption text-ink-muted transition-colors hover:text-ink disabled:opacity-40"
                        >
                          {t('restoreBoth')}
                        </button>
                      </div>
                    </div>
                  ))
                )}
                <div className="px-3 py-1.5 type-caption text-ink-muted">
                  {t('checkpointBashHint')}
                </div>
              </div>
            )}
          </div>
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
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <EmptyState
                compact
                icon={History}
                title={t('agentChatTitle')}
                description={initialized ? t('agentReadyStatus') : t('agentInitializingStatus')}
              />
              {initialized && activeKey && (
                <div className="flex max-w-md flex-wrap justify-center gap-1.5">
                  {[
                    { label: t('suggestExplain'), prompt: t('suggestExplainPrompt') },
                    { label: t('suggestTodos'), prompt: t('suggestTodosPrompt') },
                    { label: t('suggestTests'), prompt: t('suggestTestsPrompt') },
                  ].map((suggestion) => (
                    <button
                      key={suggestion.label}
                      type="button"
                      onClick={() => {
                        useChatStore.getState().setDraftInput(activeKey, suggestion.prompt)
                        inputRef.current?.focus()
                      }}
                      className="border border-rule-control px-2 py-1 type-caption text-ink-muted transition-colors hover:bg-hover hover:text-ink"
                    >
                      {suggestion.label}
                    </button>
                  ))}
                </div>
              )}
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
                        <ChatMessageRow
                          message={msg}
                          conversationKey={activeKey ?? undefined}
                          diffToolIds={diffToolIds}
                          onOpenDiff={openToolDiff}
                          onCopy={handleCopyMessage}
                          onSwitchBranch={handleSwitchBranch}
                          onOpenToolResult={handleOpenToolResult}
                          onRetry={
                            !isLoading && msg.id === lastMessageId && msg.role === 'assistant'
                              ? () => void handleRetryMessage(msg)
                              : undefined
                          }
                          onEdit={
                            !isLoading && msg.id === lastUserMessageId
                              ? () => void handleEditMessage(msg)
                              : undefined
                          }
                        />
                      </div>
                    )
                  })
                : messages
                    .slice(0, 30)
                    .map((msg) => (
                      <ChatMessageRow
                        key={msg.id}
                        message={msg}
                        conversationKey={activeKey ?? undefined}
                        diffToolIds={diffToolIds}
                        onOpenDiff={openToolDiff}
                        onCopy={handleCopyMessage}
                        onSwitchBranch={handleSwitchBranch}
                        onOpenToolResult={handleOpenToolResult}
                        onRetry={
                          !isLoading && msg.id === lastMessageId && msg.role === 'assistant'
                            ? () => void handleRetryMessage(msg)
                            : undefined
                        }
                        onEdit={
                          !isLoading && msg.id === lastUserMessageId
                            ? () => void handleEditMessage(msg)
                            : undefined
                        }
                      />
                    ))}
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
              <span className="min-w-0 flex-1 leading-relaxed">{fatalError || error}</span>
              <span className="flex flex-shrink-0 items-center gap-2">
                {lastAssistantMessage && !isLoading && (
                  <button
                    type="button"
                    onClick={() => void handleRetryMessage(lastAssistantMessage!)}
                    className="text-ink-muted transition-colors hover:text-ink"
                  >
                    {t('retryMessage')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('open-settings'))}
                  className="text-ink-muted transition-colors hover:text-ink"
                >
                  {t('goToSettings')}
                </button>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Composer */}
      {activeSessionId && (
        <div className="relative h-0 flex-shrink-0">
          {showScrollButton && (
            <button
              type="button"
              onClick={scrollToBottom}
              className="absolute bottom-2 right-4 z-10 flex items-center gap-1 border border-line bg-raised px-2 py-1 type-caption text-ink-muted shadow-print transition-colors hover:text-ink"
            >
              <ArrowDown size={12} />
              {newMessageCount > 0
                ? t('newMessages', { count: newMessageCount })
                : t('scrollToBottom')}
            </button>
          )}
        </div>
      )}
      {activeSessionId && (
        <div className="flex-shrink-0 p-2.5">
          {retryStatus && (
            <div className="mb-2 flex items-center gap-2 type-caption text-warning">
              <Spinner size={10} />
              <span>
                {t('retryInProgress', {
                  attempt: retryStatus.attempt,
                  max: retryStatus.maxAttempts,
                  seconds: Math.max(1, Math.round(retryStatus.delayMs / 1000)),
                })}
              </span>
              {retryStatus.message && (
                <span className="min-w-0 truncate text-ink-muted">{retryStatus.message}</span>
              )}
            </div>
          )}
          {lastAssistantMessage?.parts?.some((part) => part.type === 'tool') && (
            <div className="mb-2">
              <TurnTaskList parts={lastAssistantMessage.parts ?? []} />
            </div>
          )}
          {(contextUsage || sessionStats) && (
            <div className="mb-2 flex items-center gap-2">
              {contextUsage && contextPercent != null && (
                <Meter
                  value={contextPercent}
                  label={t('contextUsageLabel')}
                  tone={
                    contextPercent >= 95
                      ? 'danger'
                      : contextPercent >= 80
                        ? 'warning'
                        : 'accent'
                  }
                  className="flex-1"
                />
              )}
              <DataText
                className={
                  contextPercent != null && contextPercent >= 95
                    ? 'text-danger'
                    : contextPercent != null && contextPercent >= 80
                      ? 'text-warning'
                      : 'text-ink-muted'
                }
              >
                {[
                  contextUsage && contextPercent != null
                    ? `${contextPercent}% · ${
                        contextUsage.tokens != null
                          ? formatTokenCount(contextUsage.tokens)
                          : '—'
                      } / ${formatTokenCount(contextUsage.contextWindow)}`
                    : '',
                  sessionStats
                    ? `${formatTokenCount(sessionStats.tokens)} tok`
                    : '',
                  sessionStats && sessionStats.cost > 0
                    ? `$${sessionStats.cost.toFixed(2)}`
                    : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </DataText>
              <button
                type="button"
                disabled={isLoading}
                onClick={() => void handleCompact()}
                className="type-caption text-ink-muted transition-colors hover:text-ink disabled:opacity-40"
              >
                {t('compactContext')}
              </button>
            </div>
          )}
          {sessionSettings && (
            <div className="mb-2 flex items-center gap-2">
              <Select
                aria-label={t('modelLabel')}
                value={sessionSettings.modelId ?? ''}
                disabled={isLoading}
                onChange={(event) => void handleModelChange(event.target.value)}
                className="h-6 w-44"
              >
                {availableModels.length === 0 && sessionSettings.modelId && (
                  <option value={sessionSettings.modelId}>{sessionSettings.modelId}</option>
                )}
                {availableModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={t('thinkingLabel')}
                value={sessionSettings.thinkingLevel ?? 'medium'}
                disabled={isLoading}
                onChange={(event) => void handleThinkingChange(event.target.value)}
                className="h-6 w-28"
              >
                {THINKING_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {pendingMessages.length > 0 && (
            <div className="mb-2 flex flex-col gap-1.5">
              {pendingMessages.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 border border-rule-hairline bg-raised px-3 py-1.5"
                >
                  {isLoading ? (
                    <button
                      type="button"
                      onClick={() =>
                        activeKey &&
                        useChatStore
                          .getState()
                          .setPendingBehavior(
                            activeKey,
                            item.id,
                            item.behavior === 'queue' ? 'steer' : 'queue'
                          )
                      }
                      className="border border-rule-control px-1.5 py-0.5 type-caption text-ink-muted transition-colors hover:text-ink"
                    >
                      {item.behavior === 'steer' ? t('steerMode') : t('queueMode')}
                    </button>
                  ) : (
                    <span className="type-caption text-ink-muted">
                      {item.behavior === 'steer' ? t('steerMode') : t('queueMode')}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate type-value text-ink" title={item.text}>
                    {item.text}
                  </span>
                  {!isLoading && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!activeKey) return
                        useChatStore.getState().removePending(activeKey, item.id)
                        void handleSubmit(undefined, item.text)
                      }}
                      className="p-0.5 text-ink-muted transition-colors hover:text-ink"
                      aria-label={t('send')}
                    >
                      <Send size={11} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      activeKey && useChatStore.getState().removePending(activeKey, item.id)
                    }
                    className="p-0.5 text-ink-muted transition-colors hover:text-ink"
                    aria-label={t('removePending')}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {mode === 'plan' && !isLoading && messages.some((msg) => msg.role === 'assistant') && (
            <div className="mb-2 flex items-center justify-between gap-2 border border-rule-hairline bg-raised px-3 py-2">
              <span className="type-caption text-ink-muted">{t('planModeHint')}</span>
              <Button size="sm" variant="primary" onClick={() => void handleExecutePlan()}>
                {t('planExecute')}
              </Button>
            </div>
          )}
          {pendingApprovals.length > 0 && (
            <div className="mb-2 flex flex-col gap-2">
              {pendingApprovals.map((request) => (
                <ApprovalCard
                  key={request.requestId}
                  request={request}
                  onRespond={handleApprovalResponse}
                />
              ))}
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
                        className="p-0.5 text-ink-muted hover:text-ink"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  )
                }
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

          {mention && mention.results.length > 0 && (
            <div className="mb-1 max-h-52 overflow-y-auto border border-line bg-raised shadow-print">
              {mention.results.map((file) => (
                <button
                  key={file}
                  type="button"
                  onClick={() => addMention(file)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-data text-ink transition-colors hover:bg-hover"
                >
                  <FileText size={11} className="flex-shrink-0 text-ink-muted" />
                  <span className="truncate">{file}</span>
                </button>
              ))}
            </div>
          )}

          <form
            onSubmit={handleSubmit}
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
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={t('inputPlaceholder')}
              disabled={!initialized}
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
                  onClick={() => {
                    setShowAttachMenu((open) => !open)
                    setAttachMode('files')
                  }}
                />
                {showAttachMenu && activeKey && (
                  <div className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-72 overflow-y-auto border border-line bg-raised py-1 shadow-print">
                    <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span className="type-label text-ink-muted">{t('attachContext')}</span>
                      {currentEditorFile && (
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
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="ml-1 flex items-center border border-rule-control">
                {(['act', 'plan'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    disabled={!initialized || isLoading}
                    onClick={() => void handleModeChange(value)}
                    className={`px-2 py-1 type-caption transition-colors disabled:opacity-40 ${
                      mode === value
                        ? 'bg-active text-ink'
                        : 'text-ink-muted hover:bg-hover hover:text-ink'
                    }`}
                  >
                    {value === 'act' ? t('modeAct') : t('modePlan')}
                  </button>
                ))}
              </div>
              {isLoading && (
                <div className="mr-1 flex items-center border border-rule-control">
                  {(['queue', 'steer'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setPendingBehavior(value)}
                      className={`px-2 py-1 type-caption transition-colors ${
                        pendingBehavior === value
                          ? 'bg-active text-ink'
                          : 'text-ink-muted hover:bg-hover hover:text-ink'
                      }`}
                    >
                      {value === 'queue' ? t('queueMode') : t('steerMode')}
                    </button>
                  ))}
                </div>
              )}
              {isLoading && (
                <Button variant="danger" size="sm" icon={Square} onClick={() => void handleStop()}>
                  {t('stop')}
                </Button>
              )}
              <Button
                type="submit"
                variant="primary"
                size="sm"
                icon={Send}
                disabled={!initialized || !input.trim()}
              >
                {t('send')}
              </Button>
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
        pinnedIds={sessionMeta.pinned}
        archivedIds={sessionMeta.archived}
        showArchived={showArchived}
        onToggleShowArchived={() => setShowArchived((value) => !value)}
        onClose={() => useSessionStore.getState().setPanelOpen(workspacePath, false)}
        onSelect={(session) => void handleSelectSession(session)}
        onNew={() => void handleNewSession()}
        onRename={(session) => void handleRenameSession(session)}
        onDelete={(session) => void handleDeleteSession(session)}
        onTogglePin={togglePin}
        onToggleArchive={toggleArchive}
        onExport={(session, format) => void exportSession(session, format)}
      />

      {toolResultView && (
        <ToolResultViewer
          key={`${toolResultView.sessionId}:${toolResultView.toolCallId}`}
          workspacePath={workspacePath}
          sessionId={toolResultView.sessionId}
          toolCallId={toolResultView.toolCallId}
          toolName={toolResultView.toolName}
          onClose={() => setToolResultView(null)}
        />
      )}
    </div>
  )
}
