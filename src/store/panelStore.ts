/**
 * 面板宿主状态：哪个面板在哪个原生窗口里。
 *
 * 运行期状态，不落盘：应用重启即全部回位到主窗口默认布局（Q5）。
 */

import { create } from 'zustand'
import { api } from '../api'
import { openPanelWindow, type AuxWindowHandle } from '../panelHost/auxWindow'
import { setFocusedHostResolver } from '../panelHost/focus'
import {
  MAIN_HOST,
  PANEL_IDS,
  currentWindowHostId,
  hostIdFromFrameName,
  type AnchorRect,
  type HostId,
  type PanelId,
} from '../panelHost/types'
import { basename } from '../utils/filePath'
import { useI18nStore } from './i18nStore'
import { useThemeStore } from './themeStore'
import { toast, useToastStore } from './toastStore'
import { useDialogStore } from './dialogStore'
import { useWorkspaceStore } from './workspaceStore'

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
  dockPanel: (workspaceDir: string, panel: PanelId, explicitHost?: HostId) => void
  dockWorkspace: (workspaceDir: string) => void
  /** 应用退出 / 主窗口卸载前统一回收，避免残留窗口 */
  disposeAllWindows: () => void
  /** 主进程通知：独立面板窗口被用户关闭 → 面板回位 */
  handleWindowClosed: (hostId: HostId) => void
}

export interface DetachOptions {
  /** 目标窗口矩形；缺省时落在主窗口右侧 */
  rect?: AnchorRect
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

function resolveCurrentTheme(): 'light' | 'dark' {
  const mode = useThemeStore.getState().mode
  if (mode === 'dark') return 'dark'
  if (mode === 'light') return 'light'
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
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

/** 正在异步打开独立窗口的面板键，防止双击拆窗并发开出两个孤儿窗口 */
const detachingPanels = new Set<string>()

function removePanelHost(
  panelHost: PanelHostState['panelHost'],
  workspaceDir: string,
  panel: PanelId
): PanelHostState['panelHost'] {
  const current = panelHost[workspaceDir]
  if (!current || current[panel] === undefined) return panelHost
  const nextWorkspace = { ...current }
  delete nextWorkspace[panel]
  const nextPanelHost = { ...panelHost }
  if (Object.keys(nextWorkspace).length === 0) {
    delete nextPanelHost[workspaceDir]
  } else {
    nextPanelHost[workspaceDir] = nextWorkspace
  }
  return nextPanelHost
}

export const usePanelStore = create<PanelHostState>((set, get) => ({
  panelHost: {},
  windows: {},

  detachPanel: async (workspaceDir, panel, options) => {
    const state = get()
    if ((state.panelHost[workspaceDir]?.[panel] ?? MAIN_HOST) !== MAIN_HOST) return
    const lockKey = `${workspaceDir}\u0000${panel}`
    if (detachingPanels.has(lockKey)) return
    detachingPanels.add(lockKey)

    const hostId = `aux:${nextHostSeq++}`
    let handle: AuxWindowHandle
    try {
      handle = await openPanelWindow({
        id: hostId,
        workspaceDir,
        panel,
        // 窗口属于某个工作区，标题只写工作区名：面板名对多窗口毫无区分度
        title: basename(workspaceDir),
        rect: options?.rect ?? defaultRect(),
        theme: resolveCurrentTheme(),
        language: useI18nStore.getState().language,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const { t } = useI18nStore.getState()
      toast.error(t(reason === 'aux-window-blocked' ? 'panelDetachBlocked' : 'panelDetachFailed'))
      return
    } finally {
      detachingPanels.delete(lockKey)
    }

    // 异步开窗期间若工作区已关闭或面板已不在主窗，立刻回收新窗口，避免孤儿窗口泄漏
    const openWorkspaces = useWorkspaceStore.getState().openWorkspaces
    const workspaceStillOpen = openWorkspaces.length === 0 || openWorkspaces.includes(workspaceDir)
    if (!workspaceStillOpen || (get().panelHost[workspaceDir]?.[panel] ?? MAIN_HOST) !== MAIN_HOST) {
      handle.dispose()
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

  dockPanel: (workspaceDir, panel, explicitHost) => {
    const state = get()
    const hostId = state.panelHost[workspaceDir]?.[panel]
    if (hostId && hostId !== MAIN_HOST) {
      const entry = state.windows[hostId]
      useDialogStore.getState().cancelForHost(hostId)
      useToastStore.getState().clearHost(hostId)
      set((current) => {
        const windows = { ...current.windows }
        delete windows[hostId]
        return {
          panelHost: removePanelHost(current.panelHost, workspaceDir, panel),
          windows,
        }
      })
      entry?.handle.dispose()
      return
    }

    // 在独立拆出面板窗口内部触发「还原到主窗口」时，直接请求主进程关闭本窗口，主窗口收到关闭通知后回位
    const detachedHost =
      explicitHost && explicitHost !== MAIN_HOST ? explicitHost : currentWindowHostId()
    if (detachedHost !== MAIN_HOST && typeof api.panelDock === 'function') {
      void api.panelDock(detachedHost)
    }
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
    const windowEntries = Object.entries(get().windows)
    if (windowEntries.length === 0) return
    for (const [hostId] of windowEntries) {
      useDialogStore.getState().cancelForHost(hostId)
      useToastStore.getState().clearHost(hostId)
    }
    set({ panelHost: {}, windows: {} })
    for (const [, entry] of windowEntries) entry.handle.dispose()
  },

  handleWindowClosed: (hostId) => {
    const entry = get().windows[hostId]
    if (!entry) return
    useDialogStore.getState().cancelForHost(hostId)
    useToastStore.getState().clearHost(hostId)
    set((current) => {
      const windows = { ...current.windows }
      delete windows[hostId]
      return {
        panelHost: removePanelHost(current.panelHost, entry.workspaceDir, entry.panel),
        windows,
      }
    })
  },
}))

/** 面板当前所在宿主（默认主窗口） */
export function panelHostOf(workspaceDir: string, panel: PanelId): HostId {
  return usePanelStore.getState().panelHost[workspaceDir]?.[panel] ?? MAIN_HOST
}

/** 原生多窗口架构下，每个渲染进程拥有独立的 toast / dialog 宿主，直接返回当前窗口自身宿主 */
setFocusedHostResolver(() => currentWindowHostId())

export { hostIdFromFrameName }
