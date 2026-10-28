import React, { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, PanelRightClose, type LucideIcon } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { rectFromPointer, usePanelStore } from '../store/panelStore'
import { useHostDocument, useHostKeydown } from '../panelHost/HostContext'
import { MAIN_HOST, type PanelId } from '../panelHost/types'
import { useWorkspaceScope } from '../workspace/WorkspaceScope'

export interface PanelMenuItem {
  label: string
  icon: LucideIcon
  onSelect: () => void
}

/**
 * 光标定位的小菜单。渲染进「面板所在窗口」的 body —— 拆到辅助窗口的面板
 * 右键菜单必须出现在那个窗口，而不是主窗口。
 */
export const PanelContextMenu: React.FC<{
  x: number
  y: number
  label: string
  items: PanelMenuItem[]
  onClose: () => void
}> = ({ x, y, label, items, onClose }) => {
  const doc = useHostDocument()
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    const viewportWidth = doc.documentElement?.clientWidth ?? 0
    const viewportHeight = doc.documentElement?.clientHeight ?? 0
    setPos({
      left: Math.max(4, Math.min(x, viewportWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, viewportHeight - rect.height - 4)),
    })
  }, [doc, x, y])

  useHostKeydown(
    (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    },
    [onClose]
  )

  return createPortal(
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={onClose}>
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        style={{ left: pos.left, top: pos.top }}
        className="absolute min-w-[190px] overflow-hidden border border-line bg-raised py-1 shadow-print"
        onClick={(event) => event.stopPropagation()}
      >
        {items.map(({ label: itemLabel, icon: Icon, onSelect }) => (
          <button
            key={itemLabel}
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink hover:bg-hover"
            onClick={() => {
              onSelect()
              onClose()
            }}
          >
            <Icon size={13} className="text-ink-muted" />
            {itemLabel}
          </button>
        ))}
      </div>
    </div>,
    doc.body
  )
}

/**
 * 面板右键菜单：在「独立窗口打开 / 还原到主窗口」之间切换。
 * 返回 `onContextMenu` 处理器与待渲染的菜单节点。
 */
export function usePanelContextMenu(panel: PanelId): {
  onContextMenu: (event: React.MouseEvent) => void
  menu: React.ReactNode
} {
  const workspacePath = useWorkspaceScope()
  const { t } = useI18nStore()
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const host = usePanelStore((state) =>
    workspacePath ? state.panelHost[workspacePath]?.[panel] ?? MAIN_HOST : MAIN_HOST
  )
  const detachPanel = usePanelStore((state) => state.detachPanel)
  const dockPanel = usePanelStore((state) => state.dockPanel)

  const onContextMenu = (event: React.MouseEvent) => {
    if (!workspacePath) return
    event.preventDefault()
    event.stopPropagation()
    setAnchor({ x: event.clientX, y: event.clientY })
  }

  const menu =
    anchor && workspacePath ? (
      <PanelContextMenu
        x={anchor.x}
        y={anchor.y}
        label={t('panelMenu')}
        onClose={() => setAnchor(null)}
        items={
          host === MAIN_HOST
            ? [
                {
                  label: t('panelDetach'),
                  icon: ExternalLink,
                  onSelect: () =>
                    void detachPanel(workspacePath, panel, {
                      rect: rectFromPointer(anchor.x, anchor.y),
                    }),
                },
              ]
            : [
                {
                  label: t('panelDockBack'),
                  icon: PanelRightClose,
                  onSelect: () => dockPanel(workspacePath, panel),
                },
              ]
        }
      />
    ) : null

  return { onContextMenu, menu }
}
