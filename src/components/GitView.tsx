/** 只读 Git 视图：分支、工作树、提交历史、diff 与 GitHub 状态 */

import React, { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  Clock,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  GitCommitHorizontal,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { api } from '../api'
import { useSessionStore } from '../store/sessionStore'
import { useGitStore } from '../store/gitStore'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { Button, IconButton, Spinner } from './ui'
import { emitAppEvent } from '../utils/appEvents'
import { buildCommitGraph, type GraphRow } from '../utils/commitGraph'
import type { GitCommitInfo, GitWorktreeView } from '../types/electron'

const NO_WORKTREES: GitWorktreeView[] = []
const NO_BRANCHES: Array<{ name: string; fullName: string; current: boolean; remote: boolean }> = []
const NO_COMMITS: GitCommitInfo[] = []

/** 行高固定，提交图按它计算每条 lane 的坐标；两行标题 + 元信息行需要 60px */
const ROW_HEIGHT = 60
const LANE_WIDTH = 14
const GRAPH_PAD = 6
const LANE_CLASSES = [
  'stroke-accent',
  'stroke-success',
  'stroke-warning',
  'stroke-danger',
  'stroke-ink-muted',
] as const

function laneClass(lane: number): string {
  return LANE_CLASSES[lane % LANE_CLASSES.length]
}

function commitRefLabels(refs: string): string[] {
  const labels = refs
    .split(',')
    .map((ref) => ref.trim())
    .filter(Boolean)
    .map((ref) => ref.replace(/^HEAD -> /, ''))
  return [...new Set(labels)].slice(0, 4)
}

function formatCommitDate(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
}

/** 单行提交图的线条与节点；所有行叠在同一个坐标空间里 */
const GraphRowSvg: React.FC<{ row: GraphRow; index: number }> = ({ row, index }) => {
  const x = (lane: number) => GRAPH_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2
  const yTop = index * ROW_HEIGHT
  const yMid = yTop + ROW_HEIGHT / 2
  const yBottom = yTop + ROW_HEIGHT
  const totalLanes = Math.max(row.before.length, row.after.length)
  const parts: React.ReactNode[] = []

  for (let lane = 0; lane < totalLanes; lane += 1) {
    if (row.incoming.includes(lane)) continue
    if (row.before[lane]) {
      parts.push(
        <path
          key={`lane-${lane}`}
          d={`M ${x(lane)} ${yTop} L ${x(lane)} ${yBottom}`}
          className={laneClass(lane)}
          fill="none"
          strokeWidth={1.5}
        />
      )
    }
  }

  if (row.incoming.includes(row.lane)) {
    parts.push(
      <path
        key="node-top"
        d={`M ${x(row.lane)} ${yTop} L ${x(row.lane)} ${yMid}`}
        className={laneClass(row.lane)}
        fill="none"
        strokeWidth={1.5}
      />
    )
  }

  for (const lane of row.incoming) {
    if (lane === row.lane) continue
    parts.push(
      <path
        key={`incoming-${lane}`}
        d={`M ${x(lane)} ${yTop} C ${x(lane)} ${yMid}, ${x(row.lane)} ${yMid}, ${x(row.lane)} ${yMid}`}
        className={laneClass(lane)}
        fill="none"
        strokeWidth={1.5}
      />
    )
  }

  for (const edge of row.parentEdges) {
    const d =
      edge.from === edge.to
        ? `M ${x(edge.from)} ${yMid} L ${x(edge.to)} ${yBottom}`
        : `M ${x(edge.from)} ${yMid} C ${x(edge.from)} ${yBottom}, ${x(edge.to)} ${yBottom}, ${x(edge.to)} ${yBottom}`
    parts.push(
      <path
        key={`parent-${edge.from}-${edge.to}`}
        d={d}
        className={laneClass(edge.to)}
        fill="none"
        strokeWidth={1.5}
      />
    )
  }

  return (
    <>
      {parts}
      <circle
        cx={x(row.lane)}
        cy={yMid}
        r={row.parentEdges.length > 1 ? 4 : 3.5}
        className={laneClass(row.lane)}
        fill="rgb(var(--surface))"
        strokeWidth={1.75}
      />
    </>
  )
}

function checkTone(state: string | undefined): string {
  if (state === 'success') return 'text-success'
  if (state === 'failure') return 'text-danger'
  if (state === 'pending') return 'text-warning'
  return 'text-ink-muted'
}

export const GitView: React.FC<{ workspacePath: string }> = ({ workspacePath }) => {
  const { t } = useI18nStore()
  /** null 表示校验尚未返回，避免挂载瞬间闪出“未关联” */
  const [githubLinked, setGithubLinked] = useState<boolean | null>(null)
  const activeSessionId = useSessionStore(
    (state) => state.byWorkspace[workspacePath]?.active ?? null
  )
  const repo = useGitStore((state) => state.byWorkspace[workspacePath]?.repo ?? null)
  const worktrees = useGitStore(
    (state) => state.byWorkspace[workspacePath]?.worktrees ?? NO_WORKTREES
  )
  const branches = useGitStore(
    (state) => state.byWorkspace[workspacePath]?.branches ?? NO_BRANCHES
  )
  const binding = useGitStore((state) =>
    activeSessionId
      ? state.byWorkspace[workspacePath]?.bindings[activeSessionId] ?? null
      : null
  )
  const commits = useGitStore(
    (state) => state.byWorkspace[workspacePath]?.commits ?? NO_COMMITS
  )
  const graph = useMemo(() => buildCommitGraph(commits), [commits])
  const graphWidth = GRAPH_PAD + graph.laneCount * LANE_WIDTH + 4
  const detail = useGitStore(
    (state) => state.byWorkspace[workspacePath]?.commitDetail ?? null
  )
  const detailPending = useGitStore(
    (state) => state.byWorkspace[workspacePath]?.detailPending ?? null
  )
  const pr = useGitStore((state) => state.byWorkspace[workspacePath]?.pr ?? null)
  const load = useGitStore((state) => state.load)
  const loadCommits = useGitStore((state) => state.loadCommits)
  const loadCommitDetail = useGitStore((state) => state.loadCommitDetail)
  const loadPr = useGitStore((state) => state.loadPr)
  const switchWorktree = useGitStore((state) => state.switchWorktree)

  useEffect(() => {
    void load(workspacePath, activeSessionId)
    void loadCommits(workspacePath, 80)
  }, [workspacePath, activeSessionId, load, loadCommits])

  useEffect(() => {
    void loadPr(workspacePath, binding?.path)
  }, [workspacePath, binding?.path, loadPr])

  useEffect(() => {
    if (typeof api.onAgentSessionRootChanged !== 'function') return
    return api.onAgentSessionRootChanged(({ workspaceDir, sessionId }) => {
      if (workspaceDir !== workspacePath) return
      const active = useSessionStore.getState().byWorkspace[workspacePath]?.active ?? null
      if (sessionId === active) void load(workspacePath, active)
    })
  }, [workspacePath, load])

  useEffect(() => {
    let active = true
    const check = async () => {
      try {
        const result = await api.githubAuthStatus()
        if (active) setGithubLinked(Boolean(result.success && result.configured))
      } catch {
        if (active) setGithubLinked(false)
      }
    }
    void check()
    const off =
      typeof api.onGithubAuthComplete === 'function'
        ? api.onGithubAuthComplete((payload) => {
            if (payload.success) setGithubLinked(true)
          })
        : () => {}
    const onFocus = () => void check()
    window.addEventListener('focus', onFocus)
    return () => {
      active = false
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const refresh = () => {
    void load(workspacePath, activeSessionId)
    void loadCommits(workspacePath, 80, currentBranch === '—' ? undefined : currentBranch)
    void loadPr(workspacePath, binding?.path)
  }

  const selectWorktree = async (worktree: GitWorktreeView) => {
    if (!activeSessionId) {
      toast.info(t('worktreeNeedSession'))
      return
    }
    const result = await switchWorktree(workspacePath, activeSessionId, worktree.path)
    if (!result.success) toast.error(result.error ?? t('worktreeSwitchFailed'))
    else if (result.scheduled) toast.info(t('worktreeSwitchScheduled'))
    else toast.success(t('worktreeSwitched'))
  }

  const currentBranch =
    worktrees.find((item) => item.path === binding?.path)?.branch ??
    repo?.branch ??
    '—'

  useEffect(() => {
    if (!currentBranch || currentBranch === '—') return
    void loadCommits(workspacePath, 80, currentBranch)
  }, [currentBranch, workspacePath, loadCommits])

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-[34px] flex-shrink-0 items-center gap-1.5 border-b border-rule-divide px-2.5">
        <GitBranch size={13} className="text-ink-muted" />
        <span className="min-w-0 flex-1 truncate type-value text-ink">{currentBranch}</span>
        {pr?.checks && pr.checks.state !== 'none' && (
          <span className={`flex items-center gap-0.5 type-caption ${checkTone(pr.checks.state)}`}>
            {pr.checks.state === 'success' ? (
              <CheckCircle2 size={12} />
            ) : pr.checks.state === 'pending' ? (
              <Clock size={12} />
            ) : (
              <XCircle size={12} />
            )}
            {pr.checks.total}
          </span>
        )}
        <IconButton
          icon={RefreshCw}
          label={t('gitRefresh')}
          size="sm"
          onClick={refresh}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {pr?.pull && (
          <div className="border-b border-rule-divide px-2.5 py-2">
            <div className="type-label text-ink-muted">{t('gitPullRequest')}</div>
            <a
              href={pr.pull.url}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 block truncate type-value text-accent"
              title={pr.pull.title}
            >
              #{pr.pull.number} {pr.pull.title}
            </a>
            <div className={`mt-0.5 type-caption ${checkTone(pr.checks?.state)}`}>
              {t('gitChecks')}: {pr.checks?.state ?? 'none'}
            </div>
          </div>
        )}

        <section className="border-b border-rule-divide px-2.5 py-2">
          <div className="flex items-center gap-1 type-label text-ink-muted">
            <FolderGit2 size={12} />
            {t('gitWorktrees')}
          </div>
          <div className="mt-1 flex flex-col">
            {worktrees.map((worktree) => {
              const current = worktree.path === binding?.path
              return (
                <div
                  key={worktree.id}
                  className="flex items-center gap-1.5 py-1"
                  title={worktree.path}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate type-value text-ink">
                      {worktree.branch ?? worktree.relativePath}
                    </span>
                    <span className="block truncate type-caption text-ink-muted">
                      {worktree.isMain ? t('mainWorktree') : worktree.relativePath}
                      {worktree.boundSessionCount > 0
                        ? ` · ${t('gitInUse')}`
                        : ` · ${t('gitIdle')}`}
                      {worktree.dirtyCount > 0 ? ` · ${worktree.dirtyCount}` : ''}
                    </span>
                  </span>
                  {current ? (
                    <span className="type-caption text-accent">{t('gitInUse')}</span>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => void selectWorktree(worktree)}>
                      {t('gitUseWorktree')}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        </section>

        <section className="border-b border-rule-divide px-2.5 py-2">
          <div className="flex items-center gap-1 type-label text-ink-muted">
            <GitBranch size={12} />
            {t('gitBranches')}
          </div>
          <div className="mt-1 flex flex-col">
            {branches.slice(0, 60).map((branch) => (
              <div key={branch.fullName} className="flex items-center gap-1.5 py-0.5">
                <span className="min-w-0 flex-1 truncate type-value text-ink">
                  {branch.name}
                </span>
                {branch.current && (
                  <span className="type-caption text-accent">{t('gitInUse')}</span>
                )}
                {branch.remote && <span className="type-caption text-ink-subtle">remote</span>}
              </div>
            ))}
          </div>
        </section>

        <section className="px-2.5 py-2">
          <div className="flex items-center gap-1 type-label text-ink-muted">
            <GitCommitHorizontal size={12} />
            {t('gitCommits')}
          </div>
          {commits.length === 0 ? (
            <div className="mt-1 type-caption text-ink-muted">{t('gitNoCommits')}</div>
          ) : (
            <div className="relative mt-1" style={{ height: commits.length * ROW_HEIGHT }}>
              <svg
                className="pointer-events-none absolute left-0 top-0"
                width={graphWidth}
                height={commits.length * ROW_HEIGHT}
                aria-hidden
              >
                {graph.rows.map((row, index) => (
                  <GraphRowSvg key={row.sha} row={row} index={index} />
                ))}
              </svg>
              {commits.map((commit) => {
                const refs = commitRefLabels(commit.refs)
                return (
                  <button
                    key={commit.sha}
                    type="button"
                    onClick={() => void loadCommitDetail(workspacePath, commit.sha)}
                    style={{ height: ROW_HEIGHT, paddingLeft: graphWidth + 6 }}
                    className={`flex w-full flex-col justify-center gap-0.5 border-b border-rule-hairline pr-1 text-left transition-colors last:border-b-0 hover:bg-hover ${
                      detail?.commit.sha === commit.sha || detailPending === commit.sha
                        ? 'bg-active'
                        : ''
                    }`}
                  >
                    <span className="line-clamp-2 type-value text-ink">{commit.subject}</span>
                    <span className="flex w-full items-center gap-1">
                      <span className="min-w-0 flex-1 truncate type-caption text-ink-muted">
                        {commit.shortSha} · {commit.author}
                      </span>
                      {refs.slice(0, 2).map((ref) => (
                        <span
                          key={ref}
                          className="max-w-[80px] flex-shrink-0 truncate rounded-sm border border-rule-hairline px-1 type-caption text-ink-muted"
                          title={ref}
                        >
                          {ref}
                        </span>
                      ))}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {detailPending && detailPending !== detail?.commit.sha && (
          <section className="flex items-center gap-1.5 border-t border-rule-divide px-2.5 py-2">
            <Spinner size={12} className="text-ink-muted" />
            <span className="type-data text-ink-subtle">{detailPending.slice(0, 7)}</span>
          </section>
        )}

        {detail && (
          <section className="border-t border-rule-divide px-2.5 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate type-label text-ink-muted" title={detail.commit.sha}>
                {detail.commit.shortSha} · {detail.commit.author}
              </span>
              <span className="flex-shrink-0 type-caption text-ink-subtle">
                {formatCommitDate(detail.commit.date)}
              </span>
            </div>
            <div className="mt-1 type-value text-ink">{detail.commit.subject}</div>
            {detail.body && (
              <div className="mt-1.5 whitespace-pre-wrap break-words type-reading text-ink">
                {detail.body}
              </div>
            )}
            <div className="mt-2 flex flex-col gap-0.5 border-t border-rule-hairline pt-2">
              {detail.files.map((file) => (
                <div
                  key={`${file.status}:${file.path}`}
                  className="truncate type-caption text-ink-muted"
                >
                  <span className="text-accent">{file.status}</span> {file.path}
                </div>
              ))}
            </div>
            <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words bg-sunken p-2 type-data text-ink-muted">
              {detail.patch || ''}
            </pre>
            {detail.truncated && (
              <div className="mt-1 type-caption text-warning">diff truncated</div>
            )}
          </section>
        )}

        {githubLinked === false && (
          <section className="border-t border-rule-divide px-2.5 py-2">
            <div className="type-caption text-ink-muted">{t('githubNotLinked')}</div>
            <div className="mt-1">
              <Button
                size="sm"
                variant="secondary"
                icon={GitPullRequest}
                onClick={() => emitAppEvent('open-settings', { section: 'github' })}
              >
                {t('githubLink')}
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
