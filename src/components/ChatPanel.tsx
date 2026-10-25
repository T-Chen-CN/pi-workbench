import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  ArrowDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  History,
  Minimize2,
  PanelRightClose,
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
import {
  SESSION_MODE_ICON,
  SESSION_MODE_ICON_CLASS,
  SESSION_MODE_LABEL_KEY,
  SESSION_MODE_ORDER,
} from '../utils/sessionModePresentation'
import { createTraceBuffer } from '../utils/streamBuffer'
import { revertFileEdit } from '../utils/revertFile'
import { extractSymbols, sliceSymbol, type ExtractedSymbol } from '../utils/symbols'
import { buildChatSuggestions, type WorkspaceType } from '../utils/suggestions'
import { retrySecondsRemaining } from '../utils/retryCountdown'
import {
  ImagePrepareError,
  MAX_IMAGE_COUNT,
  MAX_IMAGE_OUTPUT_BYTES,
  MAX_TOTAL_IMAGE_BASE64_CHARS,
  prepareImageFile,
} from '../utils/imageAttachment'
import { toast } from '../store/toastStore'
import { confirmDialog, promptDialog } from '../store/dialogStore'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { SessionTabs } from './SessionTabs'
import { ChatSessionList } from './ChatSessionList'
import { ApprovalCard } from './ApprovalCard'
import { ToolResultViewer } from './ToolResultViewer'
import { Meter, RingMeter } from './patterns'
import { AgentParts } from './AgentTrace'
import { MarkdownBody, StreamingMarkdown } from './AgentMarkdown'
import {
  Button,
  Caption,
  DataText,
  EmptyState,
  IconButton,
  Label,
  MenuOption,
  PopoverMenu,
  Spinner,
  Textarea,
  Value,
} from './ui'
import type { TranslationKey } from '../i18n/translations'
import type {
  SessionSummary,
  SessionMeta,
  PendingMessagesMap,
  ModelCapabilityInfo,
  PromptTemplateInfo,
  SkillInfo,
  StructuredPlan,
  SessionMode,
  SessionPermission,
  ToolCategory,
} from '../types/electron'

interface ChatPanelProps {
  workspacePath: string
  onCollapse?: () => void
  collapseButtonRef?: React.Ref<HTMLButtonElement>
}

/** 单个附件与单条消息的上下文字符上限 */
const MAX_CONTEXT_FILE_CHARS = 120_000
const MAX_CONTEXT_SNIPPET_CHARS = 40_000
const MAX_CONTEXT_TOTAL_CHARS = 300_000

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

const THINKING_LABEL_KEYS: Record<(typeof THINKING_LEVELS)[number], TranslationKey> = {
  off: 'thinkingOff',
  minimal: 'thinkingMinimal',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXhigh',
  max: 'thinkingMax',
}

const PERMISSION_GRANT_LABEL_KEYS: Record<ToolCategory, TranslationKey> = {
  read: 'approvalCategoryRead',
  write: 'approvalCategoryWrite',
  command: 'approvalCategoryCommand',
  other: 'approvalCategoryOther',
}

const DEFAULT_SESSION_PERMISSION: SessionPermission = { mode: 'ask', grants: [] }

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
/** 用户消息中的图片缩略图；点击打开大图预览（R-08） */
const MessageImages: React.FC<{
  images: Array<{ data: string; mimeType: string }>
}> = ({ images }) => {
  const { t } = useI18nStore()
  const [preview, setPreview] = useState<number | null>(null)

  useEffect(() => {
    if (preview === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreview(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [preview])

  return (
    <>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {images.map((image, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setPreview(index)}
            className="border border-rule-hairline bg-sunken p-1"
            aria-label={t('imagePreviewLabel', { index: index + 1 })}
          >
            <img
              src={`data:${image.mimeType};base64,${image.data}`}
              alt=""
              className="h-32 max-w-[16rem] object-contain"
            />
          </button>
        ))}
      </div>
      {preview !== null &&
        images[preview] &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('imagePreviewLabel', { index: preview + 1 })}
            className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/80 p-6"
            onClick={() => setPreview(null)}
          >
            <img
              src={`data:${images[preview].mimeType};base64,${images[preview].data}`}
              alt=""
              onClick={(event) => event.stopPropagation()}
              className="max-h-full max-w-full object-contain"
            />
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setPreview(null)
              }}
              aria-label={t('close')}
              className="absolute right-4 top-4 border border-rule-control bg-raised p-1.5 text-ink transition-colors hover:text-accent"
            >
              <X size={16} />
            </button>
          </div>,
          document.body
        )}
    </>
  )
}

