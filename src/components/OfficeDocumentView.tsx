/**
 * Office / EPUB 文档的只读预览。
 *
 * 数据来自主进程 `documents:preview`（同一条 ooxml 解析链的产物），因此这里不做
 * 任何文件读取，也没有编辑能力：文书类文件的真相源仍在原文件与 Office 里。
 *
 * 布局沿用媒体与 PDF 工具条（1px `rule-divide`、左侧文件名 `type-caption`），
 * 内容排版复用 `.chat-markdown` 的排版规则（标题 / 段落 / 列表 / 表格 / 图片
 * 都由它定义，Paper 与 Ink 两套主题自动跟随）。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, FileWarning, RefreshCw } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import { Button, Caption, IconButton, Spinner } from './ui'
import type {
  DocumentPreview,
  DocumentPreviewBlock,
  DocumentPreviewSheet,
  DocumentPreviewSlide,
} from '../types/electron'
import type { OpenFile } from '../types'

/** 列字母：A…Z、AA… 只用于表头 */
function columnLabel(index: number): string {
  let label = ''
  let value = index
  while (value >= 0) {
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26) - 1
  }
  return label
}

const Blocks: React.FC<{ blocks: DocumentPreviewBlock[] }> = ({ blocks }) => {
  // 连续的 bullet 归到同一个列表里，否则每个符号点都是独立的 <ul>
  const groups = useMemo(() => {
    const result: Array<{ type: 'bullets'; items: string[] } | { type: 'block'; block: DocumentPreviewBlock }> = []
    for (const block of blocks) {
      if (block.type === 'bullet') {
        const last = result[result.length - 1]
        if (last && last.type === 'bullets') last.items.push(block.text)
        else result.push({ type: 'bullets', items: [block.text] })
        continue
      }
      result.push({ type: 'block', block })
    }
    return result
  }, [blocks])

  return (
    <>
      {groups.map((group, index) => {
        if (group.type === 'bullets') {
          return (
            <ul key={`bullets-${index}`}>
              {group.items.map((item, itemIndex) => (
                <li key={`${index}-${itemIndex}`}>{item}</li>
              ))}
            </ul>
          )
        }
        const block = group.block
        if (block.type === 'heading') {
          const Tag = `h${Math.min(block.level + 1, 5)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5'
          return <Tag key={index}>{block.text}</Tag>
        }
        if (block.type === 'table') {
          const [first, ...rest] = block.rows
          return (
            <table key={index}>
              <tbody>
                {first && rest.length > 0 ? (
                  <tr>
                    {first.map((cell, cellIndex) => (
                      <th key={cellIndex}>{cell}</th>
                    ))}
                  </tr>
                ) : null}
                {(rest.length > 0 ? rest : first ? [first] : []).map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
        return <p key={index}>{block.text}</p>
      })}
    </>
  )
}

const SheetTable: React.FC<{ sheet: DocumentPreviewSheet }> = ({ sheet }) => {
  if (sheet.rows.length === 0) return null
  const columns = Math.max(...sheet.rows.map((row) => row.length))
  return (
    <table className="border-collapse type-data">
      <thead>
        <tr>
          <th className="sticky left-0 top-0 bg-panel px-2 py-1 text-ink-subtle" />
          {Array.from({ length: columns }, (_, index) => (
            <th
              key={index}
              className="sticky top-0 min-w-[72px] border border-rule-hairline bg-panel px-2 py-1 text-left text-ink-muted"
            >
              {columnLabel(index)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sheet.rows.map((row, rowIndex) => (
          <tr key={rowIndex} className="hover:bg-hover">
            <td className="sticky left-0 border border-rule-hairline bg-panel px-2 py-1 text-right text-ink-subtle">
              {rowIndex + 1}
            </td>
            {Array.from({ length: columns }, (_, columnIndex) => (
              <td
                key={columnIndex}
                className="max-w-[320px] truncate border border-rule-hairline px-2 py-1 text-ink"
                title={row[columnIndex] ?? ''}
              >
                {row[columnIndex] ?? ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const SlideCards: React.FC<{ slides: DocumentPreviewSlide[] }> = ({ slides }) => {
  const { t } = useI18nStore()
  return (
    <div className="flex flex-col gap-3 pb-12">
      {slides.map((slide) => (
        <section key={slide.index} className="border border-rule-hairline bg-surface">
          <header className="flex items-center gap-2 border-b border-rule-hairline bg-panel px-3 py-1">
            <Caption className="text-ink-subtle">
              {t('documentSlideLabel', { index: slide.index })}
            </Caption>
            <Caption className="ml-auto text-ink-subtle">
              {t('documentSlideTextCount', { count: slide.lines.length })}
            </Caption>
          </header>
          <div className="flex flex-col gap-2 px-4 py-3">
            {slide.lines.length === 0 ? (
              <p className="type-reading text-ink-subtle">{t('documentSlideEmpty')}</p>
            ) : (
              slide.lines.map((line, index) => (
                <p key={index} className={index === 0 ? 'type-reading text-ink' : 'type-body text-ink-muted'}>
                  {line}
                </p>
              ))
            )}
            {slide.images.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {slide.images.map((image, index) => (
                  <img
                    key={`${image.name}-${index}`}
                    src={image.dataUrl}
                    alt={image.name}
                    className="max-h-64 max-w-full border border-rule-hairline"
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  )
}

/**
 * 文档预览：主进程解析 → 结构化模型 → 这里按 kind 分发。
 *
 * `office-legacy` 是特例：不是「预览失败」，而是「换个格式就能读」，所以给出
 * 明确的另存为指引，而不是一句 unsupported。
 */
export const OfficeDocumentView: React.FC<{ file: OpenFile }> = ({ file }) => {
  const { t } = useI18nStore()
  const [preview, setPreview] = useState<DocumentPreview | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [sheetIndex, setSheetIndex] = useState(0)

  // 加载与手动重载走同一条路径：外部改动后点刷新不必重挂组件
  const load = useCallback(() => {
    let cancelled = false
    setPreview(null)
    setFailed(null)
    void api.documentsPreview(file.path).then((result) => {
      if (cancelled) return
      if (!result.success || !result.preview) {
        setFailed(localizeError(result.error || 'Failed to read document'))
        return
      }
      setPreview(result.preview)
    })
    return () => {
      cancelled = true
    }
  }, [file.path])

  useEffect(() => {
    setSheetIndex(0)
    return load()
  }, [load, file.version])

  const openExternal = async () => {
    const result = await api.openPathExternally(file.path)
    if (!result.success) {
      toast.error(
        t('openExternallyFailed', { error: localizeError(result.error || 'Failed to open file') })
      )
    }
  }

  const sheets = preview?.kind === 'sheet' ? preview.sheets : []
  const activeSheet = sheets[Math.min(sheetIndex, Math.max(sheets.length - 1, 0))]

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface" data-testid="office-document-view">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-rule-divide bg-panel px-3 py-1">
        <Caption className="truncate text-ink-muted">{file.name}</Caption>
        <Caption className="flex-shrink-0 text-ink-subtle">{t('documentReadOnly')}</Caption>
        {preview?.kind === 'sheet' && sheets.length > 1 && (
          <div className="ml-2 flex min-w-0 items-center gap-1 overflow-x-auto">
            {sheets.map((sheet, index) => (
              <button
                key={sheet.name}
                type="button"
                onClick={() => setSheetIndex(index)}
                className={`type-caption rounded-sm px-2 py-0.5 transition-colors ${
                  index === sheetIndex ? 'bg-hover text-ink' : 'text-ink-muted hover:bg-hover'
                }`}
              >
                {sheet.name}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex flex-shrink-0 items-center gap-1">
          <IconButton
            icon={RefreshCw}
            label={t('previewReload')}
            size="sm"
            onClick={() => load()}
          />
          <IconButton
            icon={ExternalLink}
            label={t('openExternally')}
            size="sm"
            onClick={openExternal}
          />
        </div>
      </div>

      {failed ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FileWarning size={20} className="text-warning" />
          <p className="type-reading text-ink-muted">{failed}</p>
          <Button size="sm" icon={ExternalLink} onClick={openExternal}>
            {t('openExternally')}
          </Button>
        </div>
      ) : !preview ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : preview.kind === 'legacy' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FileWarning size={20} className="text-warning" />
          <p className="max-w-[42rem] whitespace-pre-line type-reading text-ink-muted">
            {preview.message}
          </p>
          <Button size="sm" icon={ExternalLink} onClick={openExternal}>
            {t('openExternally')}
          </Button>
        </div>
      ) : preview.kind === 'error' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FileWarning size={20} className="text-warning" />
          <p className="type-reading text-ink-muted">{preview.message}</p>
        </div>
      ) : preview.kind === 'sheet' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {activeSheet ? (
            <>
              {activeSheet.rows.length === 0 ? (
                <p className="px-4 py-6 type-reading text-ink-subtle">{t('documentSheetEmpty')}</p>
              ) : (
                <SheetTable sheet={activeSheet} />
              )}
              {(activeSheet.truncated || activeSheet.merges.length > 0) && (
                <p className="px-3 py-2 type-caption text-ink-subtle">
                  {activeSheet.truncated
                    ? t('documentSheetTruncated')
                    : t('documentSheetMerged', { count: activeSheet.merges.length })}
                </p>
              )}
            </>
          ) : null}
        </div>
      ) : preview.kind === 'slide' ? (
        <div className="min-h-0 flex-1 overflow-auto px-6 pt-4">
          <SlideCards slides={preview.slides} />
        </div>
      ) : preview.kind === 'epub' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="chat-markdown file-markdown mx-auto w-full max-w-[64rem] px-8 pt-6 pb-12">
            {preview.chapters.map((chapter, index) => (
              <section key={`${chapter.label}-${index}`}>
                <h2 className="type-label text-ink-subtle">{chapter.label}</h2>
                {chapter.lines.map((line, lineIndex) => (
                  <p key={lineIndex}>{line}</p>
                ))}
              </section>
            ))}
          </div>
        </div>
      ) : preview.kind === 'word' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="chat-markdown file-markdown mx-auto w-full max-w-[64rem] px-8 pt-6 pb-12">
            <Blocks blocks={preview.blocks} />
            {preview.truncated && (
              <p className="type-caption text-ink-subtle">{t('documentPreviewTruncated')}</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
