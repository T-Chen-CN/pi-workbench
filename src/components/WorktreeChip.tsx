/** 聊天头部的工作树 chip：显示当前分支/工作树，点击切换 */

import React, { useEffect, useState } from 'react'
import { AlertCircle, Check, ChevronDown, GitBranch, Loader2, Plus, Users } from 'lucide-react'
import { useSessionStore } from '../store/sessionStore'
import { useGitStore } from '../store/gitStore'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { api } from '../api'
import { localizeError } from '../i18n/errors'
import { MenuOption, PopoverMenu } from './ui'
import type { GitWorktreeView } from '../types/electron'

const NO_WORKTREES: GitWorktreeView[] = []

export const WorktreeChip: React.FC<{ workspacePath: string }> = ({ workspacePath }) => {
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
  const installWorktreeDeps = useGitStore((state) => state.installWorktreeDeps)
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
  const path = current?.path ?? repo.root
  // 只在链接工作树上显示：主工作树用的是仓库自己的 node_modules
  const deps = current && !current.isMain ? current.deps : null
  const depsRetryable = deps?.state === 'failed' || deps?.state === 'idle'

  const retryDeps = async () => {
    if (!current) return
    const result = await installWorktreeDeps(workspacePath, current.id)
    if (!result.success) {
      toast.error(result.error ? localizeError(result.error) : t('worktreeDepsRetryFailed'))
    }
  }

  const choose = async (target: string) => {
    setOpen(false)
    if (!activeSessionId) {
      toast.info(t('worktreeNeedSession'))
      return
    }
    setBusy(true)
    const result = await switchWorktree(workspacePath, activeSessionId, target)
    setBusy(false)
    if (!result.success) {
      toast.error(result.error ? localizeError(result.error) : t('worktreeSwitchFailed'))
    } else if (result.scheduled) toast.info(t('worktreeSwitchScheduled'))
    else toast.success(t('worktreeSwitched'))
  }

  return (
    <div className="relative flex min-w-0 items-center">
      <button
        type="button"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('worktreeChipLabel', { branch })}
        title={path}
        onClick={() => setOpen((value) => !value)}
        className="flex h-6 min-w-0 items-center gap-1.5 overflow-hidden rounded-sm border border-rule-control px-2 text-left transition-colors hover:bg-hover disabled:opacity-60"
      >
        <GitBranch size={12} className="flex-shrink-0 text-ink-muted" />
        <span className="min-w-0 truncate type-value text-ink">{branch}</span>
        <span className="min-w-0 truncate type-caption text-ink-muted">
          {current?.isMain ? t('mainWorktree') : current?.relativePath ?? t('worktree')}
        </span>
        {shared && (
          <span className="flex flex-shrink-0 items-center gap-0.5 type-caption text-accent">
            <Users size={11} />
            {t('sharedWorktree')}
          </span>
        )}
        {dirty > 0 && <span className="flex-shrink-0 type-data text-warning">{dirty}</span>}
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={`flex-shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {deps && deps.state !== 'none' && depsRetryable && (
        <button
          type="button"
          onClick={() => void retryDeps()}
          title={deps.error ?? t('worktreeDepsRetry')}
          aria-label={t('worktreeDepsRetry')}
          className="ml-1 flex h-6 flex-shrink-0 items-center gap-1 rounded-sm border border-rule-control px-2 type-caption text-danger transition-colors hover:bg-hover"
        >
          <AlertCircle size={11} className="flex-shrink-0" />
          {deps.error ? t('worktreeDepsFailed') : t('worktreeDepsIdle')}
        </button>
      )}

      {deps && deps.state !== 'none' && !depsRetryable && (
        <span
          className="ml-1 flex h-6 flex-shrink-0 items-center gap-1 rounded-sm border border-rule-control px-2 type-caption text-ink-muted"
          title={deps.manager ?? undefined}
        >
          {deps.state === 'installing' ? (
            <Loader2 size={11} className="flex-shrink-0 animate-spin text-accent" aria-hidden="true" />
          ) : (
            <Check size={11} className="flex-shrink-0 text-success" aria-hidden="true" />
          )}
          {deps.state === 'installing' ? t('worktreeDepsInstalling') : t('worktreeDepsReady')}
        </span>
      )}

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
                disabled={item.missing}
                onSelect={() => void choose(item.path)}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate type-value text-ink">
                    {item.branch ?? item.relativePath}
                  </span>
                  <span className="truncate type-caption text-ink-muted">
                    {item.relativePath}
                    {item.missing
                      ? ` · ${t('worktreeMissing')}`
                      : item.boundSessionCount > 0
                        ? ` · ${t('gitInUse')} (${item.boundSessionCount})`
                        : ` · ${t('gitIdle')}`}
                    {!item.missing && item.dirtyCount > 0 ? ` · ${item.dirtyCount}` : ''}
                  </span>
                </span>
              </MenuOption>
            ))}
        </PopoverMenu>
      )}
    </div>
  )
}
