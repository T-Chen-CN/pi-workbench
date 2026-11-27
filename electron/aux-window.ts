/**
 * 面板独立原生窗口宿主（Phase E · 原生多 BrowserWindow 拆窗）。
 *
 * 每个拆出面板由主进程通过 `panel:detach` IPC 派生独立原生 `BrowserWindow`：
 * - 加载应用自身 `pw-app://bundle/index.html?windowMode=panel&...`（开发模式走 `VITE_DEV_SERVER_URL`），
 *   彻底移除旧版 `window.open('about:blank')` 与跨文档 React Portal；
 * - 注入沙盒 `preload.cjs` 并在创建时登记 `trustIpcSender(wcId)`，关闭时按预存数值 `wcId` 注销；
 * - **禁止设置 `parent: mainWindow`**（Q5 生命周期铁律）：主窗口点 `X` 收进托盘（`hide()`）时，
 *   拆出窗口留在屏幕上继续可见；关闭拆出窗口即回位主窗口；应用重启不持久化拆窗布局；
 * - 通过 `sync:broadcast` → `sync:state` 在主窗口与各拆出窗口之间同步主题、语言、会话、文件打开与 UI 状态。
 */

import * as path from 'path'
import {
  BrowserWindow,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
  type Rectangle,
} from 'electron'
import { appUrl, isAppUrl } from './app-protocol.js'
import { isExternalUrl } from './external-links.js'
import {
  parseContractArgs,
  type DetachablePanelId,
  type PanelDetachRect,
  type PanelDetachRequest,
  type PanelDetachResult,
  type PanelDockResult,
  type WindowSyncMessage,
} from './ipc/contract.js'
import { handleIpc, trustIpcSender, untrustIpcSender } from './ipc/register.js'
import { isTrustedWorkspacePath } from './workspace-trust.js'

/** 辅助窗口注册表键前缀，与 src/panelHost/types.ts 保持逐字一致 */
export const AUX_FRAME_PREFIX = 'pi-panel:'

export const AUX_MIN_WIDTH = 320
export const AUX_MIN_HEIGHT = 220

const DEFAULT_AUX_WIDTH = 520
const DEFAULT_AUX_HEIGHT = 640
const DEFAULT_AUX_BACKGROUND = '#f4f1ea'
const LIGHT_PANEL_BACKGROUND = '#FBF9F4'
const DARK_PANEL_BACKGROUND = '#1A1815'
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const AUX_HOST_ID_RE = /^aux:\d+$/
const VALID_PANELS = new Set<DetachablePanelId>(['files', 'git', 'chat', 'terminal'])

export interface AuxWindowOptions {
  width: number
  height: number
  x: number
  y: number
  backgroundColor: string
}

export interface ScreenPoint {
  x: number
  y: number
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.round(value), min), Math.max(min, max))
}

function readNumber(features: Map<string, string>, key: string): number | null {
  const raw = features.get(key)
  if (raw === undefined) return null
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function parseFeatures(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  if (typeof raw !== 'string' || raw.length === 0) return map
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim().toLowerCase()
    const rawValue = trimmed.slice(separator + 1).trim()
    if (!key || !rawValue) continue
    let value = rawValue
    try {
      value = decodeURIComponent(rawValue)
    } catch {
      // 保持原样：非法百分号编码不该让整个请求失败
    }
    map.set(key, value)
  }
  return map
}

/** 将目标矩形夹入指定显示器工作区，保证窗口不小于最小尺寸且不落到屏幕之外 */
function clampRectToWorkArea(
  rect: Partial<PanelDetachRect> | undefined,
  workArea: Rectangle
): Rectangle {
  const maxWidth = Math.max(AUX_MIN_WIDTH, workArea.width)
  const maxHeight = Math.max(AUX_MIN_HEIGHT, workArea.height)
  const width = clampInt(rect?.width ?? DEFAULT_AUX_WIDTH, AUX_MIN_WIDTH, maxWidth)
  const height = clampInt(rect?.height ?? DEFAULT_AUX_HEIGHT, AUX_MIN_HEIGHT, maxHeight)
  const fallbackX = workArea.x + Math.round((workArea.width - width) / 2)
  const fallbackY = workArea.y + Math.round((workArea.height - height) / 2)
  const x = clampInt(rect?.x ?? fallbackX, workArea.x, workArea.x + workArea.width - width)
  const y = clampInt(rect?.y ?? fallbackY, workArea.y, workArea.y + workArea.height - height)
  return { x, y, width, height }
}

