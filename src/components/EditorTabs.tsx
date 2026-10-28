import React from 'react'
import {
  FileCode,
  FileIcon,
  FileJson,
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  Loader2,
  Music,
  X,
} from 'lucide-react'
import { useEditorStore, editorStoreFor } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { confirmDialog } from '../store/dialogStore'
import type { OpenFile } from '../types'

/** 标签图标按文件类型区分：阅读视图类型不再统一显示代码图标 */
function iconFor(file: OpenFile) {
  switch (file.kind) {
    case 'markdown':
      return FileText
    case 'html':
      return Globe
    case 'image':
      return ImageIcon
    case 'video':
      return Film
    case 'audio':
      return Music
    case 'pdf':
      return FileText
    case 'binary':
      return FileIcon
    default:
      if (/\.json$/i.test(file.name)) return FileJson
      if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|css)$/i.test(file.name)) return FileCode
      return FileText
  }
}

export interface EditorTabsProps {
  workspacePath: string
  root: string
}

/** 文件标签条：活跃标签、脏标记、关闭。视图切换不在这里（见 FileView 右下角浮层） */
export const EditorTabs: React.FC<EditorTabsProps> = ({ workspacePath, root }) => {
  const { t } = useI18nStore()
  const store = editorStoreFor(root)
  const { currentFile, openFiles, removeOpenFile } = useEditorStore(root)

  if (openFiles.length === 0) return null

  return (
    <div
      data-testid="editor-tabs"
      className="flex flex-shrink-0 items-stretch overflow-x-auto border-b border-rule-divide bg-panel"
    >
      {openFiles.map((file) => {
        const active = currentFile?.path === file.path
        const Icon = iconFor(file)
        return (
          <div
            key={file.path}
            className={`group flex h-[34px] items-center gap-2 border-r border-rule-divide pl-3 pr-1.5 type-label transition-colors ${
              active
                ? 'bg-surface text-ink shadow-[inset_0_2px_0_rgb(var(--accent))]'
                : 'text-ink-muted hover:bg-hover hover:text-ink'
            }`}
          >
            <button
              type="button"
              className="flex max-w-[220px] items-center gap-1.5 bg-transparent text-inherit"
              title={file.path}
              onClick={() => store.setState({ currentFile: file })}
            >
              <Icon size={12} className={active ? 'text-accent' : 'text-ink-muted'} />
              <span className="truncate">{file.name}</span>
              {file.isDirty && (
                <span
                  className="h-1 w-1 flex-shrink-0 rounded-full bg-accent"
                  title={t('unsavedChanges')}
                />
              )}
              {file.isSaving && <Loader2 size={10} className="animate-spin text-ink-muted" />}
            </button>
            <button
              type="button"
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-ink-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
              aria-label={t('close')}
              title={t('close')}
              onClick={async () => {
                const target = store.getState().openFiles.find((f) => f.path === file.path)
                if (
                  target?.isDirty &&
                  !(await confirmDialog({
                    message: t('discardChangesConfirm'),
                    danger: true,
                  }))
                ) {
                  return
                }
                if (workspacePath) {
                  void api.draftDelete(workspacePath, file.path).catch(() => undefined)
                }
                removeOpenFile(file.path)
              }}
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
