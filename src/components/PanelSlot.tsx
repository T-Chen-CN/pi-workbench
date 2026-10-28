import React from 'react'
import { createPortal } from 'react-dom'
import { PanelTopOpen } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { usePanelStore } from '../store/panelStore'
import { HostProvider } from '../panelHost/HostContext'
import { MAIN_HOST, type PanelId } from '../panelHost/types'
import { useWorkspaceScope } from '../workspace/WorkspaceScope'
import { Button, EmptyState } from './ui'
import { PanelWindowFrame } from './PanelWindowFrame'

/**
 * 面板槽位：决定面板渲染在主窗口原位，还是渲染进辅助窗口的文档。
 *
 * - docked：原样渲染 children（外包一层宿主上下文，值恒为 `main`）；
 * - detached：`createPortal` 到辅助窗口的 container —— 同一棵 React 树、
 *   同一份 store、同一个 JS 上下文，只是 DOM 落点换了文档；
 * - 原位置渲染 `placeholder`（默认占位提示），保证布局不塌陷。
 *
 * 注意 portal 必须以宿主为 key：换窗口时必须整棵重挂，不能复用旧 fiber。
 */
export const PanelSlot: React.FC<{
  panel: PanelId
  children: React.ReactNode
  /** 面板被拆出后原位置的内容；省略则渲染默认占位 */
  placeholder?: React.ReactNode
}> = ({ panel, children, placeholder }) => {
  const workspacePath = useWorkspaceScope()
  const host = usePanelStore((state) =>
    workspacePath ? state.panelHost[workspacePath]?.[panel] ?? MAIN_HOST : MAIN_HOST
  )
  const handle = usePanelStore((state) =>
    host === MAIN_HOST ? null : state.windows[host]?.handle ?? null
  )

  if (host === MAIN_HOST) {
    return <HostProvider host={MAIN_HOST}>{children}</HostProvider>
  }

  // 窗口刚开、句柄尚未登记：先占位，避免面板瞬间闪回原位
  const fallback = placeholder ?? <PanelDetachedPlaceholder panel={panel} />
  if (!handle || !workspacePath) return <>{fallback}</>

  return (
    <>
      {fallback}
      {createPortal(
        <HostProvider host={host}>
          <PanelWindowFrame panel={panel} workspacePath={workspacePath}>
            {children}
          </PanelWindowFrame>
        </HostProvider>,
        handle.container,
        host
      )}
    </>
  )
}

/** 面板被拆出后留在原位的占位：明确「它去哪了」并给一条回位的路 */
export const PanelDetachedPlaceholder: React.FC<{ panel: PanelId }> = ({ panel }) => {
  const { t } = useI18nStore()
  const workspacePath = useWorkspaceScope()
  const dockPanel = usePanelStore((state) => state.dockPanel)
  const focusPanelWindow = usePanelStore((state) => state.focusPanelWindow)

  if (!workspacePath) return null

  return (
    <div className="flex h-full items-center justify-center bg-panel">
      <EmptyState
        icon={PanelTopOpen}
        title={t('panelDetachedTitle')}
        description={t('panelDetachedHint')}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => focusPanelWindow(workspacePath, panel)}>
              {t('panelFocusWindow')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => dockPanel(workspacePath, panel)}>
              {t('panelDockBack')}
            </Button>
          </div>
        }
      />
    </div>
  )
}
