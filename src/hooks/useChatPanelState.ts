/**
 * ChatPanel 的 React 编排 Hook：
 * 轮次提交 / 重试 / 插话 / 审批 / 计划 / 工作树切换由纯 TS `chatTurnController` 承载；
 * 输入区草稿、附件、审批栏与底部状态栏各自在子组件内窄订阅，避免击键或菜单切换拖垮整棵聊天树。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  conversationKey,
  useChatStore,
  type ChatMessage,
  type PendingMessage,
} from '../store/chatStore'
import { useSessionStore } from '../store/sessionStore'
import { diffStoreFor } from '../store/diffStore'
import { sameOpenFileTabs, useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { selectionForWorkspace, useSelectionStore } from '../store/selectionStore'
import { api } from '../api'
import {
  getWorkspaceChatImageModels,
  isWorkspaceChatInitialized,
  registerChatSubmitHandler,
  unregisterChatSubmitHandler,
  type ChatSubmitHandler,
} from '../workspace/chatTurnControl'
import { copyText } from '../utils/clipboard'
import { buildChatSuggestions, type WorkspaceType } from '../utils/suggestions'
import { toast } from '../store/toastStore'
import { onAppEvent } from '../utils/appEvents'
import {
  EMPTY_MESSAGES,
  EMPTY_SESSIONS,
  type ChatPanelProps,
} from '../utils/chatPanelShared'
import {
  createChatTurnController,
  type ChatTurnController,
} from '../components/chat/chatTurnController'
import { useChatScroll } from './useChatScroll'
import { useChatSessionConfig } from './useChatSessionConfig'
import { useChatSessions } from './useChatSessions'
import type {
  ApprovalDecision,
  FileEdit,
  PromptTemplateInfo,
  SkillInfo,
  StructuredPlan,
} from '../types/electron'

export function useChatPanelState(props: ChatPanelProps) {
  const { workspacePath, viewRoot, active = true } = props
  const editorRoot = viewRoot ?? workspacePath
  const diffStore = diffStoreFor(editorRoot)

  const { t, language } = useI18nStore(
    useShallow((state) => ({ t: state.t, language: state.language }))
  )

  const { sessions, activeSessionId, panelOpen } = useSessionStore(
    useShallow((state) => {
      const ws = state.byWorkspace[workspacePath]
      return {
        sessions: ws?.sessions ?? EMPTY_SESSIONS,
        activeSessionId: ws?.active ?? null,
        panelOpen: ws?.panelOpen ?? false,
      }
    })
  )

  const activeKey = activeSessionId ? conversationKey(workspacePath, activeSessionId) : null

  const { messages, isLoading, isCompacting, error, sessionSettings } = useChatStore(
    useShallow((state) => {
      const conv = activeKey ? state.conversations[activeKey] : undefined
      return {
        messages: conv?.messages ?? EMPTY_MESSAGES,
        isLoading: conv?.isLoading ?? false,
        isCompacting: conv?.isCompacting ?? false,
        error: conv?.error ?? null,
        sessionSettings: conv?.sessionSettings ?? null,
      }
    })
  )

  const workspaceBusy = useChatStore(
    (state) => (state.busyCountByWorkspace[workspacePath] ?? 0) > 0
  )
  const workspaceBusyRef = useRef(workspaceBusy)
  workspaceBusyRef.current = workspaceBusy

  const { lastAssistantMessage, lastUserMessageId, lastMessageId, latestProposedPlan } =
    useMemo(() => {
      let lastAssistant: ChatMessage | null = null
      let lastUserId: string | null = null
      let proposed: { plan: StructuredPlan; messageId: string } | null = null

      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const msg = messages[index]
        if (!lastAssistant && msg.role === 'assistant') lastAssistant = msg
        if (!lastUserId && msg.role === 'user') lastUserId = msg.id
        if (!proposed && msg.parts) {
          for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = msg.parts[partIndex]
            if (part.type === 'plan' && part.plan.status === 'proposed') {
              proposed = { plan: part.plan, messageId: msg.id }
              break
            }
          }
        }
        if (lastAssistant && lastUserId && proposed) break
      }

      return {
        lastAssistantMessage: lastAssistant,
        lastUserMessageId: lastUserId,
        lastMessageId: messages.length > 0 ? messages[messages.length - 1].id : null,
        latestProposedPlan: proposed,
      }
    }, [messages])

  /** 设置中勾选的支持图片模型，用于能力接口尚未返回时的兜底 */
  const [configuredImageModels, setConfiguredImageModels] = useState<string[]>(() =>
    getWorkspaceChatImageModels(workspacePath)
  )

  // 仅用于空会话建议：sameOpenFileTabs 保证编辑器正文击键绝不触发此处重渲染
  const openFiles = useEditorStore(editorRoot, (state) => state.openFiles, sameOpenFileTabs)
  const currentEditorPath = useEditorStore(editorRoot, (state) => state.currentFile?.path ?? null)

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

  const [initialized, setInitialized] = useState(() => {
    const live = useSessionStore.getState().byWorkspace[workspacePath]
    return (
      isWorkspaceChatInitialized(workspacePath) &&
      Boolean(live && live.open.length > 0 && live.active)
    )
  })
  const [needsApiKey, setNeedsApiKey] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [toolResultView, setToolResultView] = useState<{
    toolCallId: string
    toolName: string
    sessionId: string
  } | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [configVersion, setConfigVersion] = useState(0)
  const [agentReadyVersion, setAgentReadyVersion] = useState(0)
  const pendingConfigReloadRef = useRef(false)

  const promptResourcesRef = useRef<{
    templates: PromptTemplateInfo[]
    skills: SkillInfo[]
  }>({ templates: [], skills: [] })
  const syncPromptResources = useCallback(
    (next: { templates: PromptTemplateInfo[]; skills: SkillInfo[] }) => {
      promptResourcesRef.current = next
    },
    []
  )
  const imageProcessingCountRef = useRef(0)
  const hideAttachMenuRef = useRef<(() => void) | null>(null)

  const handleAgentReady = useCallback(() => {
    setAgentReadyVersion((version) => version + 1)
  }, [])

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const initSeqRef = useRef(0)

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
    onSessionSwitch: () => hideAttachMenuRef.current?.(),
  })

  const {
    availableModels,
    modelCapabilities,
    sessionMeta,
    selectedModelCapability,
    imagesAllowed,
    modelCapabilityText,
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
    return onAppEvent('pi:insert-slash', onInsert)
  }, [activeKey, active])

  // 运行中或压缩中延后到本轮结束后再重建配置（D23）
  useEffect(() => {
    const onConfigSaved = () => {
      if (workspaceBusyRef.current) {
        pendingConfigReloadRef.current = true
        return
      }
      setConfigVersion((version) => version + 1)
    }
    return onAppEvent('api-config-saved', onConfigSaved)
  }, [])

  useEffect(() => {
    if (!workspaceBusy && pendingConfigReloadRef.current) {
      pendingConfigReloadRef.current = false
      setConfigVersion((version) => version + 1)
    }
  }, [workspaceBusy])

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
    return onAppEvent('attach-selection', onAttachSelection)
  }, [activeKey, t, active, workspacePath])

  // 桌面通知点击后激活目标会话
  const pendingActivation = useSessionStore((state) => state.pendingActivation)
  useEffect(() => {
    if (!pendingActivation || pendingActivation.workspaceDir !== workspacePath || !initialized) return
    const target = sessions.find((session) => session.id === pendingActivation.sessionId)
    useSessionStore.getState().clearPendingActivation()
    if (!target) return
    void handleSelectSession(target)
  }, [pendingActivation, initialized, sessions, workspacePath, handleSelectSession])

  // 将可变上下文收束到 ref，保证纯 TS chatTurnController 与对外回调引用稳定
  const runtimeRef = useRef({
    editorRoot,
    activeSessionId,
    availableModels,
    imagesAllowed,
    latestProposedPlan,
    t,
    handleSessionModeChange,
    applySessionPermission,
    handleCompact,
    handleNewSession,
    handleModelChange,
    refreshSessions,
    refreshBranches,
    refreshContextUsage,
    refreshSessionSettings,
    refreshSessionStats,
  })
  runtimeRef.current = {
    editorRoot,
    activeSessionId,
    availableModels,
    imagesAllowed,
    latestProposedPlan,
    t,
    handleSessionModeChange,
    applySessionPermission,
    handleCompact,
    handleNewSession,
    handleModelChange,
    refreshSessions,
    refreshBranches,
    refreshContextUsage,
    refreshSessionSettings,
    refreshSessionStats,
  }

  const turnController = useMemo<ChatTurnController>(
    () =>
      createChatTurnController({
        workspacePath,
        getEditorRoot: () => runtimeRef.current.editorRoot,
        getActiveSessionId: () => runtimeRef.current.activeSessionId,
        getAvailableModels: () => runtimeRef.current.availableModels,
        getImagesAllowed: () => runtimeRef.current.imagesAllowed,
        getImageProcessingCount: () => imageProcessingCountRef.current,
        getPromptResources: () => promptResourcesRef.current,
        setPromptResources: (next) => {
          promptResourcesRef.current = next
        },
        getLatestProposedPlan: () => runtimeRef.current.latestProposedPlan,
        translate: (key, params) => runtimeRef.current.t(key, params),
        onScrollToBottom: () => scrollToBottomRef.current(),
        onStickToBottom: () => {
          stickToBottomRef.current = true
        },
        onFocusInput: () => inputRef.current?.focus(),
        onHideAttachMenu: () => hideAttachMenuRef.current?.(),
        onStoppingChange: setStopping,
        onSessionModeChange: (mode) => runtimeRef.current.handleSessionModeChange(mode),
        onApplySessionPermission: (next) => runtimeRef.current.applySessionPermission(next),
        onCompact: () => runtimeRef.current.handleCompact(),
        onNewSession: () => runtimeRef.current.handleNewSession(),
        onModelChange: (modelId) => runtimeRef.current.handleModelChange(modelId),
        onRefreshSessions: () => runtimeRef.current.refreshSessions(),
        onRefreshBranches: (sid) => runtimeRef.current.refreshBranches(sid),
        onRefreshContextUsage: (sid) => runtimeRef.current.refreshContextUsage(sid),
        onRefreshSessionSettings: (sid) => runtimeRef.current.refreshSessionSettings(sid),
        onRefreshSessionStats: (sid) => runtimeRef.current.refreshSessionStats(sid),
      }),
    [workspacePath, scrollToBottomRef, stickToBottomRef]
  )

  const handleSubmit = useCallback<ChatSubmitHandler>(
    async (e, override, options) => {
      e?.preventDefault()
      await turnController.submitTurn(override, options)
    },
    [turnController]
  )

  useEffect(() => {
    registerChatSubmitHandler(workspacePath, handleSubmit)
    return () => {
      unregisterChatSubmitHandler(workspacePath, handleSubmit)
    }
  }, [workspacePath, handleSubmit])

  const sendSteer = useCallback(
    (sessionId: string, key: string, item: PendingMessage) =>
      turnController.sendSteer(sessionId, key, item),
    [turnController]
  )

  const handleStop = useCallback(() => turnController.stopTurn(), [turnController])

  const handleRejectPlan = useCallback(
    (plan: StructuredPlan) => turnController.rejectPlan(plan),
    [turnController]
  )

  const handleApprovePlan = useCallback(
    (plan: StructuredPlan, targetMode: 'ask' | 'auto') =>
      turnController.approvePlan(plan, targetMode),
    [turnController]
  )

  const handleExecutePlan = useCallback(
    (targetMode: 'ask' | 'auto') => turnController.executePlan(targetMode),
    [turnController]
  )

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

  const handleRetryMessage = useCallback(
    (message: ChatMessage) => turnController.retryMessage(message),
    [turnController]
  )

  const handleSwitchBranch = useCallback(
    (entryId: string) => turnController.switchBranch(entryId),
    [turnController]
  )

  const handleEditMessage = useCallback(
    (message: ChatMessage) => turnController.editMessage(message),
    [turnController]
  )

  const handleApprovalResponse = useCallback(
    (requestId: string, decision: ApprovalDecision) =>
      turnController.respondApproval(requestId, decision),
    [turnController]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
        e.preventDefault()
        void handleSubmit()
      }
    },
    [handleSubmit]
  )

  return {
    activeKey,
    activeSessionId,
    availableModels,
    diffToolIds,
    emptySuggestions,
    error,
    exportSession,
    fatalError,
    handleApprovalResponse,
    handleApprovePlan,
    handleCloseTab,
    handleCompact,
    handleCopyMessage,
    handleDeleteSession,
    handleEditMessage,
    handleExecutePlan,
    handleKeyDown,
    handleModelChange,
    handleNewSession,
    handleOpenToolResult,
    handleRejectPlan,
    handleRenameSession,
    handleResetPermissionGrants,
    handleRetryMessage,
    handleSelectSession,
    handleSessionModeChange,
    handleStop,
    handleSubmit,
    handleSwitchBranch,
    handleThinkingChange,
    handleTranscriptScroll,
    hideAttachMenuRef,
    imageProcessingCountRef,
    imagesAllowed,
    initialized,
    inputRef,
    isCompacting,
    isLoading,
    lastAssistantMessage,
    lastMessageId,
    lastUserMessageId,
    latestProposedPlan,
    messages,
    modelCapabilities,
    modelCapabilityText,
    needsApiKey,
    newMessageCount,
    openToolDiff,
    panelOpen,
    scrollToBottom,
    selectedModelCapability,
    sendSteer,
    sessionMeta,
    sessions,
    setShowArchived,
    setToolResultView,
    showArchived,
    showScrollButton,
    stopping,
    syncPromptResources,
    t,
    toggleArchive,
    togglePin,
    toolResultView,
    transcriptRef,
    turnController,
    virtualizer,
  }
}