const ChatMessageRow = React.memo(function ChatMessageRow({
  message,
  diffToolIds,
  onOpenDiff,
  onCopy,
  onRetry,
  onEdit,
  onSwitchBranch,
  onOpenToolResult,
  canActOnPlan,
  onApprovePlan,
  onRejectPlan,
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
  canActOnPlan?: boolean
  onApprovePlan?: (plan: StructuredPlan, targetMode: 'ask' | 'auto') => void
  onRejectPlan?: (plan: StructuredPlan) => void
  conversationKey?: string
}) {
  const { t, language } = useI18nStore()

  if (message.role === 'system') {
    return (
      <div className="flex items-center gap-3 py-2">
        <span className="h-px flex-1 bg-rule-divide" />
        <Caption className="flex-shrink-0 text-ink-muted">{message.content}</Caption>
        <span className="h-px flex-1 bg-rule-divide" />
      </div>
    )
  }

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
          <div className="min-w-0 flex-1">
            <span className="whitespace-pre-wrap">{message.content}</span>
            {message.images && message.images.length > 0 && (
              <MessageImages images={message.images} />
            )}
          </div>
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
              canActOnPlan={canActOnPlan}
              onApprovePlan={onApprovePlan}
              onRejectPlan={onRejectPlan}
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

export const ChatPanel: React.FC<ChatPanelProps> = ({
  workspacePath,
  onCollapse,
  collapseButtonRef,
}) => {
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
  const contextPercentRounded = contextPercent == null ? null : Math.round(contextPercent)
  const contextTone: 'accent' | 'warning' | 'danger' =
    contextPercent == null
      ? 'accent'
      : contextPercent >= 95
        ? 'danger'
        : contextPercent >= 80
          ? 'warning'
          : 'accent'
  const contextTokensText = contextUsage
    ? `${
        contextUsage.tokens != null ? formatTokenCount(contextUsage.tokens) : '—'
      } / ${formatTokenCount(contextUsage.contextWindow)}`
    : '—'
  const contextRemaining =
    contextUsage && contextUsage.tokens != null
      ? Math.max(0, contextUsage.contextWindow - contextUsage.tokens)
      : null
  const sessionSettings = conversation?.sessionSettings ?? null
  const sessionPermission = sessionSettings?.permission ?? DEFAULT_SESSION_PERMISSION
  const SessionModeIcon = SESSION_MODE_ICON[sessionPermission.mode]
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
  /** 模型能力提示（R-06） */
  const [modelCapabilities, setModelCapabilities] = useState<ModelCapabilityInfo[]>([])
  /** 设置中勾选的支持图片模型，用于能力接口尚未返回时的兜底 */
  const [configuredImageModels, setConfiguredImageModels] = useState<string[]>([])
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

  /** 最新一份待批准的计划（R-04）及其所在消息，用于只读计划卡的操作 */
  const latestProposedPlan = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const parts = messages[index].parts ?? []
      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
        const part = parts[partIndex]
        if (part.type === 'plan' && part.plan.status === 'proposed') {
          return { plan: part.plan, messageId: messages[index].id }
        }
      }
    }
    return null
  }, [messages])

  /** 最近一份已批准的计划：驱动“本轮任务” */
  const activePlan = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const parts = messages[index].parts ?? []
      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
        const part = parts[partIndex]
        if (part.type === 'plan' && part.plan.status === 'approved') return part.plan
      }
    }
    return null
  }, [messages])

  const openFiles = useEditorStore((state) => state.openFiles)
  const currentEditorFile = useEditorStore((state) => state.currentFile)
  /** 工作区类型（R-15）：按项目标记文件推断，仅用于空会话建议 */
  const [workspaceType, setWorkspaceType] = useState<WorkspaceType>('unknown')

  useEffect(() => {
    let cancelled = false
    const markers: Array<[string, WorkspaceType]> = [
      ['package.json', 'node'],
      ['pyproject.toml', 'python'],
      ['requirements.txt', 'python'],
      ['Cargo.toml', 'rust'],
      ['go.mod', 'go'],
    ]
    void (async () => {
      for (const [marker, type] of markers) {
        const result = await api.exists(`${workspacePath}/${marker}`)
        if (cancelled) return
        if (result.success && result.exists) {
          setWorkspaceType(type)
          return
        }
      }
      if (!cancelled) setWorkspaceType('unknown')
    })()
    return () => {
      cancelled = true
    }
  }, [workspacePath])

  const recentFiles = useMemo(() => {
    const normalize = (value: string) => value.replace(/\\/g, '/')
    const root = normalize(workspacePath).replace(/\/+$/, '')
    const ordered = [
      ...(currentEditorFile ? [currentEditorFile.path] : []),
      ...[...openFiles].reverse().map((file) => file.path),
    ]
    const seen = new Set<string>()
    const result: string[] = []
    for (const path of ordered) {
      const normalized = normalize(path)
      const relative = normalized.startsWith(`${root}/`)
        ? normalized.slice(root.length + 1)
        : normalized
      if (seen.has(relative)) continue
      seen.add(relative)
      result.push(relative)
      if (result.length >= 3) break
    }
    return result
  }, [openFiles, currentEditorFile, workspacePath])

  const emptySuggestions = useMemo(
    () => buildChatSuggestions({ workspaceType, recentFiles, translate: t }),
    [workspaceType, recentFiles, t]
  )
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
  const [stopping, setStopping] = useState(false)
  /** 输入区状态行当前展开的分段菜单 */
  const [statusMenu, setStatusMenu] = useState<
    'permission' | 'model' | 'thinking' | 'context' | null
  >(null)
  const closeStatusMenu = useCallback(() => setStatusMenu(null), [])
  /** 状态行放不下时收起 token 数字，只留进度条与百分比 */
  const statusStripRef = useRef<HTMLDivElement>(null)
  const contextTokensRef = useRef<HTMLSpanElement>(null)
  const contextTokensWidthRef = useRef(0)
  const [showContextTokens, setShowContextTokens] = useState(true)
  /** 窄宽度下把权限档位文字收成图标，保留可读的 aria-label / title */
  const permissionLabelRef = useRef<HTMLSpanElement>(null)
  const permissionLabelWidthRef = useRef(0)
  const [showPermissionLabel, setShowPermissionLabel] = useState(true)
  useEffect(() => {
    setStatusMenu(null)
  }, [activeSessionId])
  /** 工具结果全量查看（R-20） */
  const [toolResultView, setToolResultView] = useState<{
    toolCallId: string
    toolName: string
    sessionId: string
  } | null>(null)
  const [sessionMeta, setSessionMeta] = useState<SessionMeta>({ pinned: [], archived: [] })
  const [showArchived, setShowArchived] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [newMessageCount, setNewMessageCount] = useState(0)
  /** 正在预处理（缩放 / 编码）的图片数量 */
  const [imageProcessing, setImageProcessing] = useState(0)
  /** 重试倒计时的本地时钟（R-19） */
  const [retryNow, setRetryNow] = useState(() => Date.now())
  const lastMessageCountRef = useRef(0)
  const [mention, setMention] = useState<{
    start: number
    query: string
    results: string[]
  } | null>(null)
  const mentionTimer = useRef<number | null>(null)
  /** 提示模板与技能（R-13） */
  const [promptResources, setPromptResources] = useState<{
    templates: PromptTemplateInfo[]
    skills: SkillInfo[]
  }>({ templates: [], skills: [] })
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

  /** 斜杠菜单：内置命令 + Pi 提示模板 + 技能（R-13） */
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
        setPromptResources({ templates: result.templates ?? [], skills: result.skills ?? [] })
      }
    })
    return () => {
      cancelled = true
    }
  }, [slashActive, workspacePath, activeSessionId])

  // 命令面板插入模板 / 技能时写入输入框（R-13）
  useEffect(() => {
    const onInsert = (event: Event) => {
      if (!activeKey) return
      const insert = (event as CustomEvent<{ insert?: unknown }>).detail?.insert
      if (typeof insert !== 'string' || !insert) return
      useChatStore.getState().setDraftInput(activeKey, insert)
      inputRef.current?.focus()
    }
    window.addEventListener('pi:insert-slash', onInsert)
    return () => window.removeEventListener('pi:insert-slash', onInsert)
  }, [activeKey])

  const currentSymbols = useMemo(() =>
      currentEditorFile ? extractSymbols(currentEditorFile.content, currentEditorFile.name) : [],
    [currentEditorFile]
  )

  const selectedModelCapability =
    modelCapabilities.find((item) => item.id === sessionSettings?.modelId) ?? null
  const imagesAllowed = selectedModelCapability
    ? selectedModelCapability.vision === true
    : Boolean(
        sessionSettings?.modelId && configuredImageModels.includes(sessionSettings.modelId)
      )
  /** 模型菜单底部的能力脚注 */
  const modelCapabilityText = selectedModelCapability
    ? selectedModelCapability.available === false
      ? t('modelUnavailableHint')
      : selectedModelCapability.source === 'default'
        ? t('modelCapabilityUnknown')
        : [
            selectedModelCapability.contextWindow
              ? t('modelContextWindow', {
                  tokens: formatTokenCount(selectedModelCapability.contextWindow),
                })
              : null,
            selectedModelCapability.reasoning ? t('modelSupportsThinking') : t('modelNoThinking'),
            selectedModelCapability.vision ? t('modelSupportsVision') : t('modelNoVision'),
          ]
            .filter(Boolean)
            .join(' · ')
    : null

  /** 文案或档位变化后重新测量，避免沿用旧宽度一直把文字收着 */
  useEffect(() => {
    permissionLabelWidthRef.current = 0
    setShowPermissionLabel(true)
  }, [language, sessionPermission.mode])

  /**
   * 状态行 token 数字自适应：按各段实际宽度判断是否放得下。
   * 放不下就隐藏 token 数字（百分比与进度条始终保留），空间恢复后再显示。
   */
  useLayoutEffect(() => {
    const strip = statusStripRef.current
    if (!strip) return
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 0
      const children = Array.from(strip.children) as HTMLElement[]
      let needed = children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
      if (children.length > 1) needed += gap * (children.length - 1)

      if (showPermissionLabel) {
        const label = permissionLabelRef.current
        if (label) {
          const parent = label.parentElement
          const parentGap = parent
            ? Number.parseFloat(getComputedStyle(parent).columnGap) || 0
            : 0
          permissionLabelWidthRef.current = label.getBoundingClientRect().width + parentGap
        }
      }

      if (showContextTokens) {
        const tokens = contextTokensRef.current
        if (tokens) {
          const parent = tokens.parentElement
          const parentGap = parent
            ? Number.parseFloat(getComputedStyle(parent).columnGap) || 0
            : 0
          contextTokensWidthRef.current = tokens.getBoundingClientRect().width + parentGap
        }
      }

      if (needed > strip.clientWidth + 0.5) {
        // 放不下时先收起上下文 token 数字，再把权限档位文字收成图标
        if (showContextTokens) setShowContextTokens(false)
        else if (showPermissionLabel) setShowPermissionLabel(false)
        return
      }

      if (
        !showPermissionLabel &&
        permissionLabelWidthRef.current > 0 &&
        needed + permissionLabelWidthRef.current <= strip.clientWidth
      ) {
        setShowPermissionLabel(true)
        return
      }

      if (
        !showContextTokens &&
        contextTokensWidthRef.current > 0 &&
        needed + contextTokensWidthRef.current <= strip.clientWidth
      ) {
        setShowContextTokens(true)
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [
    showContextTokens,
    showPermissionLabel,
    sessionSettings,
    contextUsage,
    contextPercentRounded,
    language,
    sessionPermission.mode,
  ])

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

  /** 图像附件：统一预处理（长边 2048）后进入附件区，不写入上下文文本 */
  const addImageFiles = (files: File[]): void => {
    const key = activeKey
    if (!key) return
    if (!imagesAllowed) {
      toast.error(t('modelImageDisabled'))
      return
    }
    const imageFiles = files.filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    void (async () => {
      setImageProcessing((count) => count + 1)
      try {
        const existing = useChatStore.getState().conversations[key]?.attachments ?? []
        let imageCount = existing.filter((attachment) => attachment.kind === 'image').length
        let totalChars = existing.reduce(
          (total, attachment) =>
            attachment.kind === 'image' ? total + (attachment.data?.length ?? 0) : total,
          0
        )

        for (const file of imageFiles) {
          if (imageCount >= MAX_IMAGE_COUNT) {
            toast.error(t('imageLimit', { count: MAX_IMAGE_COUNT }))
            break
          }
          try {
            const prepared = await prepareImageFile(file)
            if (totalChars + prepared.data.length > MAX_TOTAL_IMAGE_BASE64_CHARS) {
              toast.error(t('imageTotalTooLarge'))
              break
            }
            useChatStore.getState().addAttachment(key, {
              kind: 'image',
              path: '',
              name:
                prepared.name ||
                `image-${Date.now()}.${prepared.mimeType.split('/')[1] || 'png'}`,
              mimeType: prepared.mimeType,
              data: prepared.data,
              size: prepared.size,
            })
            imageCount += 1
            totalChars += prepared.data.length
          } catch (error) {
            const code = error instanceof ImagePrepareError ? error.code : 'encodeFailed'
            if (code === 'unsupported') toast.error(t('imageUnsupported'))
            else if (code === 'tooLarge') {
              toast.error(t('imageTooLarge', { size: formatBytes(MAX_IMAGE_OUTPUT_BYTES) }))
            } else if (code === 'tooManyPixels') toast.error(t('imageTooManyPixels'))
            else toast.error(t('imageEncodeFailed'))
          }
        }
      } finally {
        setImageProcessing((count) => Math.max(0, count - 1))
      }
    })()
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
      // 恢复最近一份结构化计划（R-04），已在消息中时不重复追加
      void piAgentAPI.getPlan(workspacePath, session.id).then((result) => {
        if (result.success && result.plan) {
          useChatStore
            .getState()
            .appendPlanMessage(conversationKey(workspacePath, session.id), result.plan)
        }
      })
    },
    [ensureConversation, refreshBranches, workspacePath]
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
        setConfiguredImageModels(
          Array.isArray(configResult.config.imageModels) ? configResult.config.imageModels : []
        )

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

  // 自动重试期间每 250ms 刷新倒计时；重试结束或失败时状态清空、计时器释放
  useEffect(() => {
    if (!retryStatus) return
    setRetryNow(Date.now())
    const timer = window.setInterval(() => setRetryNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [retryStatus])

  // 排队消息变化时写入工作区（R-02）；关闭标签或删除会话后快照里自然不再包含它
  useEffect(() => {
    const prefix = `${workspacePath}\u0000`
    const snapshot = (
      conversations: Record<string, { pending: Array<{ id: string; text: string }> }>
    ): PendingMessagesMap => {
      const sessions: PendingMessagesMap = {}
      for (const [key, conversation] of Object.entries(conversations)) {
        if (!key.startsWith(prefix) || conversation.pending.length === 0) continue
        sessions[key.slice(prefix.length)] = conversation.pending.map(({ id, text }) => ({
          id,
          text,
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
      const approvalPending = useApprovalStore
        .getState()
        .requests.some(
          (request) =>
            request.workspaceDir === workspacePath && request.sessionId === sessionId
        )
      if (streaming || approvalPending) {
        const ok = await confirmDialog({
          title: t('closeSessionTitle'),
          message: t('closeRunningSessionConfirm'),
          confirmLabel: t('continueClose'),
          cancelLabel: t('cancel'),
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
        handleSessionModeChange('plan')
        return true
      case '/act':
        handleSessionModeChange('ask')
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
      default: {
        // 提示模板 / 技能交给 Pi SDK 展开（仍走现有审批）
        let resources = promptResources
        if (
          resources.templates.length === 0 &&
          resources.skills.length === 0 &&
          activeSessionId
        ) {
          const fetched = await piAgentAPI.listPromptResources(workspacePath, activeSessionId)
          if (fetched.success) {
            resources = {
              templates: fetched.templates ?? [],
              skills: fetched.skills ?? [],
            }
            setPromptResources(resources)
          }
        }
        const name = command.slice(1)
        if (
          resources.templates.some(
            (template) => template.name.toLowerCase() === name.toLowerCase()
          )
        ) {
          return false
        }
        if (command.startsWith('/skill:')) {
          const skillName = command.slice('/skill:'.length).toLowerCase()
          if (resources.skills.some((skill) => skill.name.toLowerCase() === skillName)) {
            return false
          }
        }
        toast.error(t('slashUnknownCommand', { command }))
        return true
      }
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

    const imageAttachments = (chat.conversations[key]?.attachments ?? []).filter(
      (attachment) => attachment.kind === 'image'
    )
    if (imageAttachments.length > 0) {
      if (!imagesAllowed) {
        toast.error(t('modelImageDisabled'))
        return
      }
      const totalChars = imageAttachments.reduce(
        (total, attachment) => total + (attachment.data?.length ?? 0),
        0
      )
      if (totalChars > MAX_TOTAL_IMAGE_BASE64_CHARS) {
        toast.error(t('imageTotalTooLarge'))
        return
      }
    }

    // 运行中：按设置默认值排队到下一轮，或立即插入当前轮
    if (isLoading && !forceSendRef.current) {
      chat.setDraftInput(key, '')
      const item = chat.addPending(key, userMessage)
      if (useSettingsStore.getState().runWhileBusy === 'steer') {
        void sendSteer(sessionId, key, item)
      }
      return
    }
    forceSendRef.current = false
    budgetWarnedRef.current = false

    stoppedRef.current = false
    useSessionStore.getState().markError(workspacePath, sessionId, null)
    useSessionStore.getState().markUnread(workspacePath, sessionId, false)
    chat.setDraftInput(key, '')
    if (!options?.skipUserMessage) {
      chat.addMessage(key, {
        role: 'user',
        content: userMessage,
        images:
          imageAttachments.length > 0
            ? imageAttachments.map((attachment) => ({
                data: attachment.data ?? '',
                mimeType: attachment.mimeType ?? 'image/png',
              }))
            : undefined,
      })
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
            // 成功或失败都立即结束倒计时，失败原因由错误条展示（R-19）
            store.setRetryStatus(key, null)
            break
          case 'compaction_start':
            break
          case 'compaction_end': {
            if (event.error) break
            const kind =
              event.reason === 'manual' ? t('compactionManual') : t('compactionAuto')
            store.addMessage(key, {
              role: 'system',
              content:
                typeof event.tokensBefore === 'number'
                  ? t('compactionDividerTokens', {
                      kind,
                      tokens: event.tokensBefore.toLocaleString(),
                    })
                  : t('compactionDivider', { kind }),
            })
            // 压缩后上下文仪表立即回落
            void piAgentAPI.getContextUsage(workspacePath, sessionId).then((result) => {
              if (result.success) {
                useChatStore.getState().setContextUsage(key, result.usage ?? null)
              }
            })
            break
          }
          case 'plan_submitted':
            store.appendPlanPart(key, assistantId, event.plan)
            break
          case 'plan_updated':
            store.applyPlanUpdate(key, event.plan)
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
        // trace 丢失时用结果里的计划兜底（R-04）
        if (result.plan) {
          useChatStore.getState().appendPlanPart(key, assistantId, result.plan)
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

      // 本轮结束：自动发送下一条待发送消息（用户主动停止时不自动发送）
      const queued = useChatStore.getState().conversations[key]?.pending[0]
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
    if (!activeSessionId || stopping) return
    setStopping(true)
    stoppedRef.current = true
    try {
      await piAgentAPI.abort(workspacePath, activeSessionId)
    } finally {
      setStopping(false)
    }
  }

  /** 计划卡拒绝：保留只读计划，不进入执行（R-04） */
  const handleRejectPlan = async (plan: StructuredPlan) => {
    if (!activeSessionId || !activeKey || isLoading) return
    const result = await piAgentAPI.rejectPlan(workspacePath, activeSessionId, plan.id)
    if (!result.success || !result.plan) {
      toast.error(t('planRejectFailed', { error: localizeError(result.error ?? '') }))
      return
    }
    useChatStore.getState().applyPlanUpdate(activeKey, result.plan)
    toast.info(t('planRejected'))
  }

  /** 计划批准：主进程原子完成“批准 + 切换到执行模式”，再按步骤执行 */
  const handleApprovePlan = async (plan: StructuredPlan, targetMode: 'ask' | 'auto') => {
    if (!activeSessionId || !activeKey || isLoading) return
    const result = await piAgentAPI.approvePlan(
      workspacePath,
      activeSessionId,
      plan.id,
      targetMode
    )
    if (!result.success || !result.plan) {
      toast.error(t('planApproveFailed', { error: localizeError(result.error ?? '') }))
      return
    }
    useChatStore.getState().applyPlanUpdate(activeKey, result.plan)
    const previous = useChatStore.getState().conversations[activeKey]?.sessionSettings ?? null
    if (result.permission) {
      useChatStore
        .getState()
        .setSessionSettings(activeKey, { ...previous, permission: result.permission })
    }
    const steps = result.plan.steps
      .map((step, index) => `${index + 1}. ${step.title}`)
      .join('\n')
    void handleSubmit(undefined, t('planExecutePrompt', { steps }))
  }

  /** 计划模式的兜底执行：优先结构化计划，回退到自由文本流程 */
  const handleExecutePlan = async (targetMode: 'ask' | 'auto') => {
    if (!activeSessionId || !activeKey || isLoading) return
    if (latestProposedPlan) {
      await handleApprovePlan(latestProposedPlan.plan, targetMode)
      return
    }
    if (!(await applySessionPermission({ mode: targetMode, grants: [] }))) return
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
          permission: result.permission,
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

  useEffect(() => {
    if (!initialized) return
    let cancelled = false
    void piAgentAPI.getModelCapabilities(workspacePath).then((result) => {
      if (cancelled) return
      if (result.success && result.models) setModelCapabilities(result.models)
    })
    return () => {
      cancelled = true
    }
  }, [initialized, workspacePath, configVersion])

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
    if (selectedModelCapability?.reasoning === false) {
      toast.error(t('modelThinkingUnavailable'))
      return
    }
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

  /** 修改会话模式：模式或额外授权，成功后同步状态行 */
  const applySessionPermission = async (next: SessionPermission): Promise<boolean> => {
    const sessionId = activeSessionId
    const key = activeKey
    if (!sessionId || !key) return false
    const previous = useChatStore.getState().conversations[key]?.sessionSettings ?? null
    useChatStore.getState().setSessionSettings(key, { ...previous, permission: next })
    const result = await piAgentAPI.setSessionPermission(workspacePath, sessionId, next)
    if (!result.success || !result.permission) {
      useChatStore.getState().setSessionSettings(key, previous)
      toast.error(t('permissionSetFailed', { error: localizeError(result.error ?? '') }))
      return false
    }
    useChatStore
      .getState()
      .setSessionSettings(key, { ...previous, permission: result.permission })
    return true
  }

  /** 切换模式会清空本会话的额外授权（后端同样会归一化） */
  const handleSessionModeChange = (nextMode: SessionMode) => {
    if (isLoading) return
    void applySessionPermission({ mode: nextMode, grants: [] })
  }

  const handleResetPermissionGrants = () => {
    const permission = sessionSettings?.permission ?? DEFAULT_SESSION_PERMISSION
    void applySessionPermission({ mode: permission.mode, grants: [] })
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
      // “始终允许”写入会话权限；重新读取以同步状态行里的授权提示
      if (decision.action === 'allow-always' && request.workspaceDir === workspacePath) {
        void refreshSessionSettings(request.sessionId)
      }
    }
  }

  if (needsApiKey) {
    return (
      <div className="flex h-full flex-col bg-panel">
        {onCollapse && (
          <div className="flex h-[38px] flex-shrink-0 items-center gap-2.5 border-b border-rule-divide pl-2 pr-3.5">
            <IconButton
              ref={collapseButtonRef}
              icon={PanelRightClose}
              label={t('collapseChat')}
              size="sm"
              aria-controls="chat-panel"
              aria-expanded
              onClick={onCollapse}
            />
            <h3 className="m-0 type-label text-ink-muted">{t('agentChatTitle')}</h3>
          </div>
        )}
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
      <div
        className={`flex h-[38px] flex-shrink-0 items-center gap-2.5 border-b border-rule-divide pr-3.5 ${
          onCollapse ? 'pl-2' : 'pl-3.5'
        }`}
      >
        {onCollapse && (
          <IconButton
            ref={collapseButtonRef}
            icon={PanelRightClose}
            label={t('collapseChat')}
            size="sm"
            aria-controls="chat-panel"
            aria-expanded
            onClick={onCollapse}
          />
        )}
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
                  {emptySuggestions.map((suggestion) => (
                    <button
                      key={suggestion.id}
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
                          canActOnPlan={
                            !isLoading && msg.id === latestProposedPlan?.messageId
                          }
                          onApprovePlan={handleApprovePlan}
                          onRejectPlan={handleRejectPlan}
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
                        canActOnPlan={
                          !isLoading && msg.id === latestProposedPlan?.messageId
                        }
                        onApprovePlan={handleApprovePlan}
                        onRejectPlan={handleRejectPlan}
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
                {retrySecondsRemaining(retryStatus, retryNow) > 0
                  ? t('retryInProgress', {
                      attempt: retryStatus.attempt,
                      max: retryStatus.maxAttempts,
                      seconds: retrySecondsRemaining(retryStatus, retryNow),
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
          )}
          {activePlan ? (
            <div className="mb-2 flex items-center justify-between gap-2 border border-rule-hairline bg-raised px-3 py-2">
              <Caption className="text-ink-muted">
                {t('planProgress', {
                  done: activePlan.steps.filter((step) => step.status === 'done').length,
                  total: activePlan.steps.length,
                })}
              </Caption>
              <span className="min-w-0 truncate type-caption text-ink">
                {(
                  activePlan.steps.find((step) => step.status === 'in_progress') ??
                  activePlan.steps.find((step) => step.status === 'pending')
                )?.title ?? ''}
              </span>
            </div>
          ) : (
            lastAssistantMessage?.parts?.some((part) => part.type === 'tool') && (
              <div className="mb-2">
                <TurnTaskList parts={lastAssistantMessage.parts ?? []} />
              </div>
            )
          )}
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
                  <span className="min-w-0 flex-1 truncate type-value text-ink" title={item.text}>
                    {item.text}
                  </span>
                  {isLoading ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (!activeKey || !activeSessionId) return
                        void sendSteer(activeSessionId, activeKey, item)
                      }}
                      className="type-caption text-ink-muted transition-colors hover:text-ink"
                    >
                      {t('insertNow')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        if (!activeKey) return
                        useChatStore.getState().removePending(activeKey, item.id)
                        void handleSubmit(undefined, item.text)
                      }}
                      className="p-0.5 text-ink-muted transition-colors hover:text-ink"
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
                    className="p-0.5 text-ink-muted transition-colors hover:text-ink"
                    aria-label={t('removePending')}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {sessionPermission.mode === 'plan' &&
            !isLoading &&
            !latestProposedPlan &&
            messages.some((msg) => msg.role === 'assistant') && (
            <div className="mb-2 flex flex-col gap-2 border border-rule-hairline bg-raised px-3 py-2">
              <span className="type-caption text-ink-muted">{t('planModeHint')}</span>
              <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => void handleExecutePlan('auto')}>
                  {t('planApproveAuto')}
                </Button>
                <Button size="sm" variant="primary" onClick={() => void handleExecutePlan('ask')}>
                  {t('planApproveAsk')}
                </Button>
              </div>
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

          {slashActive && slashItems.length > 0 && (
            <div className="mb-1 max-h-60 overflow-y-auto border border-line bg-raised shadow-print">
              {slashItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => insertSlashItem(item.insert)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-hover"
                >
                  <span className="flex-shrink-0 type-data text-ink">{item.label}</span>
                  <span className="min-w-0 truncate type-caption text-ink-muted">
                    {item.description}
                  </span>
                </button>
              ))}
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
              {isLoading && !input.trim() ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Square}
                  disabled={stopping}
                  className="text-danger hover:bg-danger/10 hover:text-danger [&_svg]:fill-current"
                  onClick={() => void handleStop()}
                >
                  {t('stop')}
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  icon={Send}
                  disabled={!initialized || !input.trim() || imageProcessing > 0}
                >
                  {t('send')}
                </Button>
              )}
            </div>
          </form>
          {(sessionSettings || contextUsage) && (
            <div
              ref={statusStripRef}
              className="mt-1 flex min-w-0 items-center gap-1 whitespace-nowrap"
            >
              {sessionSettings && (
                <span className="relative flex flex-shrink-0 items-center">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={statusMenu === 'permission'}
                    aria-label={t('sessionModeLabel')}
                    disabled={!initialized || isLoading}
                    title={
                      showPermissionLabel
                        ? undefined
                        : t(SESSION_MODE_LABEL_KEY[sessionPermission.mode])
                    }
                    onClick={() =>
                      setStatusMenu((current) => (current === 'permission' ? null : 'permission'))
                    }
                    className={`flex h-6 items-center gap-1 rounded-sm px-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      statusMenu === 'permission'
                        ? 'bg-hover text-ink'
                        : 'text-ink-muted hover:bg-hover hover:text-ink'
                    }`}
                  >
                    <SessionModeIcon
                      size={12}
                      className={SESSION_MODE_ICON_CLASS[sessionPermission.mode]}
                      aria-hidden="true"
                    />
                    {showPermissionLabel && (
                      <span ref={permissionLabelRef} className="type-caption">
                        {t(SESSION_MODE_LABEL_KEY[sessionPermission.mode])}
                      </span>
                    )}
                    <ChevronDown
                      size={10}
                      aria-hidden="true"
                      className={`transition-transform ${
                        statusMenu === 'permission' ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  <PopoverMenu
                    open={statusMenu === 'permission'}
                    onClose={closeStatusMenu}
                    label={t('sessionModeLabel')}
                    className="w-44 py-1"
                  >
                    {SESSION_MODE_ORDER.map((mode) => {
                      const ModeIcon = SESSION_MODE_ICON[mode]
                      return (
                        <MenuOption
                          key={mode}
                          selected={mode === sessionPermission.mode}
                          onSelect={() => {
                            closeStatusMenu()
                            handleSessionModeChange(mode)
                          }}
                        >
                          <span className="flex items-center gap-2">
                            <ModeIcon
                              size={14}
                              className={SESSION_MODE_ICON_CLASS[mode]}
                              aria-hidden="true"
                            />
                            <span>{t(SESSION_MODE_LABEL_KEY[mode])}</span>
                          </span>
                        </MenuOption>
                      )
                    })}
                    {sessionPermission.grants.length > 0 && (
                      <>
                        <div className="mt-1 border-t border-rule-divide px-2.5 pb-1 pt-2">
                          <span className="block type-caption text-ink-muted">
                            {t('permissionGrants', {
                              categories: sessionPermission.grants
                                .map((category) => t(PERMISSION_GRANT_LABEL_KEYS[category]))
                                .join(t('listSeparator')),
                            })}
                          </span>
                        </div>
                        <MenuOption
                          onSelect={() => {
                            closeStatusMenu()
                            handleResetPermissionGrants()
                          }}
                        >
                          {t('permissionResetGrants')}
                        </MenuOption>
                      </>
                    )}
                  </PopoverMenu>
                </span>
              )}
              {sessionSettings && (
                <span className="text-ink-subtle" aria-hidden="true">
                  ·
                </span>
              )}
              {sessionSettings && (
                <span className="relative flex min-w-24 items-center">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={statusMenu === 'model'}
                    aria-label={t('modelLabel')}
                    disabled={isLoading}
                    onClick={() =>
                      setStatusMenu((current) => (current === 'model' ? null : 'model'))
                    }
                    className={`flex h-6 min-w-0 items-center gap-1 rounded-sm px-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      statusMenu === 'model'
                        ? 'bg-hover text-ink'
                        : 'text-ink-muted hover:bg-hover hover:text-ink'
                    }`}
                  >
                    <span className="max-w-28 truncate type-data text-ink">
                      {sessionSettings.modelId ?? '—'}
                    </span>
                    <ChevronDown
                      size={10}
                      aria-hidden="true"
                      className={`transition-transform ${
                        statusMenu === 'model' ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  <PopoverMenu
                    open={statusMenu === 'model'}
                    onClose={closeStatusMenu}
                    label={t('modelLabel')}
                    className="w-56 py-1"
                  >
                    {availableModels.length === 0 && sessionSettings.modelId && (
                      <MenuOption variant="data" selected onSelect={closeStatusMenu}>
                        {sessionSettings.modelId}
                      </MenuOption>
                    )}
                    {availableModels.length > 0 &&
                      sessionSettings.modelId &&
                      !availableModels.includes(sessionSettings.modelId) && (
                        <MenuOption variant="data" selected onSelect={closeStatusMenu}>
                          {sessionSettings.modelId}
                        </MenuOption>
                      )}
                    {availableModels.map((model) => {
                      const capability = modelCapabilities.find((item) => item.id === model)
                      const unavailable = capability?.available === false
                      return (
                        <MenuOption
                          key={model}
                          variant="data"
                          selected={model === sessionSettings.modelId}
                          disabled={unavailable}
                          meta={unavailable ? t('modelUnavailable') : undefined}
                          title={unavailable ? t('modelUnavailableHint') : undefined}
                          onSelect={() => {
                            closeStatusMenu()
                            void handleModelChange(model)
                          }}
                        >
                          {model}
                        </MenuOption>
                      )
                    })}
                    {modelCapabilityText && (
                      <div className="mt-1 border-t border-rule-divide px-2.5 pb-1 pt-2">
                        <Caption className="block text-ink-muted">{modelCapabilityText}</Caption>
                      </div>
                    )}
                  </PopoverMenu>
                </span>
              )}
              {sessionSettings && (
                <span className="text-ink-subtle" aria-hidden="true">
                  ·
                </span>
              )}
              {sessionSettings && (
                <span className="relative flex flex-shrink-0 items-center">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={statusMenu === 'thinking'}
                    aria-label={t('thinkingLabel')}
                    disabled={isLoading || selectedModelCapability?.reasoning === false}
                    title={
                      selectedModelCapability?.reasoning === false
                        ? t('modelThinkingUnavailable')
                        : undefined
                    }
                    onClick={() =>
                      setStatusMenu((current) => (current === 'thinking' ? null : 'thinking'))
                    }
                    className={`flex h-6 items-center gap-1 rounded-sm px-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      statusMenu === 'thinking'
                        ? 'bg-hover text-ink'
                        : 'text-ink-muted hover:bg-hover hover:text-ink'
                    }`}
                  >
                    <span className="type-caption">
                      {t('thinkingLabel')} {t(THINKING_LABEL_KEYS[(sessionSettings.thinkingLevel ?? 'medium') as (typeof THINKING_LEVELS)[number]] ?? 'thinkingMedium')}
                    </span>
                    <ChevronDown
                      size={10}
                      aria-hidden="true"
                      className={`transition-transform ${
                        statusMenu === 'thinking' ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  <PopoverMenu
                    open={statusMenu === 'thinking'}
                    onClose={closeStatusMenu}
                    label={t('thinkingLabel')}
                    className="w-36 py-1"
                  >
                    {THINKING_LEVELS.map((level) => {
                      const supported =
                        !selectedModelCapability ||
                        selectedModelCapability.thinkingLevels.length === 0 ||
                        selectedModelCapability.thinkingLevels.includes(level)
                      return (
                        <MenuOption
                          key={level}
                          selected={level === (sessionSettings.thinkingLevel ?? 'medium')}
                          disabled={!supported}
                          meta={<span className="type-data">{level}</span>}
                          onSelect={() => {
                            closeStatusMenu()
                            void handleThinkingChange(level)
                          }}
                        >
                          {t(THINKING_LABEL_KEYS[level])}
                        </MenuOption>
                      )
                    })}
                  </PopoverMenu>
                </span>
              )}
              {sessionSettings && contextUsage && (
                <span className="text-ink-subtle" aria-hidden="true">
                  ·
                </span>
              )}
              {contextUsage && (
                <span className="relative flex flex-shrink-0 items-center">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={statusMenu === 'context'}
                    aria-label={t('contextUsageLabel')}
                    onClick={() =>
                      setStatusMenu((current) => (current === 'context' ? null : 'context'))
                    }
                    className={`flex h-6 items-center gap-1 rounded-sm px-1 transition-colors ${
                      statusMenu === 'context'
                        ? 'bg-hover text-ink'
                        : 'text-ink-muted hover:bg-hover hover:text-ink'
                    }`}
                  >
                    <RingMeter
                      value={contextPercent}
                      size={14}
                      strokeWidth={2}
                      tone={contextTone}
                      label={t('contextUsageLabel')}
                    />
                    <span
                      className={`type-data ${
                        contextPercent != null && contextPercent >= 95
                          ? 'text-danger'
                          : contextPercent != null && contextPercent >= 80
                            ? 'text-warning'
                            : 'text-ink'
                      }`}
                    >
                      {contextPercentRounded != null ? `${contextPercentRounded}%` : '—'}
                    </span>
                    {showContextTokens && (
                      <span
                        ref={contextTokensRef}
                        className="flex-shrink-0 type-data text-ink-muted"
                      >
                        {contextTokensText} tok
                      </span>
                    )}
                    <ChevronDown
                      size={10}
                      aria-hidden="true"
                      className={`transition-transform ${
                        statusMenu === 'context' ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  <PopoverMenu
                    open={statusMenu === 'context'}
                    onClose={closeStatusMenu}
                    role="dialog"
                    label={t('contextUsageLabel')}
                    className="w-64"
                  >
                    <div className="px-3 pb-2 pt-2.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <Label className="text-ink">{t('contextUsageLabel')}</Label>
                        <Caption className="text-ink-muted">{t('contextScope')}</Caption>
                      </div>
                      <div className="mt-1.5 flex items-baseline justify-between gap-2">
                        <Value className="text-ink">
                          {contextPercentRounded != null
                            ? t('contextUsed', { percent: contextPercentRounded })
                            : '—'}
                        </Value>
                        <DataText className="text-ink-muted">{contextTokensText} tok</DataText>
                      </div>
                      <Meter
                        value={contextPercent ?? 0}
                        label={t('contextUsageLabel')}
                        tone={contextTone}
                        className="mt-2"
                      />
                      <div className="mt-2.5 flex gap-6 border-t border-rule-divide pt-2.5">
                        <div className="flex flex-col gap-0.5">
                          <Caption className="text-ink-muted">{t('contextRemaining')}</Caption>
                          <DataText className="text-ink">
                            {contextRemaining != null
                              ? `${formatTokenCount(contextRemaining)} tok`
                              : '—'}
                          </DataText>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <Caption className="text-ink-muted">{t('contextSessionTotal')}</Caption>
                          <DataText className="text-ink">
                            {sessionStats
                              ? `${formatTokenCount(sessionStats.tokens)} tok${
                                  sessionStats.cost > 0
                                    ? ` · $${sessionStats.cost.toFixed(2)}`
                                    : ''
                                }`
                              : '—'}
                          </DataText>
                        </div>
                      </div>
                      {contextUsage.tokens == null && (
                        <Caption className="mt-2 block text-ink-muted">
                          {t('contextUnknownHint')}
                        </Caption>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={isLoading}
                      onClick={() => {
                        closeStatusMenu()
                        void handleCompact()
                      }}
                      className="flex w-full items-center gap-2 border-t border-rule-divide px-3 py-2 text-left type-value text-ink transition-colors enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Minimize2
                        size={13}
                        aria-hidden="true"
                        className="flex-shrink-0 text-ink-muted"
                      />
                      {t('compactContext')}
                    </button>
                  </PopoverMenu>
                </span>
              )}
            </div>
          )}
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
