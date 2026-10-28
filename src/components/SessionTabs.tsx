import React from 'react'
import { AlertCircle, History, Pencil, Plus } from 'lucide-react'
import { conversationKey, useChatStore } from '../store/chatStore'
import { useI18nStore } from '../store/i18nStore'
import { useSessionStore } from '../store/sessionStore'
import { handleTabStripWheel, Tab } from './patterns'
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
  const errors = useSessionStore((store) => store.errors)
  const needsAction = useSessionStore((store) => store.needsAction)
  const conversations = useChatStore((store) => store.conversations)
  const open = state?.open ?? []
  const active = state?.active ?? null

  const byId = new Map(sessions.map((session) => [session.id, session]))
  /** 已打开但还没有标题的会话；多于一个时追加序号，避免多开时无从区分 */
  const untitled = open.filter((id) => !byId.get(id)?.title?.trim())
  const untitledLabel = (id: string) =>
    untitled.length > 1
      ? `${t('untitledSession')} ${untitled.indexOf(id) + 1}`
      : t('untitledSession')

  return (
    <div className="flex h-[34px] flex-shrink-0 items-stretch border-b border-rule-divide bg-panel">
      <div
        role="tablist"
        aria-label={t('sessions')}
        onWheel={handleTabStripWheel}
        className="tab-strip-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto"
      >
        {open.map((id, index) => {
          const session = byId.get(id)
          const key = conversationKey(workspacePath, id)
          const isActive = id === active
          const isStreaming = Boolean(streaming[key])
          const isUnread = Boolean(unread[key])
          const error = errors[key]
          const actionReason = needsAction[key]
          const draft = Boolean(conversations[key]?.draftInput.trim())
          const title = session?.title?.trim() || untitledLabel(id)
          const statusLabel = isStreaming
            ? t('sessionRunning')
            : error
              ? t('sessionError')
              : actionReason
                ? t('sessionNeedsAction')
                : isUnread
                  ? t('sessionUnread')
                  : ''
          const draftLabel = draft ? t('sessionDraft') : ''
          const accessible = [title, statusLabel, draftLabel].filter(Boolean).join(' · ')
          const tooltip = error
            ? `${accessible}：${error.slice(0, 80)}`
            : accessible
          return (
            <Tab
              key={id}
              active={isActive}
              tabbable={isActive || (!active && index === 0)}
              busy={isStreaming}
              ariaLabel={accessible}
              title={tooltip}
              onSelect={() => onSelect(id)}
              onClose={() => onClose(id)}
              closeLabel={t('closeSessionTab')}
              className="max-w-[190px]"
              label={title}
              leading={
                isStreaming ? (
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-accent"
                  />
                ) : error ? (
                  <AlertCircle
                    size={10}
                    className="flex-shrink-0 text-danger"
                    aria-hidden="true"
                  />
                ) : actionReason ? (
                  <span
                    aria-hidden="true"
                    className="relative flex h-1.5 w-1.5 flex-shrink-0 items-center justify-center rounded-full border border-warning shadow-[0_0_0_2px_rgb(var(--warning)_/_0.18)] animate-breathe"
                  >
                    <span className="h-0.5 w-0.5 rounded-full bg-warning" />
                  </span>
                ) : isUnread ? (
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success"
                  />
                ) : (
                  <span className="h-1.5 w-1.5 flex-shrink-0" aria-hidden="true" />
                )
              }
              trailing={
                draft ? (
                  <span
                    aria-label={draftLabel}
                    className="flex flex-shrink-0 items-center text-ink-subtle"
                  >
                    <Pencil size={9} aria-hidden="true" />
                  </span>
                ) : null
              }
            />
          )
        })}
      </div>
      <div className="flex flex-shrink-0 items-center gap-0.5 pl-1 pr-0.5">
        <IconButton icon={Plus} label={t('newSession')} size="sm" onClick={onNew} />
        <IconButton icon={History} label={t('sessionList')} size="sm" onClick={onOpenList} />
      </div>
    </div>
  )
}
