import React from 'react'
import { GripVertical } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { usePanelStore } from '../store/panelStore'
import { useWorkspaceScope } from '../workspace/WorkspaceScope'
import { beginPanelDrag, finishPanelDrag } from '../panelHost/panelDrag'
import { PANEL_TITLE_KEY } from '../panelHost/panelLabels'
import { MAIN_HOST, type PanelId } from '../panelHost/types'

/**
 * 面板头部拖出柄：拖到主窗口之外松手即拆成独立窗口。
 *
 * 只在主窗口内的面板上出现 —— 拆出去的窗口用关闭按钮回位，不做拖回。
 * 隐藏时不占位，头部布局保持原样。
 */
export const PanelDragHandle: React.FC<{ panel: PanelId; className?: string }> = ({ panel, className = '' }) => {
  const workspacePath = useWorkspaceScope()
  const { t } = useI18nStore()
  const host = usePanelStore((state) =>
    workspacePath ? (state.panelHost[workspacePath]?.[panel] ?? MAIN_HOST) : MAIN_HOST
  )

  if (!workspacePath || host !== MAIN_HOST) return null

  const label = t('panelDragHint', { panel: t(PANEL_TITLE_KEY[panel]) })

  return (
    <span
      draggable
      title={label}
      aria-label={label}
      onDragStart={(event) => beginPanelDrag(event, panel)}
      onDragEnd={(event) => void finishPanelDrag(event, workspacePath, panel)}
      className={`flex h-4 w-3 flex-none cursor-grab items-center justify-center text-ink-subtle transition-colors hover:text-ink-muted active:cursor-grabbing ${className}`}
    >
      <GripVertical size={12} />
    </span>
  )
}
