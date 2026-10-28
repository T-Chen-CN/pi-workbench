import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { MarkdownBody } from './AgentMarkdown'
import { Button, Caption, IconButton, Textarea } from './ui'
import { useI18nStore } from '../store/i18nStore'
import { editorStoreFor } from '../store/editorStore'
import { splitMarkdownBlockRanges, type MarkdownBlockRange } from '../utils/markdownBlocks'
import type { OpenFile } from '../types'

const EMPTY_BLOCK: MarkdownBlockRange = { text: '', start: 0, end: 0 }

/**
 * Markdown 阅读视图。
 *
 * 按顶层块渲染排版结果，点击块上的「编辑」把该块的**原文**换成等宽文本框，
 * 提交时按偏移替换回整篇内容 —— 源文件保持原样，不会因为一次编辑被重排，
 * 也不会丢掉 frontmatter、引用式链接或 HTML 片段。
 */
export const MarkdownReadingView: React.FC<{
  root: string
  file: OpenFile
}> = ({ root, file }) => {
  const { t } = useI18nStore()
  const rendered = useMemo(() => {
    const blocks = splitMarkdownBlockRanges(file.content)
    return blocks.length > 0 ? blocks : [EMPTY_BLOCK]
  }, [file.content])
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 切换文件时退出编辑
  useEffect(() => {
    setEditingIndex(null)
  }, [file.path])

  useEffect(() => {
    if (editingIndex === null) return
    const node = textareaRef.current
    if (!node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [editingIndex])

  const startEditing = useCallback(
    (index: number) => {
      const block = rendered[index] ?? EMPTY_BLOCK
      setDraft(block.text)
      setEditingIndex(index)
    },
    [rendered]
  )

  const commit = useCallback(() => {
    if (editingIndex === null) return
    const block = rendered[editingIndex] ?? EMPTY_BLOCK
    setEditingIndex(null)
    if (draft === block.text) return
    const next = file.content.slice(0, block.start) + draft + file.content.slice(block.end)
    if (next === file.content) return
    const store = editorStoreFor(root)
    store.getState().updateOpenFile(file.path, { content: next })
    store.getState().markDirty(file.path)
  }, [draft, editingIndex, file.content, file.path, rendered, root])

  const cancel = useCallback(() => {
    setEditingIndex(null)
    setDraft('')
  }, [])

  const draftRows = Math.min(28, Math.max(4, draft.split('\n').length + 1))

  return (
    <div
      className="min-h-0 flex-1 overflow-auto bg-surface"
      data-testid="markdown-reading-view"
    >
      <article className="file-markdown chat-markdown mx-auto max-w-[68ch] px-8 py-6">
        {rendered.map((block, index) =>
          editingIndex === index ? (
            <div key={`edit-${block.start}`} className="my-3">
              <Textarea
                ref={textareaRef}
                value={draft}
                rows={draftRows}
                spellCheck={false}
                className="type-data"
                aria-label={t('markdownEditBlock')}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancel()
                  }
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault()
                    commit()
                  }
                }}
              />
              <div className="mt-1.5 flex items-center gap-2">
                <Button size="sm" variant="primary" icon={Check} onClick={commit}>
                  {t('save')}
                </Button>
                <Button size="sm" variant="ghost" icon={X} onClick={cancel}>
                  {t('cancel')}
                </Button>
                <Caption className="text-ink-muted">{t('markdownEditHint')}</Caption>
              </div>
            </div>
          ) : (
            <div
              key={`${block.start}-${index}`}
              className="group/block relative"
              data-block-index={index}
            >
              {block.frontmatter ? (
                <pre className="md-frontmatter type-data text-ink-muted">{block.text}</pre>
              ) : block.text.trim() ? (
                <MarkdownBody content={block.text} highlight />
              ) : (
                <button
                  type="button"
                  className="w-full border border-dashed border-rule-control px-3 py-6 type-body text-ink-muted hover:bg-hover hover:text-ink"
                  onClick={() => startEditing(index)}
                >
                  {t('markdownEmpty')}
                </button>
              )}
              <div className="absolute right-0 top-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover/block:opacity-100">
                <IconButton
                  icon={Pencil}
                  label={t('markdownEditBlock')}
                  size="sm"
                  onClick={() => startEditing(index)}
                />
              </div>
            </div>
          )
        )}
      </article>
    </div>
  )
}
