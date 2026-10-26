/** 会话工作树切换条：显示当前分支/工作树，并提供切换入口 */

import React, { useEffect, useState } from 'react'
import { GitBranch, Plus, Users } from 'lucide-react'
import { useSessionStore } from '../store/sessionStore'
import { useGitStore } from '../store/gitStore'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { api } from '../api'
import { MenuOption, PopoverMenu } from './ui'
import type { GitWorktreeView } from '../types/electron'

const NO_WORKTREES: GitWorktreeView[] = []

export const WorktreeBar: React.FC<{ workspacePath: string }> = ({ workspacePath }) => {
  const { t } = useI18nStore()
  const activeSessionId = useSessionStore(
    (state) => state.byWorkspace[workspacePath]?.active ?? null
  )
  const repo = useGitStore((state) => state.byWorkspace[workspacePath]?.repo ?? null)
  const worktrees = useGitStore(
    (state) => state.byWorkspace[workspacePath]?.worktrees ?? NO_WORKTREES
  )
  const binding = useGitStore((state) =>
    activeSessionId
      ? state.byWorkspace[workspacePath]?.bindings[activeSessionId] ?? null
      : null
  )
  const load = useGitStore((state) => state.load)
  const switchWorktree = useGitStore((state) => state.switchWorktree)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (activeSessionId) void load(workspacePath, activeSessionId)
  }, [workspacePath, activeSessionId, load])

  useEffect(() => {
    if (typeof api.onAgentSessionRootChanged !== 'function') return
    return api.onAgentSessionRootChanged(({ workspaceDir, sessionId }) => {
      if (workspaceDir !== workspacePath) return
      const active = useSessionStore.getState().byWorkspace[workspacePath]?.active ?? null
      if (sessionId === active) void load(workspacePath, active)
    })
  }, [workspacePath, load])

  if (!repo) return null

  const current =
    worktrees.find((item) => item.path === binding?.path) ??
    worktrees.find((item) => item.isMain) ??
    null
  const branch = current?.branch ?? repo.branch ?? '—'
  const shared = (current?.boundSessionCount ?? 0) > 1
  const dirty = current?.dirtyCount ?? 0

  const choose = async (target: string) => {
    setOpen(false)
    if (!activeSessionId) {
      toast.info(t('worktreeNeedSession'))
      return
    }
    setBusy(true)
    const result = await switchWorktree(workspacePath, activeSessionId, target)
    setBusy(false)
    if (!result.success) toast.error(result.error ?? t('worktreeSwitchFailed'))
    else if (result.scheduled) toast.info(t('worktreeSwitchScheduled'))
    else toast.success(t('worktreeSwitched'))
  }

  return (
    <div className="relative flex h-[34px] flex-shrink-0 items-center gap-2 border-b border-rule-divide px-3.5">
      <GitBranch size={14} className="flex-shrink-0 text-ink-muted" />
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-hover disabled:opacity-60"
        title={current?.path ?? repo.root}
      >
        <span className="truncate type-value text-ink">{branch}</span>
        <span className="truncate type-caption text-ink-muted">
          {current?.isMain ? t('mainWorktree') : current?.relativePath ?? t('worktree')}
        </span>
        {shared && (
          <span className="flex flex-shrink-0 items-center gap-0.5 type-caption text-accent">
            <Users size={11} />
            {t('sharedWorktree')}
          </span>
        )}
        {dirty > 0 && (
          <span className="flex-shrink-0 type-data text-warning">{dirty}</span>
        )}
      </button>

      {open && (
        <PopoverMenu
          open={open}
          onClose={() => setOpen(false)}
          label={t('worktree')}
          placement="down"
        >
          <MenuOption selected={Boolean(current?.isMain)} onSelect={() => void choose('main')}>
            {t('mainWorktree')}
          </MenuOption>
          <MenuOption onSelect={() => void choose('new')}>
            <span className="flex items-center gap-1.5">
              <Plus size={12} />
              {t('newWorktree')}
            </span>
          </MenuOption>
          {worktrees
            .filter((item) => !item.isMain)
            .map((item) => (
              <MenuOption
                key={item.id}
                selected={item.path === current?.path}
                onSelect={() => void choose(item.path)}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate type-value text-ink">
                    {item.branch ?? item.relativePath}
                  </span>
                  <span className="truncate type-caption text-ink-muted">
                    {item.relativePath}
                    {item.boundSessionCount > 0
                      ? ` · ${t('gitInUse')} (${item.boundSessionCount})`
                      : ` · ${t('gitIdle')}`}
                    {item.dirtyCount > 0 ? ` · ${item.dirtyCount}` : ''}
                  </span>
                </span>
              </MenuOption>
            ))}
        </PopoverMenu>
      )}
    </div>
  )
}
