import React, { useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Columns2, Rows3, X } from 'lucide-react'
import { useDiffStore } from '../store/diffStore'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { computeDiff, DiffLineType, DiffResult, type DiffLine } from '../api/diff'
import { useRevertEdits } from '../hooks/useRevertEdits'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { VirtualRows } from './VirtualRows'
import { Button, IconButton } from './ui'

export const DiffViewer: React.FC<{ workspacePath: string; active?: boolean }> = ({
  workspacePath,
  active = true,
}) => {
  const { t } = useI18nStore()
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearDiff()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
    >
      <div className="absolute inset-0 bg-overlay/50" onClick={handleClose} />
      <div className="relative flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden border border-line bg-raised shadow-print">
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

const SplitDiffView: React.FC<DiffViewProps> = ({ diff }) => {
  const originalLines = diff.lines.filter((l) => l.type !== DiffLineType.Added)
  const modifiedLines = diff.lines.filter((l) => l.type !== DiffLineType.Removed)

  return (
    <div className="flex h-full divide-x divide-rule-divide">
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-rule-divide bg-panel px-3 py-1.5">
          <span className="truncate type-data text-ink">{diff.originalFile}</span>
          <span className="px-1.5 py-0.5 type-data text-danger">
            -{diff.removedCount}
          </span>
        </div>
        <VirtualDiffLines lines={originalLines} side="original" />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-rule-divide bg-panel px-3 py-1.5">
          <span className="truncate type-data text-ink">{diff.modifiedFile}</span>
          <span className="px-1.5 py-0.5 type-data text-success">
            +{diff.addedCount}
          </span>
        </div>
        <VirtualDiffLines lines={modifiedLines} side="modified" />
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
      <VirtualDiffLines lines={diff.lines} side="original" />
    </div>
  )
}

const DIFF_ROW_HEIGHT = 22

const VirtualDiffLines: React.FC<{ lines: DiffLine[]; side: 'original' | 'modified' }> = ({
  lines,
  side,
}) => {
  const { parentRef, virtualizer } = useVirtualRows({
    count: lines.length,
    estimateSize: DIFF_ROW_HEIGHT,
  })

  return (
    <div ref={parentRef} className="flex-1 overflow-auto">
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
  line: DiffLine
  side: 'original' | 'modified'
}

const DiffLineElement: React.FC<DiffLineElementProps> = ({ line, side }) => {
  let bgColor = 'bg-surface'
  let prefix = ' '
  let prefixColor = 'text-ink-muted'
  const lineNumber =
    side === 'modified' ? line.modifiedLineNumber : line.originalLineNumber

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
