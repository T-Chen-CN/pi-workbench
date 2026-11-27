/** ChatPanel 的状态与行为控制器 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  conversationKey,
  useChatStore,
  type ChatMessage,
} from '../store/chatStore'
import { useSessionStore } from '../store/sessionStore'
import { diffStoreFor } from '../store/diffStore'
import { editorStoreFor, sameOpenFileTabs, useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { selectionForWorkspace, useSelectionStore } from '../store/selectionStore'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useApprovalStore } from '../store/approvalStore'
import { useSettingsStore } from '../store/settingsStore'
import { piAgentAPI } from '../api/piAgentAPI'
import { api } from '../api'
import { buildContextPrompt, CONTEXT_BLOCK_START, type ContextEntry } from '../api/chatContext'
import {
  attachmentsToContextEntries,
  attachmentsToMessageContext,
  contextToAttachments,
} from '../workspace/chatAttachments'
import { localizeError } from '../i18n/errors'
import { createTraceBuffer } from '../utils/streamBuffer'
import { copyText } from '../utils/clipboard'
import { SESSION_MODE_ICON } from '../utils/sessionModePresentation'
import { joinPath } from '../utils/filePath'
import { MAX_TOTAL_IMAGE_BASE64_CHARS } from '../utils/imageAttachment'
import { buildChatSuggestions, type WorkspaceType } from '../utils/suggestions'
import { toast } from '../store/toastStore'
import { confirmDialog, promptDialog } from '../store/dialogStore'
import { useChatAttachments } from './useChatAttachments'
import { useChatScroll } from './useChatScroll'
import { useChatSessionConfig } from './useChatSessionConfig'
import { useChatSessions } from './useChatSessions'
import type {
  PromptTemplateInfo,
  SkillInfo,
  StructuredPlan,
  FileEdit,
} from '../types/electron'

import type { ChatPanelProps } from '../utils/chatPanelShared'
import { emitAppEvent, onAppEvent } from '../utils/appEvents'
import {
  MAX_CONTEXT_SNIPPET_CHARS,
  MAX_CONTEXT_TOTAL_CHARS,
  DEFAULT_SESSION_PERMISSION,
  EMPTY_SESSIONS,
  EMPTY_MESSAGES,
  formatTokenCount,
} from '../utils/chatPanelShared'

export function useChatPanelState(props: ChatPanelProps) {
  const { workspacePath, viewRoot, active = true } = props

  const diffStore = diffStoreFor(viewRoot ?? workspacePath)
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
  const isCompacting = conversation?.isCompacting ?? false
  const pendingMessages = conversation?.pending ?? []
  const contextUsage = conversation?.contextUsage ?? null
  const contextPercent = contextUsage?.percent ?? null
  const contextPercentRounded = contextPercent == null ? null : Math.round(contextPercent)
  const autoCompactAt = contextUsage?.autoCompactPercent ?? 85
  const contextTone: 'accent' | 'warning' | 'danger' =
    contextPercent == null
      ? 'accent'
      : contextPercent >= autoCompactAt
        ? 'danger'
        : contextPercent >= Math.max(0, autoCompactAt - 10)
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
  const quoteCurrentFile = conversation?.quoteCurrentFile ?? false

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

  const editorRoot = viewRoot ?? workspacePath
  const openFiles = useEditorStore(editorRoot, (state) => state.openFiles, sameOpenFileTabs)
  // 只订阅当前文件的身份信息：`currentFile` 对象每次按键都会换身份（内容在里面），
  // 订阅它曾让聊天面板每敲一个字就重渲染一次；内容只在动手那一刻现取（`editorStoreFor`）。
  const currentEditorPath = useEditorStore(editorRoot, (state) => state.currentFile?.path ?? null)
  const currentEditorName = useEditorStore(editorRoot, (state) => state.currentFile?.name ?? '')

  /** 「引用当前文档」开关：只作用于下一次发送，发送后自动复位 */
  const toggleQuoteCurrentFile = useCallback(() => {
    if (!activeKey) return
    const chat = useChatStore.getState()
    chat.setQuoteCurrentFile(activeKey, !(chat.conversations[activeKey]?.quoteCurrentFile ?? false))
  }, [activeKey])
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
      ...(currentEditorPath ? [currentEditorPath] : []),
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
  }, [openFiles, currentEditorPath, workspacePath])

  const emptySuggestions = useMemo(
    () => buildChatSuggestions({ workspaceType, recentFiles, translate: t }),
    [workspaceType, recentFiles, t]
  )
  const selection = useSelectionStore((state) => selectionForWorkspace(state, workspacePath))
  const approvalRequests = useApprovalStore((state) => state.requests)
  const pendingApprovals = useMemo(
    () =>
      approvalRequests.filter(
        (request) =>
          request.workspaceDir === workspacePath && request.sessionId === activeSessionId
      ),
    [approvalRequests, workspacePath, activeSessionId]
  )
  const liveEditsByToolId = useMemo(() => {
    const map = new Map<string, FileEdit>()
    for (const message of messages) {
      for (const edit of message.edits ?? []) {
        if (edit.toolCallId) map.set(edit.toolCallId, edit)
      }
    }
    return map
  }, [messages])
  const liveEditsRef = useRef(liveEditsByToolId)
  liveEditsRef.current = liveEditsByToolId
  // 只在工具 id 集合变化时换新 Set，避免流式输出让所有消息行 memo 失效
  const diffToolSignature = useMemo(
    () => [...liveEditsByToolId.keys()].join('\n'),
    [liveEditsByToolId]
  )
  const diffToolIds = useMemo(
    () => new Set(diffToolSignature ? diffToolSignature.split('\n') : []),
    [diffToolSignature]
  )
  const openToolDiff = useCallback(
    (toolCallId: string) => {
      const edit =
        liveEditsRef.current.get(toolCallId) ??
        diffStore.getState().edits.find((item) => item.toolCallId === toolCallId)
      if (!edit) return
      diffStore.getState().openEdits([edit])
    },
    [diffStore]
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
  const [showArchived, setShowArchived] = useState(false)
  /** 重试倒计时的本地时钟（R-19） */
  const [retryNow, setRetryNow] = useState(() => Date.now())
  const [mention, setMention] = useState<{
    start: number
    query: string
    results: string[]
  } | null>(null)
  const mentionTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (mentionTimer.current) window.clearTimeout(mentionTimer.current)
    },
    []
  )
  /** 提示模板与技能（R-13） */
  const [promptResources, setPromptResources] = useState<{
    templates: PromptTemplateInfo[]
    skills: SkillInfo[]
  }>({ templates: [], skills: [] })
  const [configVersion, setConfigVersion] = useState(0)
  const [agentReadyVersion, setAgentReadyVersion] = useState(0)
  const pendingConfigReloadRef = useRef(false)
  const workspaceBusy = useChatStore((state) => {
    const prefix = `${workspacePath}\u0000`
    return Object.entries(state.conversations).some(
      ([key, conv]) => key.startsWith(prefix) && (conv.isLoading || conv.isCompacting)
    )
  })
  const workspaceBusyRef = useRef(workspaceBusy)
  workspaceBusyRef.current = workspaceBusy
  const handleAgentReady = useCallback(() => {
    setAgentReadyVersion((version) => version + 1)
  }, [])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** 以下运行期标记按会话区分，避免同工作区并行会话互相影响 */
  const forceSendKeysRef = useRef(new Set<string>())
  const initSeqRef = useRef(0)
  const stoppedKeysRef = useRef(new Set<string>())

  const {
    refreshSessions,
    refreshBranches,
    handleNewSession,
    handleSelectSession,
    handleCloseTab,
    handleRenameSession,
    handleDeleteSession,
  } = useChatSessions({
    workspacePath,
    t,
    configVersion,
    active,
    sessions,
    activeSessionId,
    initSeqRef,
    inputRef,
    setInitialized,
    onAgentReady: handleAgentReady,
    setNeedsApiKey,
    setFatalError,
    setConfiguredImageModels,
  })

  const {
    transcriptRef,
    virtualizer,
    stickToBottomRef,
    showScrollButton,
    newMessageCount,
    scrollToBottom,
    scrollToBottomRef,
    handleTranscriptScroll,
  } = useChatScroll({
    messages,
    activeKey,
    activeSessionId,
    workspacePath,
    active,
    onSessionSwitch: () => setShowAttachMenu(false),
  })

  const setDraft = useCallback(
    (value: string) => {
      if (activeKey) useChatStore.getState().setDraftInput(activeKey, value)
    },
    [activeKey]
  )

  /** @ 文件搜索（防抖 + 序号防乱序），避免慢请求结果覆写更新后的输入 */
  const mentionSeqRef = useRef(0)
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
    // 搜索以会话工作树根为基准，附件路径必须落在同一根上（否则 Agent 读不到）
    useChatStore.getState().addAttachment(activeKey, {
      kind: 'file',
      path: joinPath(viewRoot ?? workspacePath, relative),
      name: relative.split('/').pop() || relative
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
    if (!active) return
    const onInsert = (detail: { insert: string }) => {
      if (!activeKey) return
      const insert = detail?.insert
      if (typeof insert !== 'string' || !insert) return
      useChatStore.getState().setDraftInput(activeKey, insert)
      inputRef.current?.focus()
    }
    const offInsert = onAppEvent('pi:insert-slash', onInsert)
    return () => offInsert()
  }, [activeKey, active])

  const {
    availableModels,
    modelCapabilities,
    sessionMeta,
    selectedModelCapability,
    imagesAllowed,
    modelCapabilityText,
    budgetWarnedKeysRef,
    refreshContextUsage,
    refreshSessionSettings,
    refreshSessionStats,
    handleModelChange,
    handleThinkingChange,
    applySessionPermission,
    handleSessionModeChange,
    handleResetPermissionGrants,
    handleCompact,
    togglePin,
    toggleArchive,
    exportSession,
  } = useChatSessionConfig({
    workspacePath,
    activeSessionId,
    activeKey,
    initialized,
    isLoading,
    configVersion: agentReadyVersion,
    sessionSettings,
    configuredImageModels,
    language,
    t,
  })

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
    t,
    setShowAttachMenu,
    setAttachMode,
  })

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

  useEffect(() => {
    const onConfigSaved = () => {
      // 运行中或压缩中延后到本轮结束后再重建，避免打断当前轮（D23）
      if (workspaceBusyRef.current) {
        pendingConfigReloadRef.current = true
        return
      }
      setConfigVersion((version) => version + 1)
    }
    const offConfig = onAppEvent('api-config-saved', onConfigSaved)
    return () => offConfig()
  }, [])

  useEffect(() => {
    if (!workspaceBusy && pendingConfigReloadRef.current) {
      pendingConfigReloadRef.current = false
      setConfigVersion((version) => version + 1)
    }
  }, [workspaceBusy])

  // 自动重试期间每 250ms 刷新倒计时；重试结束或失败时状态清空、计时器释放
  useEffect(() => {
    if (!retryStatus) return
    setRetryNow(Date.now())
    const timer = window.setInterval(() => setRetryNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [retryStatus])

  /** 打开工具结果全量查看器（只读） */
  const handleOpenToolResult = useCallback(
    (toolCallId: string, toolName: string) => {
      if (!activeSessionId) return
      setToolResultView({ toolCallId, toolName, sessionId: activeSessionId })
    },
    [activeSessionId]
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [activeSessionId])

  // 命令面板：把当前选区附加到对话
  useEffect(() => {
    if (!active) return
    const onAttachSelection = () => {
      const key = activeKey
      const current = selectionForWorkspace(useSelectionStore.getState(), workspacePath)
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
    const offAttach = onAppEvent('attach-selection', onAttachSelection)
    return () => offAttach()
  }, [activeKey, t, active, workspacePath])

  // 桌面通知点击后激活目标会话（工作区已由 App 切换）：必须订阅 pendingActivation 并走 handleSelectSession
  const pendingActivation = useSessionStore((state) => state.pendingActivation)
  useEffect(() => {
    if (!pendingActivation || pendingActivation.workspaceDir !== workspacePath || !initialized) return
    const target = sessions.find((session) => session.id === pendingActivation.sessionId)
    useSessionStore.getState().clearPendingActivation()
    if (!target) return
    void handleSelectSession(target)
  }, [pendingActivation, initialized, sessions, workspacePath, handleSelectSession])

  /** 运行中插话：把消息（含图片）注入当前轮 */
  const sendSteer = async (
    sessionId: string,
    key: string,
    item: import('../store/chatStore').PendingMessage
  ) => {
    if (useChatStore.getState().conversations[key]?.isCompacting) return
    // 插话也走同一套上下文块：附件否则会随输入框消费而凭空消失
    const steerEntries = item.attachments ? attachmentsToContextEntries(item.attachments) : []
    const steerText =
      steerEntries.length > 0 ? buildContextPrompt(item.text, steerEntries) : item.text
    const steerContext = item.attachments
      ? attachmentsToMessageContext(item.attachments)
      : undefined
    const result = await piAgentAPI.steer(workspacePath, sessionId, steerText, item.images)
    const chat = useChatStore.getState()
    if (result.success) {
      chat.removePending(key, item.id)
      chat.addMessage(key, {
        role: 'user',
        content: item.text,
        images: item.images && item.images.length > 0 ? item.images : undefined,
        ...(steerContext ? { context: steerContext } : {}),
      })
      // 插话同样会往聊天记录里写一条用户消息，属主动发送：无条件回到最新位置
      scrollToBottomRef.current()
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
    options?: {
      skipUserMessage?: boolean
      /** 后台会话排队出队时显式指定目标会话，避免切会话后串发到当前激活会话 */
      targetSessionId?: string
      /** 随本次请求发送的图片；与 consumeAttachments: false 搭配用于重试 / 编辑重发 */
      images?: import('../types/electron').AgentImagePayload[]
      /** 排队重发时带回的文件附件（仅路径与元信息） */
      attachments?: import('../store/chatStore').ChatAttachment[]
      /** 是否把输入框附件带入本次请求；系统触发的发送（重试 / 计划执行 / 排队重发）传 false */
      consumeAttachments?: boolean
    }
  ) => {
    e?.preventDefault()

    const sessionId = options?.targetSessionId ?? activeSessionId
    const key = sessionId ? conversationKey(workspacePath, sessionId) : activeKey
    const userMessage = (override ?? input).trim()
    if (!sessionId || !key) return
    const takeComposerAttachments = options?.consumeAttachments !== false
    // 输入框图片仍在预处理：此时提交会与正在写入的附件竞争，静默忽略（系统触发的发送不受影响）
    if (takeComposerAttachments && imageProcessingRef.current > 0) return

    const chat = useChatStore.getState()

    // 斜杠命令不进入对话
    if (!options?.skipUserMessage && userMessage.startsWith('/')) {
      chat.setDraftInput(key, '')
      if (await handleSlashCommand(userMessage)) return
    }

    // 附件快照：用户提交时由本轮独占，随后立即从输入框消费
    const composerAttachments =
      takeComposerAttachments
        ? chat.conversations[key]?.attachments ?? []
        : options?.attachments ?? []
    // 「引用当前文档」：开关打开时自动带上正在查看的文件，真正发出后复位
    // （正文现取：渲染时不再订阅 `currentFile` 对象，那会让面板每按键重渲染）
    const quoteFile =
      takeComposerAttachments && chat.conversations[key]?.quoteCurrentFile
        ? editorStoreFor(editorRoot).getState().currentFile
        : null
    const promptImages = takeComposerAttachments
      ? composerAttachments
          .filter((attachment) => attachment.kind === 'image')
          .map((attachment) => ({
            data: attachment.data ?? '',
            mimeType: attachment.mimeType ?? 'image/png',
          }))
          .filter((image) => image.data.length > 0)
      : options?.images ?? []
    // 文件附件只交路径，不占上下文：只有文本与图片都不存在时才算空消息
    const hasFileAttachments = composerAttachments.some((attachment) => attachment.kind !== 'image')

    // 纯图片 / 纯附件消息（无文本）也允许发送
    if (!userMessage && promptImages.length === 0 && !hasFileAttachments) return

    if (promptImages.length > 0) {
      if (!imagesAllowed) {
        toast.error(t('modelImageDisabled'))
        return
      }
      const totalChars = promptImages.reduce((total, image) => total + image.data.length, 0)
      if (totalChars > MAX_TOTAL_IMAGE_BASE64_CHARS) {
        toast.error(t('imageTotalTooLarge'))
        return
      }
    }

    if (takeComposerAttachments && composerAttachments.length > 0) {
      chat.consumeAttachments(
        key,
        composerAttachments.map((attachment) => attachment.id)
      )
    }

    // 运行中：按设置默认值排队到下一轮，或立即插入当前轮（压缩期间暂不插话，等压缩结束再续）
    const targetLoading = Boolean(chat.conversations[key]?.isLoading)
    if (targetLoading && !forceSendKeysRef.current.has(key)) {
      chat.setDraftInput(key, '')
      // 附件随排队项一起带走，否则排队会让本轮附件凭空消失
      const pendingAttachments = composerAttachments.filter(
        (attachment) => attachment.kind !== 'image'
      )
      const item = chat.addPending(key, userMessage, promptImages, pendingAttachments)
      if (
        !useChatStore.getState().conversations[key]?.isCompacting &&
        useSettingsStore.getState().runWhileBusy === 'steer'
      ) {
        void sendSteer(sessionId, key, item)
      }
      return
    }
    // 真正发出这一轮才复位开关：排队期间保留，下一轮仍带上当前文档
    const hadQuoteCurrentFile = Boolean(
      takeComposerAttachments && chat.conversations[key]?.quoteCurrentFile
    )
    if (hadQuoteCurrentFile) {
      chat.setQuoteCurrentFile(key, false)
    }
    forceSendKeysRef.current.delete(key)
    budgetWarnedKeysRef.current.delete(key)

    stoppedKeysRef.current.delete(key)
    useSessionStore.getState().markError(workspacePath, sessionId, null)
    useSessionStore.getState().markUnread(workspacePath, sessionId, false)
    chat.setDraftInput(key, '')
    // 文件附件只交路径与元信息，内容由 Agent 自己的 read / grep 工具读；
    // 选区与划词引用仍内联（它们没有可交给 Agent 的文件语义）。
    // 过滤放在发送前：气泡回显与 prompt 必须用同一份快照（超限的引用不发送也不展示）。
    let snippetChars = 0
    const acceptedAttachments = composerAttachments.filter((attachment) => {
      if (attachment.kind !== 'snippet') return true
      const content = attachment.content ?? ''
      if (!content) return false
      if (content.length > MAX_CONTEXT_SNIPPET_CHARS) {
        toast.error(`${t('contextTooLarge')}: ${attachment.name}`)
        return false
      }
      if (snippetChars + content.length > MAX_CONTEXT_TOTAL_CHARS) {
        toast.error(t('contextTotalTooLarge'))
        return false
      }
      snippetChars += content.length
      return true
    })
    let addedUserMessageId: string | null = null
    if (!options?.skipUserMessage) {
      const attachmentCount = acceptedAttachments.filter(
        (attachment) => attachment.kind !== 'image'
      ).length
      // 发送后气泡要能看到引用 / 附件：与 prompt 使用同一份快照
      const messageContext = attachmentsToMessageContext(
        acceptedAttachments,
        quoteFile ? [{ path: quoteFile.path, name: quoteFile.name }] : []
      )
      addedUserMessageId = chat.addMessage(key, {
        role: 'user',
        // 有引用 / 附件时由气泡里的 chip 表达，不再用占位文案；纯文本除外
        content:
          userMessage ||
          (messageContext
            ? ''
            : attachmentCount > 0
              ? t('attachmentOnlyMessage', { count: attachmentCount })
              : ''),
        images: promptImages.length > 0 ? promptImages : undefined,
        ...(messageContext ? { context: messageContext } : {}),
      })
    }
    setShowAttachMenu(false)
    chat.setLoading(key, true)
    useSessionStore.getState().markStreaming(workspacePath, sessionId, true)
    // 用户主动发送：无论此前提过历史还是被上滑打断，都回到最新位置
    scrollToBottomRef.current()

    const assistantId = chat.startStreamingMessage(key)
    let autoCompacting = false
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
            autoCompacting = true
            store.setCompacting(key, true)
            break
          case 'compaction_end': {
            autoCompacting = false
            store.setCompacting(key, false)
            if (event.error) {
              toast.error(t('compactFailed', { error: localizeError(event.error) }))
              break
            }
            // 被取消的压缩不产生分隔线
            if (event.aborted) break
            store.appendCompactionPart(key, {
              type: 'compaction',
              id: `compaction-${event.entryId ?? event.timestamp ?? Date.now()}`,
              entryId: event.entryId,
              timestamp: event.timestamp ?? Date.now(),
              tokensBefore: event.tokensBefore,
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
    let succeeded = false
    let abortedByCompaction = false

    try {
      const contextEntries: ContextEntry[] = attachmentsToContextEntries(acceptedAttachments)
      // 「引用当前文档」同样只交路径：不受 120k 截断影响，Agent 需要时自己读
      if (quoteFile) {
        contextEntries.push({
          kind: 'file',
          path: quoteFile.path,
          name: quoteFile.name
        })
      }
      // 重试 / 编辑重发会带着记录里已剥过的正文回来；已含上下文块时不得再包一层
      const prompt = userMessage.includes(CONTEXT_BLOCK_START)
        ? userMessage
        : buildContextPrompt(userMessage, contextEntries)

      const result = await piAgentAPI.chat(
        prompt,
        { onTrace: traceBuffer.push },
        workspacePath,
        sessionId,
        promptImages.length > 0 ? promptImages : undefined
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
          emitAppEvent('pi:refresh-files')
          toast.info(t('agentModifiedFiles', { count: result.edits.length }))
        }
        // trace 丢失时用结果里的计划兜底（R-04）
        if (result.plan) {
          useChatStore.getState().appendPlanPart(key, assistantId, result.plan)
        }
      } else if (result.compactionFailed) {
        // 前置手动压缩失败：未发给模型的消息从对话流撤回并退回输入框，失败提醒由压缩流程弹出
        abortedByCompaction = true
        const latestStore = useChatStore.getState()
        if (addedUserMessageId) latestStore.removeMessage(key, addedUserMessageId)
        latestStore.removeMessage(key, assistantId)
        latestStore.setError(key, null)
        useSessionStore.getState().markError(workspacePath, sessionId, null)
        const currentDraft = latestStore.conversations[key]?.draftInput ?? ''
        const restoredDraft = userMessage
          ? currentDraft
            ? `${userMessage}\n${currentDraft}`
            : userMessage
          : currentDraft
        if (restoredDraft !== currentDraft) {
          latestStore.setDraftInput(key, restoredDraft)
        }
        if (takeComposerAttachments && composerAttachments.length > 0) {
          for (const attachment of composerAttachments) {
            latestStore.addAttachment(key, attachment)
          }
        }
        if (hadQuoteCurrentFile) {
          latestStore.setQuoteCurrentFile(key, true)
        }
      } else {
        const errorMessage = describeAgentFailure(result)
        if (stoppedKeysRef.current.has(key)) {
          chat.setError(key, null)
          chat.finishStreamingMessage(key, assistantId)
        } else {
          chat.setError(key, errorMessage)
          useSessionStore.getState().markError(workspacePath, sessionId, errorMessage)
          chat.finishStreamingMessage(key, assistantId)
        }
        // 失败/截断/中止轮次前已落盘的文件修改与用量不能丢弃，仍须展示并通知文件树刷新
        if (result.usage) chat.setMessageUsage(key, assistantId, result.usage)
        if (result.edits && result.edits.length > 0) {
          chat.setMessageEdits(key, assistantId, result.edits)
          emitAppEvent('pi:refresh-files')
        }
      }
      // 轮末以磁盘会话记录（deriveMessages）为单一真相源对账：统一插话位置、context_edit、
      // 多步 usage、压缩点与持久化 entryId，随后再按 entryId 刷新分支分组
      if (!abortedByCompaction) {
        try {
          const synced = await piAgentAPI.sessionsOpen(workspacePath, sessionId)
          if (synced.success && Array.isArray(synced.history) && synced.history.length > 0) {
            useChatStore.getState().reconcileMessages(key, synced.history)
          }
        } catch {
          // 离线/测试替身未实现 sessionsOpen 时保持实时渲染结果
        }
        void refreshBranches(sessionId)
      }
    } catch (err) {
      traceBuffer.flush()
      const errorMsg = localizeError(err instanceof Error ? err.message : String(err))
      if (stoppedKeysRef.current.has(key)) {
        chat.setError(key, null)
        chat.finishStreamingMessage(key, assistantId)
      } else {
        chat.setError(key, errorMsg)
        useSessionStore.getState().markError(workspacePath, sessionId, errorMsg)
        chat.finishStreamingMessage(key, assistantId)
      }
    } finally {
      traceBuffer.dispose()
      if (autoCompacting) {
        useChatStore.getState().setCompacting(key, false)
      }
      useChatStore.getState().setLoading(key, false)
      useSessionStore.getState().markStreaming(workspacePath, sessionId, false)
      useChatStore.getState().setRetryStatus(key, null)
      void refreshContextUsage(sessionId)
      void refreshSessionStats(sessionId)

      // 本轮结束：自动发送下一条待发送消息（用户主动停止或前置压缩失败时不自动发送；走 submitRef 避免陈旧闭包）
      const queued = useChatStore.getState().conversations[key]?.pending[0]
      if (queued && !stoppedKeysRef.current.has(key) && !abortedByCompaction) {
        useChatStore.getState().removePending(key, queued.id)
        forceSendKeysRef.current.add(key)
        // 附件在入队时已转入排队项，重发只带排队项自己的图片与附件
        window.setTimeout(() => {
          const currentOpen = useWorkspaceStore.getState().openWorkspaces
          if (currentOpen.length > 0 && !currentOpen.includes(workspacePath)) return
          void submitRef.current(undefined, queued.text, {
            targetSessionId: sessionId,
            images: queued.images,
            attachments: queued.attachments,
            consumeAttachments: false,
          })
        }, 0)
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
      // 若工作区已关闭，绝不再回写 sessionStore 或触发延迟刷新（避免已关闭工作区回魂）
      const openWorkspaces = useWorkspaceStore.getState().openWorkspaces
      const workspaceStillOpen = openWorkspaces.length === 0 || openWorkspaces.includes(workspacePath)
      if (workspaceStillOpen) {
        const currentMessages = useChatStore.getState().conversations[key]?.messages.length ?? 0
        useSessionStore.getState().updateSession(workspacePath, sessionId, {
          messageCount: currentMessages,
          updatedAt: Date.now(),
        })
        void refreshSessions()
        // 自动标题是异步生成的；稍后再拉一次列表，Web 模式也能显示标题
        window.setTimeout(() => {
          const currentOpen = useWorkspaceStore.getState().openWorkspaces
          if (currentOpen.length > 0 && !currentOpen.includes(workspacePath)) return
          void refreshSessions()
        }, 1500)
      }
    }
  }

  /** 供稳定的行回调调用，避免把整个 handleSubmit 暴露给消息行 */
  const submitRef = useRef(handleSubmit)
  submitRef.current = handleSubmit

  const handleStop = async () => {
    if (!activeSessionId || stopping) return
    const key = conversationKey(workspacePath, activeSessionId)
    // 压缩过程不可终止
    if (useChatStore.getState().conversations[key]?.isCompacting) return
    setStopping(true)
    stoppedKeysRef.current.add(key)
    try {
      await piAgentAPI.abort(workspacePath, activeSessionId)
    } finally {
      setStopping(false)
    }
  }

  /** 计划卡拒绝：保留只读计划，不进入执行（R-04） */
  const handleRejectPlan = useCallback(
    async (plan: StructuredPlan) => {
      if (!activeSessionId || !activeKey || isLoading) return
      const result = await piAgentAPI.rejectPlan(workspacePath, activeSessionId, plan.id)
      if (!result.success || !result.plan) {
        toast.error(t('planRejectFailed', { error: localizeError(result.error ?? '') }))
        return
      }
      useChatStore.getState().applyPlanUpdate(activeKey, result.plan)
      toast.info(t('planRejected'))
    },
    [activeSessionId, activeKey, isLoading, workspacePath, t]
  )

  /** 计划批准：主进程原子完成“批准 + 切换到执行模式”，再按步骤执行 */
  const handleApprovePlan = useCallback(
    async (plan: StructuredPlan, targetMode: 'ask' | 'auto') => {
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
      void submitRef.current(undefined, t('planExecutePrompt', { steps }), {
        consumeAttachments: false,
      })
    },
    [activeSessionId, activeKey, isLoading, workspacePath, t]
  )

  /** 计划模式的兜底执行：优先结构化计划，回退到自由文本流程 */
  const handleExecutePlan = async (targetMode: 'ask' | 'auto') => {
    if (!activeSessionId || !activeKey || isLoading) return
    if (latestProposedPlan) {
      await handleApprovePlan(latestProposedPlan.plan, targetMode)
      return
    }
    if (!(await applySessionPermission({ mode: targetMode, grants: [] }))) return
    void handleSubmit(undefined, t('planExecuteFallback'), { consumeAttachments: false })
  }

  /** 复制整条消息 */
  const handleCopyMessage = useCallback(
    async (text: string) => {
      if (await copyText(text)) {
        toast.info(t('copied'))
      } else {
        toast.error(t('copyFailedPlain'))
      }
    },
    [t]
  )

  /** 重新生成：回退到最后一条用户消息并重新发送 */
  const handleRetryMessage = useCallback(
    async (message: ChatMessage) => {
      if (!activeSessionId || !activeKey || isLoading) return
      const existingMessages = useChatStore.getState().conversations[activeKey]?.messages ?? []
      const msgIndex = existingMessages.findIndex((item) => item.id === message.id)
      // 图片挂在配对的用户消息上而非 assistant 消息上，回退前先取回用户图片避免丢图
      let pairedUserImages = message.images
      for (let i = (msgIndex >= 0 ? msgIndex : existingMessages.length) - 1; i >= 0; i -= 1) {
        if (existingMessages[i].role === 'user') {
          pairedUserImages = existingMessages[i].images ?? pairedUserImages
          break
        }
      }
      const result = await piAgentAPI.rewindLastUser(workspacePath, activeSessionId)
      if (!result.success || !result.text) {
        toast.error(t('retryFailed', { error: localizeError(result.error ?? '') }))
        return
      }
      useChatStore.getState().removeMessage(activeKey, message.id)
      // 重发带上原消息的引用 / 附件：否则「重新生成」会把划词引用静默丢掉
      const restored = result.context ? contextToAttachments(result.context) : []
      await submitRef.current(undefined, result.text, {
        skipUserMessage: true,
        images: pairedUserImages,
        ...(restored.length > 0 ? { attachments: restored } : {}),
        consumeAttachments: false,
      })
    },
    [activeSessionId, activeKey, isLoading, workspacePath, t]
  )

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
    [activeSessionId, activeKey, isLoading, workspacePath, refreshBranches, stickToBottomRef, t]
  )

  /** 编辑最后一条用户消息并重发 */
  const handleEditMessage = useCallback(
    async (message: ChatMessage) => {
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
      const restored = result.context ? contextToAttachments(result.context) : []
      await submitRef.current(undefined, next.trim(), {
        images: message.images,
        ...(restored.length > 0 ? { attachments: restored } : {}),
        consumeAttachments: false,
      })
    },
    [activeSessionId, activeKey, isLoading, workspacePath, t]
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  /** 审批响应：成功即从队列移除，仅当该会话再无待审项时清除红点 */
  const handleApprovalResponse = async (
    requestId: string,
    decision: import('../types/electron').ApprovalDecision
  ) => {
    const clearNeedsActionIfDone = (dir: string, sid: string) => {
      const remaining = useApprovalStore
        .getState()
        .requests.some((item) => item.workspaceDir === dir && item.sessionId === sid)
      if (!remaining) {
        useSessionStore.getState().markNeedsAction(dir, sid, null)
      }
    }
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
      if (stale) clearNeedsActionIfDone(stale.workspaceDir, stale.sessionId)
      return
    }
    const request = useApprovalStore
      .getState()
      .requests.find((item) => item.requestId === requestId)
    useApprovalStore.getState().remove(requestId)
    if (request) {
      clearNeedsActionIfDone(request.workspaceDir, request.sessionId)
      // “始终允许”写入会话权限；重新读取以同步状态行里的授权提示
      if (decision.action === 'allow-always' && request.workspaceDir === workspacePath) {
        void refreshSessionSettings(request.sessionId)
      }
    }
  }

  return {
    SessionModeIcon,
    activeKey,
    activePlan,
    activeSessionId,
    addMention,
    attachMode,
    attachSymbol,
    attachments,
    availableModels,
    closeStatusMenu,
    contextPercent,
    contextPercentRounded,
    contextRemaining,
    contextTokensRef,
    contextTokensText,
    contextTone,
    contextUsage,
    currentEditorName,
    currentEditorPath,
    currentSymbols,
    diffToolIds,
    emptySuggestions,
    error,
    exportSession,
    fatalError,
    handleApprovalResponse,
    handleNewSession,
    handleSelectSession,
    handleCloseTab,
    handleRenameSession,
    handleDeleteSession,
    handleApprovePlan,
    handleCompact,
    handleCopyMessage,
    handleDraftChange,
    handleDropFiles,
    handleEditMessage,
    handleExecutePlan,
    handleKeyDown,
    handleModelChange,
    handleOpenToolResult,
    handlePaste,
    handlePickFiles,
    handleRejectPlan,
    handleResetPermissionGrants,
    handleRetryMessage,
    handleSessionModeChange,
    handleStop,
    handleSubmit,
    handleSwitchBranch,
    handleThinkingChange,
    handleTranscriptScroll,
    imageProcessing,
    initialized,
    input,
    inputRef,
    insertSlashItem,
    isCompacting,
    isLoading,
    lastAssistantMessage,
    lastMessageId,
    lastUserMessageId,
    latestProposedPlan,
    mention,
    messages,
    modelCapabilities,
    modelCapabilityText,
    needsApiKey,
    newMessageCount,
    openFiles,
    openToolDiff,
    panelOpen,
    pendingApprovals,
    pendingMessages,
    quoteCurrentFile,
    toggleQuoteCurrentFile,
    permissionLabelRef,
    retryNow,
    retryStatus,
    scrollToBottom,
    selectedModelCapability,
    selection,
    sendSteer,
    sessionMeta,
    sessionPermission,
    sessionSettings,
    sessionStats,
    sessions,
    setAttachMode,
    setShowArchived,
    setShowAttachMenu,
    setStatusMenu,
    setToolResultView,
    showArchived,
    showAttachMenu,
    showContextTokens,
    showPermissionLabel,
    showScrollButton,
    slashActive,
    slashItems,
    statusMenu,
    statusStripRef,
    stopping,
    t,
    toggleArchive,
    togglePin,
    toolResultView,
    transcriptRef,
    virtualizer,
  }
}

/**
 * 截断类错误用结构化字段 + i18n 生成文案；其余错误走 localizeError。
 * 不在这里给「降低思考强度」之类的建议——思考强度是用户的选择。
 */
function describeAgentFailure(result: {
  error?: string
  errorCode?: 'output-truncated' | 'empty-response'
  outputLimit?: number
  usage?: { output: number; reasoning: number }
}): string {
  const { t } = useI18nStore.getState()
  if (result.errorCode) {
    const limit = (result.outputLimit ?? 0).toLocaleString()
    if (result.errorCode === 'empty-response') {
      return t('agentEmptyResponse', { limit })
    }
    const output = result.usage?.output ?? 0
    const reasoning = result.usage?.reasoning ?? 0
    const body = Math.max(0, output - reasoning)
    return t('agentOutputTruncated', {
      reasoning: reasoning.toLocaleString(),
      body: body.toLocaleString(),
      limit,
    })
  }
  return result.error ? localizeError(result.error) : t('agentResponseFailed')
}
