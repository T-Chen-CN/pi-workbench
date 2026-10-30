import React from 'react'
import { Folder, Plus } from 'lucide-react'
import { ListRow } from './patterns'
import { Button, Modal } from './ui'
import { useI18nStore } from '../store/i18nStore'
import { basename } from '../utils/filePath'

export interface WorkspacePickerDialogProps {
  open: boolean
  onClose: () => void
  /** 最近工作区，最近打开在前；已经打开的条目由弹窗过滤掉 */
  recentWorkspaces: string[]
  /** 当前已打开的工作区，不在列表里重复列出 */
  openWorkspaces: string[]
  onOpenWorkspace: (path: string) => void
  /** 「新增工作区」：交给调用方打开原生目录选择器 */
  onAddWorkspace: () => void
}

/**
 * 标签栏 `+` 的应用内弹窗：先列出尚未打开的历史工作区，末项才是「新增工作区」。
 *
 * 行样式复用首页「最近工作区」的 `ListRow`（图标 + 目录名 + 完整路径）。点任意一行
 * 都先关弹窗再触发动作；只有点「新增工作区」才会弹系统文件选择器。
 */
export const WorkspacePickerDialog: React.FC<WorkspacePickerDialogProps> = ({
  open,
  onClose,
  recentWorkspaces,
  openWorkspaces,
  onOpenWorkspace,
  onAddWorkspace,
}) => {
  const { t } = useI18nStore()
  const opened = new Set(openWorkspaces)
  const available = recentWorkspaces.filter((path) => !opened.has(path))

  const runAndClose = (action: () => void) => () => {
    onClose()
    action()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('selectWorkspace')}
      size="sm"
      closeLabel={t('close')}
      footer={<Button onClick={onClose}>{t('cancel')}</Button>}
    >
      {/* 末行（新增工作区）不画分隔线，避免与 footer 的边框叠成双线 */}
      <div className="py-1 [&>button:last-child]:border-b-0">
        {available.map((path) => (
          <ListRow
            key={path}
            icon={Folder}
            title={basename(path)}
            subtitle={path}
            titleAttr={path}
            titleVariant="project"
            className="px-5"
            onClick={runAndClose(() => onOpenWorkspace(path))}
          />
        ))}
        {available.length > 0 && (
          <div role="separator" className="mx-5 my-1 border-t border-rule-divide" />
        )}
        <ListRow
          icon={Plus}
          title={t('addWorkspaceNew')}
          className="px-5"
          onClick={runAndClose(onAddWorkspace)}
        />
      </div>
    </Modal>
  )
}
