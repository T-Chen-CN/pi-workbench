import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Columns2, Rows3, X } from 'lucide-react'
import { useDiffStore } from '../../store/diffStore'
import { useI18nStore } from '../../store/i18nStore'
import { toast } from '../../store/toastStore'
import { computeDiff, DiffLineType, DiffResult, type DiffLine } from '../../api/diff'
import { useRevertEdits } from '../../hooks/useRevertEdits'
import { useVirtualRows } from '../../hooks/useVirtualRows'
import { VirtualRows } from '../ui/VirtualRows'
import { Button, IconButton } from '../ui/ui'

export const DiffViewer: React.FC<{ workspacePath: string; active?: boolean }> = ({
  workspacePath,
  active = true,
}) => {
  const t = useI18nStore((state) => state.t)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const {
    edits,
    currentIndex,
    isOpen,
    clearDiff,
    setCurrentIndex,
    removeEdit,
  } = useDiffStore(workspacePath)
  const { busy, handleRevert, handleRevertAll } = useRevertEdits({
    workspacePath,
    onReverted: (target) => removeEdit(target.path),
  })

  const handleKeep = () => {
    removeEdit(edit.path)
    toast.info(t('keptChanges'))
  }
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split')

  useEffect(() => {
    if (!isOpen || !active) return
    const previousFocus = document.activeElement as HTMLElement | null
    const raf = window.requestAnimationFrame(() => {
      const container = dialogRef.current
      if (!container || container.contains(document.activeElement)) return
      const first = container.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      ;(first ?? container).focus()
    })
    const onKeyDown = (event: KeyboardEvent) => {
      // 若确认撤销弹窗（DialogHost）等上层模态框已打开，不抢占其按键
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-diff-viewer])')) return
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        clearDiff()
        return
      }
      if (event.key === 'Tab') {
        const container = dialogRef.current
        if (!container) return
        const focusables = Array.from(
          container.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const activeEl = document.activeElement as HTMLElement | null
        if (event.shiftKey) {
          if (!activeEl || activeEl === first || !container.contains(activeEl)) {
            event.preventDefault()
            last.focus()
          }
        } else if (!activeEl || activeEl === last || !container.contains(activeEl)) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus()
      }
    }
  }, [isOpen, clearDiff, active])

  const edit = edits[currentIndex]
  const diff = useMemo(
    () =>
      edit
        ? computeDiff(edit.oldContent, edit.newContent, `${edit.path}${t('diffBefore')}`, edit.path)
        : null,
    [edit, t]
  )
  if (!isOpen || !edit || !diff) {
    return null
  }

  const canGoPrev = currentIndex > 0
  const canGoNext = currentIndex < edits.length - 1

  const handleClose = () => {
    clearDiff()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('reviewChanges')}
      data-diff-viewer="true"
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
    >
      <div aria-hidden="true" className="absolute inset-0 bg-overlay/50" onClick={handleClose} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden border border-line bg-raised shadow-print focus:outline-none"
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-rule-divide px-4 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <h3 className="m-0 whitespace-nowrap type-label text-ink">
              {t('reviewChanges')}
            </h3>
            <span className="whitespace-nowrap border border-success/30 px-2 py-0.5 type-data text-success">
              +{diff.addedCount}
            </span>
            <span className="whitespace-nowrap border border-danger/30 px-2 py-0.5 type-data text-danger">
              -{diff.removedCount}
            </span>
            {edits.length > 1 && (
              <div className="flex items-center gap-1 type-caption text-ink-muted">
                <IconButton
                  icon={ChevronLeft}
                  label={t('previousFile')}
                  size="sm"
                  disabled={!canGoPrev || busy}
                  onClick={() => setCurrentIndex(currentIndex - 1)}
                />
                <span className="whitespace-nowrap">
                  {currentIndex + 1} / {edits.length}
                </span>
                <IconButton
                  icon={ChevronRight}
                  label={t('nextFile')}
                  size="sm"
                  disabled={!canGoNext || busy}
                  onClick={() => setCurrentIndex(currentIndex + 1)}
                />
              </div>
            )}
          </div>

          <div className="flex flex-shrink-0 items-center gap-2">
            <div className="flex items-center gap-0.5 border border-rule-control bg-sunken p-0.5">
              <button
                type="button"
                onClick={() => setViewMode('split')}
                title={t('splitView')}
                aria-pressed={viewMode === 'split'}
                className={`flex items-center gap-1.5 px-2 py-1 type-label font-normal transition-colors ${
                  viewMode === 'split'
                    ? 'bg-raised text-ink'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                <Columns2 size={13} />
                {t('splitView')}
              </button>
              <button
                type="button"
                onClick={() => setViewMode('unified')}
                title={t('unifiedView')}
                aria-pressed={viewMode === 'unified'}
                className={`flex items-center gap-1.5 px-2 py-1 type-label font-normal transition-colors ${
                  viewMode === 'unified'
                    ? 'bg-raised text-ink'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                <Rows3 size={13} />
                {t('unifiedView')}
              </button>
            </div>

            <Button size="sm" icon={Check} disabled={busy} onClick={handleKeep}>
              {t('keepChanges')}
            </Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => edit && void handleRevert(edit)}>
              {t('revertFile')}
            </Button>
            {edits.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                className="text-danger hover:bg-danger/10 hover:text-danger"
                onClick={() => void handleRevertAll(edits)}
              >
                {t('revertAll')}
              </Button>
            )}

            <IconButton icon={X} label={t('close')} size="sm" onClick={handleClose} />
          </div>
        </div>

        {/* Hint */}
        <div className="flex-shrink-0 border-b border-rule-divide px-4 py-1.5 type-caption text-ink-muted">
          {t('reviewHint')}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {viewMode === 'split' ? <SplitDiffView diff={diff} /> : <UnifiedDiffView diff={diff} />}
        </div>
      </div>
    </div>
  )
}

