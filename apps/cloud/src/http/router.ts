/**
 * 极简 HTTP 层：路由 + JSON 读写 + 来源提取。
 *
 * 不用框架：控制面只有十来个端点，Node 内置 http 足够；少一个运行时依赖就少一份
 * 服务器上的升级负担（D-25 只批准了 `ws`）。
 */

import type { IncomingMessage, ServerResponse } from 'http'

export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  /** 来源标识：用于限速。优先取反代写的 X-Forwarded-For 首段 */
  source: string
  /** 已解析的 cookie 值（懒解析） */
  cookie: (name: string) => string | undefined
  /** 解析 JSON body；超过上限或不是 JSON 时抛 HttpError */
  json: <T = unknown>(limitBytes?: number) => Promise<T>
  params: Record<string, string>
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

/**
 * 帧级错误对外一律同一个 code（配对 / 登录），避免泄露「码是否存在 / 是否过期」。
 * 内部只用于日志。
 */
export const GENERIC_CREDENTIAL_ERROR = 'invalid-credential'

export type Handler = (context: RequestContext) => Promise<unknown> | unknown

interface Route {
  method: string
  /** `/v1/devices/:id` 形式的模板 */
  segments: string[]
  handler: Handler
}

export class Router {
  private routes: Route[] = []

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
    })
    return this
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler)
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler)
  }

  put(pattern: string, handler: Handler): this {
    return this.add('PUT', pattern, handler)
  }

  patch(pattern: string, handler: Handler): this {
    return this.add('PATCH', pattern, handler)
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler)
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue
      if (route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index]
        if (segment.startsWith(':')) {
          try {
            params[segment.slice(1)] = decodeURIComponent(parts[index])
          } catch {
            throw new HttpError(400, 'Malformed path encoding')
          }
          continue
        }
        if (segment !== parts[index]) {
          matched = false
          break
        }
      }
      if (matched) return { handler: route.handler, params }
    }
    return null
  }
}

const MAX_BODY_BYTES = 256 * 1024
const BODY_READ_TIMEOUT_MS = 15_000

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 只在来自本机反代（Caddy）时信任 X-Forwarded-For 末跳；
 * 绝不读取 X-Real-IP（Caddy 会透传客户端伪造的 X-Real-IP，会被用于绕过限速）。
 */
export function sourceOf(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress
  if (isLoopbackAddress(remote)) {
    const forwarded = req.headers['x-forwarded-for']
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
    const hops = raw
      ?.split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    const last = hops && hops.length > 0 ? hops[hops.length - 1] : undefined
    if (last) return last
  }
  return remote || 'unknown'
}

/** 校验浏览器请求 Origin 与当前 Host 及协议一致（防 CSWSH 与跨站 CSRF） */
export function isAllowedOrigin(
  req: IncomingMessage,
  options?: { requireOrigin?: boolean }
): boolean {
  const origin = req.headers.origin
  if (!origin) return !options?.requireOrigin
  const host = req.headers.host
  if (!host) return false
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (parsed.host.toLowerCase() !== host.toLowerCase()) return false
    // 经 HTTPS 反代或 TLS 接入时拒绝明文 http:// Origin
    const remote = req.socket?.remoteAddress
    const rawProto = isLoopbackAddress(remote) ? req.headers['x-forwarded-proto'] : undefined
    const proto = (Array.isArray(rawProto) ? rawProto[0] : rawProto)?.split(',')[0]?.trim().toLowerCase()
    const isHttps = proto === 'https' || Boolean((req.socket as { encrypted?: boolean })?.encrypted)
    if (isHttps && parsed.protocol !== 'https:') return false
    return true
  } catch {
    return false
  }
}

export async function readJsonBody<T>(req: IncomingMessage, limitBytes = MAX_BODY_BYTES): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    req.destroy()
  }, BODY_READ_TIMEOUT_MS)
  timer.unref?.()
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limitBytes) throw new HttpError(413, 'Body is too large')
      chunks.push(buffer)
    }
  } catch (error) {
    if (timedOut) throw new HttpError(408, 'Request body timeout')
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (size === 0) return {} as T
  // 有请求体时强制校验 Content-Type 为 application/json，阻断 text/plain 简单 CORS CSRF
  const contentType = String(req.headers['content-type'] ?? '').trim().toLowerCase()
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json')
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Body must be JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Body must be a JSON object')
  }
  return parsed as T
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value ?? null)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
  res.end(text)
}

export function readCookieFrom(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}
