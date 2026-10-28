/** IPC 注册与来源校验 */

import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

let getMainWindow: () => BrowserWindow | null = () => null

/** 主进程创建窗口后注入 getter；测试中保持返回 null 即可 */
export function configureIpcWindow(getter: () => BrowserWindow | null): void {
  getMainWindow = getter
}

/**
 * 拆出的面板窗口同样要能用 IPC（链接、剪贴板、会话）。
 * 它们由主窗口 window.open('about:blank') 创建，与主窗口同源；窗口销毁时移除。
 */
const trustedAuxSenders = new Set<number>()

export function trustIpcSender(contents: { id: number }): void {
  trustedAuxSenders.add(contents.id)
}

export function untrustIpcSender(contents: { id: number }): void {
  trustedAuxSenders.delete(contents.id)
}

/** 只接受主窗口主框架（或已登记的辅助窗口）发来的 IPC；应用 ready 之后 fail-closed */
export function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  // 测试替身没有 isReady，直接放行
  if (typeof app.isReady !== 'function') return true
  if (!app.isReady()) return true
  const senderId = event.sender.id
  const mainWindow = getMainWindow()
  const fromMain = Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents)
  if (!fromMain && !trustedAuxSenders.has(senderId)) return false
  // 子框架不能借用窗口身份（about:blank 子框架会继承同一 webContents）
  if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) return false
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
