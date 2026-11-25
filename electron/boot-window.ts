/**
 * 主窗口启动期动画与尺寸状态机。
 *
 * 首启以紧凑启动窗居中展示，在最短停留（600ms）且渲染层就绪（或 8s 兜底超时）后
 * 平滑放大到正常主窗口尺寸，并通知渲染层切换到主界面。
 */
import { app, BrowserWindow, screen, type Rectangle } from 'electron'
import { animateBounds, type WindowBounds } from './window-morph.js'

const BOOT_WINDOW_WIDTH = 420
const BOOT_WINDOW_HEIGHT = 260
const APP_WINDOW_WIDTH = 1200
const APP_WINDOW_HEIGHT = 800
const BOOT_HOLD_MS = 600
const BOOT_EXPAND_MS = 400
const BOOT_READY_TIMEOUT_MS = 8000

export function centeredWindowBounds(
  workArea: Rectangle,
  width: number,
  height: number
): WindowBounds {
  const w = Math.min(width, workArea.width)
  const h = Math.min(height, workArea.height)
  return {
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + (workArea.height - h) / 2),
    width: Math.round(w),
    height: Math.round(h),
  }
}

/** 放大目标以窗口当前中心为准（用户可能拖过小窗），并限制在所在显示器工作区内 */
function expandedWindowBounds(win: BrowserWindow): WindowBounds {
  const current = win.getBounds()
  const workArea = screen.getDisplayMatching(current).workArea
  const width = Math.min(APP_WINDOW_WIDTH, workArea.width)
  const height = Math.min(APP_WINDOW_HEIGHT, workArea.height)
  const centerX = current.x + current.width / 2
  const centerY = current.y + current.height / 2
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
  return {
    x: Math.round(clamp(centerX - width / 2, workArea.x, workArea.x + workArea.width - width)),
    y: Math.round(clamp(centerY - height / 2, workArea.y, workArea.y + workArea.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  }
}

export interface BootWindowControllerOptions {
  getMainWindow: () => BrowserWindow | null
  onBootFinished?: () => void
}

export interface BootWindowController {
  isCompleted(): boolean
  initialBounds(workArea: Rectangle): WindowBounds
  begin(win: BrowserWindow): void
  finish(win: BrowserWindow): void
  skip(): void
  handleReady(): void
  reset(): void
}

export function createBootWindowController(
  options: BootWindowControllerOptions
): BootWindowController {
  let bootActive = false
  let bootStartedAt = 0
  let bootReadyAt: number | null = null
  let bootExpanded = false
  let bootCompleted = false
  let bootTimers: ReturnType<typeof setTimeout>[] = []
  let expandScheduled = false
  let cancelExpandAnimation: (() => void) | null = null

  function clearBootTimers(): void {
    for (const timer of bootTimers) clearTimeout(timer)
    bootTimers = []
  }

  function finishBoot(win: BrowserWindow): void {
    if (!bootActive || bootExpanded) return
    bootActive = false
    bootExpanded = true
    bootCompleted = true
    expandScheduled = false
    cancelExpandAnimation = null
    clearBootTimers()
    console.log('[Boot] Window expanded after', Date.now() - bootStartedAt, 'ms')
    if (!win.isDestroyed()) {
      win.setResizable(true)
      if (process.platform === 'darwin') {
        try {
          win.setWindowButtonVisibility(true)
        } catch {
          // 旧版本 macOS / 非 macOS 没有该方法
        }
      }
      try {
        win.webContents.send('app:boot-expanded')
      } catch (error) {
        console.warn('[Boot] Failed to notify renderer:', error)
      }
    }
    if (app.isPackaged && process.platform !== 'darwin') {
      options.onBootFinished?.()
    }
  }

  function startExpansion(win: BrowserWindow): void {
    if (bootExpanded || win.isDestroyed()) return
    const from = win.getBounds()
    const to = expandedWindowBounds(win)
    console.log(
      '[Boot] Expanding window',
      `${from.width}×${from.height}`,
      '→',
      `${to.width}×${to.height}`
    )
    cancelExpandAnimation = animateBounds({
      from,
      to,
      durationMs: BOOT_EXPAND_MS,
      apply: (bounds) => {
        if (!win.isDestroyed()) win.setBounds(bounds)
      },
      onDone: () => finishBoot(win),
    })
  }

  function scheduleExpansion(win: BrowserWindow): void {
    if (bootExpanded || expandScheduled || win.isDestroyed()) return
    expandScheduled = true
    const startAt = Math.max(bootStartedAt + BOOT_HOLD_MS, bootReadyAt ?? Date.now())
    const timer = setTimeout(() => startExpansion(win), Math.max(0, startAt - Date.now()))
    bootTimers.push(timer)
  }

  function reset(): void {
    clearBootTimers()
    cancelExpandAnimation?.()
    cancelExpandAnimation = null
    expandScheduled = false
    bootActive = false
  }

  return {
    isCompleted: () => bootCompleted,
    initialBounds: (workArea: Rectangle) =>
      bootCompleted
        ? centeredWindowBounds(workArea, APP_WINDOW_WIDTH, APP_WINDOW_HEIGHT)
        : centeredWindowBounds(workArea, BOOT_WINDOW_WIDTH, BOOT_WINDOW_HEIGHT),
    begin(win: BrowserWindow): void {
      bootActive = true
      bootStartedAt = Date.now()
      bootReadyAt = null
      bootExpanded = false
      expandScheduled = false
      clearBootTimers()
      const fallback = setTimeout(() => {
        if (bootExpanded) return
        console.warn('[Boot] Renderer did not signal ready in time; expanding anyway')
        scheduleExpansion(win)
      }, BOOT_READY_TIMEOUT_MS)
      bootTimers.push(fallback)
    },
    finish: finishBoot,
    skip(): void {
      reset()
    },
    handleReady(): void {
      const win = options.getMainWindow()
      if (!bootActive || bootExpanded || !win || win.isDestroyed()) return
      bootReadyAt = Date.now()
      console.log('[Boot] Renderer ready after', bootReadyAt - bootStartedAt, 'ms')
      scheduleExpansion(win)
    },
    reset,
  }
}
