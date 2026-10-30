/**
 * 工作区面板：Git 跟踪文件的「仓库地图画布」。
 *
 * 数据来自主进程的只读扫描（`repo-map:scan`），这里负责工具条、状态与降级提示：
 * - 首次可见时扫一次，之后靠 `git:changed`（debounce）与手动刷新；
 * - 仓库超过全量上限时，只有展开的文件夹 / 搜索命中的文件会补描述，并常驻一条提示条；
 * - 画布本身（平移 / 缩放 / 拖动 / 落盘）在 `RepoMapCanvas` 里，面板只持有工具条状态。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  GitBranch,
  Maximize2,
  RefreshCw,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { RepoMapFile } from '../types/electron'
import { useRepoMapStore, repoMapStateFor } from '../store/repoMapStore'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { joinPath, samePath } from '../utils/filePath'
import { openFileInEditor } from '../workspace/openFileInEditor'
import { Button, Caption, EmptyState, IconButton, Spinner } from './ui'
import { SearchField } from './patterns'
import { RepoMapCanvas, type RepoMapCanvasHandle } from './RepoMapCanvas'

/** 与主进程 `REPO_MAP_FULL_SCAN_LIMIT` 保持一致：超出后描述按需补齐 */
const FULL_SCAN_LIMIT = 5000

/** 一次补描述最多点多少文件：防止展开一个超大目录就把主进程压住 */
const DESCRIBE_BATCH = 200

/** git 变化后合并重扫的窗口：连续保存只扫一次 */
const RESCAN_DEBOUNCE_MS = 1500

/** 仓库文件数达到这个量（≥）就常驻提示「逐层查看或搜索」：这时一眼看全已经不现实 */
const MANY_NODES_HINT = 600

export interface WorkspacePanelProps {
  workspacePath: string
  /** 面板是否可见（被文件视图盖住时不扫描，也不补描述） */
  active: boolean
}

