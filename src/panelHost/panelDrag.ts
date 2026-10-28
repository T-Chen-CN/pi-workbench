/**
 * 面板拖出拆窗。
 *
 * 拖拽本身用原生 HTML5 DnD：拖动柄写入 `application/x-pi-panel`，松手时
 * `dragend` 交给主进程读真实光标位置——渲染层的 clientX/screenX 在混合 DPI
 * 下不可靠，落点判定必须在主进程做。
 *
 * 只在主窗口内的面板上启用：拆出的面板要用「关闭窗口」回位，拖回主窗口不是 v1 范围。
 */

import type React from 'react'
import { api } from '../api'
import { usePanelStore } from '../store/panelStore'
import { useI18nStore } from '../store/i18nStore'
import { PANEL_TITLE_KEY } from './panelLabels'
import type { PanelId } from './types'

export const PANEL_DRAG_MIME = 'application/x-pi-panel'

/** 拖影：一个 1px 的透明占位，避免浏览器把整块面板头当拖影 */
function paintDragImage(event: React.DragEvent, label: string): void {
  const doc = event.currentTarget.ownerDocument
  const ghost = doc.createElement('div')
  ghost.textContent = label
  ghost.style.cssText = [
    'position:fixed',
    'top:-1000px',
    'left:-1000px',
    'padding:4px 10px',
    'font:12px system-ui,sans-serif'
  ].join(';')
  doc.body.appendChild(ghost)
  event.dataTransfer.setDragImage(ghost, 0, 0)
  // setDragImage 只取当下的快照，节点下一帧就可以撤掉
  requestAnimationFrame(() => ghost.remove())
}

export function beginPanelDrag(event: React.DragEvent, panel: PanelId): void {
  const { t } = useI18nStore.getState()
  event.dataTransfer.setData(PANEL_DRAG_MIME, panel)
  event.dataTransfer.effectAllowed = 'move'
  paintDragImage(event, t(PANEL_TITLE_KEY[panel]))
}

/**
 * 松手后判定是否需要拆窗。
 *
 * 不能用 `dataTransfer.dropEffect` 判断「是否取消」：拖到窗口外松手时没有任何
 * drop 目标接收，Chromium 同样报 `'none'` —— 而那正是需要拆窗的时机。
 * 唯一判据交给主进程的光标位置：仍落在主窗口内就不拆（含 Esc 取消）。
 */
export async function finishPanelDrag(workspacePath: string, panel: PanelId): Promise<void> {
  const result = await api.auxDetachAt()
  if (!result.success || result.inside || !result.rect) return
  await usePanelStore.getState().detachPanel(workspacePath, panel, { rect: result.rect })
}
