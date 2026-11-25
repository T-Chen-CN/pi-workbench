/** IPC 注册与来源校验 */

import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { isAppUrl } from '../app-protocol.js'

let getMainWindow: () => BrowserWindow | null = () => null

/** 主进程创建窗口后注入 getter；测试中保持返回 null 即可 */
export function configureIpcWindow(getter: () => BrowserWindow | null): void {
  getMainWindow = getter
}

/**
 * 拆出的面板窗口同样要能用 IPC（链接、剪贴板、会话）。
 * 它们由主窗口 window.open('about:blank') 创建，与主窗口同源；窗口销毁时移除。
 *
 * 接口收的是 webContents **id**，不是 webContents 对象：窗口 destroyed 之后读
 * `win.webContents` 会抛 `Object has been destroyed`，而 `closed` 回调正是那个时刻，
 * 调用方只能带着创建时取好的数字过来（见 electron/aux-window.ts）。
 */
const trustedAuxSenders = new Set<number>()

export function trustIpcSender(webContentsId: number): void {
  trustedAuxSenders.add(webContentsId)
}

export function untrustIpcSender(webContentsId: number): void {
  trustedAuxSenders.delete(webContentsId)
}

function isTrustedFrameUrl(frameUrl: string, allowAuxBlank: boolean): boolean {
  if (!frameUrl) return false
  if (allowAuxBlank && frameUrl === 'about:blank') return true
  if (isAppUrl(frameUrl)) return true
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    try {
      return new URL(frameUrl).origin === new URL(devServerUrl).origin
    } catch {
      return false
    }
  }
  return false
}

/** 只接受主窗口主框架（或已登记的辅助窗口）发来的 IPC；应用 ready 之后 fail-closed */
export function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  // 测试替身没有 isReady，直接放行
  if (typeof app.isReady !== 'function') return true
  if (!app.isReady()) return true
  const senderId = event.sender.id
  const mainWindow = getMainWindow()
  const fromMain = Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents)
  const fromAux = !fromMain && trustedAuxSenders.has(senderId)
  if (!fromMain && !fromAux) return false
  // fail-closed：缺失 senderFrame 或来自子框架一律拒绝
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false
  if (!isTrustedFrameUrl(event.senderFrame.url, fromAux)) return false
  return true
}

export function handleIpc(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcSender(event)) {
      return { success: false, error: 'Untrusted IPC sender' }
    }
    return listener(event, ...args)
  })
}