/**
 * 几何字符串 → 受控窗口边界（保留给工具校验与单测复用）。
 * 只读取位置、尺寸与首帧背景色；其余字段一律忽略。
 */
export function parseAuxWindowFeatures(raw: string, workArea: Rectangle): AuxWindowOptions {
  const features = parseFeatures(raw)
  const bounds = clampRectToWorkArea(
    {
      x: readNumber(features, 'left') ?? undefined,
      y: readNumber(features, 'top') ?? undefined,
      width: readNumber(features, 'width') ?? undefined,
      height: readNumber(features, 'height') ?? undefined,
    },
    workArea
  )
  const rawBackground = features.get('bg') ?? ''
  const backgroundColor = HEX_COLOR.test(rawBackground) ? rawBackground : DEFAULT_AUX_BACKGROUND

  return { ...bounds, backgroundColor }
}

export function isPointInBounds(point: ScreenPoint, bounds: Rectangle): boolean {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  )
}

/**
 * 拖出拆窗的落点 → 新窗口矩形。
 * 锚在光标处（略偏左上），再整体夹回工作区，避免窗口出现在屏幕外。
 */
export function computeDetachedRect(point: ScreenPoint, hostBounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = clampInt(hostBounds.width * 0.32, 380, Math.min(860, workArea.width))
  const height = clampInt(hostBounds.height * 0.72, 320, Math.min(820, workArea.height))
  const x = clampInt(point.x - 32, workArea.x, workArea.x + workArea.width - width)
  const y = clampInt(point.y - 18, workArea.y, workArea.y + workArea.height - height)
  return { x, y, width, height }
}

export interface AuxDetachResult {
  success: boolean
  inside?: boolean
  rect?: Rectangle
  /** 光标离拖动起点的 DIP 距离；没有起点记录时为 undefined */
  distance?: number
  error?: string
}

/**
 * 拖动多远算「拖出」：光标没离开窗口、但已经拖了这么远，同样拆窗。
 * 96 DIP ≈ 一个面板头宽，短促的误触不会触发。
 */
export const PANEL_DETACH_DISTANCE = 96

/** 渲染层在 dragstart 时调用：记下拖动起点，供松手时算拖动距离 */
let dragOrigin: { x: number; y: number } | null = null

export function beginDetachDrag(): { success: boolean } {
  const point = screen.getCursorScreenPoint()
  dragOrigin = { x: point.x, y: point.y }
  return { success: true }
}

/** 渲染层在 dragend 时调用：由主进程读取真实光标位置，规避混合 DPI 下 screenX 失真 */
export function resolveDetachTarget(host: BrowserWindow): AuxDetachResult {
  if (!host || host.isDestroyed()) return { success: false, error: 'No window' }
  const point = screen.getCursorScreenPoint()
  const distance = dragOrigin ? Math.hypot(point.x - dragOrigin.x, point.y - dragOrigin.y) : undefined
  dragOrigin = null
  const bounds = host.getBounds()
  const inside = isPointInBounds(point, bounds)
  // 拖得够远就拆，即使光标仍在窗口内（拖动距离与落点用同一坐标源，同样不受 DPI 影响）
  const farEnough = distance !== undefined && distance >= PANEL_DETACH_DISTANCE
  if (inside && !farEnough) return { success: true, inside: true, distance }
  const workArea = screen.getDisplayNearestPoint(point).workArea
  return {
    success: true,
    inside,
    rect: computeDetachedRect(point, bounds, workArea),
    distance,
  }
}

export type AuxWindowCommand = 'minimize' | 'toggleMaximize' | 'close'

export interface AuxWindowCommandResult {
  success: boolean
  maximized?: boolean
  error?: string
}

/** frameName → 独立原生面板窗口。渲染层只有 hostId / frameName，窗口引用留在主进程 */
const auxWindows = new Map<string, BrowserWindow>()

export function getAuxWindow(frameName: string): BrowserWindow | null {
  const win = auxWindows.get(frameName)
  if (!win || win.isDestroyed()) return null
  return win
}

/** 渲染层点自绘窗口按钮：一律作用在 frameName 指定的窗口上 */
export function runAuxWindowCommand(frameName: string, command: AuxWindowCommand): AuxWindowCommandResult {
  const win = getAuxWindow(frameName)
  if (!win) return { success: false, error: 'No such aux window' }
  switch (command) {
    case 'minimize':
      win.minimize()
      return { success: true }
    case 'close':
      win.close()
      return { success: true }
    case 'toggleMaximize':
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      return { success: true, maximized: win.isMaximized() }
    default:
      return { success: false, error: 'Unknown command' }
  }
}

