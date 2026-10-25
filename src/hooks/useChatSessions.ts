/** 会话初始化、标签、历史与增删改 */

import { useCallback, useEffect, type MutableRefObject, type RefObject } from 'react'
import { piAgentAPI } from '../api/piAgentAPI'
import { api } from '../api'
import { conversationKey, useChatStore, type ChatMessage } from '../store/chatStore'
import { MAX_OPEN_SESSIONS, useSessionStore } from '../store/sessionStore'
import { useApprovalStore } from '../store/approvalStore'
import { confirmDialog, promptDialog } from '../store/dialogStore'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import type { TranslationKey, TranslationParams } from '../i18n/translations'
import type { SessionSummary } from '../types/electron'
import { onAppEvent } from '../utils/appEvents'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

export interface ChatSessionsOptions {
  workspacePath: string
  t: Translate
  configVersion: number
  active: boolean
  sessions: SessionSummary[]
  activeSessionId: string | null
  initSeqRef: MutableRefObject<number>
  pendingHydratedRef: MutableRefObject<boolean>
  inputRef: RefObject<HTMLTextAreaElement | null>
  setInitialized: (value: boolean) => void
  setNeedsApiKey: (value: boolean) => void
  setFatalError: (value: string | null) => void
  setConfiguredImageModels: (value: string[]) => void
}

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

export function useChatSessions(options: ChatSessionsOptions) {
  const {
    workspacePath,
    t,
    configVersion,
    active,
    sessions,
    activeSessionId,
    initSeqRef,
    pendingHydratedRef,
    inputRef,
    setInitialized,
    setNeedsApiKey,
    setFatalError,
    setConfiguredImageModels,
  } = options

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
        const pendingWorkspace = useChatStore.getState().pendingDraftWorkspace
        if (
          pending &&
          active &&
          (!pendingWorkspace || pendingWorkspace === workspacePath)
        ) {
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
  }, [workspacePath, loadHistory, persistTabs, t, configVersion, initSeqRef, inputRef, pendingHydratedRef, setConfiguredImageModels, setFatalError, setInitialized, setNeedsApiKey])

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
    if (!active) return
    const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null
    const onNew = () => void handleNewSession()
    const onList = () => useSessionStore.getState().setPanelOpen(workspacePath, true)
    const onRename = () => {
      if (activeSession) void handleRenameSession(activeSession)
    }
    const onDelete = () => {
      if (activeSession) void handleDeleteSession(activeSession)
    }
    const onClose = () => {
      if (activeSessionId) void handleCloseTab(activeSessionId)
    }
    const offNew = onAppEvent('session-new', onNew)
    const offList = onAppEvent('session-list', onList)
    const offRename = onAppEvent('session-rename', onRename)
    const offDelete = onAppEvent('session-delete', onDelete)
    const offClose = onAppEvent('session-close', onClose)
    return () => {
      offNew(); offList(); offRename(); offDelete(); offClose()
    }
  }, [
    active,
    activeSessionId,
    handleCloseTab,
    handleDeleteSession,
    handleNewSession,
    handleRenameSession,
    sessions,
    workspacePath,
  ])


  return {
    persistTabs,
    refreshSessions,
    ensureConversation,
    refreshBranches,
    loadHistory,
    openSessionById,
    handleNewSession,
    handleSelectSession,
    handleCloseTab,
    handleRenameSession,
    handleDeleteSession,
  }
}
