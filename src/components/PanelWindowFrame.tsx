import React from 'react'
import { PanelRightClose } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { usePanelStore } from '../store/panelStore'
import { PANEL_TITLE_KEY } from '../panelHost/panelLabels'
import { MAIN_HOST, type HostId, type PanelId } from '../panelHost/types'
import { isMacPlatform } from '../utils/keybindings'
import { IconButton } from './ui'
import { WindowControls } from './WindowControls'

/**
 * 辅助窗口里的面板外框：34px 自绘标题栏 + 内容。
 *
 * 辅助窗口与主窗口同一套外壳（Windows / Linux 无边框，macOS hiddenInset），
 * 所以这一条就是窗口标题栏：整条 `app-drag` 可拖动窗口，双击最大化，
 * 右侧是「还原到主窗口」与自绘窗口按钮。macOS 保留红绿灯，标题从左侧让位。
 *
 * 标题栏只有一个信息位（面板名），不重复系统标题，也不放第二行元数据。
 */
export const PanelWindowFrame: React.FC<{
  panel: PanelId
  workspacePath: string
  host?: HostId
  children: React.ReactNode
}> = ({ panel, workspacePath, host = MAIN_HOST, children }) => {
  const { t } = useI18nStore()
  const dockPanel = usePanelStore((state) => state.dockPanel)
  const isMac = isMacPlatform()
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  const isAux = host !== MAIN_HOST

  const toggleMaximize = () => {
    if (!api) return
    if (isAux) void api.auxWindowCommand(host, 'toggleMaximize')
    else void api.toggleMaximizeWindow()
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div
        className={`app-drag flex h-[34px] flex-shrink-0 select-none items-center justify-between gap-2 border-b border-rule-divide bg-panel ${
          isMac ? 'pl-[84px]' : 'pl-3'
        } ${isMac ? 'pr-3' : 'pr-0'}`}
        onDoubleClick={(event) => {
          if (isMac) return
          if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return
          toggleMaximize()
        }}
      >
        <span className="min-w-0 truncate type-label text-ink-muted">{t(PANEL_TITLE_KEY[panel])}</span>
        <div className="flex h-full flex-shrink-0 items-center">
          <div className="px-1.5">
            <IconButton
              icon={PanelRightClose}
              label={t('panelDockBack')}
              title={t('panelDockBack')}
              size="sm"
              onClick={() => dockPanel(workspacePath, panel)}
            />
          </div>
          {!isMac && <WindowControls host={host} compact />}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  )
}
