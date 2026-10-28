/**
 * 面板宿主状态：哪个面板在哪个窗口里。
 *
 * 运行期状态，不落盘：应用重启即回到默认布局（与「退出不自动恢复工作区」一致）。
 * 窗口句柄本身也放在这里，面板 portal 需要它的 container。
 */

import { create } from 'zustand'
import { openPanelWindow, type AuxWindowHandle } from '../panelHost/auxWindow'
import { setFocusedHostResolver } from '../panelHost/focus'
import { MAIN_HOST, PANEL_IDS, type AnchorRect, type HostId, type PanelId } from '../panelHost/types'
import { useI18nStore } from './i18nStore'
import { toast } from './toastStore'

interface PanelWindowEntry {
  workspaceDir: string
  panel: PanelId
  handle: AuxWindowHandle
}

interface PanelHostState {
  /** workspaceDir -> panel -> host */
  panelHost: Record<string, Partial<Record<PanelId, HostId>>>
  windows: Record<HostId, PanelWindowEntry>
  detachPanel: (workspaceDir: string, panel: PanelId, options?: DetachOptions) => Promise<void>
  dockPanel: (workspaceDir: string, panel: PanelId) => void
  dockWorkspace: (workspaceDir: string) => void
  /** 应用退出 / 主窗口卸载前统一回收，避免残留空窗口 */
  disposeAllWindows: () => void
  focusPanelWindow: (workspaceDir: string, panel: PanelId) => void
  /** 主进程通知：辅助窗口被用户关闭 → 面板回位 */
  handleWindowClosed: (hostId: HostId) => void
}

export interface DetachOptions {
  /** 目标窗口矩形；缺省时落在主窗口右侧 */
  rect?: AnchorRect
  /** 窗口标题（原生标题栏显示） */
  title?: string
}

let nextHostSeq = 1

function defaultRect(): AnchorRect {
  const width = 520
  const height = 640
  if (typeof window === 'undefined') return { x: 80, y: 80, width, height }
  const anchorX = Number.isFinite(window.screenX) ? window.screenX : 0
  const anchorY = Number.isFinite(window.screenY) ? window.screenY : 0
  const outerWidth = Number.isFinite(window.outerWidth) ? window.outerWidth : 1200
  return {
    x: Math.round(anchorX + Math.max(0, outerWidth - width - 48)),
    y: Math.round(anchorY + 64),
    width,
    height,
  }
}

/** 光标位置 → 新窗口矩形（屏幕坐标系）；主进程会再夹一次工作区 */
export function rectFromPointer(clientX: number, clientY: number): AnchorRect {
  const width = 520
  const height = 640
  if (typeof window === 'undefined') return { x: clientX, y: clientY, width, height }
  const offsetX = Number.isFinite(window.screenX) ? window.screenX : 0
  const offsetY = Number.isFinite(window.screenY) ? window.screenY : 0
  return {
    x: Math.round(offsetX + clientX - 40),
    y: Math.round(offsetY + clientY - 12),
    width,
    height,
  }
}

function removePanelHost(
  panelHost: PanelHostState['panelHost'],
  workspaceDir: string,
  panel: PanelId
): PanelHostState['panelHost'] {
  const current = panelHost[workspaceDir]
  if (!current || current[panel] === undefined) return panelHost
  const nextWorkspace = { ...current }
  delete nextWorkspace[panel]
  return { ...panelHost, [workspaceDir]: nextWorkspace }
}

export const usePanelStore = create<PanelHostState>((set, get) => ({
  panelHost: {},
  windows: {},

  detachPanel: async (workspaceDir, panel, options) => {
    const state = get()
    if ((state.panelHost[workspaceDir]?.[panel] ?? MAIN_HOST) !== MAIN_HOST) return

    const hostId = `aux:${nextHostSeq++}`
    let handle: AuxWindowHandle
    try {
      handle = await openPanelWindow({
        id: hostId,
        title: options?.title ?? panel,
        rect: options?.rect ?? defaultRect(),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const { t } = useI18nStore.getState()
      toast.error(t(reason === 'aux-window-blocked' ? 'panelDetachBlocked' : 'panelDetachFailed'))
      return
    }

    set((current) => ({
      panelHost: {
        ...current.panelHost,
        [workspaceDir]: { ...current.panelHost[workspaceDir], [panel]: hostId },
      },
      windows: {
        ...current.windows,
        [hostId]: { workspaceDir, panel, handle },
      },
    }))
  },

  dockPanel: (workspaceDir, panel) => {
    const state = get()
    const hostId = state.panelHost[workspaceDir]?.[panel]
    if (!hostId || hostId === MAIN_HOST) return
    const entry = state.windows[hostId]
    set((current) => {
      const windows = { ...current.windows }
      delete windows[hostId]
      return {
        panelHost: removePanelHost(current.panelHost, workspaceDir, panel),
        windows,
      }
    })
    entry?.handle.dispose()
  },

  dockWorkspace: (workspaceDir) => {
    const state = get()
    const panels = PANEL_IDS.filter(
      (panel) => (state.panelHost[workspaceDir]?.[panel] ?? MAIN_HOST) !== MAIN_HOST
    )
    if (panels.length === 0) return
    for (const panel of panels) get().dockPanel(workspaceDir, panel)
  },

  disposeAllWindows: () => {
    const entries = Object.values(get().windows)
    if (entries.length === 0) return
    set({ panelHost: {}, windows: {} })
    for (const entry of entries) entry.handle.dispose()
  },

  focusPanelWindow: (workspaceDir, panel) => {
    const hostId = get().panelHost[workspaceDir]?.[panel]
    if (!hostId || hostId === MAIN_HOST) return
    const win = get().windows[hostId]?.handle.window
    if (!win) return
    try {
      if (win.closed) {
        get().handleWindowClosed(hostId)
        return
      }
      win.focus()
    } catch {
      get().handleWindowClosed(hostId)
    }
  },

  handleWindowClosed: (hostId) => {
    const entry = get().windows[hostId]
    if (!entry) return
    set((current) => {
      const windows = { ...current.windows }
      delete windows[hostId]
      return {
        panelHost: removePanelHost(current.panelHost, entry.workspaceDir, entry.panel),
        windows,
      }
    })
    entry.handle.dispose()
  },
}))

/** 面板当前所在宿主（默认主窗口） */
export function panelHostOf(workspaceDir: string, panel: PanelId): HostId {
  return usePanelStore.getState().panelHost[workspaceDir]?.[panel] ?? MAIN_HOST
}

/** 焦点窗口：辅助窗口优先，否则主窗口。toast / dialog 用它决定落点 */
setFocusedHostResolver(() => {
  const { windows } = usePanelStore.getState()
  for (const [hostId, entry] of Object.entries(windows)) {
    try {
      if (entry.handle.document.hasFocus()) return hostId
    } catch {
      // 窗口已销毁：忽略
    }
  }
  return MAIN_HOST
})

/** frameName → hostId（`pi-panel:aux:1` → `aux:1`） */
export function hostIdFromFrameName(frameName: string): HostId | null {
  const prefix = 'pi-panel:'
  if (typeof frameName !== 'string' || !frameName.startsWith(prefix)) return null
  return frameName.slice(prefix.length) || null
}
