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

/** 独立原生面板窗口 URL 启动参数 */
export interface DetachedPanelWindowParams {
  panel: PanelId
  workspaceDir: string
  hostId: HostId
}

/** 与主进程 electron/aux-window.ts 的 AUX_FRAME_PREFIX 逐字一致（进程间协议，不能只改一边） */
export const AUX_FRAME_PREFIX = 'pi-panel:'

/** host → 窗口注册表键（`aux:1` → `pi-panel:aux:1`）；主进程据此找回 BrowserWindow */
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

const AUX_HOST_ID_RE = /^aux:\d+$/

/** 解析独立面板窗口 URL 查询串（`?windowMode=panel&panel=...&workspace=...&hostId=aux:1`） */
export function parseDetachedWindowParams(search: string): DetachedPanelWindowParams | null {
  if (!search) return null
  const params = new URLSearchParams(search)
  if (params.get('windowMode') !== 'panel') return null
  const panel = params.get('panel')
  const workspaceDir = params.get('workspace')
  const hostId = params.get('hostId')
  if (!panel || !PANEL_IDS.includes(panel as PanelId)) return null
  if (!workspaceDir || !hostId || !AUX_HOST_ID_RE.test(hostId)) return null
  return { panel: panel as PanelId, workspaceDir, hostId }
}

/** 当前渲染进程对应的宿主标识：主窗口为 `main`，独立面板窗口为 `aux:<n>` */
export function currentWindowHostId(): HostId {
  if (typeof window === 'undefined') return MAIN_HOST
  return parseDetachedWindowParams(window.location.search)?.hostId ?? MAIN_HOST
}

/** 当前渲染进程是否运行在独立拆出面板的原生 BrowserWindow 内 */
export function isDetachedPanelWindow(): boolean {
  return currentWindowHostId() !== MAIN_HOST
}
