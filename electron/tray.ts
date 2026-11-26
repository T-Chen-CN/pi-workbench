/**
 * 托盘常驻：主窗口关闭按钮 = 收进托盘，进程与全部后台任务继续运行。
 *
 * 这里只负责「托盘图标 + 菜单」和「关闭按钮该做什么」的判定；窗口本身由
 * main.ts 持有，通过回调注入，避免托盘模块反向依赖主进程状态。
 *
 * 平台差异：
 * - Windows：托盘图标用彩色 `.ico`，首次收起时用气泡提示一次（每次启动一条）；
 * - macOS：菜单栏用单色 π 模板图（`tray-template.png`），跟随系统深浅色；
 * - Linux：桌面环境的托盘支持不一致（GNOME 默认没有托盘区），收进去可能再也
 *   找不回来，因此降级为「最小化到任务栏」，不创建托盘。
 */

import {
  Menu,
  Tray,
  app,
  nativeImage,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron'
import * as path from 'path'
import { fileURLToPath } from 'url'

// 主进程为 ESM，没有 CJS 的 __dirname
const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/** 主窗口关闭时该做什么 */
export type CloseAction = 'close' | 'hide' | 'minimize'

export const TRAY_LABELS = {
  zh: {
    tooltip: 'Pi Workbench',
    show: '显示主窗口',
    quit: '退出',
    hintTitle: '仍在后台运行',
    hintBody: '应用已收进托盘，会话与终端继续运行。点托盘图标可打开主窗口。'
  },
  en: {
    tooltip: 'Pi Workbench',
    show: 'Show Main Window',
    quit: 'Quit',
    hintTitle: 'Still running',
    hintBody: 'The app is in the tray and your sessions keep running. Click the tray icon to open the window.'
  }
} as const

export function normalizeTrayLanguage(value: unknown): 'zh' | 'en' {
  return value === 'en' ? 'en' : 'zh'
}

/**
 * 关闭按钮的语义：
 * - 真退出（`quitting`）或用户关掉「收进托盘」→ 正常关闭窗口；
 * - 托盘常驻 → 隐藏窗口；Linux 降级为最小化；
 * - Windows 上托盘创建失败 → 退回正常关闭，避免窗口藏起来却找不到入口。
 */
export function resolveCloseAction(input: {
  closeToTray: boolean
  quitting: boolean
  trayReady: boolean
  platform?: NodeJS.Platform
}): CloseAction {
  if (input.quitting || !input.closeToTray) return 'close'
  const platform = input.platform ?? process.platform
  if (platform === 'linux') return 'minimize'
  // macOS 还有 Dock 图标，托盘缺失也不会失去入口
  if (platform === 'darwin') return 'hide'
  return input.trayReady ? 'hide' : 'close'
}

export function trayMenuTemplate(
  language: unknown,
  actions: { showMainWindow: () => void; quit: () => void }
): MenuItemConstructorOptions[] {
  const labels = TRAY_LABELS[normalizeTrayLanguage(language)]
  return [
    { label: labels.show, click: actions.showMainWindow },
    { type: 'separator' },
    { label: labels.quit, click: actions.quit }
  ]
}

export interface TrayBadgeState {
  runningTasks: number
  unreadCount: number
}

export function formatTrayTooltip(language: unknown, status?: TrayBadgeState): string {
  const lang = normalizeTrayLanguage(language)
  const base = TRAY_LABELS[lang].tooltip
  if (!status) return base
  const running = Math.max(0, Math.floor(status.runningTasks))
  const unread = Math.max(0, Math.floor(status.unreadCount))
  if (running === 0 && unread === 0) return base
  const parts: string[] = [base]
  if (running > 0) {
    parts.push(lang === 'en' ? `${running} task${running > 1 ? 's' : ''} running` : `${running} 个工单执行中`)
  }
  if (unread > 0) {
    parts.push(lang === 'en' ? `${unread} unread` : `${unread} 条未读`)
  }
  return parts.join(' · ')
}

/** 生成 16x16 纯色圆点角标位图，供 Windows 任务栏 setOverlayIcon 使用（零外部绘图依赖） */
function createOverlayBadgeIcon(count: number): NativeImage | null {
  if (count <= 0 || typeof nativeImage.createFromBuffer !== 'function') return null
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  const cx = 7.5
  const cy = 7.5
  const radius = 6.5
  // 琥珀强调色（#D97706 → BGRA on Windows/Electron raw bitmap: B=6, G=119, R=217, A=255）
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - cx
      const dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist <= radius) {
        const idx = (y * size + x) * 4
        const border = dist > radius - 1.2
        buf[idx] = border ? 255 : 6
        buf[idx + 1] = border ? 255 : 119
        buf[idx + 2] = border ? 255 : 217
        buf[idx + 3] = 255
      }
    }
  }
  try {
    return nativeImage.createFromBuffer(buf, { width: size, height: size })
  } catch {
    return null
  }
}

