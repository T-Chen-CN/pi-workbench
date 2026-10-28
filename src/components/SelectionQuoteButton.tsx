/**
 * 划词引用：选区浮起的「引用到对话」按钮。
 *
 * 只在带 `data-quote-scope` 的区域内生效（文档阅读视图与 Agent 回复），
 * 选区为空 / 过短 / 落在输入框等其它区域时自动隐藏。
 *
 * 面板可能被拆进辅助窗口：此时 DOM 在另一个 document 里，监听与坐标都必须
 * 走那个文档（`doc` 参数），不能读全局 `document`。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { TextQuote } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import { basename } from '../utils/filePath'
import { MAX_QUOTE_CHARS, addChatQuote } from '../workspace/quoteSelection'

interface SelectionInfo {
  text: string
  docPath: string | null
  title: string
  rect: { top: number; right: number; bottom: number }
}

/** 选区所属的引用域；不在域内返回 null */
function resolveScope(node: Node | null): { docPath: string | null } | null {
  const element = node ? (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement) : null
  const host = element?.closest('[data-quote-scope]')
  if (!host) return null
  const scope = host.getAttribute('data-quote-scope')
  if (scope !== 'doc' && scope !== 'chat') return null
  return { docPath: scope === 'doc' ? host.getAttribute('data-quote-doc') : null }
}

export interface SelectionQuoteButtonProps {
  /** 监听哪个文档的选区；辅助窗口里的面板要传它自己的 document */
  doc?: Document
}

export const SelectionQuoteButton: React.FC<SelectionQuoteButtonProps> = ({ doc }) => {
  const { t } = useI18nStore()
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const rangeRef = useRef<Range | null>(null)
  const documentRef = doc ?? (typeof document === 'undefined' ? null : document)

  const measure = useCallback(() => {
    if (!documentRef) return
    const active = documentRef.getSelection()
    const text = active?.toString().trim() ?? ''
    if (!active || active.rangeCount === 0 || active.isCollapsed || text.length < 2) {
      rangeRef.current = null
      setSelection(null)
      return
    }
    const scope = resolveScope(active.anchorNode) ?? resolveScope(active.focusNode)
    if (!scope) {
      rangeRef.current = null
      setSelection(null)
      return
    }
    const range = active.getRangeAt(0).cloneRange()
    const rect = range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      rangeRef.current = null
      setSelection(null)
      return
    }
    rangeRef.current = range
    setSelection({
      text,
      docPath: scope.docPath,
      title: scope.docPath ? basename(scope.docPath) || scope.docPath : t('quoteFromChat'),
      rect: { top: rect.top, right: rect.right, bottom: rect.bottom }
    })
  }, [documentRef, t])

  useEffect(() => {
    if (!documentRef) return
    const view = documentRef.defaultView
    let timer: number | null = null
    const schedule = () => {
      if (timer !== null) view?.clearTimeout(timer)
      timer = view?.setTimeout(measure, 120) ?? null
    }
    const onScroll = () => {
      if (!rangeRef.current) return
      const rect = rangeRef.current.getBoundingClientRect()
      setSelection((prev) =>
        prev ? { ...prev, rect: { top: rect.top, right: rect.right, bottom: rect.bottom } } : prev
      )
    }
    documentRef.addEventListener('selectionchange', schedule)
    documentRef.addEventListener('scroll', onScroll, true)
    view?.addEventListener('resize', onScroll)
    return () => {
      if (timer !== null) view?.clearTimeout(timer)
      documentRef.removeEventListener('selectionchange', schedule)
      documentRef.removeEventListener('scroll', onScroll, true)
      view?.removeEventListener('resize', onScroll)
    }
  }, [documentRef, measure])

  if (!selection) return null

  // 选区上方优先；贴近视口顶部时落到下方
  const viewWidth = documentRef?.defaultView?.innerWidth ?? 1280
  const above = selection.rect.top > 44
  const style: React.CSSProperties = {
    position: 'fixed',
    top: above ? selection.rect.top - 32 : selection.rect.bottom + 8,
    left: Math.max(8, Math.min(selection.rect.right - 112, viewWidth - 136)),
    zIndex: 40
  }

  const quote = () => {
    const result = addChatQuote({
      text: selection.text,
      title: selection.title,
      sourcePath: selection.docPath ?? undefined
    })
    if (result === 'ok') toast.info(t('quotedToChat'))
    else if (result === 'too-long') toast.error(t('quoteTooLong', { count: MAX_QUOTE_CHARS }))
    else if (result === 'no-session') toast.error(t('quoteNoSession'))
    else toast.error(t('quoteSelection'))
    documentRef?.getSelection()?.removeAllRanges()
    rangeRef.current = null
    setSelection(null)
  }

  return (
    <button
      type="button"
      style={style}
      onMouseDown={(event) => event.preventDefault()}
      onClick={quote}
      className="flex items-center gap-1 border border-line bg-raised px-2 py-1 type-caption text-ink shadow-print transition-colors hover:text-accent"
    >
      <TextQuote size={12} />
      {t('quoteSelection')}
    </button>
  )
}
