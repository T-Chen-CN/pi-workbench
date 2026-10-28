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

export function isAuxHost(host: HostId | null | undefined): boolean {
  return Boolean(host) && host !== MAIN_HOST
}
