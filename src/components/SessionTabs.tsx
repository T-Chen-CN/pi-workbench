import React from 'react'
import { History, Plus, X } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useSessionStore } from '../store/sessionStore'
import { IconButton } from './ui'
import type { SessionSummary } from '../types/electron'

interface SessionTabsProps {
  workspacePath: string
  sessions: SessionSummary[]
  onSelect: (sessionId: string) => void
  onNew: () => void
  onClose: (sessionId: string) => void
  onOpenList: () => void
}

/** 聊天面板内的会话标签栏；标签只代表“已打开”，会话文件仍在列表里 */
export const SessionTabs: React.FC<SessionTabsProps> = ({
  workspacePath,
  sessions,
  onSelect,
  onNew,
  onClose,
  onOpenList,
}) => {
  const { t } = useI18nStore()
  const state = useSessionStore((store) => store.byWorkspace[workspacePath])
  const streaming = useSessionStore((store) => store.streaming)
  const unread = useSessionStore((store) => store.unread)
  const open = state?.open ?? []
  const active = state?.active ?? null

  const byId = new Map(sessions.map((session) => [session.id, session]))

  return (
    <div className="flex flex-shrink-0 items-stretch border-b border-rule-divide bg-panel">
      <div
        role="tablist"
        aria-label={t('sessions')}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
      >
        {open.map((id) => {
          const session = byId.get(id)
          const key = `${workspacePath}\u0000${id}`
          const isActive = id === active
          const isStreaming = Boolean(streaming[key])
          const isUnread = Boolean(unread[key])
          const title = session?.title?.trim() || t('untitledSession')
          return (
            <div
              key={id}
              className={`group flex h-8 max-w-[190px] flex-shrink-0 items-center gap-1.5 border-r border-rule-divide pl-3 pr-1 type-label transition-colors ${
                isActive
                  ? 'bg-surface text-ink shadow-[inset_0_2px_0_rgb(var(--accent))]'
                  : 'text-ink-muted hover:bg-hover hover:text-ink'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                title={title}
                onClick={() => onSelect(id)}
                className="flex min-w-0 items-center gap-1.5 bg-transparent text-inherit"
              >
                {isStreaming ? (
                  <span className="h-1 w-1 flex-shrink-0 animate-pulse rounded-full bg-accent" />
                ) : isUnread ? (
                  <span className="h-1 w-1 flex-shrink-0 rounded-full bg-accent" />
                ) : null}
                <span className="truncate">{title}</span>
              </button>
              <button
                type="button"
                aria-label={t('closeSessionTab')}
                title={t('closeSessionTab')}
                onClick={(event) => {
                  event.stopPropagation()
                  onClose(id)
                }}
                className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-ink-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X size={10} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex flex-shrink-0 items-center gap-0.5 px-1">
        <IconButton icon={Plus} label={t('newSession')} size="sm" onClick={onNew} />
        <IconButton icon={History} label={t('sessionList')} size="sm" onClick={onOpenList} />
      </div>
    </div>
  )
}
