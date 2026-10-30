import React from 'react'
import {
  FileCode,
  FileIcon,
  FileJson,
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  LayoutDashboard,
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

/**
 * 文件标签条：面板标签 + 活跃标签、脏标记、关闭。
 *
 * 标签条常驻（没有打开任何文件时也留着），因为最左那枚「面板」标签是预览区
 * 默认视图的唯一入口。面板标签不属于 `openFiles`：不可关闭、不可排序，也不落盘；
 * 用 sticky 固定在左端，文件标签再多也只是从它下面横向滚过去。视图切换不在这里
 * （Markdown / HTML 的源码 ↔ 阅读见 FileView 右下角浮层）。
 */
export const EditorTabs: React.FC<EditorTabsProps> = ({ workspacePath, root }) => {
  const { t } = useI18nStore()
  const store = editorStoreFor(root)
  const { currentFile, openFiles, panelActive, setPanelActive, setCurrentFile, removeOpenFile } =
    useEditorStore(root)

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
      {/* 面板标签：左端固定（sticky），背景不透明，滚动的文件标签从它下面经过 */}
      <div className="sticky left-0 z-10 flex flex-shrink-0 items-stretch bg-panel">
        <Tab
          active={panelActive}
          tabbable={panelActive}
          title={t('panelTab')}
          ariaLabel={t('panelTab')}
          onSelect={() => setPanelActive(true)}
          className="max-w-[160px] pr-3"
          labelClassName="max-w-[120px]"
          leading={
            <LayoutDashboard
              size={12}
              className={panelActive ? 'text-accent' : 'text-ink-muted'}
            />
          }
          label={t('panelTab')}
        />
      </div>

      {openFiles.map((file, index) => {
        const active = !panelActive && currentFile?.path === file.path
        const Icon = iconFor(file)
        return (
          <Tab
            key={file.path}
            active={active}
            tabbable={active || (!panelActive && !currentFile && index === 0)}
            title={file.path}
            ariaLabel={
              [file.name, file.isDirty ? t('unsavedChanges') : '', file.isSaving ? t('saving') : '']
                .filter(Boolean)
                .join(' · ') || undefined
            }
            busy={file.isSaving}
            onSelect={() => {
              setCurrentFile(file)
              setPanelActive(false)
            }}
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
