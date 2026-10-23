import React, { useMemo, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  Download,
  History,
  Pencil,
  Pin,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useSessionStore } from '../store/sessionStore'
import { Caption, DataText, EmptyState, IconButton } from './ui'
import { SearchField } from './patterns'
import type { ExportSessionFormat, SessionSummary } from '../types/electron'

interface ChatSessionListProps {
  workspacePath: string
  open: boolean
  sessions: SessionSummary[]
  pinnedIds?: string[]
  archivedIds?: string[]
  showArchived?: boolean
  onToggleShowArchived?: () => void
  onClose: () => void
  onSelect: (session: SessionSummary) => void
  onNew: () => void
  onRename: (session: SessionSummary) => void
  onDelete: (session: SessionSummary) => void
  onTogglePin?: (session: SessionSummary) => void
  onToggleArchive?: (session: SessionSummary) => void
  onExport?: (session: SessionSummary, format: ExportSessionFormat) => void
}

function relativeTime(timestamp: number, language: 'zh' | 'en'): string {
  const diff = Date.now() - timestamp
  const minutes = Math.max(1, Math.round(diff / 60_000))
  const formatter = new Intl.RelativeTimeFormat(language === 'zh' ? 'zh-CN' : 'en', {
    numeric: 'auto',
  })
  if (minutes < 60) return formatter.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 24) return formatter.format(-hours, 'hour')
  const days = Math.round(hours / 24)
  if (days < 30) return formatter.format(-days, 'day')
  return new Date(timestamp).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')
}

/** 聊天列内的会话列表抽屉：搜索、置顶、归档、导出、打开/重命名/删除 */
export const ChatSessionList: React.FC<ChatSessionListProps> = ({
  workspacePath,
  open,
  sessions,
  pinnedIds = [],
  archivedIds = [],
  showArchived = false,
  onToggleShowArchived = () => {},
  onClose,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onTogglePin = () => {},
  onToggleArchive = () => {},
  onExport = () => {},
}) => {
  const { t, language } = useI18nStore()
  const state = useSessionStore((store) => store.byWorkspace[workspacePath])
  const streaming = useSessionStore((store) => store.streaming)
  const openIds = state?.open ?? []
  const activeId = state?.active ?? null
  const [query, setQuery] = useState('')
  const [exportMenuId, setExportMenuId] = useState<string | null>(null)

  const visibleSessions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sessions
      .filter((session) => showArchived || !archivedIds.includes(session.id))
      .filter((session) => {
        if (!needle) return true
        const title = session.title?.trim().toLowerCase() ?? ''
        return title.includes(needle) || session.id.toLowerCase().includes(needle)
      })
      .sort((a, b) => {
        const aPinned = pinnedIds.includes(a.id) ? 1 : 0
        const bPinned = pinnedIds.includes(b.id) ? 1 : 0
        return bPinned - aPinned
      })
  }, [sessions, query, showArchived, archivedIds, pinnedIds])

  if (!open) return null

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-panel">
      <div className="flex h-[38px] flex-shrink-0 items-center justify-between border-b border-rule-divide px-3">
        <div className="flex items-center gap-2">
          <History size={13} className="text-ink-muted" aria-hidden="true" />
          <h3 className="m-0 type-label text-ink">{t('sessions')}</h3>
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            icon={showArchived ? ArchiveRestore : Archive}
            label={showArchived ? t('hideArchived') : t('showArchived')}
            size="sm"
            active={showArchived}
            onClick={onToggleShowArchived}
          />
          <IconButton icon={Plus} label={t('newSession')} size="sm" onClick={onNew} />
          <IconButton icon={X} label={t('close')} size="sm" onClick={onClose} />
        </div>
      </div>

      <div className="flex-shrink-0 border-b border-rule-divide p-2">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('searchSessions')}
          ariaLabel={t('searchSessions')}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {visibleSessions.length === 0 ? (
          <EmptyState compact icon={History} title={t('sessionsEmpty')} />
        ) : (
          visibleSessions.map((session) => {
            const key = `${workspacePath}\u0000${session.id}`
            const isActive = session.id === activeId
            const isOpen = openIds.includes(session.id)
            const isStreaming = Boolean(streaming[key])
            const isPinned = pinnedIds.includes(session.id)
            const isArchived = archivedIds.includes(session.id)
            const title = session.title?.trim() || t('untitledSession')
            return (
              <div
                key={session.id}
                className={`group flex items-center gap-2 border-b border-rule-divide border-l-2 px-3 py-2 transition-colors ${
                  isActive
                    ? 'border-l-accent bg-accent/[0.06]'
                    : 'border-l-transparent hover:bg-hover'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(session)}
                  title={session.title}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 bg-transparent text-left"
                >
                  <span className="flex w-full items-center gap-1.5">
                    {isPinned && (
                      <Pin size={10} className="flex-shrink-0 text-accent" aria-hidden="true" />
                    )}
                    {isStreaming && (
                      <span className="h-1 w-1 flex-shrink-0 animate-pulse rounded-full bg-accent" />
                    )}
                    <span className="truncate type-value text-ink">{title}</span>
                    {isArchived && (
                      <Caption className="flex-shrink-0 text-ink-muted">{t('archived')}</Caption>
                    )}
                    {isOpen && (
                      <Caption className="flex-shrink-0 text-ink-muted">
                        {t('sessionOpened')}
                      </Caption>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <DataText className="text-ink-muted">
                      {t('sessionMessages', { count: session.messageCount })}
                    </DataText>
                    <Caption className="text-ink-muted">
                      {relativeTime(session.updatedAt, language)}
                    </Caption>
                  </span>
                </button>
                <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <IconButton
                    icon={Pin}
                    label={isPinned ? t('unpinSession') : t('pinSession')}
                    size="sm"
                    active={isPinned}
                    onClick={() => onTogglePin(session)}
                  />
                  <IconButton
                    icon={isArchived ? ArchiveRestore : Archive}
                    label={isArchived ? t('unarchiveSession') : t('archiveSession')}
                    size="sm"
                    onClick={() => onToggleArchive(session)}
                  />
                  <span className="relative">
                    <IconButton
                      icon={Download}
                      label={t('exportSession')}
                      size="sm"
                      onClick={() =>
                        setExportMenuId(exportMenuId === session.id ? null : session.id)
                      }
                    />
                    {exportMenuId === session.id && (
                      <div className="absolute right-0 top-full z-20 mt-1 w-40 border border-line bg-raised shadow-print">
                        {(['md', 'html', 'jsonl'] as const).map((format) => (
                          <button
                            key={format}
                            type="button"
                            onClick={() => {
                              setExportMenuId(null)
                              onExport(session, format)
                            }}
                            className="block w-full px-3 py-1.5 text-left type-value text-ink transition-colors hover:bg-hover"
                          >
                            {format === 'md'
                              ? t('exportMarkdown')
                              : format === 'html'
                                ? t('exportHtml')
                                : t('exportJsonl')}
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                  <IconButton
                    icon={Pencil}
                    label={t('renameSession')}
                    size="sm"
                    onClick={() => onRename(session)}
                  />
                  <IconButton
                    icon={Trash2}
                    label={t('deleteSession')}
                    size="sm"
                    onClick={() => onDelete(session)}
                  />
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
