import React, { Suspense, lazy, useEffect, useState } from 'react'
import { Code, Eye, FileQuestion, FilePlus2 } from 'lucide-react'
import { editorStoreFor, useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import { hasReadingView, supportsSourceView } from '../utils/fileKind'
import { useFileDocument } from '../workspace/useFileDocument'
import { Button, EmptyState, OverlayButton, Spinner } from './ui'
import { EditorTabs } from './EditorTabs'
import { MarkdownReadingView } from './MarkdownReadingView'
import { HtmlPreview } from './HtmlPreview'
import { MediaView } from './MediaView'
import { PdfReadingView } from './PdfReadingView'

// Monaco 体积大：只在真正需要源码视图时加载
const MonacoEditor = lazy(() =>
  import('./MonacoEditor').then((module) => ({ default: module.MonacoEditor }))
)

/** 二进制文件：不猜内容，直接给出系统打开入口 */
const UnsupportedFileView: React.FC<{ path: string; name: string }> = ({ path, name }) => {
  const { t } = useI18nStore()
  const openExternal = async () => {
    const result = await api.openPathExternally(path)
    if (!result.success) {
      toast.error(
        t('openExternallyFailed', { error: localizeError(result.error || 'Failed to open file') })
      )
    }
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
      <EmptyState
        icon={FileQuestion}
        title={t('previewUnavailableTitle')}
        description={`${name} — ${t('previewUnavailableDescription')}`}
        action={
          <Button size="sm" icon={FilePlus2} onClick={openExternal}>
            {t('openExternally')}
          </Button>
        }
      />
    </div>
  )
}

export interface FileViewProps {
  workspacePath: string
  viewRoot?: string
  active?: boolean
}

/**
 * 编辑区容器：标签条 + 视图分发。
 *
 * 视图形态由 `file.kind` 决定，切换按钮只对支持源码视图的类型出现
 * （Markdown / HTML）；媒体类始终是预览。保存与草稿由 `useFileDocument` 承担，
 * 因此阅读视图里的修改与 Monaco 里的修改走同一条落盘路径。
 */
export const FileView: React.FC<FileViewProps> = ({
  workspacePath,
  viewRoot,
  active = true,
}) => {
  const root = viewRoot ?? workspacePath
  const { t } = useI18nStore()
  const store = editorStoreFor(root)
  const { currentFile } = useEditorStore(root)
  useFileDocument({ workspacePath, root, active })

  // Monaco 一经挂载就保留（隐藏而非卸载），这样切回源码视图时撤销栈还在
  const [sourceMounted, setSourceMounted] = useState(false)
  const fileKind = currentFile?.kind
  // 只有 Markdown / HTML 有阅读视图：其余类型即使残留 reading 也按源码处理
  const reading = Boolean(
    currentFile && currentFile.view === 'reading' && hasReadingView(currentFile.kind)
  )
  const canSource = Boolean(currentFile && supportsSourceView(currentFile.kind))
  const readingKind = fileKind && hasReadingView(fileKind) ? fileKind : null

  useEffect(() => {
    if (!currentFile) return
    // 纯文本永远走源码视图；Markdown / HTML 只有切到源码时才加载 Monaco
    if (!supportsSourceView(currentFile.kind)) return
    if (currentFile.kind === 'text' || currentFile.view === 'source') setSourceMounted(true)
  }, [currentFile])

  // 预热 Monaco：Markdown / HTML 随时可能切到源码，先让浏览器把模块取下来，
  // 否则第一次点切换要现等 4MB 模块下载 + 解析
  useEffect(() => {
    if (!canSource) return
    const handle = window.setTimeout(() => void import('./MonacoEditor'), 300)
    return () => window.clearTimeout(handle)
  }, [canSource])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EditorTabs workspacePath={workspacePath} root={root} />

      {!currentFile ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
          <EmptyState
            icon={FilePlus2}
            title={t('noFileOpen')}
            description={t('selectFileToEdit')}
          />
        </div>
      ) : (
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {canSource && (
            <div className={reading ? 'hidden' : 'flex min-h-0 min-w-0 flex-1'}>
              {sourceMounted ? (
                <Suspense
                  fallback={
                    <div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
                      <Spinner />
                    </div>
                  }
                >
                  <MonacoEditor
                    workspacePath={workspacePath}
                    viewRoot={root}
                    active={active && !reading}
                  />
                </Suspense>
              ) : null}
            </div>
          )}

          {/* 阅读视图同样常驻：切回源码再切回来时不必重建 DOM，滚动位置也留着 */}
          {readingKind && (
            <div
              data-testid="file-reading-pane"
              data-active={reading ? 'true' : 'false'}
              className={reading ? 'flex min-h-0 min-w-0 flex-1' : 'hidden'}
            >
              {readingKind === 'markdown' ? (
                <MarkdownReadingView root={root} file={currentFile} active={reading} />
              ) : (
                <HtmlPreview file={currentFile} />
              )}
            </div>
          )}
          {fileKind === 'image' || fileKind === 'video' || fileKind === 'audio' ? (
            <MediaView file={currentFile} />
          ) : null}
          {fileKind === 'pdf' && <PdfReadingView file={currentFile} />}
          {fileKind === 'binary' && (
            <UnsupportedFileView path={currentFile.path} name={currentFile.name} />
          )}

          {/* 视图切换浮在内容右下角：不再和文件标签抢标签条，标签再多也不会被挤出可视区 */}
          {readingKind && (
            <OverlayButton
              data-testid="file-view-toggle"
              icon={reading ? Code : Eye}
              label={reading ? t('viewSource') : t('viewReading')}
              className="absolute bottom-4 right-4 z-10"
              onClick={() => store.getState().toggleFileView(currentFile.path)}
            />
          )}
        </div>
      )}
    </div>
  )
}
