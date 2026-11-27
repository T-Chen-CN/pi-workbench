/**
 * 主进程系统代理适配：让 Node 运行时的全局 `fetch` 与 `ws` 跟随操作系统代理设置。
 *
 * Pi Agent、供应商目录、GitHub 与联网搜索均在主进程调用 `globalThis.fetch`；
 * Node 内置 undici `fetch` 默认忽略操作系统代理（Windows WinINET / macOS / Linux）。
 * 开启后把 `http:` / `https:` 请求路由给 Electron `net.fetch`（走 Chromium 网络栈与
 * 系统代理 / PAC / SOCKS5），`ws:` / `wss:` 连接经 Chromium `resolveProxy()` 解析后
 * 通过 `https-proxy-agent` / `socks-proxy-agent` 建隧道；关闭时直接回退到原始 `fetch`。
 */

import * as electron from 'electron'
import { EventEmitter } from 'events'
import * as http from 'http'
import { createRequire } from 'module'
import * as net from 'net'
import * as tls from 'tls'
import type { ClientRequestArgs } from 'http'
import type { Duplex } from 'stream'

interface ProxyAgentConnectOpts extends Omit<ClientRequestArgs, 'host' | 'port'> {
  host?: string | null
  port?: number | string | null
  secureEndpoint?: boolean
  servername?: string
}

interface ProxyAgentBase extends http.Agent {
  isSecureEndpoint(options?: ProxyAgentConnectOpts): boolean
  connect(req: http.ClientRequest, opts: ProxyAgentConnectOpts): Promise<net.Socket>
  createConnection(
    options?: ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void
  ): Duplex
}

interface ProxyAgentConstructor {
  new (
    proxy: string | URL,
    opts?: http.AgentOptions & { timeout?: number }
  ): ProxyAgentBase
}

const requireProxyAgent = createRequire(import.meta.url)
// https-proxy-agent@9 / socks-proxy-agent@10 仅声明 package.json exports（无顶层 main/types），
// 通过 Node 24 createRequire 按 exports 同步加载，同时兼容 electron/tsconfig.json (node) 与根 tsconfig.json (bundler)
const { HttpsProxyAgent } = requireProxyAgent('https-proxy-agent') as {
  HttpsProxyAgent: ProxyAgentConstructor
}
const { SocksProxyAgent } = requireProxyAgent('socks-proxy-agent') as {
  SocksProxyAgent: ProxyAgentConstructor
}

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

export type ProxyProtocol =
  | 'http:'
  | 'https:'
  | 'socks:'
  | 'socks4:'
  | 'socks4a:'
  | 'socks5:'
  | 'socks5h:'

export interface ParsedProxyEntry {
  host: string
  port: number
  protocol: ProxyProtocol
  username?: string
  password?: string
}

export interface ParsedHttpProxyEntry {
  host: string
  port: number
  protocol: 'http:' | 'https:'
  username?: string
  password?: string
}

function defaultPortForProtocol(protocol: ProxyProtocol): number {
  if (protocol === 'https:') return 443
  if (protocol === 'http:') return 80
  return 1080
}

function parseAuthorityWithProtocol(
  protocol: ProxyProtocol,
  authority: string
): ParsedProxyEntry | null {
  try {
    const parsed = new URL(`${protocol}//${authority}`)
    const port = Number(parsed.port || String(defaultPortForProtocol(protocol)))
    if (!parsed.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return null
    }
    const entry: ParsedProxyEntry = {
      host: parsed.hostname,
      port,
      protocol,
    }
    if (parsed.username) entry.username = decodeURIComponent(parsed.username)
    if (parsed.password) entry.password = decodeURIComponent(parsed.password)
    return entry
  } catch {
    return null
  }
}

const PAC_SCHEME_MAP: Record<string, ProxyProtocol> = {
  PROXY: 'http:',
  HTTP: 'http:',
  HTTPS: 'https:',
  SOCKS: 'socks:',
  SOCKS4: 'socks4:',
  SOCKS4A: 'socks4a:',
  SOCKS5: 'socks5:',
  SOCKS5H: 'socks5h:',
}

