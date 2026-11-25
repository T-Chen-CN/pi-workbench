/**
 * 主进程系统代理适配：让 Node 运行时的全局 `fetch` 跟随操作系统代理设置。
 *
 * Pi Agent、供应商目录、GitHub 与联网搜索均在主进程调用 `globalThis.fetch`；
 * Node 内置 undici `fetch` 默认忽略操作系统代理（Windows WinINET / macOS / Linux）。
 * 开启后把 `http:` / `https:` 请求路由给 Electron `net.fetch`（走 Chromium 网络栈与
 * 系统代理 / PAC / SOCKS5），关闭时直接回退到原始 `fetch`，切换即时生效无需重启。
 */

import { app, net } from 'electron'

export type FetchInput = string | URL | Request

export type FetchLike = (input: FetchInput, init?: RequestInit) => Promise<Response>

export type NetFetchInit = RequestInit & {
  bypassCustomProtocolHandlers?: boolean
}

export type NetFetchLike = (input: string | Request, init?: NetFetchInit) => Promise<Response>

export interface SystemProxyFetchDeps {
  isEnabled: () => boolean
  isAppReady: () => boolean
  baseFetch: FetchLike
  netFetch: NetFetchLike | null
}

/** 提取 http(s) URL；非 http(s)（如 file:/data:/blob: 或非法地址）返回 null，交回原始 fetch */
export function extractHttpUrl(input: FetchInput): string | null {
  let raw: string | null = null
  if (typeof input === 'string') {
    raw = input
  } else if (input instanceof URL) {
    raw = input.href
  } else if (typeof input === 'object' && input !== null && 'url' in input && typeof input.url === 'string') {
    raw = input.url
  }
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

/**
 * 构造可热切换的全局 fetch 包装器。
 * 保持单一函数身份：即便第三方 SDK 在初始化时缓存了 `globalThis.fetch`，开关切换仍能即时生效。
 */
export function createSystemProxyFetch(deps: SystemProxyFetchDeps): FetchLike {
  return (input: FetchInput, init?: RequestInit): Promise<Response> => {
    if (!deps.isEnabled() || !deps.netFetch || !deps.isAppReady()) {
      return deps.baseFetch(input, init)
    }
    if (!extractHttpUrl(input)) {
      return deps.baseFetch(input, init)
    }
    const target: string | Request = input instanceof URL ? input.toString() : input
    const nextInit: NetFetchInit = init
      ? { ...init, bypassCustomProtocolHandlers: true }
      : { bypassCustomProtocolHandlers: true }
    return deps.netFetch(target, nextInit)
  }
}

export interface SystemProxyOptions {
  getEnabled: () => boolean
  logger?: Pick<Console, 'log' | 'warn'>
}

let installed = false
let originalFetch: typeof globalThis.fetch | null = null
let proxyOptions: SystemProxyOptions | null = null
let lastLoggedEnabled: boolean | null = null

function logStateIfChanged(): void {
  if (!proxyOptions) return
  const enabled = Boolean(proxyOptions.getEnabled())
  if (enabled === lastLoggedEnabled) return
  lastLoggedEnabled = enabled
  const logger = proxyOptions.logger ?? console
  logger.log(`[Main] System proxy ${enabled ? 'enabled' : 'disabled'}`)
}

/** 在主进程挂载系统代理 fetch 包装器；重复调用仅更新回调并刷新日志状态 */
export function installSystemProxy(options: SystemProxyOptions): void {
  proxyOptions = options
  if (!installed && typeof globalThis.fetch === 'function') {
    originalFetch = globalThis.fetch
    const baseFetch: FetchLike = originalFetch.bind(globalThis)
    const wrapped = createSystemProxyFetch({
      isEnabled: () => Boolean(proxyOptions?.getEnabled()),
      isAppReady: () => typeof app?.isReady === 'function' && app.isReady(),
      baseFetch,
      netFetch: typeof net?.fetch === 'function' ? (input, init) => net.fetch(input, init) : null,
    })
    globalThis.fetch = wrapped as typeof globalThis.fetch
    installed = true
  }
  logStateIfChanged()
}

/** 设置保存后调用：记录最新开关状态（包装器本身按次读取最新值，已即时生效） */
export function refreshSystemProxy(): void {
  logStateIfChanged()
}

/** 仅用于测试清理：还原原始 globalThis.fetch */
export function uninstallSystemProxy(): void {
  if (installed && originalFetch) {
    globalThis.fetch = originalFetch
  }
  installed = false
  originalFetch = null
  proxyOptions = null
  lastLoggedEnabled = null
}
