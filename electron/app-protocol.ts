/**
 * `pw-app://` 应用外壳协议。
 *
 * 生产环境不能用 `file://` 加载工作台：Chromium 把每个 `file://` URL 视为不同
 * origin，`window.open` 出来的辅助窗口无法与 opener 互访（electron#19789，
 * 维护者明确建议改用自定义协议）。辅助窗口拆分依赖「主窗口 JS 直接操作子文档」，
 * 因此外壳也必须跑在一个标准协议上。
 *
 * 约束：
 * - 只读，只接受 GET / HEAD；
 * - 路径必须落在 `dist/` 内（realpath 规范化后判断），逐段解码并拒绝 `..`；
 * - 不做 SPA 回退：应用没有前端路由，未知路径直接 404；
 * - `Cache-Control: no-store`：升级会整体替换 `dist/`，缓存住旧 index.html 会白屏。
 */

import { protocol } from 'electron'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { Readable } from 'stream'

export const APP_SCHEME = 'pw-app'
const APP_HOST = 'bundle'

const MIME_BY_EXTENSION: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
}

export function mimeForAppPath(targetPath: string): string {
  const extension = path.extname(targetPath).slice(1).toLowerCase()
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

/** 生成外壳 URL，例如 appUrl('/index.html', { theme: 'ink' }) */
export function appUrl(pathname: string, query?: Record<string, string>): string {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`
  const url = new URL(`${APP_SCHEME}://${APP_HOST}${normalized}`)
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  }
  return url.toString()
}

/** 判断某个 URL 是否属于应用外壳（用于 will-navigate 白名单） */
export function isAppUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === `${APP_SCHEME}:` && parsed.hostname === APP_HOST
  } catch {
    return false
  }
}

/**
 * 把 `pw-app://bundle/<路径>` 解码成相对 `dist/` 的路径段。
 * 任何包含分隔符、控制字符或 `..` 的段都直接拒绝。
 */
export function decodeAppPath(rawUrl: string): string[] | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== `${APP_SCHEME}:`) return null
  if (parsed.hostname !== APP_HOST) return null

  const decoded: string[] = []
  for (const segment of parsed.pathname.split('/')) {
    if (segment.length === 0) continue
    let value: string
    try {
      value = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (
      value.length === 0 ||
      value === '.' ||
      value === '..' ||
      value.includes('/') ||
      value.includes('\\')
    ) {
      return null
    }
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code < 0x20 || code === 0x7f) return null
    }
    decoded.push(value)
  }

  return decoded
}

/** 在 distDir 内解析目标文件；越界返回 null */
export function resolveAppTarget(segments: string[], distDir: string): string | null {
  const root = path.resolve(distDir)
  const target = segments.length === 0 ? path.join(root, 'index.html') : path.join(root, ...segments)
  const resolved = path.resolve(target)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved
}

function baseHeaders(targetPath: string, size: number): Headers {
  return new Headers({
    'Content-Type': mimeForAppPath(targetPath),
    'Content-Length': String(size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
}

/** 协议响应；抽成纯函数便于单测（不依赖 Electron 运行时） */
export async function serveAppRequest(
  rawUrl: string,
  method: string,
  distDir: string
): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const segments = decodeAppPath(rawUrl)
  if (!segments) return new Response('Bad Request', { status: 400 })

  const target = resolveAppTarget(segments, distDir)
  if (!target) return new Response('Forbidden', { status: 403 })

  let stats
  try {
    stats = await fsp.stat(target)
  } catch {
    return new Response('Not Found', { status: 404 })
  }
  if (!stats.isFile()) return new Response('Not Found', { status: 404 })

  const headers = baseHeaders(target, stats.size)
  if (method === 'HEAD') return new Response(null, { status: 200, headers })

  const stream = fs.createReadStream(target)
  const body = Readable.toWeb(stream) as unknown as ReadableStream
  return new Response(body, { status: 200, headers })
}

/** app ready 之后调用 */
export function registerAppProtocol(distDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      return await serveAppRequest(request.url, request.method, distDir)
    } catch (error) {
      console.error('[AppProtocol] Failed to serve:', request.url, error)
      return new Response('Internal Error', { status: 500 })
    }
  })
}