/**
 * 解析 Chromium `resolveProxy()` 返回的通用 PAC 字符串：
 * 支持 `DIRECT`、`PROXY`、`HTTP`、`HTTPS`、`SOCKS`、`SOCKS4`、`SOCKS4A`、`SOCKS5`、`SOCKS5H`，
 * 以及可选 `user:pass@host:port` 认证与 IPv6 `[::1]:port`。
 */
export function parseFirstProxyEntry(pacResult: string): ParsedProxyEntry | null {
  for (const rawEntry of pacResult.split(';')) {
    const trimmed = rawEntry.trim()
    if (!trimmed) continue
    const [scheme, authority] = trimmed.split(/\s+/, 2)
    const upper = scheme?.toUpperCase()
    if (upper === 'DIRECT') return null
    const protocol = upper ? PAC_SCHEME_MAP[upper] : undefined
    if (protocol && authority) {
      const parsed = parseAuthorityWithProtocol(protocol, authority)
      if (parsed) return parsed
    }
  }
  return null
}

/** 解析 Chromium `resolveProxy()` 返回的 PAC 字符串，取首个 HTTP(S) 代理项（含协议） */
export function parseFirstHttpProxyEntry(pacResult: string): ParsedHttpProxyEntry | null {
  for (const rawEntry of pacResult.split(';')) {
    const trimmed = rawEntry.trim()
    if (!trimmed) continue
    const [scheme, authority] = trimmed.split(/\s+/, 2)
    const upper = scheme?.toUpperCase()
    if (upper === 'DIRECT') return null
    if ((upper === 'PROXY' || upper === 'HTTP' || upper === 'HTTPS') && authority) {
      const protocol: 'http:' | 'https:' = upper === 'HTTPS' ? 'https:' : 'http:'
      const parsed = parseAuthorityWithProtocol(protocol, authority)
      if (parsed) {
        const entry: ParsedHttpProxyEntry = {
          host: parsed.host,
          port: parsed.port,
          protocol,
        }
        if (parsed.username !== undefined) entry.username = parsed.username
        if (parsed.password !== undefined) entry.password = parsed.password
        return entry
      }
    }
  }
  return null
}

/** 解析 Chromium `resolveProxy()` 返回的 PAC 字符串，取首个 HTTP(S) 代理项 */
export function parseFirstHttpProxy(pacResult: string): { host: string; port: number } | null {
  const entry = parseFirstHttpProxyEntry(pacResult)
  return entry ? { host: entry.host, port: entry.port } : null
}

const CONNECT_TIMEOUT_MS = 15_000

function stripIpv6Brackets(host: string): string {
  const trimmed = host.trim()
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
}

function formatAuthority(host: string, port: number): string {
  const trimmed = host.trim()
  const bracketed =
    trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed
  return `${bracketed}:${port}`
}

function buildProxyUrl(proxy: {
  host: string
  port: number
  protocol: ProxyProtocol
  username?: string
  password?: string
}): URL {
  // SOCKS5 默认使用代理端 DNS（socks5h），避免本地 DNS 污染或内网隔离导致建连前就 ENOTFOUND
  const effectiveProtocol: ProxyProtocol =
    proxy.protocol === 'socks5:' || proxy.protocol === 'socks:' ? 'socks5h:' : proxy.protocol
  const url = new URL(`${effectiveProtocol}//${formatAuthority(proxy.host, proxy.port)}`)
  if (proxy.username !== undefined) url.username = proxy.username
  if (proxy.password !== undefined) url.password = proxy.password
  return url
}

function normalizeConnectOpts(
  opts: ProxyAgentConnectOpts,
  defaultSecure: boolean
): ProxyAgentConnectOpts & { host: string; port: number; secureEndpoint: boolean } {
  const rawHost = stripIpv6Brackets(String(opts.host || opts.hostname || ''))
  const secureEndpoint =
    typeof opts.secureEndpoint === 'boolean'
      ? opts.secureEndpoint
      : typeof opts.protocol === 'string'
        ? opts.protocol === 'https:'
        : defaultSecure
  const port = Number(opts.port) || (secureEndpoint ? 443 : 80)
  const rawSni = opts.servername || rawHost
  const servername =
    secureEndpoint && rawSni && net.isIP(rawSni) === 0 ? rawSni : undefined

  return {
    ...opts,
    host: rawHost,
    port,
    secureEndpoint,
    ...(servername ? { servername } : {}),
  }
}

function withConnectTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onLateResolve: (value: T) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()

    promise.then(
      (value) => {
        clearTimeout(timer)
        if (settled) {
          onLateResolve(value)
          return
        }
        settled = true
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        reject(error)
      }
    )
  })
}

function waitForTlsHandshake(
  tlsSocket: tls.TLSSocket,
  timeoutMs: number
): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    if (tlsSocket.destroyed) {
      reject(new Error('TLS socket closed before handshake completed'))
      return
    }
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      tlsSocket.removeListener('secureConnect', onSecureConnect)
      tlsSocket.removeListener('error', onError)
      tlsSocket.removeListener('close', onClose)
    }
    const onSecureConnect = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(tlsSocket)
    }
    const onError = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      tlsSocket.destroy()
      reject(err)
    }
    const onClose = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Proxy TLS connection closed before handshake completed'))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      const err = new Error(`Proxy TLS handshake timed out after ${timeoutMs}ms`)
      tlsSocket.destroy(err)
      reject(err)
    }, timeoutMs)
    timer.unref?.()

    tlsSocket.once('secureConnect', onSecureConnect)
    tlsSocket.once('error', onError)
    tlsSocket.once('close', onClose)
  })
}

function createStubClientRequest(): http.ClientRequest {
  const emitter = new EventEmitter() as EventEmitter & { destroy?: () => void }
  emitter.destroy = () => {}
  return emitter as unknown as http.ClientRequest
}

class TimeoutHttpsProxyAgent extends HttpsProxyAgent {
  private readonly defaultSecureTarget: boolean
  private readonly connectTimeoutMs: number

  constructor(proxyUrl: URL, secureTarget: boolean, connectTimeoutMs: number) {
    super(proxyUrl, { keepAlive: false, timeout: connectTimeoutMs })
    this.defaultSecureTarget = secureTarget
    this.connectTimeoutMs = connectTimeoutMs
  }

  override isSecureEndpoint(options?: ProxyAgentConnectOpts): boolean {
    if (options) {
      if (typeof options.secureEndpoint === 'boolean') return options.secureEndpoint
      if (typeof options.protocol === 'string') return options.protocol === 'https:'
    }
    return this.defaultSecureTarget
  }

  override async connect(req: http.ClientRequest, opts: ProxyAgentConnectOpts): Promise<net.Socket> {
    const normalized = normalizeConnectOpts(opts, this.defaultSecureTarget)
    const socket = await withConnectTimeout(
      super.connect(req, normalized),
      this.connectTimeoutMs,
      'Proxy CONNECT',
      (lateSocket) => lateSocket.destroy()
    )
    if (socket instanceof tls.TLSSocket) {
      // HttpsProxyAgent 仅在 `req.once('socket')` 才恢复底层可读流；提前等待握手时必须解除暂停
      socket.resume()
      await waitForTlsHandshake(socket, this.connectTimeoutMs)
    }
    return socket
  }

  override createConnection(
    connOptions?: ClientRequestArgs & { servername?: string },
    callback?: (err: Error | null, stream: Duplex) => void
  ): Duplex {
    // 走 http.request / https.request / ws 路径时，agent-base 已准备好 currentSocket，直接同步返回
    try {
      return super.createConnection()
    } catch {
      // 直接调用 createConnection(opts, cb) 的兼容路径
    }
    const stubReq = createStubClientRequest()
    let proxyStatusCode: number | null = null
    stubReq.once('proxyConnect', (info: { statusCode?: number }) => {
      if (typeof info?.statusCode === 'number') proxyStatusCode = info.statusCode
    })
    const connectOpts = normalizeConnectOpts(connOptions ?? {}, this.defaultSecureTarget)
    void this.connect(stubReq, connectOpts).then(
      (socket) => {
        if (proxyStatusCode !== null && proxyStatusCode !== 200) {
          socket.destroy()
          callback?.(
            new Error(`Proxy CONNECT rejected with HTTP ${proxyStatusCode}`),
            undefined as unknown as Duplex
          )
          return
        }
        callback?.(null, socket)
      },
      (error: unknown) => {
        callback?.(
          error instanceof Error ? error : new Error(String(error)),
          undefined as unknown as Duplex
        )
      }
    )
    return undefined as unknown as Duplex
  }
}

