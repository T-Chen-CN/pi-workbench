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
  Presentation,
  Table2,
} from 'lucide-react'
import { useEditorStore, editorStoreFor } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { confirmDialog } from '../store/dialogStore'
import { handleTabStripWheel, Tab } from './patterns'
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
    case 'word':
    case 'epub':
      return FileText
    case 'sheet':
      return Table2
    case 'slide':
      return Presentation
    case 'office-legacy':
      return FileIcon
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

  const hasActive = Boolean(currentFile?.path)

  const closeFile = async (file: OpenFile) => {
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
  }

  return (
    <div
      data-testid="editor-tabs"
      role="tablist"
      aria-label={t('editorTabsLabel')}
      onWheel={handleTabStripWheel}
      className="tab-strip-scroll flex flex-shrink-0 items-stretch overflow-x-auto border-b border-rule-divide bg-panel"
    >
      {openFiles.map((file, index) => {
        const active = currentFile?.path === file.path
        const Icon = iconFor(file)
        return (
          <Tab
            key={file.path}
            active={active}
            tabbable={active || (!hasActive && index === 0)}
            title={file.path}
            ariaLabel={
              [file.name, file.isDirty ? t('unsavedChanges') : '', file.isSaving ? t('saving') : '']
                .filter(Boolean)
                .join(' · ') || undefined
            }
            busy={file.isSaving}
            onSelect={() => store.setState({ currentFile: file })}
            onClose={() => void closeFile(file)}
            closeLabel={t('close')}
            className="max-w-[280px]"
            labelClassName="max-w-[220px]"
            leading={
              <Icon size={12} className={active ? 'text-accent' : 'text-ink-muted'} />
            }
            label={file.name}
            trailing={
              file.isSaving ? (
                <Loader2 size={10} className="flex-shrink-0 animate-spin text-ink-muted" />
              ) : file.isDirty ? (
                <span className="h-1 w-1 flex-shrink-0 rounded-full bg-accent" />
              ) : null
            }
          />
        )
      })}
    </div>
  )
}
