/** 面板与宿主窗口的类型定义（无运行时依赖，供 store / 组件 / 工具共用） */

export type PanelId = 'files' | 'git' | 'chat' | 'terminal'

/** `main` 或 `aux:<n>`；辅助窗口宿主只在运行期存在，不落盘 */
export type HostId = string

export const MAIN_HOST: HostId = 'main'

export const PANEL_IDS: PanelId[] = ['files', 'git', 'chat', 'terminal']

export interface AnchorRect {
  x: number
  y: number
  width: number
  height: number
}

/** 与主进程 electron/aux-window.ts 的 AUX_FRAME_PREFIX 逐字一致（进程间协议，不能只改一边） */
export const AUX_FRAME_PREFIX = 'pi-panel:'

/** host → window.open 的 frameName；主进程据此找回 BrowserWindow */
export function frameNameOf(host: HostId): string {
  return `${AUX_FRAME_PREFIX}${host}`
}

/** frameName → host（`pi-panel:aux:1` → `aux:1`）；不是辅助窗口的 frameName 返回 null */
export function hostIdFromFrameName(frameName: string): HostId | null {
  if (typeof frameName !== 'string' || !frameName.startsWith(AUX_FRAME_PREFIX)) return null
  return frameName.slice(AUX_FRAME_PREFIX.length) || null
}

/** 主进程回传的 host 可能是 frameName 也可能是 `main`，比较前统一成 host */
export function sameHost(stateHost: string, host: HostId): boolean {
  return (hostIdFromFrameName(stateHost) ?? stateHost) === host
}
