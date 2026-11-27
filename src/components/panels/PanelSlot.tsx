import React from 'react'
import { usePanelStore } from '../../store/panelStore'
import { HostProvider } from '../../panelHost/HostContext'
import { MAIN_HOST, type PanelId } from '../../panelHost/types'
import { useWorkspaceScope } from '../../workspace/WorkspaceScope'

/**
 * 面板槽位（Phase E · 原生多 BrowserWindow 架构）：
 * - docked（`host === 'main'`）：在主窗口原位渲染 children（包裹 `HostProvider`）；
 * - detached（`host !== 'main'`）：面板由独立原生 `BrowserWindow`（`DetachedPanelApp`）承载，
 *   主窗口侧返回 `null`，彻底释放 DOM 与内存，原位置空间 100% 让给编辑器。
 */
export const PanelSlot: React.FC<{
  panel: PanelId
  children: React.ReactNode
}> = ({ panel, children }) => {
  const workspacePath = useWorkspaceScope()
  const host = usePanelStore((state) =>
    workspacePath ? (state.panelHost[workspacePath]?.[panel] ?? MAIN_HOST) : MAIN_HOST
  )

  if (host !== MAIN_HOST) {
    return null
  }

  return <HostProvider host={MAIN_HOST}>{children}</HostProvider>
}
