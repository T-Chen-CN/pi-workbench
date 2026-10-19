import React, { useState } from 'react'
import { useDiffStore } from '../store/diffStore'
import { useI18nStore } from '../store/i18nStore'
import { DiffLineType, DiffResult } from '../api/diff'
import '../styles/DiffViewer.css'

export const DiffViewer: React.FC = () => {
  const { t } = useI18nStore()
  const { currentDiff, isOpen, isLoading, error, clearDiff } = useDiffStore()
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split')

  if (!isOpen || !currentDiff) {
    return null
  }

  const handleClose = () => {
    clearDiff()
  }

  return (
    <div className="diff-modal">
      <div className="diff-overlay" onClick={handleClose} />
      <div className="diff-container">
        <div className="diff-header">
          <div className="diff-title">
            <h3>{t('diffViewer')}</h3>
            <span className="diff-stats">
              +{currentDiff.addedCount} -{currentDiff.removedCount}
            </span>
          </div>

          <div className="diff-controls">
            <div className="view-mode-toggle">
              <button
                className={`mode-btn ${viewMode === 'split' ? 'active' : ''}`}
                onClick={() => setViewMode('split')}
                title={t('splitView')}
              >
                ∥
              </button>
              <button
                className={`mode-btn ${viewMode === 'unified' ? 'active' : ''}`}
                onClick={() => setViewMode('unified')}
                title={t('unifiedView')}
              >
                ≡
              </button>
            </div>

            <button className="close-btn" onClick={handleClose} title={t('close')}>
              ✕
            </button>
          </div>
        </div>

        {error && <div className="diff-error">{error}</div>}

        {isLoading && (
          <div className="diff-loading">
            <span>⏳ {t('comparing')}</span>
          </div>
        )}

        {!isLoading && (
          <div className="diff-content">
            {viewMode === 'split' ? (
              <SplitDiffView diff={currentDiff} />
            ) : (
              <UnifiedDiffView diff={currentDiff} />
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
    <div className="split-diff">
      <div className="diff-column">
        <div className="column-header">
          <span className="filename">{diff.originalFile}</span>
          <span className="stats removed">-{diff.removedCount}</span>
        </div>
        <div className="diff-lines">
          {originalLines.map((line, idx) => (
            <DiffLineElement key={`orig-${idx}`} line={line} />
          ))}
        </div>
      </div>

      <div className="diff-column">
        <div className="column-header">
          <span className="filename">{diff.modifiedFile}</span>
          <span className="stats added">+{diff.addedCount}</span>
        </div>
        <div className="diff-lines">
          {modifiedLines.map((line, idx) => (
            <DiffLineElement key={`mod-${idx}`} line={line} />
          ))}
        </div>
      </div>
    </div>
  )
}

const UnifiedDiffView: React.FC<DiffViewProps> = ({ diff }) => {
  return (
    <div className="unified-diff">
      <div className="diff-info">
        <span className="file-a">{diff.originalFile}</span>
        <span className="separator">→</span>
        <span className="file-b">{diff.modifiedFile}</span>
      </div>
      <div className="diff-lines">
        {diff.lines.map((line, idx) => (
          <DiffLineElement key={idx} line={line} />
        ))}
      </div>
    </div>
  )
}

interface DiffLineElementProps {
  line: any // DiffLine
}

const DiffLineElement: React.FC<DiffLineElementProps> = ({ line }) => {
  let className = 'diff-line'
  let prefix = ' '

  if (line.type === DiffLineType.Added) {
    className += ' line-added'
    prefix = '+'
  } else if (line.type === DiffLineType.Removed) {
    className += ' line-removed'
    prefix = '-'
  } else {
    className += ' line-unchanged'
    prefix = ' '
  }

  return (
    <div className={className}>
      <span className="line-prefix">{prefix}</span>
      <span className="line-number">{line.lineNumber || '-'}</span>
      <span className="line-content">{line.content}</span>
    </div>
  )
}
