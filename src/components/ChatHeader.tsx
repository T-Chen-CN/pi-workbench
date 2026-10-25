/** 聊天面板头部与会话标签栏 */

import React from 'react'
import { PanelRightClose } from 'lucide-react'
import { useSessionStore } from '../store/sessionStore'
import type { SessionSummary } from '../types/electron'
import { IconButton } from './ui'
import { SessionTabs } from './SessionTabs'

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
  handleCloseTab,
}) => (
  <>
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
            aria-controls={panelId}
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

  </>
)
