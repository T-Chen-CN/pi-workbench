/**
 * 主进程系统代理适配：让 Node 运行时的全局 `fetch` 跟随操作系统代理设置。
 *
 * Pi Agent、供应商目录、GitHub 与联网搜索均在主进程调用 `globalThis.fetch`；
 * Node 内置 undici `fetch` 默认忽略操作系统代理（Windows WinINET / macOS / Linux）。
 * 开启后把 `http:` / `https:` 请求路由给 Electron `net.fetch`（走 Chromium 网络栈与
 * 系统代理 / PAC / SOCKS5），关闭时直接回退到原始 `fetch`，切换即时生效无需重启。
 */

import * as electron from 'electron'
import * as http from 'http'
import * as https from 'https'
import * as tls from 'tls'
import type { ClientRequestArgs } from 'http'
import type { Duplex } from 'stream'

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

/** 回环地址直连不走系统代理，防止本机 Vite / OAuth 回调 / 局部测试服务被代理劫持 */
export function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase()
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.endsWith('.localhost')
    )
  } catch {
    return false
  }
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
    const httpUrl = extractHttpUrl(input)
    if (!httpUrl || isLoopbackUrl(httpUrl)) {
      return deps.baseFetch(input, init)
    }
    const target: string | Request = input instanceof URL ? input.toString() : input
    const nextInit: NetFetchInit = init
      ? { ...init, bypassCustomProtocolHandlers: true }
      : { bypassCustomProtocolHandlers: true }
    return deps.netFetch(target, nextInit)
  }
}

/** 解析 Chromium `resolveProxy()` 返回的 PAC 字符串，取首个 HTTP(S) 代理项 */
export function parseFirstHttpProxy(pacResult: string): { host: string; port: number } | null {
  for (const rawEntry of pacResult.split(';')) {
    const trimmed = rawEntry.trim()
    if (!trimmed) continue
    const [scheme, authority] = trimmed.split(/\s+/, 2)
    const upper = scheme?.toUpperCase()
    if (upper === 'DIRECT') return null
    if ((upper === 'PROXY' || upper === 'HTTP' || upper === 'HTTPS') && authority) {
      try {
        const parsed = new URL(`${upper === 'HTTPS' ? 'https' : 'http'}://${authority}`)
        const port = Number(parsed.port || (upper === 'HTTPS' ? '443' : '80'))
        if (parsed.hostname && Number.isInteger(port) && port > 0 && port <= 65535) {
          return { host: parsed.hostname, port }
        }
      } catch {
        continue
      }
    }
  }
  return null
}

/** 为 `ws` 客户端构造走 HTTP CONNECT 隧道的 Agent（仅在系统代理开启且非直连/非回环时返回） */
function createHttpConnectAgent(
  proxy: { host: string; port: number },
  secureTarget: boolean
): http.Agent {
  const BaseAgent = secureTarget ? https.Agent : http.Agent
  class ConnectProxyAgent extends BaseAgent {
    override createConnection(
      options: ClientRequestArgs & { servername?: string },
      callback?: (err: Error | null, stream: Duplex) => void
    ): Duplex | null | undefined {
      const targetHost = String(options.hostname || options.host || '')
      const targetPort = Number(options.port) || (secureTarget ? 443 : 80)
      const authority = `${targetHost}:${targetPort}`
      const req = http.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: authority,
        headers: { Host: authority },
      })
      let settled = false
      const done = (err: Error | null, socket?: Duplex) => {
        if (settled) return
        settled = true
        callback?.(err, socket as Duplex)
      }
      req.once('connect', (res, socket, head) => {
        if (res.statusCode !== 200) {
          socket.destroy()
          done(new Error(`Proxy CONNECT rejected with HTTP ${res.statusCode}`))
          return
        }
        if (head && head.length > 0) socket.unshift(head)
        if (!secureTarget) {
          done(null, socket)
          return
        }
        const tlsSocket = tls.connect({
          socket,
          servername: options.servername || targetHost,
        })
        tlsSocket.once('error', (err) => done(err))
        done(null, tlsSocket)
      })
      req.once('error', (err) => done(err))
      req.end()
      // createConnection 异步返回 undefined，ws 通过 callback 接收已建立的隧道 socket
      return undefined
    }
  }
  return new ConnectProxyAgent({ keepAlive: false })
}

export interface SystemProxyOptions {
  getEnabled: () => boolean
  logger?: Pick<Console, 'log' | 'warn'>
}

let installed = false
let originalFetch: typeof globalThis.fetch | null = null
let proxyOptions: SystemProxyOptions | null = null
let lastLoggedEnabled: boolean | null = null

function getIsolatedProxySession(): Electron.Session | null {
  try {
    const sess = electron.session
    if (typeof sess?.fromPartition !== 'function') return null
    // 独立非持久分区：主进程 API 请求不读写渲染层 defaultSession 的 Cookie 与 HSTS
    return sess.fromPartition('pi-system-proxy', { cache: false })
  } catch {
    return null
  }
}

/** 当前主进程系统代理开关是否启用且 Electron app 已就绪（同步快速路径，避免关闭态引入微任务延迟） */
export function isSystemProxyActive(): boolean {
  if (!proxyOptions?.getEnabled()) return false
  try {
    return typeof electron.app?.isReady === 'function' && electron.app.isReady()
  } catch {
    return false
  }
}

/** 为主进程 `ws` WebSocket 解析系统代理 Agent；关闭、直连或回环地址返回 undefined */
export async function resolveWebSocketProxyAgent(wsUrl: string): Promise<http.Agent | undefined> {
  if (!isSystemProxyActive()) return undefined
  let parsed: URL
  try {
    parsed = new URL(wsUrl)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return undefined
  if (isLoopbackUrl(wsUrl)) return undefined
  const httpEquivalent = `${parsed.protocol === 'wss:' ? 'https:' : 'http:'}//${parsed.host}${parsed.pathname}`
  let defaultSession: Electron.Session | undefined
  try {
    defaultSession = electron.session?.defaultSession
  } catch {
    defaultSession = undefined
  }
  const targetSession = getIsolatedProxySession() ?? defaultSession
  if (typeof targetSession?.resolveProxy !== 'function') return undefined
  try {
    const pac = await targetSession.resolveProxy(httpEquivalent)
    const proxy = parseFirstHttpProxy(pac)
    if (!proxy) return undefined
    return createHttpConnectAgent(proxy, parsed.protocol === 'wss:')
  } catch {
    return undefined
  }
}

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
      isAppReady: () => {
        try {
          return typeof electron.app?.isReady === 'function' && electron.app.isReady()
        } catch {
          return false
        }
      },
      baseFetch,
      netFetch:
        typeof electron.net?.fetch === 'function'
          ? (input, init) => {
              const isolated = getIsolatedProxySession()
              return isolated && typeof isolated.fetch === 'function'
                ? isolated.fetch(input, init)
                : electron.net.fetch(input, init)
            }
          : null,
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
