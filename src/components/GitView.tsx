/** Git 面板：全分支提交图、工作树更改入口与提交索引 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  Cloud,
  Clock,
  Copy,
  FolderGit2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Monitor,
  RefreshCw,
  Tag,
  XCircle,
} from 'lucide-react'
import { api } from '../api'
import { useSessionStore } from '../store/sessionStore'
import { useGitStore } from '../store/gitStore'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import { promptDialog } from '../store/dialogStore'
import { IconButton, Spinner } from './ui'
import { emitAppEvent } from '../utils/appEvents'
import { buildCommitGraph, type GraphRow } from '../utils/commitGraph'
import { parseGitRefs, type GitRefChip } from '../utils/gitRefs'
import { formatRelativeTime } from '../utils/relativeTime'
import type {
  GitCommitInfo,
  GitCommitStats,
  GitWorktreeView,
} from '../types/electron'

const LANE_WIDTH = 12
const GRAPH_PAD_LEFT = 6
const GRAPH_PAD_RIGHT = 2
const ROW_HEIGHT = 30
const ROW_HEIGHT_NARROW = 44
const NARROW_BREAKPOINT = 420
/** 行内最多显示几个 ref 徽章，其余折叠成 +N */
const MAX_VISIBLE_REFS = 2
const COMMIT_LIMIT = 200
/** 改动行数到这个量时圆环半满，和 GitLens 的 Changes 列观感一致 */
const CHANGE_SCALE = 400

const LANE_VARS = ['--accent', '--success', '--warning', '--danger', '--ink-muted'] as const
const LANE_CLASSES = [
  'stroke-accent',
  'stroke-success',
  'stroke-warning',
  'stroke-danger',
  'stroke-ink-muted',
] as const

const COLUMN_LIMITS = {
  author: { min: 40, max: 140 },
  ring: { min: 26, max: 56 },
  date: { min: 56, max: 150 },
  sha: { min: 44, max: 110 },
} as const

const EMPTY_WORKTREES: GitWorktreeView[] = []
const EMPTY_COMMITS: GitCommitInfo[] = []
const EMPTY_STATS: Record<string, GitCommitStats> = {}

type ColumnKey = keyof typeof COLUMN_LIMITS
type ColumnWidths = Record<ColumnKey, number>

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function laneClass(lane: number): string {
  return LANE_CLASSES[lane % LANE_CLASSES.length]
}

function laneVar(lane: number): string {
  return LANE_VARS[lane % LANE_VARS.length]
}

function refBadgeIcon(kind: GitRefChip['kind']) {
  if (kind === 'tag') return Tag
  if (kind === 'remote') return Cloud
  if (kind === 'head') return Monitor
  return GitBranch
}

const RefBadge: React.FC<{ chip: GitRefChip; shrinkable?: boolean }> = ({
  chip,
  shrinkable = false,
}) => {
  const Icon = refBadgeIcon(chip.kind)
  const tone =
    chip.kind === 'head'
      ? 'border border-transparent bg-accent text-accent-fg'
      : chip.kind === 'tag'
        ? 'border border-warning/45 bg-warning/[0.08] text-warning'
        : chip.kind === 'branch'
          ? 'border border-accent/45 bg-accent/[0.06] text-accent'
          : 'border border-rule-hairline bg-raised text-ink-muted'
  return (
    <span
      title={chip.title}
      className={`inline-flex h-4 items-center gap-0.5 rounded-sm px-1 type-caption ${
        shrinkable ? 'min-w-0 max-w-[120px] shrink' : 'max-w-[140px] flex-none'
      } ${tone}`}
    >
      <Icon size={10} className="flex-none" />
      <span className="truncate">{chip.label}</span>
    </span>
  )
}

