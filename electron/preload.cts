import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  buildPreloadEventApi,
  buildPreloadInvokeApi,
  IPC_SEND_CHANNELS,
  type AgentStreamPayload,
  type CloudClientOutgoingFrame,
  type CloudClientState,
  type CloudConfigInput,
  type CloudDeviceState,
  type CloudPairInput,
  type ElectronAPIContract,
  type IpcInvokeChannel,
  type IpcInvokeContract,
} from './ipc/contract.js'

function invoke<K extends IpcInvokeChannel>(
  channel: K,
  ...args: IpcInvokeContract[K]['args']
): Promise<IpcInvokeContract[K]['result']> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcInvokeContract[K]['result']>
}

const invokeApi = buildPreloadInvokeApi((channel, ...args) => ipcRenderer.invoke(channel, ...args))
const eventApi = buildPreloadEventApi((channel, listener) => {
  const wrapped = (event: IpcRendererEvent, payload: unknown) => listener(event, payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
})

/** 直连 Agent utilityProcess 的 MessagePort 接口（preload tsconfig 不含 DOM lib，独立声明最小形状） */
interface PreloadStreamPort {
  onmessage: ((event: { data: unknown }) => void) | null
  start?: () => void
  close?: () => void
}

const agentStreamCallbacks = new Set<(payload: AgentStreamPayload) => void>()
const agentStreamPorts = new Map<string, PreloadStreamPort>()

// 接收主进程转交的 Agent utilityProcess 直连流端口，高频 token 不再经主进程逐条中转
ipcRenderer.on('agent:stream-port', (event: IpcRendererEvent, meta: unknown) => {
  const ports = (event as IpcRendererEvent & { ports?: readonly PreloadStreamPort[] }).ports
  const port = ports?.[0]
  if (!port) return
  const record =
    meta && typeof meta === 'object' ? (meta as { workspaceDir?: unknown; portId?: unknown }) : {}
  const key =
    typeof record.workspaceDir === 'string' && record.workspaceDir
      ? record.workspaceDir
      : typeof record.portId === 'string' && record.portId
        ? record.portId
        : `port-${agentStreamPorts.size + 1}`

  const previous = agentStreamPorts.get(key)
  if (previous && previous !== port) {
    previous.onmessage = null
    try {
      previous.close?.()
    } catch {
      // 忽略陈旧端口关闭异常
    }
  }

  agentStreamPorts.set(key, port)
  port.onmessage = (msgEvent: { data: unknown }) => {
    const payload = msgEvent.data as AgentStreamPayload
    for (const callback of [...agentStreamCallbacks]) {
      try {
        callback(payload)
      } catch (error) {
        console.error('[Preload] Agent stream listener failed:', error)
      }
    }
  }
  port.start?.()
})

const electronAPI: ElectronAPIContract = {
  platform: process.platform,
  /** Windows / Linux 主窗口与辅助窗口启用原生 titleBarOverlay，渲染层不再重复绘制窗口按钮 */
  nativeTitleBarOverlay: process.platform !== 'darwin',

  ...invokeApi,
  ...eventApi,

  // 同时订阅直连 MessagePort 与主进程 agent:stream 兜底通道（测试与非端口回退路径继续可用）
  onAgentStream: (callback: (payload: AgentStreamPayload) => void) => {
    agentStreamCallbacks.add(callback)
    const offFallback = eventApi.onAgentStream(callback)
    return () => {
      agentStreamCallbacks.delete(callback)
      offFallback()
    }
  },

  // 剪贴板：pw-app:// 不是浏览器认可的可信来源，navigator.clipboard.writeText 会被拒绝。
  // sandbox preload 里没有 clipboard 模块，转给主进程写系统剪贴板并规范为字符串。
  writeClipboardText: (text: string) => invoke('clipboard:writeText', String(text ?? '')),

  // 强制收敛为布尔值，防止渲染层传入非布尔值触发协议歧义
  providersRefresh: (force?: boolean) => invoke('providers:refresh', force === true),

  // Electron 原生拖拽文件真实路径解析（仅 preload webUtils 可访问）
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // 启动闸门：渲染层数据就绪后单向通知主进程放大窗口
  appBootReady: () => {
    ipcRenderer.send(IPC_SEND_CHANNELS.appBootReady)
  },

  // 云端通道显式契约绑定（与 IPC_INVOKE_CHANNELS / IPC_EVENT_CHANNELS 强对齐，
  // 同时满足静态预加载连线检查）
  cloudLinkStatus: () => invoke('cloud:linkStatus'),
  cloudPair: (input: CloudPairInput) => invoke('cloud:pair', input),
  cloudUnlink: () => invoke('cloud:unlink'),
  cloudReconnect: () => invoke('cloud:reconnect'),
  cloudRefreshWorkspaces: () => invoke('cloud:refreshWorkspaces'),
  cloudListWorkspaces: () => invoke('cloud:listWorkspaces'),
  cloudClientOpen: () => invoke('cloud:clientOpen'),
  cloudClientClose: () => invoke('cloud:clientClose'),
  cloudClientSend: (frame: CloudClientOutgoingFrame) => invoke('cloud:clientSend', frame),
  cloudClientState: () => invoke('cloud:clientState'),
  cloudGetConfig: () => invoke('cloud:getConfig'),
  cloudSaveConfig: (config: CloudConfigInput) => invoke('cloud:saveConfig', config),
  cloudFetchModels: (input: { providerId: string }) => invoke('cloud:fetchModels', input),
  cloudGetMemoryData: () => invoke('cloud:getMemoryData'),
  cloudAddMemory: (input: { kind?: string; content: string; tags?: string[]; pinned?: boolean }) =>
    invoke('cloud:addMemory', input),
  cloudUpdateMemory: (input: {
    id: string
    kind?: string
    content?: string
    tags?: string[]
    pinned?: boolean
  }) => invoke('cloud:updateMemory', input),
  cloudDeleteMemory: (id: string) => invoke('cloud:deleteMemory', id),
  cloudSaveDoc: (input: { name: 'AGENTS.md' | 'SOUL.md'; content: string }) =>
    invoke('cloud:saveDoc', input),
  cloudRunDream: () => invoke('cloud:runDream'),
  onCloudState: (callback: (state: CloudDeviceState) => void) => {
    const listener = (_event: IpcRendererEvent, state: CloudDeviceState) => callback(state)
    ipcRenderer.on('cloud:state', listener)
    return () => {
      ipcRenderer.removeListener('cloud:state', listener)
    }
  },
  onCloudClientFrame: (callback: (frame: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, frame: unknown) => callback(frame)
    ipcRenderer.on('cloud:client-frame', listener)
    return () => {
      ipcRenderer.removeListener('cloud:client-frame', listener)
    }
  },
  onCloudClientState: (callback: (state: CloudClientState) => void) => {
    const listener = (_event: IpcRendererEvent, state: CloudClientState) => callback(state)
    ipcRenderer.on('cloud:client-state', listener)
    return () => {
      ipcRenderer.removeListener('cloud:client-state', listener)
    }
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
