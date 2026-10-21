import React, { useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Columns2, Rows3, X } from 'lucide-react'
import { useDiffStore } from '../store/diffStore'
import { useI18nStore } from '../store/i18nStore'
import { useEditorStore } from '../store/editorStore'
import { api } from '../api'
import { toast } from '../store/toastStore'
import { confirmDialog } from '../store/dialogStore'
import { localizeError } from '../i18n/errors'
import { computeDiff, DiffLineType, DiffResult, type DiffLine } from '../api/diff'
import type { FileEdit } from '../types/electron'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { Button, IconButton, Spinner } from './ui'

export const DiffViewer: React.FC = () => {
  const { t } = useI18nStore()
  const {
    edits,
    currentIndex,
    isOpen,
    isLoading,
    error,
    clearDiff,
    setCurrentIndex,
    removeEdit,
  } = useDiffStore()
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearDiff()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, clearDiff])

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

  /** 把文件恢复为 Agent 修改前的内容；文件被外部改动过时拒绝覆盖 */
  const revertFile = async (target: FileEdit): Promise<boolean> => {
    const openFile = useEditorStore.getState().openFiles.find((file) => file.path === target.path)
    if (openFile?.isDirty) {
      toast.error(t('revertBlockedDirty'))
      return false
    }

    const current = await api.readFile(target.path)
    if (!current.success || typeof current.content !== 'string') {
      toast.error(`${t('revertFailed')}: ${localizeError(current.error) || target.path}`)
      return false
    }
    if (current.content !== target.newContent) {
      toast.error(t('revertConflict'))
      return false
    }

    const written = await api.writeFile(target.path, target.oldContent)
    if (!written.success) {
      toast.error(`${t('revertFailed')}: ${localizeError(written.error) || target.path}`)
      return false
    }
    return true
  }

  const handleKeep = () => {
    removeEdit(edit.path)
    toast.info(t('keptChanges'))
  }

  const handleRevert = async () => {
    if (!(await confirmDialog({ message: t('revertConfirm'), danger: true }))) return
    setBusy(true)
    try {
      if (await revertFile(edit)) {
        removeEdit(edit.path)
        toast.success(t('reverted'))
      }
    } finally {
      setBusy(false)
    }
  }

  const handleRevertAll = async () => {
    if (!(await confirmDialog({ message: t('revertAllConfirm'), danger: true }))) return
    setBusy(true)
    let reverted = 0
    try {
      for (const target of [...edits]) {
        if (await revertFile(target)) {
          removeEdit(target.path)
          reverted++
        }
      }
      if (reverted > 0) {
        toast.success(`${t('reverted')}: ${reverted}`)
      }
    } finally {
      setBusy(false)
    }
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
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void handleRevert()}>
              {t('revertFile')}
            </Button>
            {edits.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                className="text-danger hover:bg-danger/10 hover:text-danger"
                onClick={() => void handleRevertAll()}
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

        {/* Error */}
        {error && (
          <div className="flex-shrink-0 border-b border-danger/30 bg-danger/10 px-4 py-2 type-caption text-danger">
            {error}
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex flex-1 items-center justify-center gap-2 type-value text-ink-muted">
            <Spinner />
            {t('comparing')}
          </div>
        )}

        {/* Content */}
        {!isLoading && (
          <div className="flex-1 overflow-hidden">
            {viewMode === 'split' ? <SplitDiffView diff={diff} /> : <UnifiedDiffView diff={diff} />}
          </div>
        )}
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
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().length > 0
          ? virtualizer.getVirtualItems().map((virtualRow) => {
              const line = lines[virtualRow.index]
              if (!line) return null
              return (
                <div
                  key={virtualRow.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    minWidth: '100%',
                    width: 'max-content',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <DiffLineElement line={line} side={side} />
                </div>
              )
            })
          : lines
              .slice(0, 80)
              .map((line, index) => (
                <DiffLineElement key={index} line={line} side={side} />
              ))}
      </div>
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
