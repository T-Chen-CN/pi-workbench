/** IPC 注册与来源校验 */

import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { isAppUrl } from '../app-protocol.js'
import {
  parseContractArgs,
  type IpcInvokeChannel,
  type IpcInvokeContract,
} from './contract.js'

let getMainWindow: () => BrowserWindow | null = () => null

/** 主进程创建窗口后注入 getter；测试中保持返回 null 即可 */
export function configureIpcWindow(getter: () => BrowserWindow | null): void {
  getMainWindow = getter
}

/**
 * 拆出的独立原生面板窗口同样要能用 IPC（文件树、Git、会话、终端、跨窗同步）。
 * 它们由主进程 `createDetachedPanelWindow` 创建并加载 `pw-app://bundle/index.html`（或开发服务器），
 * 窗口创建时登记 `webContents.id`，销毁时移除。
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

function isTrustedFrameUrl(frameUrl: string): boolean {
  if (!frameUrl) return false
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

/** 只接受主窗口主框架（或已登记的独立面板窗口）发来的 IPC；应用 ready 之后 fail-closed */
export function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  // 测试替身没有 isReady，直接放行
  if (typeof app.isReady !== 'function') return true
  if (!app.isReady()) return true
  const senderId = event.sender.id
  const mainWindow = getMainWindow()
  const fromMain = Boolean(
    mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
  )
  const fromAux = !fromMain && trustedAuxSenders.has(senderId)
  if (!fromMain && !fromAux) return false
  // fail-closed：缺失 senderFrame 或来自子框架一律拒绝
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false
  if (!isTrustedFrameUrl(event.senderFrame.url)) return false
  return true
}

export function handleIpc<TArgs extends readonly unknown[] = unknown[], TResult = unknown>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedIpcSender(event)) {
      return { success: false, error: 'Untrusted IPC sender' }
    }
    return listener(event, ...(args as unknown as TArgs))
  })
}

/**
 * 基于单源契约（`electron/ipc/contract.ts`）的强类型 IPC 注册入口：
 * - 与 `handleIpc` 一致强制执行 `isTrustedIpcSender` fail-closed；
 * - 若该通道在 `IPC_INVOKE_SCHEMAS` 登记了运行时 Zod 校验器，先校验再分发。
 */
export function handleTypedIpc<K extends IpcInvokeChannel>(
  channel: K,
  listener: (
    event: IpcMainInvokeEvent,
    ...args: IpcInvokeContract[K]['args']
  ) => IpcInvokeContract[K]['result'] | Promise<IpcInvokeContract[K]['result']>
): void {
  ipcMain.handle(channel, (event, ...rawArgs: unknown[]) => {
    if (!isTrustedIpcSender(event)) {
      return { success: false, error: 'Untrusted IPC sender' }
    }
    const validated = parseContractArgs(channel, rawArgs)
    if (!validated.ok) {
      return { success: false, error: validated.error }
    }
    return listener(event, ...validated.data)
  })
}