class TimeoutSocksProxyAgent extends SocksProxyAgent {
  private readonly defaultSecureTarget: boolean
  private readonly connectTimeoutMs: number

  constructor(proxyUrl: URL, secureTarget: boolean, connectTimeoutMs: number) {
    super(proxyUrl, { keepAlive: false, timeout: connectTimeoutMs })
    this.defaultSecureTarget = secureTarget
    this.connectTimeoutMs = connectTimeoutMs
  }

  override isSecureEndpoint(options?: ProxyAgentConnectOpts): boolean {
    if (options) {
      if (typeof options.secureEndpoint === 'boolean') return options.secureEndpoint
      if (typeof options.protocol === 'string') return options.protocol === 'https:'
    }
    return this.defaultSecureTarget
  }

  override async connect(req: http.ClientRequest, opts: ProxyAgentConnectOpts): Promise<net.Socket> {
    const normalized = normalizeConnectOpts(opts, this.defaultSecureTarget)
    const socket = await withConnectTimeout(
      super.connect(req, normalized),
      this.connectTimeoutMs,
      'SOCKS proxy connect',
      (lateSocket) => lateSocket.destroy()
    )
    if (socket instanceof tls.TLSSocket) {
      await waitForTlsHandshake(socket, this.connectTimeoutMs)
    }
    return socket
  }

  override createConnection(
    connOptions?: ClientRequestArgs & { servername?: string },
    callback?: (err: Error | null, stream: Duplex) => void
  ): Duplex {
    try {
      return super.createConnection()
    } catch {
      // 直接调用 createConnection(opts, cb) 的兼容路径
    }
    const stubReq = createStubClientRequest()
    const connectOpts = normalizeConnectOpts(connOptions ?? {}, this.defaultSecureTarget)
    void this.connect(stubReq, connectOpts).then(
      (socket) => callback?.(null, socket),
      (error: unknown) =>
        callback?.(
          error instanceof Error ? error : new Error(String(error)),
          undefined as unknown as Duplex
        )
    )
    return undefined as unknown as Duplex
  }
}

/** 为 `ws` 客户端构造 HTTP(S) 或 SOCKS4/5 代理 Agent */
export function createWsProxyAgent(
  proxy: ParsedProxyEntry,
  secureTarget: boolean,
  options?: { connectTimeoutMs?: number }
): http.Agent {
  const timeoutMs = options?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  const proxyUrl = buildProxyUrl(proxy)
  if (proxy.protocol === 'http:' || proxy.protocol === 'https:') {
    return new TimeoutHttpsProxyAgent(proxyUrl, secureTarget, timeoutMs)
  }
  return new TimeoutSocksProxyAgent(proxyUrl, secureTarget, timeoutMs)
}

/** 为 `ws` 客户端构造走 HTTP(S) CONNECT 隧道的 Agent（底层委托给 `https-proxy-agent`） */
export function createHttpConnectAgent(
  proxy: {
    host: string
    port: number
    protocol?: 'http:' | 'https:'
    username?: string
    password?: string
  },
  secureTarget: boolean,
  options?: { connectTimeoutMs?: number }
): http.Agent {
  return createWsProxyAgent(
    {
      host: proxy.host,
      port: proxy.port,
      protocol: proxy.protocol ?? 'http:',
      ...(proxy.username !== undefined ? { username: proxy.username } : {}),
      ...(proxy.password !== undefined ? { password: proxy.password } : {}),
    },
    secureTarget,
    options
  )
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
    const proxy = parseFirstProxyEntry(pac)
    if (!proxy) return undefined
    return createWsProxyAgent(proxy, parsed.protocol === 'wss:')
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