interface DiffViewProps {
  diff: DiffResult
}

interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
}

/** 把连续的删除段与新增段并排对齐，缺侧补占位空行，保证左右两栏行号与滚动位置严格同步 */
function alignSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.type === DiffLineType.Unchanged) {
      rows.push({ left: line, right: line })
      i += 1
      continue
    }
    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    while (i < lines.length && lines[i].type !== DiffLineType.Unchanged) {
      if (lines[i].type === DiffLineType.Removed) removed.push(lines[i])
      else added.push(lines[i])
      i += 1
    }
    const span = Math.max(removed.length, added.length)
    for (let k = 0; k < span; k += 1) {
      rows.push({ left: removed[k] ?? null, right: added[k] ?? null })
    }
  }
  return rows
}

const SplitDiffView: React.FC<DiffViewProps> = ({ diff }) => {
  const aligned = useMemo(() => alignSplitRows(diff.lines), [diff.lines])
  const originalLines = useMemo(
    () => aligned.map((row) => row.left),
    [aligned]
  )
  const modifiedLines = useMemo(
    () => aligned.map((row) => row.right),
    [aligned]
  )
  const leftElRef = useRef<HTMLDivElement | null>(null)
  const rightElRef = useRef<HTMLDivElement | null>(null)
  const syncingRef = useRef<'left' | 'right' | null>(null)

  const syncScroll = (source: 'left' | 'right') => {
    if (syncingRef.current && syncingRef.current !== source) return
    const from = source === 'left' ? leftElRef.current : rightElRef.current
    const to = source === 'left' ? rightElRef.current : leftElRef.current
    if (!from || !to) return
    syncingRef.current = source
    to.scrollTop = from.scrollTop
    to.scrollLeft = from.scrollLeft
    requestAnimationFrame(() => {
      if (syncingRef.current === source) syncingRef.current = null
    })
  }

  return (
    <div className="flex h-full divide-x divide-rule-divide">
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-rule-divide bg-panel px-3 py-1.5">
          <span className="truncate type-data text-ink">{diff.originalFile}</span>
          <span className="px-1.5 py-0.5 type-data text-danger">
            -{diff.removedCount}
          </span>
        </div>
        <VirtualDiffLines
          lines={originalLines}
          side="original"
          scrollRef={leftElRef}
          onScroll={() => syncScroll('left')}
        />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-rule-divide bg-panel px-3 py-1.5">
          <span className="truncate type-data text-ink">{diff.modifiedFile}</span>
          <span className="px-1.5 py-0.5 type-data text-success">
            +{diff.addedCount}
          </span>
        </div>
        <VirtualDiffLines
          lines={modifiedLines}
          side="modified"
          scrollRef={rightElRef}
          onScroll={() => syncScroll('right')}
        />
      </div>
    </div>
  )
}

