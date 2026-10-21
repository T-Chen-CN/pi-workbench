import React, { useEffect, useMemo, useState } from 'react'
import { FileDiff } from 'lucide-react'
import { api } from '../api'
import { computeDiff, DiffLineType, type DiffLine } from '../api/diff'
import { useI18nStore } from '../store/i18nStore'
import { localizeError } from '../i18n/errors'
import { Button, EmptyState, Modal, Spinner } from './ui'
import type { FleetFileChange, FleetTask } from '../types/electron'

interface FleetDiffModalProps {
  task: FleetTask
  workspacePath: string
  onClose: () => void
}

type DiffState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; files: FleetFileChange[]; truncated: boolean }

type CompactLine = { kind: 'line'; line: DiffLine } | { kind: 'gap' }

const CONTEXT_LINES = 3

function compactDiff(lines: DiffLine[]): CompactLine[] {
  const keep = new Set<number>()
  lines.forEach((line, index) => {
    if (line.type !== DiffLineType.Added && line.type !== DiffLineType.Removed) return
    for (let cursor = index - CONTEXT_LINES; cursor <= index + CONTEXT_LINES; cursor++) {
      if (cursor >= 0 && cursor < lines.length) keep.add(cursor)
    }
  })

  const result: CompactLine[] = []
  let lastIndex = -1
  for (let index = 0; index < lines.length; index++) {
    if (!keep.has(index)) continue
    if (lastIndex !== -1 && index > lastIndex + 1) result.push({ kind: 'gap' })
    result.push({ kind: 'line', line: lines[index] })
    lastIndex = index
  }
  return result
}

export const FleetDiffModal: React.FC<FleetDiffModalProps> = ({
  task,
  workspacePath,
  onClose,
}) => {
  const { t } = useI18nStore()
  const [state, setState] = useState<DiffState>({ status: 'loading' })
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    setSelectedPath(null)

    api
      .fleetDiff(task.id, workspacePath)
      .then((result) => {
        if (cancelled) return
        if (!result.success) {
          setState({
            status: 'error',
            error: localizeError(result.error) || t('unknownError'),
          })
          return
        }
        const files = result.files ?? []
        setState({ status: 'ready', files, truncated: Boolean(result.truncated) })
        setSelectedPath(files[0]?.path ?? null)
      })
      .catch((error) => {
        if (cancelled) return
        setState({
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      cancelled = true
    }
  }, [task.id, workspacePath, t])

  const selectedFile =
    state.status === 'ready'
      ? state.files.find((file) => file.path === selectedPath) ?? state.files[0] ?? null
      : null

  const diff = useMemo(() => {
    if (!selectedFile || selectedFile.binary) return null
    return computeDiff(
      selectedFile.oldContent,
      selectedFile.newContent,
      selectedFile.path,
      selectedFile.path
    )
  }, [selectedFile])

  const compactLines = useMemo(() => (diff ? compactDiff(diff.lines) : []), [diff])

  const statusLabel = (status: FleetFileChange['status']): string => {
    if (status === 'added') return t('fleetFileAdded')
    if (status === 'deleted') return t('fleetFileDeleted')
    return t('fleetFileModified')
  }

  const statusColor = (status: FleetFileChange['status']): string => {
    if (status === 'added') return 'text-success'
    if (status === 'deleted') return 'text-danger'
    return 'text-warning'
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-baseline gap-2">
          {t('fleetChanges')}
          <span className="truncate type-caption text-ink-muted">{task.name}</span>
        </span>
      }
      size="lg"
      closeLabel={t('close')}
      footer={
        <Button size="sm" onClick={onClose}>
          {t('close')}
        </Button>
      }
    >
      {state.status === 'loading' && (
        <div className="flex h-48 items-center justify-center gap-2 type-value text-ink-muted">
          <Spinner size={13} />
          {t('fleetDiffLoading')}
        </div>
      )}

      {state.status === 'error' && (
        <div className="border-l-2 border-danger bg-danger/5 px-3 py-2 type-caption text-danger">
          {t('fleetDiffFailed', { error: state.error })}
        </div>
      )}

      {state.status === 'ready' && state.files.length === 0 && (
        <EmptyState icon={FileDiff} title={t('fleetDiffEmpty')} compact />
      )}

      {state.status === 'ready' && state.files.length > 0 && (
        <div className="flex h-[62vh] min-h-0">
          <div className="w-56 flex-shrink-0 overflow-y-auto border-r border-rule-divide">
            <div className="border-b border-rule-divide px-3 py-2 type-caption text-ink-muted">
              {t('fleetChangedFiles', { count: state.files.length })}
            </div>
            {state.files.map((file) => {
              const active = file.path === selectedFile?.path
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                  className={`flex w-full flex-col gap-0.5 border-b border-rule-divide px-3 py-2 text-left transition-colors ${
                    active ? 'bg-hover' : 'hover:bg-hover/50'
                  }`}
                >
                  <span className="truncate type-data text-ink" title={file.path}>
                    {file.path}
                  </span>
                  <span className={`type-caption ${statusColor(file.status)}`}>
                    {statusLabel(file.status)}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {selectedFile && (
              <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-rule-divide px-3 py-1.5">
                <span className="truncate type-data text-ink" title={selectedFile.path}>
                  {selectedFile.path}
                </span>
                {diff && (
                  <span className="flex-shrink-0 type-data">
                    <span className="text-success">+{diff.addedCount}</span>{' '}
                    <span className="text-danger">-{diff.removedCount}</span>
                  </span>
                )}
              </div>
            )}

            {state.truncated && (
              <div className="flex-shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-1.5 type-caption text-warning">
                {t('fleetDiffListTruncated')}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-auto bg-sunken">
              {!selectedFile && null}

              {selectedFile?.binary && (
                <div className="p-3 type-caption text-ink-muted">{t('fleetDiffBinary')}</div>
              )}

              {selectedFile && !selectedFile.binary && (
                <>
                  {selectedFile.truncated && (
                    <div className="border-b border-warning/30 bg-warning/10 px-3 py-1.5 type-caption text-warning">
                      {t('fleetDiffTruncated')}
                    </div>
                  )}
                  <div className="min-w-max py-1">
                    {compactLines.map((entry, index) => {
                      if (entry.kind === 'gap') {
                        return (
                          <div
                            key={`gap-${index}`}
                            className="px-3 py-0.5 type-data text-ink-subtle"
                          >
                            …
                          </div>
                        )
                      }

                      const line = entry.line
                      const added = line.type === DiffLineType.Added
                      const removed = line.type === DiffLineType.Removed
                      return (
                        <div
                          key={`line-${index}`}
                          className={`flex ${
                            added ? 'bg-success/10' : removed ? 'bg-danger/10' : ''
                          }`}
                        >
                          <span className="w-10 flex-shrink-0 select-none pr-2 text-right type-data text-ink-subtle">
                            {line.originalLineNumber ?? ''}
                          </span>
                          <span className="w-10 flex-shrink-0 select-none pr-2 text-right type-data text-ink-subtle">
                            {line.modifiedLineNumber ?? ''}
                          </span>
                          <span
                            className={`w-4 flex-shrink-0 select-none text-center type-data ${
                              added ? 'text-success' : removed ? 'text-danger' : 'text-ink-subtle'
                            }`}
                          >
                            {added ? '+' : removed ? '-' : ' '}
                          </span>
                          <span className="whitespace-pre pr-3 type-code text-ink">
                            {line.content || ' '}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
