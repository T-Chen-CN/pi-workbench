import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, ExternalLink } from 'lucide-react'
import { piAgentAPI } from '../api/piAgentAPI'
import type { ToolResultMeta } from '../types/electron'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { Button, Caption, IconButton, Modal, Spinner } from './ui'
import { SearchField } from './patterns'

/** 每次读取的字符数；分块传输避免超长结果一次性进入渲染进程 */
const CHUNK_CHARS = 262_144
/** 超过该大小时默认不在内嵌查看器中加载，改为外部编辑器打开 */
const AUTO_VIEW_BYTES = 20 * 1024 * 1024

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export interface ToolResultViewerProps {
  workspacePath: string
  sessionId: string
  toolCallId: string
  toolName: string
  onClose: () => void
}

/** 工具结果全量查看器（R-20）：只读，不修改会话，也不重新注入 Agent 上下文 */
export const ToolResultViewer: React.FC<ToolResultViewerProps> = ({
  workspacePath,
  sessionId,
  toolCallId,
  toolName,
  onClose,
}) => {
  const { t } = useI18nStore()
  const [meta, setMeta] = useState<ToolResultMeta | null>(null)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [imageIndex, setImageIndex] = useState(0)
  const [showImage, setShowImage] = useState(false)
  const [opening, setOpening] = useState(false)
  const [started, setStarted] = useState(false)

  const loadText = useCallback(
    async (total: number) => {
      setLoading(true)
      setError(null)
      let offset = 0
      let acc = ''
      try {
        for (;;) {
          const chunk = await piAgentAPI.readToolResultChunk(
            workspacePath,
            sessionId,
            toolCallId,
            offset,
            CHUNK_CHARS
          )
          if (!chunk.success) {
            setError(chunk.error ?? t('toolResultLoadFailed', { error: '' }))
            break
          }
          acc += chunk.text ?? ''
          if (chunk.done) break
          const next = chunk.nextOffset ?? offset
          if (next <= offset) break
          offset = next
          if (total > 0) setProgress(Math.min(99, Math.round((offset / total) * 100)))
        }
        setProgress(100)
      } finally {
        setText(acc)
        setLoading(false)
      }
    },
    [workspacePath, sessionId, toolCallId, t]
  )

  useEffect(() => {
    let cancelled = false
    setMeta(null)
    setText('')
    setError(null)
    setProgress(0)
    setStarted(false)
    setImage(null)
    setQuery('')

    void (async () => {
      const result = await piAgentAPI.getToolResultMeta(workspacePath, sessionId, toolCallId)
      if (cancelled) return
      if (!result.success || !result.meta) {
        setError(t('toolResultLoadFailed', { error: result.error ?? '' }))
        setLoading(false)
        return
      }
      const nextMeta = result.meta
      setMeta(nextMeta)

      if (nextMeta.imageCount > 0) {
        const loaded = await piAgentAPI.getToolResultImage(workspacePath, sessionId, toolCallId, 0)
        if (cancelled) return
        if (loaded.success && loaded.data) {
          setImage(`data:${loaded.mimeType ?? 'image/png'};base64,${loaded.data}`)
        }
      }

      if (nextMeta.kind === 'image') {
        setLoading(false)
        return
      }
      if (nextMeta.bytes > AUTO_VIEW_BYTES) {
        setLoading(false)
        return
      }
      setStarted(true)
      await loadText(nextMeta.chars)
    })()

    return () => {
      cancelled = true
    }
  }, [workspacePath, sessionId, toolCallId, loadText, t])

  const lines = useMemo(() => (text.length > 0 ? text.split('\n') : []), [text])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return null
    const found: Array<{ lineNumber: number; text: string }> = []
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].toLowerCase().includes(needle)) {
        found.push({ lineNumber: index + 1, text: lines[index] })
        if (found.length >= 5_000) break
      }
    }
    return found
  }, [lines, query])

  const rows = useMemo(
    () =>
      matches ?? lines.map((line, index) => ({ lineNumber: index + 1, text: line })),
    [matches, lines]
  )

  const { parentRef, virtualizer } = useVirtualRows({
    count: rows.length,
    estimateSize: 18,
    overscan: 12,
  })

  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 })
  }, [query, parentRef])

  const handleCopy = async () => {
    try {
      const content = matches ? matches.map((match) => match.text).join('\n') : text
      await navigator.clipboard.writeText(content)
      toast.info(t('toolResultCopied'))
    } catch (err) {
      toast.error(String(err))
    }
  }

  const handleOpenExternal = async () => {
    setOpening(true)
    const result = await piAgentAPI.openToolResultExternally(workspacePath, sessionId, toolCallId)
    setOpening(false)
    if (!result.success) {
      toast.error(t('toolResultOpenFailed', { error: result.error ?? '' }))
    }
  }

  const canCopy = !loading && (text.length > 0 || matches !== null)
  const tooLarge = Boolean(meta && meta.bytes > AUTO_VIEW_BYTES)

  const selectImage = async (index: number) => {
    const loaded = await piAgentAPI.getToolResultImage(
      workspacePath,
      sessionId,
      toolCallId,
      index
    )
    if (loaded.success && loaded.data) {
      setImage(`data:${loaded.mimeType ?? 'image/png'};base64,${loaded.data}`)
      setImageIndex(index)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${t('toolResultTitle')} · ${meta?.toolName || toolName}`}
      size="lg"
      closeLabel={t('close')}
    >
      <div className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {meta && (
            <Caption className="text-ink-muted">
              {formatBytes(meta.bytes)}
              {meta.kind === 'text' && ` · ${meta.lines.toLocaleString()} ${t('toolResultLines')}`}
              {meta.imageCount > 1 &&
                ` · ${t('toolResultImages', { count: meta.imageCount })}`}
            </Caption>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder={t('toolResultSearch')}
              ariaLabel={t('toolResultSearch')}
              className="w-48"
            />
            <IconButton
              icon={Copy}
              label={t('toolResultCopy')}
              size="sm"
              onClick={() => void handleCopy()}
              disabled={!canCopy}
            />
            <Button
              size="sm"
              icon={ExternalLink}
              loading={opening}
              onClick={() => void handleOpenExternal()}
            >
              {t('toolResultOpenExternal')}
            </Button>
          </span>
        </div>

        {error && (
          <div className="border border-rule-hairline bg-raised p-3 type-caption text-danger">
            {error}
          </div>
        )}

        {image && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowImage(true)}
              className="w-fit border border-rule-hairline bg-sunken p-1"
              aria-label={t('toolResultPreviewImage')}
            >
              <img
                src={image}
                alt={toolName}
                className="max-h-80 max-w-full object-contain"
              />
            </button>
            {meta && meta.imageCount > 1 && (
              <span className="flex items-center gap-0.5">
                <IconButton
                  icon={ChevronLeft}
                  label={t('previousImage')}
                  size="sm"
                  disabled={imageIndex <= 0}
                  onClick={() => void selectImage(imageIndex - 1)}
                />
                <Caption className="text-ink-muted">
                  {imageIndex + 1}/{meta.imageCount}
                </Caption>
                <IconButton
                  icon={ChevronRight}
                  label={t('nextImage')}
                  size="sm"
                  disabled={imageIndex >= meta.imageCount - 1}
                  onClick={() => void selectImage(imageIndex + 1)}
                />
              </span>
            )}
          </div>
        )}

        {meta?.kind === 'image' && !image && !loading && !error && (
          <Caption className="text-ink-muted">{t('toolResultEmpty')}</Caption>
        )}

        {tooLarge && !started && (
          <div className="flex flex-col gap-2 border border-rule-hairline bg-raised p-3">
            <Caption className="text-ink-muted">
              {t('toolResultLargeHint', { size: formatBytes(meta?.bytes ?? 0) })}
            </Caption>
            <div>
              <Button
                size="sm"
                onClick={() => {
                  setStarted(true)
                  void loadText(meta?.chars ?? 0)
                }}
              >
                {t('toolResultLoadInViewer')}
              </Button>
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 py-3 type-caption text-ink-muted">
            <Spinner size={12} />
            {t('toolResultLoading', { percent: progress })}
          </div>
        )}

        {!loading && !error && started && rows.length > 0 && (
          <>
            {matches !== null && (
              <Caption className="text-ink-muted">
                {t('toolResultMatches', { count: matches.length })}
              </Caption>
            )}
            <div
              ref={parentRef}
              className="h-[55vh] overflow-auto border border-rule-hairline bg-sunken"
            >
              {virtualizer.getVirtualItems().length > 0 ? (
                <div
                  style={{
                    height: `${virtualizer.getTotalSize()}px`,
                    position: 'relative',
                    width: '100%',
                  }}
                >
                  {virtualizer.getVirtualItems().map((row) => {
                    const item = rows[row.index]
                    if (!item) return null
                    return (
                      <div
                        key={row.index}
                        data-index={row.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${row.start}px)`,
                        }}
                        className="flex items-start gap-2 px-2 py-0.5 type-data"
                      >
                        <span className="w-12 flex-shrink-0 select-none text-right text-ink-subtle">
                          {item.lineNumber}
                        </span>
                        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">
                          {item.text || ' '}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                // 无滚动测量环境（如 jsdom）或首帧时退化为前几行
                <div>
                  {rows.slice(0, 200).map((item) => (
                    <div
                      key={item.lineNumber}
                      className="flex items-start gap-2 px-2 py-0.5 type-data"
                    >
                      <span className="w-12 flex-shrink-0 select-none text-right text-ink-subtle">
                        {item.lineNumber}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">
                        {item.text || ' '}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {matches !== null && rows.length === 0 && (
              <Caption className="text-ink-muted">{t('toolResultNoMatches')}</Caption>
            )}
          </>
        )}

        {!loading && !error && started && rows.length === 0 && (
          <Caption className="text-ink-muted">{t('toolResultEmpty')}</Caption>
        )}
      </div>

      {showImage && image && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/70 p-6"
          onClick={() => setShowImage(false)}
        >
          <img src={image} alt={toolName} className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </Modal>
  )
}
