/** ChatPanel 的状态与行为控制器 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  conversationKey,
  useChatStore,
  type ChatMessage,
} from '../store/chatStore'
import { useSessionStore } from '../store/sessionStore'
import { diffStoreFor } from '../store/diffStore'
import { useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { useSelectionStore } from '../store/selectionStore'
import { useApprovalStore } from '../store/approvalStore'
import { useSettingsStore } from '../store/settingsStore'
import { useHostKeydown } from '../panelHost/HostContext'
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
import { formatBytes } from '../utils/formatBytes'
import { SESSION_MODE_ICON } from '../utils/sessionModePresentation'
import { extractSymbols, sliceSymbol, type ExtractedSymbol } from '../utils/symbols'
import { isPathInside, joinPath } from '../utils/filePath'
import { buildChatSuggestions, type WorkspaceType } from '../utils/suggestions'
import {
  ALLOWED_IMAGE_TYPES,
  ImagePrepareError,
  MAX_IMAGE_COUNT,
  MAX_IMAGE_OUTPUT_BYTES,
  MAX_TOTAL_IMAGE_BASE64_CHARS,
  base64ToFile,
  prepareImageFile,
} from '../utils/imageAttachment'
import { toast } from '../store/toastStore'
import { confirmDialog, promptDialog } from '../store/dialogStore'
import { useVirtualRows } from './useVirtualRows'
import {
  distanceFromBottom,
  pinToBottom as pinChatToBottom,
  shouldFollow,
  shouldShowScrollButton,
} from './chatScroll'
import { useChatSessions } from './useChatSessions'
import type {
  SessionSummary,
  SessionMeta,
  ModelCapabilityInfo,
  PromptTemplateInfo,
  SkillInfo,
  StructuredPlan,
  SessionMode,
  SessionPermission,
  FileEdit,
} from '../types/electron'

import type { ChatPanelProps } from '../utils/chatPanelShared'
import { emitAppEvent, onAppEvent } from '../utils/appEvents'
import {
  MAX_ATTACHMENTS,
  MAX_CONTEXT_SNIPPET_CHARS,
  MAX_CONTEXT_TOTAL_CHARS,
  DEFAULT_SESSION_PERMISSION,
  EMPTY_SESSIONS,
  EMPTY_MESSAGES,
  formatTokenCount,
} from '../utils/chatPanelShared'

export function useChatPanelState(props: ChatPanelProps) {
  const { workspacePath, viewRoot, active = true } = props

  const diffStore = diffStoreFor(workspacePath)
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

  const openFiles = useEditorStore(viewRoot ?? workspacePath, (state) => state.openFiles)
  const currentEditorFile = useEditorStore(viewRoot ?? workspacePath, (state) => state.currentFile)

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
  const [sessionMeta, setSessionMeta] = useState<SessionMeta>({ pinned: [], archived: [] })
  const [showArchived, setShowArchived] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [newMessageCount, setNewMessageCount] = useState(0)
  /** 正在预处理（缩放 / 编码）的图片数量 */
  const [imageProcessing, setImageProcessing] = useState(0)
  /** 同一计数的同步镜像：发送路径需要在事件回调里立即判断，不等渲染 */
  const imageProcessingRef = useRef(0)
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
  /** 以下运行期标记按会话区分，避免同工作区并行会话互相影响 */
  const forceSendKeysRef = useRef(new Set<string>())
  const budgetWarnedKeysRef = useRef(new Set<string>())
  const initSeqRef = useRef(0)
  const stickToBottomRef = useRef(true)
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
    setNeedsApiKey,
    setFatalError,
    setConfiguredImageModels,
  })
  const { parentRef: transcriptRef, virtualizer } = useVirtualRows({
    count: messages.length,
    estimateSize: 96,
    overscan: 8,
  })

  /** 贴到滚动容器真实底部（消息列表之外的提示 / 错误块也算在内） */
  const pinToBottom = useCallback(() => {
    const element = transcriptRef.current
    // 容器隐藏时 clientHeight 为 0，写入 scrollTop 会被钳回顶部；等恢复可见再补
    if (!element || element.clientHeight === 0) return
    pinChatToBottom(element)
  }, [transcriptRef])

  /** 回到底部并恢复跟随（发送消息、Alt+↓、点击回底按钮共用） */
  const scrollToBottom = useCallback(() => {
    stickToBottomRef.current = true
    setShowScrollButton(false)
    setNewMessageCount(0)
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
    }
    pinToBottom()
    // 新行首帧只有 estimateSize 占位，measure 完成后总高度会变；下一帧按真实高度再贴一次
    requestAnimationFrame(() => {
      if (!stickToBottomRef.current) return
      pinToBottom()
    })
  }, [messages.length, pinToBottom, virtualizer])

  /** 供挂载 / 尺寸回调等非渲染期执行路径调用，避免闭包过期 */
  const scrollToBottomRef = useRef(scrollToBottom)
  scrollToBottomRef.current = scrollToBottom

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
        const result = await api.searchWorkspaceFiles(viewRoot ?? workspacePath, query, 12)
        if (!result.success) return
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

  const currentSymbols = useMemo(() =>
      currentEditorFile ? extractSymbols(currentEditorFile.content, currentEditorFile.name) : [],
    [currentEditorFile]
  )

  const selectedModelCapability =
    modelCapabilities.find((item) => item.id === sessionSettings?.modelId) ?? null
  const imagesAllowed = selectedModelCapability
    ? selectedModelCapability.vision
    : Boolean(
        sessionSettings?.modelId && configuredImageModels.includes(sessionSettings.modelId)
      )
  /** 模型菜单底部的能力脚注 */
  const modelCapabilityText = selectedModelCapability
    ? selectedModelCapability.available === false
      ? t('modelUnavailableHint')
      : [
          t('modelContextWindow', {
            tokens: formatTokenCount(selectedModelCapability.contextWindow),
          }),
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
      imageProcessingRef.current += 1
      setImageProcessing((count) => count + 1)
      try {
        const existing = useChatStore.getState().conversations[key]?.attachments ?? []
        let imageCount = existing.filter((attachment) => attachment.kind === 'image').length
        // 图片与文件共用同一条消息的总量上限
        let attachmentCount = existing.length
        let totalChars = existing.reduce(
          (total, attachment) =>
            attachment.kind === 'image' ? total + (attachment.data?.length ?? 0) : total,
          0
        )

        for (const file of imageFiles) {
          if (attachmentCount >= MAX_ATTACHMENTS) {
            toast.error(t('attachmentLimit', { count: MAX_ATTACHMENTS }))
            break
          }
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
            attachmentCount += 1
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
        imageProcessingRef.current = Math.max(0, imageProcessingRef.current - 1)
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

  /** 拖入 / 选中的文件统一转成附件：补元信息、去重、守住总量上限 */
  const attachFiles = useCallback(
    (
      key: string,
      files: Array<{
        path: string
        name: string
        size?: number
        mime?: string
        mtime?: number
      }>
    ) => {
      const store = useChatStore.getState()
      const existing = store.conversations[key]?.attachments ?? []
      const seen = new Set(existing.map((attachment) => attachment.path))
      let count = existing.length
      let overflow = false
      for (const file of files) {
        if (count >= MAX_ATTACHMENTS) {
          overflow = true
          break
        }
        if (seen.has(file.path)) continue
        seen.add(file.path)
        count += 1
        store.addAttachment(key, {
          kind: 'file',
          path: file.path,
          name: file.name,
          size: file.size,
          mime: file.mime,
          mtime: file.mtime,
          // 工作区外的文件同样能附加，只在 UI 与 prompt 里标明来源
          external: !isPathInside(viewRoot ?? workspacePath, file.path)
        })
      }
      if (overflow) toast.error(t('attachmentLimit', { count: MAX_ATTACHMENTS }))
    },
    [t, viewRoot, workspacePath]
  )

  /** 原生文件选择：任意位置、任意格式；除图片外只拿路径 */
  const handlePickFiles = async () => {
    setShowAttachMenu(false)
    if (!activeKey) return
    const result = await api.pickAttachments()
    if (!result.success) {
      toast.error(t('attachmentPickFailed'))
      return
    }
    if (result.canceled || result.files.length === 0) return

    // 图片走视觉通道，其余文件只交路径
    const images: File[] = []
    const plain: Array<{ path: string; name: string; size?: number; mime?: string; mtime?: number }> = []
    for (const file of result.files) {
      // 只把视觉通道支持的位图当图片；SVG 之类仍按普通文件交路径
      if (ALLOWED_IMAGE_TYPES.has(file.mime) && file.data) {
        try {
          images.push(base64ToFile(file.data, file.name, file.mime))
          continue
        } catch {
          // 解码失败就退化为普通文件附件
        }
      }
      plain.push({
        path: file.path,
        name: file.name,
        size: file.size,
        mime: file.mime,
        mtime: file.mtime
      })
    }
    attachFiles(activeKey, plain)
    if (images.length > 0) addImageFiles(images)
  }

  /** 拖入文件作为附件 */
  const handleDropFiles = (event: React.DragEvent) => {
    event.preventDefault()
    if (!activeKey) return
    const images: File[] = []
    const plain: Array<{ path: string; name: string; size?: number; mime?: string; mtime?: number }> = []
    for (const file of Array.from(event.dataTransfer.files)) {
      // 只有位图走视觉通道；SVG 等其他图片格式按普通文件附加（模型可读源码）
      if (ALLOWED_IMAGE_TYPES.has(file.type)) {
        images.push(file)
        continue
      }
      const target = api.getPathForFile(file)
      if (!target) continue
      plain.push({
        path: target,
        name: file.name,
        size: file.size,
        mime: file.type || undefined,
        mtime: file.lastModified || undefined
      })
    }
    attachFiles(activeKey, plain)
    if (images.length > 0) addImageFiles(images)
  }

  useEffect(() => {
    const onConfigSaved = () => setConfigVersion((version) => version + 1)
    const offConfig = onAppEvent('api-config-saved', onConfigSaved)
    return () => offConfig()
  }, [])

  // 自动重试期间每 250ms 刷新倒计时；重试结束或失败时状态清空、计时器释放
  useEffect(() => {
    if (!retryStatus) return
    setRetryNow(Date.now())
    const timer = window.setInterval(() => setRetryNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [retryStatus])

  // 激活会话切换时回到最新位置
  useEffect(() => {
    stickToBottomRef.current = true
    const key = activeKey
    if (!key) return
    useSessionStore.getState().markUnread(workspacePath, activeSessionId!, false)
    setShowAttachMenu(false)
  }, [activeKey, activeSessionId, workspacePath])

  // 贴底时才跟随内容增长（流式输出、新消息、列表外的提示块）
  useEffect(() => {
    if (!stickToBottomRef.current || messages.length === 0) return
    virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
    pinToBottom()
    const frame = requestAnimationFrame(() => {
      if (!stickToBottomRef.current) return
      pinToBottom()
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, virtualizer, pinToBottom, activeKey])

  // 容器尺寸变化（面板收起后展开、标签页切回、独立窗口接入、窗口缩放）时补一次贴底：
  // 隐藏期间 clientHeight 为 0，滚动位置无法计算，内容也还在增长；节点搬移还会把 scrollTop 归零
  useEffect(() => {
    const element = transcriptRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    let height = element.clientHeight
    const observer = new ResizeObserver(() => {
      const next = element.clientHeight
      const changed = next !== height
      height = next
      if (changed && next > 0 && stickToBottomRef.current) scrollToBottomRef.current()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [transcriptRef, activeSessionId])

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
    // 布局未就绪（容器隐藏时 clientHeight 为 0）不参与判定，否则会把跟随状态误置为 false
    const distance = distanceFromBottom(element)
    stickToBottomRef.current = shouldFollow(distance)
    setShowScrollButton(shouldShowScrollButton(distance))
    if (stickToBottomRef.current) setNewMessageCount(0)
  }

  useEffect(() => {
    const previous = lastMessageCountRef.current
    lastMessageCountRef.current = messages.length
    if (messages.length > previous && previous > 0 && !stickToBottomRef.current) {
      setNewMessageCount((count) => count + (messages.length - previous))
    }
  }, [messages.length])

  useHostKeydown(
    (event) => {
      if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault()
        scrollToBottom()
      }
    },
    [messages.length],
    active
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [activeSessionId])

  // 命令面板：把当前选区附加到对话
  useEffect(() => {
    if (!active) return
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
    const offAttach = onAppEvent('attach-selection', onAttachSelection)
    return () => offAttach()
  }, [activeKey, t, active])

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

  /** 运行中插话：把消息（含图片）注入当前轮 */
  const sendSteer = async (
    sessionId: string,
    key: string,
    item: import('../store/chatStore').PendingMessage
  ) => {
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
      /** 随本次请求发送的图片；与 consumeAttachments: false 搭配用于重试 / 编辑重发 */
      images?: import('../types/electron').AgentImagePayload[]
      /** 排队重发时带回的文件附件（仅路径与元信息） */
      attachments?: import('../store/chatStore').ChatAttachment[]
      /** 是否把输入框附件带入本次请求；系统触发的发送（重试 / 计划执行 / 排队重发）传 false */
      consumeAttachments?: boolean
    }
  ) => {
    e?.preventDefault()

    const sessionId = activeSessionId
    const key = activeKey
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
    const quoteFile = takeComposerAttachments && chat.conversations[key]?.quoteCurrentFile ? currentEditorFile : null
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

    // 运行中：按设置默认值排队到下一轮，或立即插入当前轮
    if (isLoading && !forceSendKeysRef.current.has(key)) {
      chat.setDraftInput(key, '')
      // 附件随排队项一起带走，否则排队会让本轮附件凭空消失
      const pendingAttachments = composerAttachments.filter(
        (attachment) => attachment.kind !== 'image'
      )
      const item = chat.addPending(key, userMessage, promptImages, pendingAttachments)
      if (useSettingsStore.getState().runWhileBusy === 'steer') {
        void sendSteer(sessionId, key, item)
      }
      return
    }
    // 真正发出这一轮才复位开关：排队期间保留，下一轮仍带上当前文档
    if (takeComposerAttachments && chat.conversations[key]?.quoteCurrentFile) {
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
    if (!options?.skipUserMessage) {
      const attachmentCount = acceptedAttachments.filter(
        (attachment) => attachment.kind !== 'image'
      ).length
      // 发送后气泡要能看到引用 / 附件：与 prompt 使用同一份快照
      const messageContext = attachmentsToMessageContext(
        acceptedAttachments,
        quoteFile ? [{ path: quoteFile.path, name: quoteFile.name }] : []
      )
      chat.addMessage(key, {
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
            // 失败或被取消的压缩不产生分隔线
            if (event.error || event.aborted) break
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
        if (stoppedKeysRef.current.has(key)) {
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
      useChatStore.getState().setLoading(key, false)
      useSessionStore.getState().markStreaming(workspacePath, sessionId, false)
      useChatStore.getState().setRetryStatus(key, null)
      void refreshContextUsage(sessionId)
      void refreshSessionStats(sessionId)

      // 本轮结束：自动发送下一条待发送消息（用户主动停止时不自动发送）
      const queued = useChatStore.getState().conversations[key]?.pending[0]
      if (queued && !stoppedKeysRef.current.has(key)) {
        useChatStore.getState().removePending(key, queued.id)
        forceSendKeysRef.current.add(key)
        // 附件在入队时已转入排队项，重发只带排队项自己的图片
        window.setTimeout(
          () =>
            void handleSubmit(undefined, queued.text, {
              images: queued.images,
              attachments: queued.attachments,
              consumeAttachments: false,
            }),
          0
        )
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

  /** 供稳定的行回调调用，避免把整个 handleSubmit 暴露给消息行 */
  const submitRef = useRef(handleSubmit)
  submitRef.current = handleSubmit

  const handleStop = async () => {
    if (!activeSessionId || stopping) return
    setStopping(true)
    stoppedKeysRef.current.add(conversationKey(workspacePath, activeSessionId))
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
      if (budget > 0 && result.stats.cost >= budget && !budgetWarnedKeysRef.current.has(key)) {
        budgetWarnedKeysRef.current.add(key)
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
      setAvailableModels(
        Array.isArray(result.config?.models)
          ? result.config.models.map((entry) => entry.id)
          : []
      )
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
        images: message.images,
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
    [activeSessionId, activeKey, isLoading, workspacePath, refreshBranches, t]
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
    currentEditorFile,
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
