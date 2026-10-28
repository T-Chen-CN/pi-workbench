import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import { filePreviewUrl } from '../utils/fileKind'
import { Button, Caption, IconButton } from './ui'
import type { OpenFile } from '../types'

/** 页面四周留白与页间距，4px 网格 */
const GUTTER = 24
const PAGE_GAP = 16
/** 单页 canvas 像素上限：超过就降采样，避免 4K 屏上每页 9000×12000 */
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024
const ZOOM_MIN = 0.5
const ZOOM_MAX = 4

interface PageSize {
  width: number
  height: number
}

interface PdfPageProps {
  document: PDFDocumentProxy
  pageNumber: number
  scale: number
  size: PageSize
  onSize: (pageNumber: number, size: PageSize) => void
}

/**
 * 单页渲染：只有进入视口（含 ±2 页缓冲）才画 canvas，离开后保留占位与最后一次画面。
 * 缩放变化时取消未完成的渲染任务，避免旧分辨率拖住主线程。
 */
const PdfPage: React.FC<PdfPageProps> = ({ document, pageNumber, scale, size, onSize }) => {
  const holderRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const holder = holderRef.current
    if (!holder || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting)
      },
      { rootMargin: '120% 0px' }
    )
    observer.observe(holder)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let task: { cancel: () => void; promise: Promise<void> } | null = null
    const canvasAtStart = canvasRef.current
    if (canvasAtStart) {
      // 缩放变化时先把绘制尺寸拉到新值：旧分辨率的位图不会短暂拉伸，也不用等 getPage
      canvasAtStart.style.width = `${Math.round(size.width * scale)}px`
      canvasAtStart.style.height = `${Math.round(size.height * scale)}px`
      canvasAtStart.dataset.rendered = 'false'
    }

    void document
      .getPage(pageNumber)
      .then((loaded) => {
        if (cancelled) return
        const base = loaded.getViewport({ scale: 1 })
        onSize(pageNumber, { width: base.width, height: base.height })

        const canvas = canvasAtStart
        if (!canvas) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        let renderScale = scale * dpr
        const pixels = base.width * base.height * renderScale * renderScale
        if (pixels > MAX_CANVAS_PIXELS) {
          renderScale = Math.max(scale, renderScale * Math.sqrt(MAX_CANVAS_PIXELS / pixels))
        }
        const viewport = loaded.getViewport({ scale: renderScale })
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))
        const context = canvas.getContext('2d')
        if (!context) return
        task = loaded.render({ canvas, canvasContext: context, viewport })
        void task.promise
          .then(() => {
            if (!cancelled) canvas.dataset.rendered = 'true'
          })
          .catch(() => undefined)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
      task?.cancel()
      // 离开视口就释放 canvas 占用的像素内存：单页 1224×1584 @dpr2 约 31MB，
      // 留着让长文档滚一遍就吃掉上 GB。pdf.js 缓存了解析结果，回滚时重绘很快。
      const canvas = canvasAtStart
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
        canvas.style.width = `${Math.round(size.width * scale)}px`
        canvas.style.height = `${Math.round(size.height * scale)}px`
        delete canvas.dataset.rendered
      }
    }
  }, [document, pageNumber, scale, size, visible, onSize])

  return (
    <div
      ref={holderRef}
      data-page={pageNumber}
      // overflow-hidden：缩小时未重绘的旧画布不能把滚动容器撑出横向滚动条
      className="flex-shrink-0 overflow-hidden border border-rule-hairline bg-surface"
      style={{ width: Math.round(size.width * scale), height: Math.round(size.height * scale) }}
    >
      <canvas ref={canvasRef} className="block" aria-label={`page ${pageNumber}`} />
    </div>
  )
}

/**
 * PDF 阅读视图：pdf.js 自绘。
 *
 * 之前用 Chromium 内置查看器（iframe），滚动要在嵌套的 OOPIF 里做命中测试与合成，
 * 明显发涩；工具条也是它的黑盒 UI。这里换成单一滚动容器 + canvas 虚拟化，
 * 模板与 Markdown / 媒体阅读视图一致。
 */