const GraphRowSvg: React.FC<{
  row: GraphRow
  width: number
  height: number
  radius: number
  strokeWidth: number
  dashedTop?: boolean
}> = ({ row, width, height, radius, strokeWidth, dashedTop = false }) => {
  const laneX = (lane: number) => GRAPH_PAD_LEFT + lane * LANE_WIDTH + LANE_WIDTH / 2
  const yMid = height / 2
  const total = Math.max(row.before.length, row.after.length, row.lane + 1)
  const strokeProps = (lane: number) => ({
    className: laneClass(lane),
    strokeWidth,
    fill: 'none' as const,
    strokeLinecap: 'round' as const,
  })
  const parts: React.ReactNode[] = []

  for (let lane = 0; lane < total; lane += 1) {
    if (row.incoming.includes(lane)) continue
    if (!row.before[lane]) continue
    parts.push(
      <path
        key={`lane-${lane}`}
        d={`M ${laneX(lane)} 0 L ${laneX(lane)} ${height}`}
        {...strokeProps(lane)}
      />
    )
  }

  if (dashedTop) {
    parts.push(
      <path
        key="dash-top"
        d={`M ${laneX(row.lane)} 0 L ${laneX(row.lane)} ${yMid}`}
        className="stroke-accent"
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray="2 3"
        strokeLinecap="round"
      />
    )
  }

  if (row.incoming.includes(row.lane)) {
    parts.push(
      <path
        key="node-in"
        d={`M ${laneX(row.lane)} 0 L ${laneX(row.lane)} ${yMid}`}
        {...strokeProps(row.lane)}
      />
    )
  }

  for (const lane of row.incoming) {
    if (lane === row.lane) continue
    parts.push(
      <path
        key={`incoming-${lane}`}
        d={`M ${laneX(lane)} 0 C ${laneX(lane)} ${yMid / 2}, ${laneX(row.lane)} ${yMid / 2}, ${laneX(row.lane)} ${yMid}`}
        {...strokeProps(lane)}
      />
    )
  }

  for (const edge of row.parentEdges) {
    const d =
      edge.from === edge.to
        ? `M ${laneX(edge.from)} ${yMid} L ${laneX(edge.to)} ${height}`
        : `M ${laneX(edge.from)} ${yMid} C ${laneX(edge.from)} ${(yMid + height) / 2}, ${laneX(edge.to)} ${(yMid + height) / 2}, ${laneX(edge.to)} ${height}`
    parts.push(<path key={`parent-${edge.from}-${edge.to}`} d={d} {...strokeProps(edge.to)} />)
  }

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="flex-none">
      {parts}
      <circle
        cx={laneX(row.lane)}
        cy={yMid}
        r={radius}
        fill={`rgb(var(${laneVar(row.lane)}))`}
        stroke="rgb(var(--panel))"
        strokeWidth={2}
      />
    </svg>
  )
}

const WipNodeSvg: React.FC<{ width: number; height: number; radius: number }> = ({
  width,
  height,
  radius,
}) => {
  const x = GRAPH_PAD_LEFT + LANE_WIDTH / 2
  const yMid = height / 2
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="flex-none">
      <path
        d={`M ${x} ${yMid} L ${x} ${height}`}
        className="stroke-accent"
        strokeWidth={2}
        strokeDasharray="2 3"
        fill="none"
        strokeLinecap="round"
      />
      <circle
        cx={x}
        cy={yMid}
        r={radius}
        fill="rgb(var(--panel))"
        stroke="rgb(var(--accent))"
        strokeWidth={2}
        strokeDasharray="2.6 2.4"
      />
    </svg>
  )
}

/** 提交变更环：绿=新增行、红=删除行，弧长按改动量饱和填充，灰色为底环 */
const ChangeRing: React.FC<{ stats?: GitCommitStats; title: string }> = ({ stats, title }) => {
  const additions = stats?.additions ?? 0
  const deletions = stats?.deletions ?? 0
  const total = additions + deletions
  const size = 18
  const center = size / 2
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const track = (
    <circle
      cx={center}
      cy={center}
      r={radius}
      fill="none"
      stroke="rgb(var(--rule-hairline))"
      strokeWidth={2.8}
    />
  )
  let arcs: React.ReactNode = null
  if (total > 0) {
    const fill = total / (total + CHANGE_SCALE)
    const arc = circumference * fill
    const green = (arc * additions) / total
    const red = arc - green
    arcs = (
      <>
        {green > 0.2 && (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="rgb(var(--success))"
            strokeWidth={2.8}
            strokeDasharray={`${green} ${circumference - green}`}
            transform={`rotate(-90 ${center} ${center})`}
          />
        )}
        {red > 0.2 && (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="rgb(var(--danger))"
            strokeWidth={2.8}
            strokeDasharray={`${red} ${circumference - red}`}
            strokeDashoffset={-green}
            transform={`rotate(-90 ${center} ${center})`}
          />
        )}
      </>
    )
  }
  return (
    <span title={title} className="flex flex-none items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {track}
        {arcs}
      </svg>
    </span>
  )
}