export interface TrayOptions {
  /** 用户偏好：关闭按钮是否收进托盘 */
  getEnabled: () => boolean
  getLanguage: () => unknown
  showMainWindow: () => void
  quit: () => void
  /** 可选：用于 Windows 任务栏覆盖角标（F-32 / C-03c） */
  getMainWindow?: () => BrowserWindow | null
}

let tray: Tray | null = null
let options: TrayOptions | null = null
let hintShown = false
let badgeState: TrayBadgeState = { runningTasks: 0, unreadCount: 0 }

export function isTrayReady(): boolean {
  return Boolean(tray && !tray.isDestroyed())
}

function trayImage(): NativeImage {
  if (process.platform === 'darwin') {
    // 模板图：只保留 alpha，颜色由系统按菜单栏底色决定
    const template = nativeImage.createFromPath(path.join(moduleDir, '../tray-template.png'))
    if (!template.isEmpty()) {
      template.setTemplateImage(true)
      return template
    }
  }
  const ico = nativeImage.createFromPath(path.join(moduleDir, '../app-icon.ico'))
  if (!ico.isEmpty()) return ico
  const png = nativeImage.createFromPath(path.join(moduleDir, '../app-icon.png'))
  return png.isEmpty() ? png : png.resize({ width: 16, height: 16 })
}

/** 按当前设置创建 / 更新 / 销毁托盘；重复调用是幂等的 */
export function refreshTray(): void {
  if (!options) return
  if (!options.getEnabled() || process.platform === 'linux') {
    destroyTray()
    return
  }
  if (!isTrayReady()) {
    try {
      tray = new Tray(trayImage())
      // Windows：单击图标直接打开主窗口；右键由 setContextMenu 负责
      if (process.platform === 'win32') tray.on('click', () => options?.showMainWindow())
      console.log('[Main] Tray icon installed')
    } catch (error) {
      console.error('[Main] Failed to create tray icon:', error)
      tray = null
      return
    }
  }
  const isMac = process.platform === 'darwin'
  const instance = tray
  if (!instance) return
  instance.setToolTip(formatTrayTooltip(options.getLanguage(), badgeState))
  const menu = trayMenuTemplate(options.getLanguage(), {
    showMainWindow: () => options?.showMainWindow(),
    quit: () => options?.quit()
  })
  // macOS 菜单栏图标本身不区分左右键，菜单由系统在点击时弹出
  instance.setContextMenu(Menu.buildFromTemplate(menu))
  if (isMac) instance.setIgnoreDoubleClickEvents(true)
}

/** 更新托盘提示与系统角标（F-32 / C-03c）：显示运行中工单数与云端未读数 */
export function updateTrayBadge(next: Partial<TrayBadgeState>): void {
  badgeState = {
    runningTasks:
      typeof next.runningTasks === 'number' && Number.isFinite(next.runningTasks)
        ? Math.max(0, Math.floor(next.runningTasks))
        : badgeState.runningTasks,
    unreadCount:
      typeof next.unreadCount === 'number' && Number.isFinite(next.unreadCount)
        ? Math.max(0, Math.floor(next.unreadCount))
        : badgeState.unreadCount,
  }
  const total = badgeState.runningTasks + badgeState.unreadCount
  const tooltip = formatTrayTooltip(options?.getLanguage(), badgeState)

  if (isTrayReady() && tray) {
    tray.setToolTip(tooltip)
  }

  // macOS / Linux 原生应用角标
  if (process.platform !== 'win32' && typeof app?.setBadgeCount === 'function') {
    try {
      app.setBadgeCount(total)
    } catch {
      // 部分 Linux 桌面环境不支持角标，静默忽略
    }
  }

  // Windows 任务栏覆盖角标
  if (process.platform === 'win32') {
    const win = options?.getMainWindow?.()
    if (win && !win.isDestroyed() && typeof win.setOverlayIcon === 'function') {
      try {
        if (total > 0) {
          const icon = createOverlayBadgeIcon(total)
          win.setOverlayIcon(icon, tooltip)
        } else {
          win.setOverlayIcon(null, '')
        }
      } catch {
        // 忽略无头或窗口销毁时的竞态
      }
    }
  }
}

export function installTray(next: TrayOptions): void {
  options = next
  refreshTray()
}

export function destroyTray(): void {
  badgeState = { runningTasks: 0, unreadCount: 0 }
  if (!tray) return
  try {
    tray.destroy()
  } catch (error) {
    console.warn('[Main] Failed to destroy tray icon:', error)
  }
  tray = null
}

/** Windows 首次收进托盘时提示一次（每次启动最多一次，macOS / Linux 不提示） */
export function showTrayHintOnce(): void {
  if (process.platform !== 'win32' || hintShown || !isTrayReady()) return
  hintShown = true
  const labels = TRAY_LABELS[normalizeTrayLanguage(options?.getLanguage())]
  try {
    tray?.displayBalloon({
      title: labels.hintTitle,
      content: labels.hintBody,
      icon: trayImage(),
      iconType: 'info',
      noSound: true
    })
  } catch (error) {
    console.warn('[Main] Failed to show tray hint:', error)
  }
}
