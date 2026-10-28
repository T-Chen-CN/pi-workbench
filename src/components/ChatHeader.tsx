/** 聊天面板头部与会话标签栏 */

import React from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { SessionSummary } from '../types/electron'
import { SessionTabs } from './SessionTabs'
import { ChatPanelHeader } from './ChatPanelHeader'

export interface ChatHeaderProps {
  onCollapse?: () => void
  collapseButtonRef?: React.Ref<HTMLButtonElement>
  panelId?: string
  t: (key: any) => string
  initialized: boolean
  workspacePath: string
  sessions: SessionSummary[]
  handleSelectSession: (session: SessionSummary) => void | Promise<void>
  handleNewSession: () => void | Promise<void>
  handleCloseTab: (sessionId: string) => void | Promise<void>
}

/** 聊天面板顶部两层：会话头（34px）+ 会话标签栏（34px） */
export const ChatHeader: React.FC<ChatHeaderProps> = ({
  onCollapse,
  collapseButtonRef,
  panelId,
  t,
  initialized,
  workspacePath,
  sessions,
  handleSelectSession,
  handleNewSession,
  handleCloseTab
}) => (
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
      onSelect={(id) => {
        const session = sessions.find((item) => item.id === id)
        if (session) void handleSelectSession(session)
      }}
      onNew={() => void handleNewSession()}
      onClose={(id) => void handleCloseTab(id)}
      onOpenList={() => useSessionStore.getState().setPanelOpen(workspacePath, true)}
    />
  </>
)
