/**
 * 主窗口启动期状态机。
 *
 * 直接以正常工作台尺寸居中打开，不再播放 1s 窗口放大动画（避免 `setBounds` 抖动
 * 拖慢首帧可交互时间）；渲染层就绪（或兜底超时）后立刻通知切换到主界面。
 */
import { app, BrowserWindow, type Rectangle } from 'electron'
import type { WindowBounds } from './window-morph.js'

const APP_WINDOW_WIDTH = 1200
const APP_WINDOW_HEIGHT = 800
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
  let bootExpanded = false
  let bootCompleted = false
  let bootTimers: ReturnType<typeof setTimeout>[] = []

  function clearBootTimers(): void {
    for (const timer of bootTimers) clearTimeout(timer)
    bootTimers = []
  }

  function finishBoot(win: BrowserWindow): void {
    if (!bootActive || bootExpanded) return
    bootActive = false
    bootExpanded = true
    bootCompleted = true
    clearBootTimers()
    console.log('[Boot] Ready after', Date.now() - bootStartedAt, 'ms')
    if (!win.isDestroyed()) {
      win.setResizable(true)
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

  function reset(): void {
    clearBootTimers()
    bootActive = false
  }

  return {
    isCompleted: () => bootCompleted,
    initialBounds: (workArea: Rectangle) =>
      centeredWindowBounds(workArea, APP_WINDOW_WIDTH, APP_WINDOW_HEIGHT),
    begin(win: BrowserWindow): void {
      bootActive = true
      bootStartedAt = Date.now()
      bootExpanded = false
      clearBootTimers()
      const fallback = setTimeout(() => {
        if (bootExpanded) return
        console.warn('[Boot] Renderer did not signal ready in time; revealing anyway')
        finishBoot(win)
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
      finishBoot(win)
    },
    reset,
  }
}
