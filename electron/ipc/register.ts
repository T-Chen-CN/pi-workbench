/** IPC 注册与来源校验 */

import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

let getMainWindow: () => BrowserWindow | null = () => null

/** 主进程创建窗口后注入 getter；测试中保持返回 null 即可 */
export function configureIpcWindow(getter: () => BrowserWindow | null): void {
  getMainWindow = getter
}

/** 只接受主窗口主框架发来的 IPC；应用 ready 之后 fail-closed */
export function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  // 测试替身没有 isReady，直接放行
  if (typeof app.isReady !== 'function') return true
  if (!app.isReady()) return true
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (event.sender !== mainWindow.webContents) return false
  if (event.senderFrame && event.senderFrame !== mainWindow.webContents.mainFrame) return false
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