export const PdfReadingView: React.FC<{ file: OpenFile }> = ({ file }) => {
  const { t } = useI18nStore()
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({})
  const [containerWidth, setContainerWidth] = useState(0)
  const [fitWidth, setFitWidth] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [failed, setFailed] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)

  const openExternal = async () => {
    const result = await api.openPathExternally(file.path)
    if (!result.success) {
      toast.error(
        t('openExternallyFailed', { error: localizeError(result.error || 'Failed to open file') })
      )
    }
  }

  // 文档加载：pdf.js 主库 + worker 都在这条动态导入后面，只有打开 PDF 才载入
  useEffect(() => {
    let cancelled = false
    let destroy: (() => void) | null = null
    setFailed(false)
    setDocument(null)
    setNumPages(0)
    setPageSizes({})
    setCurrentPage(1)

    void import('../pdf/loadPdf')
      .then(({ loadPdf }) => loadPdf(filePreviewUrl(file.path, file.version)))
      .then(async (result) => {
        if (cancelled) {
          result.destroy()
          return
        }
        destroy = result.destroy
        const first = await result.document.getPage(1)
        if (cancelled) return
        const viewport = first.getViewport({ scale: 1 })
        setDocument(result.document)
        setNumPages(result.document.numPages)
        setPageSizes({ 1: { width: viewport.width, height: viewport.height } })
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
      destroy?.()
    }
  }, [file.path, file.version])

  // 适应宽度需要知道容器宽度：面板拖拽、窗口缩放都要跟
  useEffect(() => {
    const element = scrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width)
    })
    observer.observe(element)
    setContainerWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  const baseSize = pageSizes[1] ?? null
  const fitScale =
    baseSize && containerWidth > 0 ? (containerWidth - GUTTER * 2) / baseSize.width : 1
  const scale = fitWidth ? Math.max(0.1, fitScale) : zoom

  const sizeFor = useCallback(
    (pageNumber: number): PageSize =>
      pageSizes[pageNumber] ?? baseSize ?? { width: 612, height: 792 },
    [pageSizes, baseSize]
  )

  const handlePageSize = useCallback((pageNumber: number, size: PageSize) => {
    setPageSizes((previous) => {
      const existing = previous[pageNumber]
      if (existing && existing.width === size.width && existing.height === size.height) {
        return previous
      }
      return { ...previous, [pageNumber]: size }
    })
  }, [])

  const scrollToPage = useCallback((pageNumber: number) => {
    const container = scrollRef.current
    if (!container) return
    const target = container.querySelector<HTMLElement>(`[data-page="${pageNumber}"]`)
    if (!target) return
    container.scrollTop = target.offsetTop - PAGE_GAP
    setCurrentPage(pageNumber)
  }, [])

  const handleScroll = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      const container = scrollRef.current
      if (!container) return
      const pages = container.querySelectorAll<HTMLElement>('[data-page]')
      const probe = container.scrollTop + 48
      let next = 1
      for (const element of pages) {
        if (element.offsetTop <= probe) next = Number(element.dataset.page)
        else break
      }
      setCurrentPage((previous) => (previous === next ? previous : next))
    })
  }, [])

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
  }, [])

  const applyZoom = (next: number) => {
    setFitWidth(false)
    setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)))
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!numPages) return
    const withModifier = event.ctrlKey || event.metaKey
    if (withModifier && event.key === '0') {
      event.preventDefault()
      setFitWidth(true)
      return
    }
    if (withModifier) return
    switch (event.key) {
      case 'PageDown':
        event.preventDefault()
        scrollToPage(Math.min(numPages, currentPage + 1))
        break
      case 'PageUp':
        event.preventDefault()
        scrollToPage(Math.max(1, currentPage - 1))
        break
      case 'Home':
        event.preventDefault()
        scrollToPage(1)
        break
      case 'End':
        event.preventDefault()
        scrollToPage(numPages)
        break
      case '+':
      case '=':
        event.preventDefault()
        applyZoom(scale * 1.2)
        break
      case '-':
        event.preventDefault()
        applyZoom(scale / 1.2)
        break
      default:
        break
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface" data-testid="pdf-reading-view">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-rule-divide bg-panel px-3 py-1">
        <Caption className="truncate text-ink-muted">{file.name}</Caption>
        <div className="ml-auto flex items-center gap-1">
          {failed ? null : (
            <>
              <IconButton
                icon={ChevronUp}
                label={t('previousPage')}
                size="sm"
                disabled={currentPage <= 1}
                onClick={() => scrollToPage(Math.max(1, currentPage - 1))}
              />
              <span className="type-data px-1 text-ink-muted" data-testid="pdf-page-indicator">
                {numPages ? `${currentPage} / ${numPages}` : '–'}
              </span>
              <IconButton
                icon={ChevronDown}
                label={t('nextPage')}
                size="sm"
                disabled={!numPages || currentPage >= numPages}
                onClick={() => scrollToPage(Math.min(numPages, currentPage + 1))}
              />
              <IconButton
                icon={ZoomOut}
                label={t('zoomOut')}
                size="sm"
                disabled={fitWidth ? false : zoom <= ZOOM_MIN}
                onClick={() => applyZoom(scale / 1.2)}
              />
              <IconButton
                icon={ZoomIn}
                label={t('zoomIn')}
                size="sm"
                disabled={fitWidth ? false : zoom >= ZOOM_MAX}
                onClick={() => applyZoom(scale * 1.2)}
              />
              <IconButton
                icon={Maximize2}
                label={t('fitWidth')}
                size="sm"
                active={fitWidth}
                onClick={() => setFitWidth(true)}
              />
              <IconButton
                icon={ExternalLink}
                label={t('openExternally')}
                size="sm"
                onClick={openExternal}
              />
            </>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        tabIndex={0}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        data-testid="pdf-scroll"
        aria-label={file.name}
        // scrollbar-gutter：竖滚动条占位固定，避免「页宽变大 → 出现竖条 → 可用宽度变小 → 再变窄」的抖动
        className="min-h-0 flex-1 overflow-auto bg-sunken py-4 [scrollbar-gutter:stable] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="type-reading text-ink-muted">{t('pdfLoadFailed')}</p>
            <Button size="sm" icon={ExternalLink} onClick={openExternal}>
              {t('openExternally')}
            </Button>
          </div>
        ) : !document || !numPages ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 size={16} className="animate-spin text-ink-muted" aria-hidden="true" />
          </div>
        ) : (
          <div className="flex flex-col items-center" style={{ gap: PAGE_GAP }}>
            {Array.from({ length: numPages }, (_, index) => (
              <PdfPage
                key={index + 1}
                document={document}
                pageNumber={index + 1}
                scale={scale}
                size={sizeFor(index + 1)}
                onSize={handlePageSize}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