const UnifiedDiffView: React.FC<DiffViewProps> = ({ diff }) => {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center justify-center gap-2 border-b border-rule-divide bg-panel px-3 py-1.5">
        <span className="truncate type-data text-ink-muted">{diff.originalFile}</span>
        <span className="text-ink-muted">→</span>
        <span className="truncate type-data text-ink">{diff.modifiedFile}</span>
      </div>
      <VirtualDiffLines lines={diff.lines} side="unified" />
    </div>
  )
}

const DIFF_ROW_HEIGHT = 22

const VirtualDiffLines: React.FC<{
  lines: Array<DiffLine | null>
  side: 'original' | 'modified' | 'unified'
  scrollRef?: React.MutableRefObject<HTMLDivElement | null>
  onScroll?: () => void
}> = ({ lines, side, scrollRef, onScroll }) => {
  const { parentRef, virtualizer } = useVirtualRows({
    count: lines.length,
    estimateSize: DIFF_ROW_HEIGHT,
  })

  return (
    <div
      ref={(node) => {
        parentRef.current = node
        if (scrollRef) scrollRef.current = node
      }}
      onScroll={onScroll}
      className="flex-1 overflow-auto"
    >
      <VirtualRows
        virtualizer={virtualizer}
        items={lines}
        getKey={(_line, index) => index}
        fallbackCount={80}
        rowStyle={{ minWidth: '100%', width: 'max-content' }}
        renderItem={(line) => <DiffLineElement line={line} side={side} />}
      />
    </div>
  )
}

interface DiffLineElementProps {
  line: DiffLine | null
  side: 'original' | 'modified' | 'unified'
}

const DiffLineElement: React.FC<DiffLineElementProps> = ({ line, side }) => {
  if (!line) {
    return (
      <div
        aria-hidden="true"
        className="flex h-[22px] items-center border-b border-rule-divide bg-sunken/40 type-code"
        style={{ minWidth: '100%', width: 'max-content' }}
      >
        <span className="w-6 flex-shrink-0 select-none text-center text-ink-subtle" />
        <span className="w-10 flex-shrink-0 select-none pr-2 text-right text-ink-subtle" />
        <span className="flex-1 whitespace-pre px-2" />
      </div>
    )
  }

  let bgColor = 'bg-surface'
  let prefix = ' '
  let prefixColor = 'text-ink-muted'
  const lineNumber =
    side === 'unified'
      ? line.type === DiffLineType.Added
        ? line.modifiedLineNumber
        : line.originalLineNumber
      : side === 'modified'
        ? line.modifiedLineNumber
        : line.originalLineNumber

  if (line.type === DiffLineType.Added) {
    bgColor = 'bg-success/10'
    prefix = '+'
    prefixColor = 'text-success'
  } else if (line.type === DiffLineType.Removed) {
    bgColor = 'bg-danger/10'
    prefix = '-'
    prefixColor = 'text-danger'
  }

  return (
    <div
      className={`flex h-[22px] items-center border-b border-rule-divide type-code ${bgColor}`}
      style={{ minWidth: '100%', width: 'max-content' }}
    >
      <span className={`w-6 flex-shrink-0 select-none text-center ${prefixColor}`}>
        {prefix}
      </span>
      <span className="w-10 flex-shrink-0 select-none pr-2 text-right text-ink-muted">
        {lineNumber || '-'}
      </span>
      <span className="flex-1 whitespace-pre px-2 text-ink">{line.content}</span>
    </div>
  )
}