export function readAuxWindowState(frameName: string): AuxWindowCommandResult {
  const win = getAuxWindow(frameName)
  if (!win) return { success: false, error: 'No such aux window' }
  return { success: true, maximized: win.isMaximized() }
}

function isAuxFrameName(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(AUX_FRAME_PREFIX)
}

function isValidHostId(value: unknown): value is string {
  return typeof value === 'string' && AUX_HOST_ID_RE.test(value)
}

function isValidPanelId(value: unknown): value is DetachablePanelId {
  return typeof value === 'string' && VALID_PANELS.has(value as DetachablePanelId)
}

/** 白名单校验 window.open 来源：仅放行应用外壳 `pw-app://bundle/` 或当前 Vite 开发服务器同源 */
function isAllowedWindowOpenReferrer(referrerUrl: string): boolean {
  if (!referrerUrl) return false
  let parsed: URL
  try {
    parsed = new URL(referrerUrl)
  } catch {
    return false
  }
  if (parsed.protocol === 'pw-app:' && parsed.hostname === 'bundle') return true
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    try {
      if (parsed.origin === new URL(devServerUrl).origin) return true
    } catch {
      return false
    }
  }
  return false
}

/** 白名单校验窗口导航目标：仅允许外壳协议或开发服务器同源 */
function isAllowedAppNavigation(targetUrl: string): boolean {
  if (isAppUrl(targetUrl)) return true
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    try {
      return new URL(targetUrl).origin === new URL(devServerUrl).origin
    } catch {
      return false
    }
  }
  return false
}

function buildPanelWindowUrl(query: Record<string, string>): string {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    const devUrl = new URL(devServerUrl)
    for (const [key, value] of Object.entries(query)) devUrl.searchParams.set(key, value)
    return devUrl.toString()
  }
  return appUrl('/index.html', query)
}

function isWebContentsAlive(win: BrowserWindow | null | undefined): win is BrowserWindow {
  if (!win || win.isDestroyed()) return false
  const wc = win.webContents
  if (!wc) return false
  return typeof wc.isDestroyed === 'function' ? !wc.isDestroyed() : true
}

/** 向除发送者外的所有非销毁窗口广播跨窗同步消息（避免回声循环） */
export function relaySyncState(message: WindowSyncMessage, excludeWebContentsId?: number): void {
  if (typeof BrowserWindow?.getAllWindows !== 'function') return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isWebContentsAlive(win)) continue
    if (excludeWebContentsId !== undefined && win.webContents.id === excludeWebContentsId) continue
    win.webContents.send('sync:state', message)
  }
}

export interface AuxWindowIpcContext {
  getMainWindow: () => BrowserWindow | null
  preloadPath?: string
  iconPath?: string
  onClosed?: (frameName: string) => void
  resolveTheme?: () => 'light' | 'dark'
  resolveLanguage?: () => 'zh' | 'en'
  onThemeSync?: (mode: 'light' | 'dark' | 'system') => void
}

/**
 * 为拆出面板创建独立的原生 `BrowserWindow`。
 *
 * 铁律（Q5）：
 * - 不设置 `parent`，确保主窗口收进托盘（`hide()`）时拆出窗口留在屏幕上；
 * - 注入沙盒 preload 并在创建时登记 `trustIpcSender(wcId)`，关闭时按预存 `wcId` 注销；
 * - 窗口关闭自动通知主窗口回位并广播 `panel-docked`。
 */
