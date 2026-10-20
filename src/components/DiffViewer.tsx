import React, { useMemo, useState } from 'react'
import { useDiffStore } from '../store/diffStore'
import { useI18nStore } from '../store/i18nStore'
import { useEditorStore } from '../store/editorStore'
import { api } from '../api'
import { toast } from '../store/toastStore'
import { computeDiff, DiffLineType, DiffResult, type DiffLine } from '../api/diff'
import type { FileEdit } from '../types/electron'

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

  const edit = edits[currentIndex]
  const diff = useMemo(
    () =>
      edit
        ? computeDiff(edit.oldContent, edit.newContent, `${edit.path} (before)`, edit.path)
        : null,
    [edit]
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
      toast.error(`${t('revertFailed')}: ${current.error ?? target.path}`)
      return false
    }
    if (current.content !== target.newContent) {
      toast.error(t('revertConflict'))
      return false
    }

    const written = await api.writeFile(target.path, target.oldContent)
    if (!written.success) {
      toast.error(`${t('revertFailed')}: ${written.error ?? target.path}`)
      return false
    }
    return true
  }

  const handleKeep = () => {
    removeEdit(edit.path)
    toast.info(t('keptChanges'))
  }

  const handleRevert = async () => {
    if (!window.confirm(t('revertConfirm'))) return
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
    if (!window.confirm(t('revertAllConfirm'))) return
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
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50 cursor-pointer" onClick={handleClose} />
      <div className="relative bg-white dark:bg-[#1e1e1e] border border-gray-300 dark:border-gray-700 rounded-lg w-11/12 h-5/6 max-w-6xl shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-300 dark:border-gray-700 flex-shrink-0 gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <h3 className="text-lg font-semibold m-0 text-gray-900 dark:text-gray-100 whitespace-nowrap">
              {t('reviewChanges')}
            </h3>
            <span className="px-3 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded text-sm font-mono whitespace-nowrap">
              +{diff.addedCount} -{diff.removedCount}
            </span>
            {edits.length > 1 && (
              <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <button
                  onClick={() => setCurrentIndex(currentIndex - 1)}
                  disabled={!canGoPrev || busy}
                  title={t('previousFile')}
                  className="px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ‹
                </button>
                <span className="whitespace-nowrap">
                  {currentIndex + 1} / {edits.length}
                </span>
                <button
                  onClick={() => setCurrentIndex(currentIndex + 1)}
                  disabled={!canGoNext || busy}
                  title={t('nextFile')}
                  className="px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ›
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={handleKeep}
              disabled={busy}
              className="px-3 py-1 text-sm font-medium rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-40"
            >
              {t('keepChanges')}
            </button>
            <button
              onClick={handleRevert}
              disabled={busy}
              className="px-3 py-1 text-sm font-medium rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-40"
            >
              {t('revertFile')}
            </button>
            {edits.length > 1 && (
              <button
                onClick={handleRevertAll}
                disabled={busy}
                className="px-3 py-1 text-sm font-medium rounded border border-red-500 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40"
              >
                {t('revertAll')}
              </button>
            )}

            <div className="flex gap-1 bg-gray-200 dark:bg-gray-700 p-1 rounded">
              <button
                onClick={() => setViewMode('split')}
                title={t('splitView')}
                className={`px-3 py-1 text-sm font-medium rounded transition-colors ${
                  viewMode === 'split'
                    ? 'bg-blue-600 text-white'
                    : 'bg-transparent text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                ∥ Split
              </button>
              <button
                onClick={() => setViewMode('unified')}
                title={t('unifiedView')}
                className={`px-3 py-1 text-sm font-medium rounded transition-colors ${
                  viewMode === 'unified'
                    ? 'bg-blue-600 text-white'
                    : 'bg-transparent text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                ≡ Unified
              </button>
            </div>

            <button
              onClick={handleClose}
              title={t('close')}
              className="bg-none border-none cursor-pointer text-xl text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Hint */}
        <div className="px-6 py-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          {t('reviewHint')}
        </div>

        {/* Error */}
        {error && (
          <div className="px-6 py-4 bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-b border-red-300 dark:border-red-700/50">
            {error}
          </div>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-xl">⏳ {t('comparing')}</span>
          </div>
        )}

        {/* Content */}
        {!isLoading && (
          <div className="flex-1 overflow-hidden">
            {viewMode === 'split' ? (
              <SplitDiffView diff={diff} />
            ) : (
              <UnifiedDiffView diff={diff} />
            )}
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
    <div className="flex h-full divide-x divide-gray-300 dark:divide-gray-700">
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-[#252526] border-b border-gray-300 dark:border-gray-700 flex-shrink-0">
          <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{diff.originalFile}</span>
          <span className="text-sm px-2 py-1 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded">-{diff.removedCount}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {originalLines.map((line, idx) => (
            <DiffLineElement key={`orig-${idx}`} line={line} side="original" />
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-[#252526] border-b border-gray-300 dark:border-gray-700 flex-shrink-0">
          <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{diff.modifiedFile}</span>
          <span className="text-sm px-2 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded">+{diff.addedCount}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {modifiedLines.map((line, idx) => (
            <DiffLineElement key={`mod-${idx}`} line={line} side="modified" />
          ))}
        </div>
      </div>
    </div>
  )
}

const UnifiedDiffView: React.FC<DiffViewProps> = ({ diff }) => {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-center gap-2 px-4 py-3 bg-gray-100 dark:bg-[#252526] border-b border-gray-300 dark:border-gray-700 flex-shrink-0">
        <span className="font-mono text-sm text-gray-700 dark:text-gray-300">{diff.originalFile}</span>
        <span className="text-gray-500 dark:text-gray-400">→</span>
        <span className="font-mono text-sm text-gray-700 dark:text-gray-300">{diff.modifiedFile}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {diff.lines.map((line, idx) => (
          <DiffLineElement key={idx} line={line} side="original" />
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
  let bgColor = 'bg-white dark:bg-[#1e1e1e]'
  let textColor = 'text-gray-700 dark:text-gray-300'
  let prefix = ' '
  const lineNumber =
    side === 'modified' ? line.modifiedLineNumber : line.originalLineNumber

  if (line.type === DiffLineType.Added) {
    bgColor = 'bg-green-50 dark:bg-green-900/20'
    textColor = 'text-green-700 dark:text-green-400'
    prefix = '+'
  } else if (line.type === DiffLineType.Removed) {
    bgColor = 'bg-red-50 dark:bg-red-900/20'
    textColor = 'text-red-700 dark:text-red-400'
    prefix = '-'
  }

  return (
    <div className={`flex font-mono text-sm ${bgColor} border-b border-gray-200 dark:border-gray-700`}>
      <span className={`w-8 text-center py-1 px-2 select-none text-gray-500 dark:text-gray-600 flex-shrink-0`}>{prefix}</span>
      <span className={`w-12 text-right py-1 px-2 select-none text-gray-500 dark:text-gray-600 flex-shrink-0`}>{lineNumber || '-'}</span>
      <span className={`flex-1 py-1 px-2 break-all ${textColor}`}>{line.content}</span>
    </div>
  )
}
