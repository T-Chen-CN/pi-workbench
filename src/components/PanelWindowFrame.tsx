import React from 'react'
import { PanelRightClose } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { usePanelStore } from '../store/panelStore'
import { PANEL_TITLE_KEY } from '../panelHost/panelLabels'
import type { PanelId } from '../panelHost/types'
import { IconButton } from './ui'

/**
 * 辅助窗口里的面板外框：32px 信息条 + 内容。
 *
 * 原生标题栏负责拖动 / 最大化 / 关闭；信息条只做一件事——告诉用户
 * 「这是一块被拆出去的面板」，并提供明确的回位按钮（关闭窗口也会回位）。
 */
export const PanelWindowFrame: React.FC<{
  panel: PanelId
  workspacePath: string
  children: React.ReactNode
}> = ({ panel, workspacePath, children }) => {
  const { t } = useI18nStore()
  const dockPanel = usePanelStore((state) => state.dockPanel)

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex h-8 flex-shrink-0 items-center justify-between gap-2 border-b border-rule-divide bg-panel pl-3 pr-1.5">
        <span className="min-w-0 truncate type-label text-ink-muted">{t(PANEL_TITLE_KEY[panel])}</span>
        <IconButton
          icon={PanelRightClose}
          label={t('panelDockBack')}
          title={t('panelDockBack')}
          size="sm"
          onClick={() => dockPanel(workspacePath, panel)}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  )
}