export function createDetachedPanelWindow(
  options: PanelDetachRequest,
  context: AuxWindowIpcContext
): PanelDetachResult {
  if (!options || typeof options !== 'object') {
    return { success: false, error: 'Invalid detach request' }
  }
  const { workspaceDir, panel, hostId, title, rect } = options
  if (typeof workspaceDir !== 'string' || !workspaceDir || !isTrustedWorkspacePath(workspaceDir)) {
    return { success: false, error: 'Workspace is not approved' }
  }
  if (!isValidPanelId(panel)) {
    return { success: false, error: 'Invalid panel' }
  }
  if (!isValidHostId(hostId)) {
    return { success: false, error: 'Invalid host' }
  }

  const frameName = `${AUX_FRAME_PREFIX}${hostId}`
  const existing = getAuxWindow(frameName)
  if (existing) {
    if (existing.isMinimized?.()) existing.restore?.()
    existing.show?.()
    existing.focus?.()
    return { success: true, hostId, frameName }
  }

  const anchorPoint: ScreenPoint =
    rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)
      ? { x: Math.round(rect.x), y: Math.round(rect.y) }
      : screen.getCursorScreenPoint()
  const workArea = screen.getDisplayNearestPoint(anchorPoint).workArea
  const bounds = clampRectToWorkArea(rect, workArea)

  const theme: 'light' | 'dark' =
    options.theme === 'dark' || options.theme === 'light'
      ? options.theme
      : (context.resolveTheme?.() ?? 'light')
  const language: 'zh' | 'en' =
    options.language === 'en' || options.language === 'zh'
      ? options.language
      : (context.resolveLanguage?.() ?? 'zh')
  const isDark = theme === 'dark'
  const backgroundColor = isDark ? DARK_PANEL_BACKGROUND : LIGHT_PANEL_BACKGROUND
  const windowTitle =
    typeof title === 'string' && title.trim()
      ? title.trim()
      : path.basename(workspaceDir) || workspaceDir

  const winOptions: BrowserWindowConstructorOptions = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: AUX_MIN_WIDTH,
    minHeight: AUX_MIN_HEIGHT,
    title: windowTitle,
    backgroundColor,
    resizable: true,
    autoHideMenuBar: true,
    show: true,
    ...(context.iconPath ? { icon: context.iconPath } : {}),
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 12, y: 10 },
        }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: isDark
            ? { color: DARK_PANEL_BACKGROUND, symbolColor: '#A8A093', height: 34 }
            : { color: LIGHT_PANEL_BACKGROUND, symbolColor: '#615C52', height: 34 },
        }),
    webPreferences: {
      ...(context.preloadPath ? { preload: context.preloadPath } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }

  const child = new BrowserWindow(winOptions)
  const wcId = child.webContents.id
  trustIpcSender(wcId)
  auxWindows.set(frameName, child)

  try {
    child.setMenuBarVisibility?.(false)
  } catch {
    // 个别平台没有菜单栏
  }

  const notifyMaximized = (maximized: boolean): void => {
    const payload = { host: frameName, maximized }
    const host = context.getMainWindow()
    if (isWebContentsAlive(host)) {
      host.webContents.send('window:maximized-changed', payload)
    }
    if (isWebContentsAlive(child)) {
      child.webContents.send('window:maximized-changed', payload)
    }
  }
  child.on('maximize', () => notifyMaximized(true))
  child.on('unmaximize', () => notifyMaximized(false))

  // 子窗口反向加固：禁止 webview、限制导航白名单、仅允许可信来源拉起外部 http(s) 链接
  child.webContents.setWindowOpenHandler?.((details) => {
    const referrerUrl = typeof details.referrer?.url === 'string' ? details.referrer.url : ''
    if (isAllowedWindowOpenReferrer(referrerUrl) && isExternalUrl(details.url)) {
      void shell.openExternal(details.url).catch(() => undefined)
    }
    return { action: 'deny' }
  })
  child.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedAppNavigation(url)) event.preventDefault()
  })
  child.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  child.on('closed', () => {
    // 身份校验：防止重开同名窗口时旧窗口 closed 误删新窗口登记记录
    const isCurrent = auxWindows.get(frameName) === child
    if (isCurrent) auxWindows.delete(frameName)
    // 窗口销毁后不可再读 child.webContents，必须使用创建时缓存的数值 wcId
    untrustIpcSender(wcId)
    if (!isCurrent) return
    const host = context.getMainWindow()
    if (context.onClosed) {
      if (host && !host.isDestroyed()) context.onClosed(frameName)
    } else if (isWebContentsAlive(host)) {
      host.webContents.send('aux:window-closed', frameName)
    }
    relaySyncState(
      {
        sourceHost: hostId,
        kind: 'panel-docked',
        workspaceDir,
        panel,
        hostId,
      },
      wcId
    )
  })

  const targetUrl = buildPanelWindowUrl({
    windowMode: 'panel',
    panel,
    workspace: workspaceDir,
    hostId,
    theme,
    lang: language,
    boot: '0',
  })
  void Promise.resolve(child.loadURL(targetUrl)).catch((error: unknown) => {
    console.error('[AuxWindow] Failed to load detached panel URL:', error)
  })

  return { success: true, hostId, frameName }
}

