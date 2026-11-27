/** 聊天面板头部与会话标签栏（窄订阅 + React.memo） */

import React, { useCallback } from 'react'
import { useSessionStore } from '../../store/sessionStore'
import { useI18nStore } from '../../store/i18nStore'
import { EMPTY_SESSIONS } from '../../utils/chatPanelShared'
import type { SessionSummary } from '../../types/electron'
import { SessionTabs } from './SessionTabs'
import { ChatPanelHeader } from './ChatPanelHeader'

export interface ChatHeaderProps {
  onCollapse?: () => void
  collapseButtonRef?: React.Ref<HTMLButtonElement>
  panelId?: string
  t?: (key: any) => string
  initialized: boolean
  workspacePath: string
  /** 可选：不传时自动窄订阅 sessionStore 中当前工作区的会话列表 */
  sessions?: SessionSummary[]
  handleSelectSession: (session: SessionSummary) => void | Promise<void>
  handleNewSession: () => void | Promise<void>
  handleCloseTab: (sessionId: string) => void | Promise<void>
  onOpenList?: () => void
}

/** 聊天面板顶部两层：会话头（34px）+ 会话标签栏（34px） */
export const ChatHeader: React.FC<ChatHeaderProps> = React.memo(function ChatHeader({
  onCollapse,
  collapseButtonRef,
  panelId,
  t: tProp,
  initialized,
  workspacePath,
  sessions: sessionsProp,
  handleSelectSession,
  handleNewSession,
  handleCloseTab,
  onOpenList,
}) {
  const storeT = useI18nStore((state) => state.t)
  const storeSessions = useSessionStore(
    (state) => state.byWorkspace[workspacePath]?.sessions ?? EMPTY_SESSIONS
  )
  const t = tProp ?? storeT
  const sessions = sessionsProp ?? storeSessions

  const handleSelectById = useCallback(
    (id: string) => {
      const session = sessions.find((item) => item.id === id)
      if (session) void handleSelectSession(session)
    },
    [sessions, handleSelectSession]
  )

  const handleNew = useCallback(() => {
    void handleNewSession()
  }, [handleNewSession])

  const handleClose = useCallback(
    (id: string) => {
      void handleCloseTab(id)
    },
    [handleCloseTab]
  )

  const handleOpenList = useCallback(() => {
    if (onOpenList) {
      onOpenList()
      return
    }
    useSessionStore.getState().setPanelOpen(workspacePath, true)
  }, [onOpenList, workspacePath])

  return (
    <>
      <ChatPanelHeader
        onCollapse={onCollapse}
        collapseButtonRef={collapseButtonRef}
        panelId={panelId}
        t={t}
        workspacePath={workspacePath}
        initialized={initialized}
      />

      <SessionTabs
        workspacePath={workspacePath}
        sessions={sessions}
        onSelect={handleSelectById}
        onNew={handleNew}
        onClose={handleClose}
        onOpenList={handleOpenList}
      />
    </>
  )
})