const FilterChip: React.FC<{
  active: boolean
  onClick: () => void
  children: React.ReactNode
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`h-5 flex-none rounded-sm border px-1.5 type-caption transition-colors ${
      active
        ? 'border-rule-control bg-active text-ink'
        : 'border-transparent text-ink-muted hover:bg-hover hover:text-ink'
    }`}
  >
    {children}
  </button>
)

export const GitView: React.FC<{ workspacePath: string }> = ({ workspacePath }) => {
  const { t, language } = useI18nStore()
  const [githubLinked, setGithubLinked] = useState<boolean | null>(null)
  const [panelWidth, setPanelWidth] = useState(0)
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>({
    author: 54,
    ring: 34,
    date: 82,
    sha: 58,
  })
  const [filters, setFilters] = useState({ branches: true, remotes: true, tags: true })
  const [worktreesOpen, setWorktreesOpen] = useState(false)
  const [resizeGuide, setResizeGuide] = useState<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const tableRef = useRef<HTMLDivElement>(null)

  const activeSessionId = useSessionStore(
    (state) => state.byWorkspace[workspacePath]?.active ?? null
  )
  const repo = useGitStore((state) => state.byWorkspace[workspacePath]?.repo ?? null)
  const worktrees = useGitStore(
    (state) => state.byWorkspace[workspacePath]?.worktrees ?? EMPTY_WORKTREES
  )
  const binding = useGitStore((state) =>
    activeSessionId
      ? state.byWorkspace[workspacePath]?.bindings[activeSessionId] ?? null
      : null
  )
  const commits = useGitStore(
    (state) => state.byWorkspace[workspacePath]?.commits ?? EMPTY_COMMITS
  )
  const stats = useGitStore((state) => state.byWorkspace[workspacePath]?.stats ?? EMPTY_STATS)
  const detail = useGitStore((state) => state.byWorkspace[workspacePath]?.commitDetail ?? null)
  const detailPending = useGitStore(
    (state) => state.byWorkspace[workspacePath]?.detailPending ?? null
  )
  const pr = useGitStore((state) => state.byWorkspace[workspacePath]?.pr ?? null)
  const error = useGitStore((state) => state.byWorkspace[workspacePath]?.error ?? null)
  const load = useGitStore((state) => state.load)
  const loadCommits = useGitStore((state) => state.loadCommits)
  const loadCommitStats = useGitStore((state) => state.loadCommitStats)
  const loadPr = useGitStore((state) => state.loadPr)
  const refreshWorktrees = useGitStore((state) => state.refreshWorktrees)
  const switchWorktree = useGitStore((state) => state.switchWorktree)
  const openCommitDetail = useGitStore((state) => state.openCommitDetail)
  const createBranchAtCommit = useGitStore((state) => state.createBranch)

  const graph = useMemo(() => buildCommitGraph(commits), [commits])
  const graphWidth = GRAPH_PAD_LEFT + graph.laneCount * LANE_WIDTH + GRAPH_PAD_RIGHT
  const narrow = panelWidth > 0 && panelWidth < NARROW_BREAKPOINT
  const rowHeight = narrow ? ROW_HEIGHT_NARROW : ROW_HEIGHT
  const nodeRadius = narrow ? 6.5 : 4.5
  const graphStrokeWidth = narrow ? 2.4 : 2
  const rowGrid = narrow
    ? `${graphWidth}px minmax(0,1fr)`
    : `${graphWidth}px minmax(0,1fr) ${columnWidths.author}px ${columnWidths.ring}px ${columnWidths.date}px ${columnWidths.sha}px 36px`

  const currentWorktree =
    worktrees.find((worktree) => worktree.path === binding?.path) ??
    worktrees.find((worktree) => worktree.isMain) ??
    null
  const dirtyCount = currentWorktree?.dirtyCount ?? 0
  const ahead = currentWorktree?.ahead ?? 0
  const behind = currentWorktree?.behind ?? 0
  const currentBranch =
    currentWorktree?.branch ?? repo?.branch ?? '—'
  const allRefsOn = filters.branches && filters.remotes && filters.tags
  const selectedSha = detailPending ?? detail?.commit.sha ?? null

  useEffect(() => {
    const element = panelRef.current
    if (!element) return
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setPanelWidth(entry.contentRect.width)
    })
    observer.observe(element)
    setPanelWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    void load(workspacePath, activeSessionId)
    void loadCommits(workspacePath, COMMIT_LIMIT, undefined, true)
    void loadCommitStats(workspacePath, COMMIT_LIMIT, undefined, true)
    // 打开面板时补一次远端同步；失败静默，手动刷新会给出提示
    if (typeof api.gitFetch === 'function') {
      void api.gitFetch(workspacePath).catch(() => undefined)
    }
  }, [workspacePath, activeSessionId, load, loadCommits, loadCommitStats])

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

  const refreshLocal = useCallback(() => {
    void load(workspacePath, activeSessionId)
    void loadCommits(workspacePath, COMMIT_LIMIT, undefined, true)
    void loadCommitStats(workspacePath, COMMIT_LIMIT, undefined, true)
    void refreshWorktrees(workspacePath, activeSessionId)
    void loadPr(workspacePath, binding?.path)
  }, [
    workspacePath,
    activeSessionId,
    binding?.path,
    load,
    loadCommits,
    loadCommitStats,
    loadPr,
    refreshWorktrees,
  ])

  /** 手动刷新：先拉远端，再重读本地；拉取失败时提示一次并照常重读 */
  const refresh = useCallback(async () => {
    if (typeof api.gitFetch === 'function') {
      const fetched = await api.gitFetch(workspacePath, { force: true }).catch(() => null)
      if (fetched && !fetched.success && fetched.error) {
        toast.error(t('gitFetchFailed', { error: localizeError(fetched.error) }))
      }
    }
    refreshLocal()
  }, [refreshLocal, t, workspacePath])

  const selectWorktree = useCallback(
    async (worktree: GitWorktreeView) => {
      if (!activeSessionId) {
        toast.info(t('worktreeNeedSession'))
        return
      }
      const result = await switchWorktree(workspacePath, activeSessionId, worktree.path)
      if (!result.success) {
        toast.error(result.error ? localizeError(result.error) : t('worktreeSwitchFailed'))
      } else if (result.scheduled) toast.info(t('worktreeSwitchScheduled'))
      else toast.success(t('worktreeSwitched'))
      setWorktreesOpen(false)
    },
    [activeSessionId, switchWorktree, workspacePath, t]
  )

  const copySha = useCallback(
    async (sha: string) => {
      try {
        await navigator.clipboard.writeText(sha)
        toast.success(t('gitCopiedSha'))
      } catch {
        toast.error(t('gitCopyFailed'))
      }
    },
    [t]
  )

  const createBranchHere = useCallback(
    async (sha: string) => {
      const name = await promptDialog({
        title: t('gitNewBranchTitle'),
        message: t('gitNewBranchMessage', { sha: sha.slice(0, 7) }),
        placeholder: t('gitNewBranchPlaceholder'),
        confirmLabel: t('gitCreateAction'),
      })
      const trimmed = name?.trim()
      if (!trimmed) return
      const result = await createBranchAtCommit(workspacePath, sha, trimmed)
      if (result.success) {
        toast.success(t('gitBranchCreated', { name: trimmed }))
        refreshLocal()
      } else {
        toast.error(result.error ?? t('gitCreateAction'))
      }
    },
    [createBranchAtCommit, refreshLocal, t, workspacePath]
  )

  const authorLabel = useCallback(
    (commit: GitCommitInfo) =>
      commit.email && repo?.userEmail && commit.email.toLowerCase() === repo.userEmail.toLowerCase()
        ? t('gitYou')
        : commit.author,
    [repo?.userEmail, t]
  )

  const visibleRefs = useCallback(
    (commit: GitCommitInfo) =>
      parseGitRefs(commit.refs).filter((chip) => {
        if (chip.kind === 'tag') return filters.tags
        if (chip.kind === 'remote') return filters.remotes
        return filters.branches
      }),
    [filters]
  )

  const ringTitle = useCallback(
    (commitSha: string) => {
      const entry = stats[commitSha]
      if (!entry || entry.additions + entry.deletions === 0) return t('gitRingEmpty')
      return t('gitRingTitle', {
        added: entry.addedFiles,
        modified: entry.modifiedFiles,
        deleted: entry.deletedFiles,
        additions: entry.additions.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US'),
        deletions: entry.deletions.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US'),
      })
    },
    [stats, t, language]
  )

  const dayLabel = useMemo(() => {
    const iso = commits[0]?.date
    if (!iso) return ''
    const target = new Date(iso)
    const now = new Date()
    if (target.toDateString() === now.toDateString()) return t('gitToday')
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    if (target.toDateString() === yesterday.toDateString()) return t('gitYesterday')
    return target.toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'long',
      day: 'numeric',
    })
  }, [commits, language, t])

  const beginResize = useCallback(
    (key: ColumnKey) => (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      const table = tableRef.current
      const tableLeft = table?.getBoundingClientRect().left ?? 0
      const handleRect = event.currentTarget.getBoundingClientRect()
      // 手柄以列边界为中心，取它的中心作为参考线的起点
      const startBoundary = handleRect.left + handleRect.width / 2
      const startX = event.clientX
      const startWidth = columnWidths[key]
      const limits = COLUMN_LIMITS[key]
      setResizeGuide(startBoundary - tableLeft)

      const onMove = (move: PointerEvent) => {
        // 边界跟随指针，但夹在列的最小/最大宽度内，参考线取夹住后的实际位置
        const dx = clamp(move.clientX - startX, startWidth - limits.max, startWidth - limits.min)
        setColumnWidths((current) => ({ ...current, [key]: startWidth - dx }))
        setResizeGuide(startBoundary + dx - tableLeft)
      }
      const onUp = () => {
        setResizeGuide(null)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [columnWidths]
  )

  const renderActionButtons = (commit: GitCommitInfo) => (
    <>
      <span
        role="button"
        tabIndex={-1}
        title={t('gitCopySha')}
        onClick={(event) => {
          event.stopPropagation()
          void copySha(commit.sha)
        }}
        className="flex h-5 w-5 items-center justify-center rounded-sm text-ink-muted hover:bg-hover hover:text-ink"
      >
        <Copy size={12} />
      </span>
      <span
        role="button"
        tabIndex={-1}
        title={t('gitCreateBranchHere')}
        onClick={(event) => {
          event.stopPropagation()
          void createBranchHere(commit.sha)
        }}
        className="flex h-5 w-5 items-center justify-center rounded-sm text-ink-muted hover:bg-hover hover:text-ink"
      >
        <GitBranch size={12} />
      </span>
    </>
  )

  const actionVisibility = (commit: GitCommitInfo) =>
    selectedSha === commit.sha
      ? 'opacity-100'
      : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'

  const renderRow = (commit: GitCommitInfo, index: number) => {
    const graphRow = graph.rows[index]
    if (!graphRow) return null
    const chips = visibleRefs(commit)
    const shownRefs = chips.length > MAX_VISIBLE_REFS ? chips.slice(0, 1) : chips
    const hiddenRefs = chips.slice(shownRefs.length)
    const selected = selectedSha === commit.sha
    const relative = formatRelativeTime(commit.date, language)
    const author = authorLabel(commit)
    return (
      <button
        key={commit.sha}
        type="button"
        onClick={() => void openCommitDetail(workspacePath, commit.sha)}
        aria-label={`${commit.subject} ${author}`}
        style={{ gridTemplateColumns: rowGrid, height: rowHeight }}
        className={`group relative grid w-full items-center border-l-2 pr-2 text-left transition-colors ${
          selected
            ? 'border-accent bg-accent/[0.07]'
            : 'border-transparent hover:bg-hover focus-visible:bg-hover'
        }`}
      >
        <span className="flex h-full items-center overflow-hidden">
          <GraphRowSvg
            row={graphRow}
            width={graphWidth}
            height={rowHeight}
            radius={nodeRadius}
            strokeWidth={graphStrokeWidth}
            dashedTop={index === 0}
          />
        </span>
        {narrow ? (
          <span className="flex min-w-0 flex-col justify-center gap-0.5">
            <span className="relative flex min-w-0 items-center gap-1">
              {commit.parents.length > 1 && (
                <span
                  className="flex flex-none items-center text-ink-muted"
                  title={t('gitMergeCommit')}
                >
                  <GitMerge size={11} />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate type-value text-ink">{commit.subject}</span>
              <span className="flex-none type-caption text-ink-subtle">{relative}</span>
              <span
                className={`absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-sm bg-panel px-0.5 ${actionVisibility(commit)}`}
              >
                {renderActionButtons(commit)}
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-1 type-caption text-ink-muted">
              {shownRefs.map((chip) => (
                <RefBadge key={`${chip.kind}:${chip.title}`} chip={chip} shrinkable />
              ))}
              {hiddenRefs.length > 0 && (
                <span
                  title={hiddenRefs.map((chip) => chip.title).join(', ')}
                  className="inline-flex h-4 flex-none items-center rounded-sm border border-rule-hairline bg-raised px-1 type-caption text-ink-subtle"
                >
                  +{hiddenRefs.length}
                </span>
              )}
              <span className="flex-none type-data text-ink-subtle">{commit.shortSha}</span>
            </span>
          </span>
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-1 overflow-hidden pl-0.5">
              {commit.parents.length > 1 && (
                <span
                  className="flex flex-none items-center text-ink-muted"
                  title={t('gitMergeCommit')}
                >
                  <GitMerge size={11} />
                </span>
              )}
              {shownRefs.map((chip) => (
                <RefBadge key={`${chip.kind}:${chip.title}`} chip={chip} shrinkable />
              ))}
              {hiddenRefs.length > 0 && (
                <span
                  title={hiddenRefs.map((chip) => chip.title).join(', ')}
                  className="inline-flex h-4 flex-none items-center rounded-sm border border-rule-hairline bg-raised px-1 type-caption text-ink-subtle"
                >
                  +{hiddenRefs.length}
                </span>
              )}
              <span className="min-w-[60px] flex-1 truncate type-value text-ink">
                {commit.subject}
              </span>
            </span>
            <span className="truncate pl-0.5 type-caption text-ink-muted">{author}</span>
            <span className="flex items-center pl-0.5">
              <ChangeRing stats={stats[commit.sha]} title={ringTitle(commit.sha)} />
            </span>
            <span className="truncate pl-0.5 type-caption text-ink-muted">{relative}</span>
            <span className="truncate pl-0.5 type-data text-ink-subtle">{commit.shortSha}</span>
            <span className={`flex flex-none items-center gap-0.5 ${actionVisibility(commit)}`}>
              {renderActionButtons(commit)}
            </span>
          </>
        )}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 right-0 border-b border-rule-hairline"
          style={{ left: graphWidth }}
        />
      </button>
    )
  }

  const prRow =
    pr?.pull && pr.available ? (
      <div className="flex h-[26px] flex-none items-center gap-1.5 border-b border-rule-hairline px-2.5 type-caption">
        <GitPullRequest size={11} className="flex-none text-ink-muted" />
        <a
          href={pr.pull.url}
          target="_blank"
          rel="noreferrer"
          title={pr.pull.title}
          className="min-w-0 truncate text-accent hover:underline"
        >
          #{pr.pull.number} {pr.pull.title}
        </a>
        {pr.checks && pr.checks.state !== 'none' && (
          <span
            className={`ml-auto flex-none ${
              pr.checks.state === 'success'
                ? 'text-success'
                : pr.checks.state === 'pending'
                  ? 'text-warning'
                  : 'text-danger'
            }`}
          >
            {pr.checks.state}
          </span>
        )}
      </div>
    ) : null

  const worktreeList = worktreesOpen ? (
    <div className="max-h-40 flex-none overflow-auto border-b border-rule-divide">
      {worktrees.map((worktree) => {
        const current = binding ? worktree.path === binding.path : worktree.isMain
        return (
          <div
            key={worktree.id}
            className="flex items-center gap-1.5 px-2.5 py-1 type-caption text-ink-muted"
            title={worktree.path}
          >
            <span className="min-w-0 flex-1 truncate type-value text-ink">
              {worktree.branch ?? worktree.relativePath}
            </span>
            {current ? (
              <span className="flex-none text-accent">{t('gitInUse')}</span>
            ) : (
              <button
                type="button"
                onClick={() => void selectWorktree(worktree)}
                className="flex-none rounded-sm px-1 text-accent hover:bg-hover"
              >
                {t('gitUseWorktree')}
              </button>
            )}
          </div>
        )
      })}
    </div>
  ) : null

  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col bg-panel">
      {narrow ? (
        <>
          <div className="flex h-[34px] flex-none items-center gap-1.5 border-b border-rule-divide px-2">
          <span className="h-2 w-2 flex-none rounded-full bg-accent" aria-hidden="true" />
          <span className="min-w-0 truncate type-label text-ink">{t('gitWorkingTree')}</span>
          <span className="ml-auto flex-none type-caption text-ink-subtle">{dayLabel}</span>
          <IconButton
            icon={FolderGit2}
            label={t('gitWorktrees')}
            size="sm"
            active={worktreesOpen}
            onClick={() => setWorktreesOpen((value) => !value)}
          />
          <IconButton icon={RefreshCw} label={t('gitRefresh')} size="sm" onClick={() => void refresh()} />
          </div>
          {worktreeList}
          {prRow}
        </>
      ) : (
        <>
          <div className="flex h-[32px] flex-none items-center gap-1.5 border-b border-rule-divide px-2.5">
            <span className="flex-none type-data text-ink-muted">
              ↑{ahead} ↓{behind}
            </span>
            <span className="h-3 w-px flex-none bg-rule-divide" aria-hidden="true" />
            <FilterChip
              active={allRefsOn}
              onClick={() => setFilters({ branches: true, remotes: true, tags: true })}
            >
              {t('gitAllBranches')}
            </FilterChip>
            <FilterChip
              active={filters.branches}
              onClick={() => setFilters((current) => ({ ...current, branches: !current.branches }))}
            >
              {t('gitLocalRefs')}
            </FilterChip>
            <FilterChip
              active={filters.remotes}
              onClick={() => setFilters((current) => ({ ...current, remotes: !current.remotes }))}
            >
              {t('gitRemoteRefs')}
            </FilterChip>
            <FilterChip
              active={filters.tags}
              onClick={() => setFilters((current) => ({ ...current, tags: !current.tags }))}
            >
              {t('gitTags')}
            </FilterChip>
            <span className="min-w-0 flex-1" />
            {pr?.checks && pr.checks.state !== 'none' && (
              <span
                className={`flex flex-none items-center gap-0.5 type-caption ${
                  pr.checks.state === 'success'
                    ? 'text-success'
                    : pr.checks.state === 'pending'
                      ? 'text-warning'
                      : 'text-danger'
                }`}
              >
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
            <IconButton icon={RefreshCw} label={t('gitRefresh')} size="sm" onClick={() => void refresh()} />
          </div>
          <button
            type="button"
            onClick={() => setWorktreesOpen((value) => !value)}
            aria-expanded={worktreesOpen}
            className="flex h-[27px] w-full flex-none items-center gap-1.5 border-b border-rule-hairline bg-panel px-2.5 type-caption text-ink-muted hover:bg-hover"
          >
            <FolderGit2 size={11} className="flex-none" />
            <span className="flex-none">{t('gitWorktrees')}</span>
            <span className="flex-none type-data">{worktrees.length}</span>
            <span className="min-w-0 truncate text-accent">{currentBranch}</span>
            <ChevronDown
              size={11}
              className={`ml-auto flex-none transition-transform ${worktreesOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {worktreeList}
          {prRow}
        </>
      )}

      <div ref={tableRef} className="relative flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-auto">
          {!narrow && (
            <div
              className="sticky top-0 z-[3] grid h-[26px] items-center border-b border-l-2 border-l-transparent border-rule-divide bg-panel pr-2 text-ink-subtle type-caption"
              style={{ gridTemplateColumns: rowGrid }}
            >
              <span aria-hidden="true" />
              <span className="truncate pl-0.5">{t('gitCommitColumn')}</span>
              <span className="relative flex h-full items-center pl-0.5">
                <span className="truncate">{t('gitAuthorColumn')}</span>
                <span
                  role="separator"
                  aria-orientation="vertical"
                  className="absolute -left-1 top-0 h-full w-2 cursor-col-resize before:absolute before:bottom-1 before:left-1/2 before:top-1 before:w-px before:-translate-x-1/2 before:bg-transparent before:content-[''] hover:before:bg-accent"
                  onPointerDown={beginResize('author')}
                />
              </span>
              <span className="relative flex h-full items-center pl-0.5">
                <span className="truncate">{t('gitChangesColumn')}</span>
                <span
                  role="separator"
                  aria-orientation="vertical"
                  className="absolute -left-1 top-0 h-full w-2 cursor-col-resize before:absolute before:bottom-1 before:left-1/2 before:top-1 before:w-px before:-translate-x-1/2 before:bg-transparent before:content-[''] hover:before:bg-accent"
                  onPointerDown={beginResize('ring')}
                />
              </span>
              <span className="relative flex h-full items-center pl-0.5">
                <span className="truncate">{t('gitDateColumn')}</span>
                <span
                  role="separator"
                  aria-orientation="vertical"
                  className="absolute -left-1 top-0 h-full w-2 cursor-col-resize before:absolute before:bottom-1 before:left-1/2 before:top-1 before:w-px before:-translate-x-1/2 before:bg-transparent before:content-[''] hover:before:bg-accent"
                  onPointerDown={beginResize('date')}
                />
              </span>
              <span className="relative flex h-full items-center pl-0.5">
                <span className="truncate">{t('gitShaColumn')}</span>
                <span
                  role="separator"
                  aria-orientation="vertical"
                  className="absolute -left-1 top-0 h-full w-2 cursor-col-resize before:absolute before:bottom-1 before:left-1/2 before:top-1 before:w-px before:-translate-x-1/2 before:bg-transparent before:content-[''] hover:before:bg-accent"
                  onPointerDown={beginResize('sha')}
                />
              </span>
              <span aria-hidden="true" />
            </div>
          )}

          <div
            className="sticky z-[2] grid items-center border-l-2 border-transparent bg-panel"
            style={{ gridTemplateColumns: rowGrid, height: ROW_HEIGHT, top: narrow ? 0 : 26 }}
            title={t('gitWorkingTreeSummary', { count: dirtyCount })}
          >
          <span className="flex h-full items-center overflow-hidden">
            <WipNodeSvg
              width={graphWidth}
              height={ROW_HEIGHT}
              radius={narrow ? 6.5 : 5.5}
            />
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="inline-flex h-[18px] flex-none items-center gap-1 rounded-sm border border-rule-hairline bg-raised px-1.5 type-data text-ink-muted">
              <FolderGit2 size={11} className="flex-none text-accent" />
              <span className="text-ink-subtle">+</span>
              <span className="text-ink">{dirtyCount}</span>
            </span>
            {!narrow && <span className="truncate type-label text-ink">{t('gitWorkingTree')}</span>}
          </span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 right-0 border-b border-rule-hairline"
            style={{ left: graphWidth }}
          />
        </div>

        {commits.map((commit, index) => renderRow(commit, index))}

        {detailPending && !detail && (
          <div className="flex items-center gap-1.5 border-b border-rule-hairline px-2.5 py-1.5">
            <Spinner size={12} className="text-ink-muted" />
            <span className="type-data text-ink-subtle">{detailPending.slice(0, 7)}</span>
          </div>
        )}

        {commits.length === 0 && (
          <div className="px-2.5 py-2 type-caption text-ink-muted">
            {error ?? t('gitNoCommits')}
          </div>
        )}
        </div>

        {resizeGuide !== null && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 z-20 w-px bg-accent"
            style={{ left: resizeGuide }}
          />
        )}
      </div>

      {githubLinked === false && (
        <div className="flex flex-none items-center gap-1.5 border-t border-rule-divide px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate type-caption text-ink-muted">
            {t('githubNotLinked')}
          </span>
          <button
            type="button"
            onClick={() => emitAppEvent('open-settings', { section: 'github' })}
            className="flex flex-none items-center gap-1 rounded-sm px-1 type-caption text-accent hover:bg-hover"
          >
            <GitPullRequest size={11} />
            {t('githubLink')}
          </button>
        </div>
      )}
    </div>
  )
}

