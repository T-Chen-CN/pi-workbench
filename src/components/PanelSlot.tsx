import React from 'react'
import { createPortal } from 'react-dom'
import { usePanelStore } from '../store/panelStore'
import { HostProvider } from '../panelHost/HostContext'
import { MAIN_HOST, type PanelId } from '../panelHost/types'
import { useWorkspaceScope } from '../workspace/WorkspaceScope'
import { PanelWindowFrame } from './PanelWindowFrame'

/**
 * 面板槽位：决定面板渲染在主窗口原位，还是渲染进辅助窗口的文档。
 *
 * - docked：原样渲染 children（外包一层宿主上下文，值恒为 `main`）；
 * - detached：`createPortal` 到辅助窗口的 container —— 同一棵 React 树、
 *   同一份 store、同一个 JS 上下文，只是 DOM 落点换了文档。
 *
 * 拆出后主窗口这一侧不渲染任何东西：原位置让给编辑器。因此调用方必须
 * 保证 `PanelSlot` 保持挂载（portal 的 fiber 挂在这里），只是不再占布局；
 * 卸载它等于把独立窗口里的面板一起拆掉。
 *
 * 注意 portal 必须以宿主为 key：换窗口时必须整棵重挂，不能复用旧 fiber。
 */
export const PanelSlot: React.FC<{
  panel: PanelId
  children: React.ReactNode
}> = ({ panel, children }) => {
  const workspacePath = useWorkspaceScope()
  const host = usePanelStore((state) =>
    workspacePath ? (state.panelHost[workspacePath]?.[panel] ?? MAIN_HOST) : MAIN_HOST
  )
  const handle = usePanelStore((state) => (host === MAIN_HOST ? null : (state.windows[host]?.handle ?? null)))

  if (host === MAIN_HOST) {
    return <HostProvider host={MAIN_HOST}>{children}</HostProvider>
  }

  // 窗口刚开、句柄尚未登记：这一帧什么都不渲染，也不要退回主窗口
  if (!handle || !workspacePath) return null

  return createPortal(
    <HostProvider host={host}>
      <PanelWindowFrame panel={panel} workspacePath={workspacePath} host={host}>
        {children}
      </PanelWindowFrame>
    </HostProvider>,
    handle.container,
    host
  )
}
