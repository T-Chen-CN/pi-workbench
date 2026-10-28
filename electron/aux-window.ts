/**
 * 面板辅助窗口（把面板拆成独立窗口）。
 *
 * 走 `window.open('about:blank')`：子窗口与主窗口同 JS 上下文（Chromium 为
 * `about:blank` 继承 opener 的 origin），React 通过 portal 把面板渲染进子文档。
 * 因此这里只需要「允许开窗 + 加固子窗口 + 提供拖拽落点」三件事，
 * 不需要额外的数据通道或窗口注册表。
 *
 * 与 VS Code 的 auxiliary window、Obsidian 的 popout 是同一路线。
 *
 * 外壳与主窗口一致：Windows / Linux 无边框 + 自绘窗口按钮，macOS 隐藏标题栏
 * 保留红绿灯。自绘按钮意味着「关闭」不再由系统处理，因此这里维护
 * frameName → BrowserWindow 的注册表，让渲染层按窗口寻址，而不是一律操作主窗口。
 */

import { screen, type BrowserWindow, type BrowserWindowConstructorOptions, type Rectangle } from 'electron'
import { handleIpc } from './ipc/register.js'

/** window.open 的 frameName 前缀；只有带前缀的 about:blank 会被放行 */
export const AUX_FRAME_PREFIX = 'pi-panel:'

export const AUX_MIN_WIDTH = 320
export const AUX_MIN_HEIGHT = 220

const DEFAULT_AUX_WIDTH = 520
const DEFAULT_AUX_HEIGHT = 640
const DEFAULT_AUX_BACKGROUND = '#f4f1ea'
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

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

/**
 * window.open features → 受控的 BrowserWindow 选项。
 * 只读取位置、尺寸与首帧背景色；其余一律忽略，渲染层无法借 features 提权。
 */
export function parseAuxWindowFeatures(raw: string, workArea: Rectangle): AuxWindowOptions {
  const features = parseFeatures(raw)
  const maxWidth = Math.max(AUX_MIN_WIDTH, workArea.width)
  const maxHeight = Math.max(AUX_MIN_HEIGHT, workArea.height)

  const width = clampInt(readNumber(features, 'width') ?? DEFAULT_AUX_WIDTH, AUX_MIN_WIDTH, maxWidth)
  const height = clampInt(readNumber(features, 'height') ?? DEFAULT_AUX_HEIGHT, AUX_MIN_HEIGHT, maxHeight)
  const fallbackX = workArea.x + Math.round((workArea.width - width) / 2)
  const fallbackY = workArea.y + Math.round((workArea.height - height) / 2)
  const x = clampInt(readNumber(features, 'left') ?? fallbackX, workArea.x, workArea.x + workArea.width - width)
  const y = clampInt(readNumber(features, 'top') ?? fallbackY, workArea.y, workArea.y + workArea.height - height)

  const rawBackground = features.get('bg') ?? ''
  const backgroundColor = HEX_COLOR.test(rawBackground) ? rawBackground : DEFAULT_AUX_BACKGROUND

  return { width, height, x, y, backgroundColor }
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
  error?: string
}

/** 渲染层在 dragend 时调用：由主进程读取真实光标位置，规避混合 DPI 下 screenX 失真 */
export function resolveDetachTarget(host: BrowserWindow): AuxDetachResult {
  if (!host || host.isDestroyed()) return { success: false, error: 'No window' }
  const point = screen.getCursorScreenPoint()
  const bounds = host.getBounds()
  if (isPointInBounds(point, bounds)) return { success: true, inside: true }
  const workArea = screen.getDisplayNearestPoint(point).workArea
  return { success: true, inside: false, rect: computeDetachedRect(point, bounds, workArea) }
}

export type AuxWindowCommand = 'minimize' | 'toggleMaximize' | 'close'

export interface AuxWindowCommandResult {
  success: boolean
  maximized?: boolean
  error?: string
}

/** frameName → 子窗口。渲染层只有 frameName，窗口引用必须留在主进程 */
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

export function registerAuxWindowIpc(context: { getMainWindow: () => BrowserWindow | null }): void {
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
}

export interface AuxWindowSupportOptions {
  /** 子窗口被用户关闭时回调，参数是 window.open 的 frameName */
  onClosed: (frameName: string) => void
}

/**
 * 在主窗口上启用辅助窗口：
 * - 只放行 `about:blank` + `pi-panel:` 前缀的 window.open；
 * - 覆盖窗口选项（与主窗口一致的外壳、最小尺寸、主题背景色，避免首帧白闪）；
 * - 子窗口反向加固：隐藏菜单栏（保留应用默认菜单的快捷键）、禁导航、禁二级弹窗、禁 webview；
 * - 登记窗口引用，并转发最大化状态给渲染层。
 */
export function installAuxWindowSupport(host: BrowserWindow, options: AuxWindowSupportOptions): void {
  host.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    if (url !== 'about:blank') return { action: 'deny' }
    if (!frameName.startsWith(AUX_FRAME_PREFIX)) return { action: 'deny' }

    const point = screen.getCursorScreenPoint()
    const workArea = screen.getDisplayNearestPoint(point).workArea
    const parsed = parseAuxWindowFeatures(features, workArea)

    const override: BrowserWindowConstructorOptions = {
      x: parsed.x,
      y: parsed.y,
      width: parsed.width,
      height: parsed.height,
      minWidth: AUX_MIN_WIDTH,
      minHeight: AUX_MIN_HEIGHT,
      backgroundColor: parsed.backgroundColor,
      // 与主窗口同一套外壳：无边框 + 自绘窗口按钮，标题栏由 PanelWindowFrame 提供
      ...(process.platform === 'darwin'
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 12, y: 10 }
          }
        : {
            frame: false
          }),
      autoHideMenuBar: true,
      show: true
    }
    return { action: 'allow', overrideBrowserWindowOptions: override }
  })

  host.webContents.on('did-create-window', (child, details) => {
    const frameName = details.frameName
    auxWindows.set(frameName, child)
    try {
      // 不给子窗口单独设菜单：BrowserWindow 会自动继承应用菜单（Windows / Linux 上是
      // 该窗口的菜单栏），Ctrl +/-/0、Ctrl+W 等默认快捷键依附在这份菜单上。
      // 无边框窗口不绘制菜单栏，所以只需把栏隐藏起来即可。
      child.setMenuBarVisibility(false)
    } catch {
      // 个别平台没有菜单栏
    }

    // 自绘窗口按钮的图标切换：主窗口与每个辅助窗口各自上报
    const notifyMaximized = (maximized: boolean) => {
      if (host.isDestroyed()) return
      host.webContents.send('window:maximized-changed', { host: frameName, maximized })
    }
    child.on('maximize', () => notifyMaximized(true))
    child.on('unmaximize', () => notifyMaximized(false))

    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    child.webContents.on('will-navigate', (event, url) => {
      if (url !== 'about:blank') event.preventDefault()
    })
    child.webContents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
    child.on('closed', () => {
      auxWindows.delete(frameName)
      if (!host.isDestroyed()) options.onClosed(frameName)
    })
  })
}