export const WorkspacePanel: React.FC<WorkspacePanelProps> = ({ workspacePath, active }) => {
  const { t } = useI18nStore()
  const state = useRepoMapStore((s) => repoMapStateFor(s, workspacePath))
  const scan = useRepoMapStore((s) => s.scan)
  const canvasRef = useRef<RepoMapCanvasHandle | null>(null)
  /** 面板被盖住时仓库变了：不当时扫，记一笔待办，重新可见时补一次 */
  const rescanPendingRef = useRef(false)
  const [query, setQuery] = useState('')
  const [zoom, setZoom] = useState(1)

  /**
   * 首次可见时扫一次：面板是编辑区默认视图，启动时不该做无谓的磁盘扫描。
   * 直接读 store 而不是依赖 `scanned / scanning`：扫描失败后这两个值会反复变化，
   * 依赖它们会让失败的仓库无限重试（重试只走按钮或 git:changed）。
   */
  useEffect(() => {
    if (!active) return
    const current = useRepoMapStore.getState().byWorkspace[workspacePath]
    if (current?.scanned || current?.scanning) return
    void scan(workspacePath)
  }, [active, scan, workspacePath])

  /** 仓库变化（提交、切分支、暂存）→ 合并后重扫；文件内容变化不触发 */
  useEffect(() => {
    if (typeof api.onGitChanged !== 'function') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = api.onGitChanged((payload) => {
      if (!samePath(payload.workspaceDir, workspacePath)) return
      // 隐藏的工作区零开销：不扫，只记待办（否则每个后台工作区都在刷 git status）
      if (!active) {
        rescanPendingRef.current = true
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void scan(workspacePath)
      }, RESCAN_DEBOUNCE_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [active, scan, workspacePath])

  /** 重新可见时把隐藏期间攒下的那次变化补扫掉（合并成最多一次） */
  useEffect(() => {
    if (!active || !rescanPendingRef.current) return
    rescanPendingRef.current = false
    void scan(workspacePath)
  }, [active, scan, workspacePath])

  const files = state.files

  const ensureDescribed = useCallback(
    (paths: string[]) => {
      if (!state.truncated) return
      const missing = paths
        .filter((path) => files.some((file) => file.path === path && !file.described))
        .slice(0, DESCRIBE_BATCH)
      if (missing.length === 0) return
      void scan(workspacePath, { paths: missing })
    },
    [files, scan, state.truncated, workspacePath]
  )

  const openFile = useCallback(
    (file: RepoMapFile) => {
      const base = state.repoRoot ?? workspacePath
      void openFileInEditor(base, joinPath(base, file.path))
    },
    [state.repoRoot, workspacePath]
  )

  const refresh = () => void scan(workspacePath, { force: true })
  const resetLayout = () => canvasRef.current?.resetLayout()

  const showEmptyRepo = state.scanned && state.isRepo && state.total === 0
  const showNotRepo = state.scanned && !state.isRepo

  return (
    <div data-testid="workspace-panel" className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      <div className="flex h-[34px] flex-shrink-0 items-center gap-3 border-b border-rule-divide bg-panel px-3">
        <Caption className="truncate text-ink-muted">
          {state.scanned
            ? t('repoMapSummary', { total: state.total, described: state.described })
            : t('repoMapScanning')}
        </Caption>
        <div className="ml-auto flex items-center gap-2">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={t('repoMapSearchPlaceholder')}
            ariaLabel={t('repoMapSearchLabel')}
            className="w-52"
          />
          <IconButton
            icon={RefreshCw}
            label={t('repoMapRefresh')}
            aria-busy={state.scanning || undefined}
            disabled={state.scanning}
            className={state.scanning ? 'animate-spin' : undefined}
            onClick={refresh}
          />
        </div>
      </div>

      {state.truncated && (
        <div
          role="status"
          data-testid="repo-map-truncated"
          className="flex flex-shrink-0 items-start gap-2 border-b border-rule-divide bg-panel px-3 py-1.5"
        >
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0 text-warning" />
          <span className="type-caption text-ink-muted">
            {t('repoMapTruncated', {
              total: state.total,
              described: state.described,
              limit: FULL_SCAN_LIMIT,
            })}
          </span>
        </div>
      )}

      {state.status === 'error' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-surface">
          <Caption className="text-ink-muted">
            {t('repoMapScanFailed', { error: state.error ?? '' })}
          </Caption>
          <Button size="sm" icon={RefreshCw} onClick={refresh}>
            {t('repoMapRetry')}
          </Button>
        </div>
      ) : !state.scanned ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
          <Spinner />
        </div>
      ) : showNotRepo ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
          <EmptyState
            icon={GitBranch}
            title={t('repoMapNotRepo')}
            description={t('repoMapNotRepoHint')}
          />
        </div>
      ) : showEmptyRepo ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
          <EmptyState icon={GitBranch} title={t('repoMapEmpty')} />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <RepoMapCanvas
            ref={canvasRef}
            workspacePath={workspacePath}
            files={files}
            query={query}
            onOpenFile={openFile}
            onEnsureDescribed={ensureDescribed}
            onZoomChange={setZoom}
          />

          <div
            data-canvas-controls="true"
            className="absolute bottom-3 left-3 z-10 flex h-7 items-center border border-rule-control bg-panel/95 px-1 shadow-print"
          >
            <IconButton
              icon={ZoomOut}
              label={t('repoMapCanvasZoomOut')}
              size="sm"
              onClick={() => canvasRef.current?.zoomBy(1 / 1.2)}
            />
            <span
              aria-live="polite"
              aria-label={t('repoMapCanvasZoomLevel', { percent: Math.round(zoom * 100) })}
              className="type-data w-10 text-center text-ink-muted"
            >
              {Math.round(zoom * 100)}%
            </span>
            <IconButton
              icon={ZoomIn}
              label={t('repoMapCanvasZoomIn')}
              size="sm"
              onClick={() => canvasRef.current?.zoomBy(1.2)}
            />
            <span className="mx-1 h-3 w-px bg-rule-divide" />
            <IconButton
              icon={Maximize2}
              label={t('repoMapCanvasFit')}
              size="sm"
              onClick={() => canvasRef.current?.fit()}
            />
            <IconButton
              icon={RotateCcw}
              label={t('repoMapCanvasReset')}
              size="sm"
              onClick={resetLayout}
            />
          </div>

          {state.total >= MANY_NODES_HINT && (
            <Caption
              role="status"
              className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 text-ink-subtle"
            >
              {t('repoMapCanvasManyNodes', { count: state.total })}
            </Caption>
          )}
        </div>
      )}
    </div>
  )
}