/** 关闭指定 hostId 的拆出面板窗口（回位主窗口）；已关闭时幂等返回成功 */
export function closeDetachedPanelWindow(hostId: string): PanelDockResult {
  if (!isValidHostId(hostId)) {
    return { success: false, error: 'Invalid host' }
  }
  const frameName = `${AUX_FRAME_PREFIX}${hostId}`
  const win = auxWindows.get(frameName)
  if (!win || win.isDestroyed()) {
    auxWindows.delete(frameName)
    return { success: true }
  }
  win.close()
  return { success: true }
}

/** 真正退出应用（before-quit）或主窗口彻底销毁时回收全部拆出面板窗口，避免阻塞退出 */
export function closeAllDetachedPanelWindows(): void {
  for (const [frameName, win] of [...auxWindows.entries()]) {
    if (win.isDestroyed()) {
      auxWindows.delete(frameName)
      continue
    }
    try {
      win.close()
    } catch {
      // 窗口可能已在退出过程中销毁
    }
  }
}

export function registerAuxWindowIpc(context: AuxWindowIpcContext): void {
  handleIpc('aux:drag-begin', () => beginDetachDrag())
  handleIpc('aux:detach-at', () => resolveDetachTarget(context.getMainWindow() as BrowserWindow))

  handleIpc('aux:window-command', (_event, frameName: unknown, command: unknown) => {
    if (!isAuxFrameName(frameName)) return { success: false, error: 'Invalid host' }
    if (command !== 'minimize' && command !== 'toggleMaximize' && command !== 'close') {
      return { success: false, error: 'Invalid command' }
    }
    return runAuxWindowCommand(frameName, command)
  })

  handleIpc('aux:window-state', (_event, frameName: unknown) => {
    if (!isAuxFrameName(frameName)) return { success: false, error: 'Invalid host' }
    return readAuxWindowState(frameName)
  })

  handleIpc('panel:detach', (_event, rawOptions: unknown) => {
    const validated = parseContractArgs('panel:detach', [rawOptions])
    if (!validated.ok) return { success: false, error: validated.error }
    return createDetachedPanelWindow(validated.data[0], context)
  })

  handleIpc('panel:dock', (_event, hostId: unknown) => {
    const validated = parseContractArgs('panel:dock', [hostId])
    if (!validated.ok) return { success: false, error: validated.error }
    return closeDetachedPanelWindow(validated.data[0])
  })

  handleIpc('sync:broadcast', (event, rawMessage: unknown) => {
    const validated = parseContractArgs('sync:broadcast', [rawMessage])
    if (!validated.ok) return { success: false, error: validated.error }
    const [message] = validated.data
    if (message.kind === 'theme') {
      context.onThemeSync?.(message.mode)
    } else if (message.kind === 'open-file' || message.kind === 'open-settings') {
      const mainWin = context.getMainWindow()
      if (mainWin && !mainWin.isDestroyed()) {
        if (mainWin.isMinimized?.()) mainWin.restore?.()
        if (typeof mainWin.isVisible === 'function' && !mainWin.isVisible()) mainWin.show?.()
        mainWin.focus?.()
      }
    }
    const senderId = typeof event?.sender?.id === 'number' ? event.sender.id : undefined
    relaySyncState(message, senderId)
    return { success: true }
  })
}

export interface AuxWindowSupportOptions {
  /** 保留可选签名兼容既有调用点；拆窗已改走 `panel:detach` IPC */
  onClosed?: (frameName: string) => void
}

/**
 * 收紧主窗口 `window.open` 策略：
 * - 仅放行来自可信外壳/开发服务器的外部 `http(s)://` 链接交给系统浏览器；
 * - 拒绝所有内部弹窗（包括旧版 `about:blank` + `pi-panel:`），所有面板拆窗统一经 `panel:detach` IPC 创建。
 */
export function installAuxWindowSupport(host: BrowserWindow, _options?: AuxWindowSupportOptions): void {
  host.webContents.setWindowOpenHandler((details) => {
    const { url } = details
    const referrerUrl = typeof details.referrer?.url === 'string' ? details.referrer.url : ''
    if (!isAllowedWindowOpenReferrer(referrerUrl)) {
      return { action: 'deny' }
    }
    if (isExternalUrl(url)) {
      void shell.openExternal(url).catch(() => undefined)
    }
    return { action: 'deny' }
  })
}
