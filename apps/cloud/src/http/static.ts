/**
 * Web 客户端静态文件服务（D-19 修订版 / D-26）。
 *
 * 本地由 Vite + React 构建纯静态产物到 `apps/cloud/web-dist/`（部署包位于 `web/`），
 * 服务器端零构建、固定白名单路由与严格单段 `/assets/<file>` 校验，彻底防路径穿越并强制 CSP。
 */

import { existsSync, promises as fs } from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import type { ServerResponse } from 'http'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 默认静态产物目录：
 * - 生产运行包（`cache/cloud-bundle/`）：`dist/http → ../../web`
 * - 开发仓库（`apps/cloud/`）：`dist/http` 或 `src/http` → `../../web-dist`
 */
export function defaultWebDir(): string {
  const built = path.resolve(HERE, '..', '..', 'web-dist')
  if (existsSync(path.join(built, 'index.html'))) return built
  return path.resolve(HERE, '..', '..', 'web')
}

const ROOT_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
}

const ASSET_MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/** 仅允许单段安全文件名（无 `/`、`..` 等），防止路径穿越 */
const SAFE_ASSET_FILE = /^[a-zA-Z0-9._-]+\.(?:js|css|woff2|woff|ttf|svg|png)$/

/**
 * 严格 CSP：零 `eval`、零 `wasm-unsafe-eval`、零外网资源；
 * `img-src` 允许 `data:` 与 `blob:` 以支持 Mermaid SVG/PNG 预览与导出。
 */
const CSP_HEADER =
  "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"

const COMPRESSIBLE_EXTS = new Set(['.js', '.css', '.html', '.svg'])

interface CachedStaticEntry {
  body: Buffer
  br?: Buffer
  gzip?: Buffer
  type: string
  immutable?: boolean
  compressible: boolean
}

const cache = new Map<string, CachedStaticEntry>()

function buildCachedEntry(
  body: Buffer,
  type: string,
  ext: string,
  immutable?: boolean
): CachedStaticEntry {
  const compressible = COMPRESSIBLE_EXTS.has(ext)
  if (!compressible) {
    return { body, type, immutable, compressible: false }
  }
  // 首次读取时预压缩并缓存，后续请求按 Accept-Encoding 直接复用，避免重复占用主线程 CPU
  const br = brotliCompressSync(body, {
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
    },
  })
  const gzip = gzipSync(body, { level: 6 })
  return { body, br, gzip, type, immutable, compressible: true }
}

function negotiateEncoding(acceptEncoding?: string | string[]): 'br' | 'gzip' | null {
  if (!acceptEncoding) return null
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding
  if (!header.trim()) return null

  let acceptsBr = false
  let acceptsGzip = false
  for (const part of header.split(',')) {
    const segments = part.split(';').map((s) => s.trim().toLowerCase())
    const token = segments[0]
    if (token !== 'br' && token !== 'gzip') continue
    let q = 1
    for (let i = 1; i < segments.length; i += 1) {
      if (segments[i].startsWith('q=')) {
        const parsed = Number(segments[i].slice(2))
        q = Number.isFinite(parsed) ? parsed : 0
      }
    }
    if (q <= 0) continue
    if (token === 'br') acceptsBr = true
    else if (token === 'gzip') acceptsGzip = true
  }

  if (acceptsBr) return 'br'
  if (acceptsGzip) return 'gzip'
  return null
}

function writeResponse(
  res: ServerResponse,
  cached: CachedStaticEntry,
  acceptEncoding?: string | string[]
): void {
  let payload = cached.body
  let contentEncoding: 'br' | 'gzip' | undefined
  if (cached.compressible) {
    const encoding = negotiateEncoding(acceptEncoding)
    if (encoding === 'br' && cached.br) {
      payload = cached.br
      contentEncoding = 'br'
    } else if (encoding === 'gzip' && cached.gzip) {
      payload = cached.gzip
      contentEncoding = 'gzip'
    }
  }

  const headers: Record<string, string> = {
    'content-type': cached.type,
    'content-length': String(payload.length),
    'cache-control': cached.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'content-security-policy': CSP_HEADER,
  }
  if (cached.compressible) {
    headers['vary'] = 'Accept-Encoding'
  }
  if (contentEncoding) {
    headers['content-encoding'] = contentEncoding
  }

  res.writeHead(200, headers)
  res.end(payload)
}

export async function serveStatic(
  webDir: string,
  pathname: string,
  res: ServerResponse,
  acceptEncoding?: string | string[]
): Promise<boolean> {
  if (pathname.startsWith('/assets/')) {
    const fileName = pathname.slice('/assets/'.length)
    if (!SAFE_ASSET_FILE.test(fileName)) return false
    const ext = path.extname(fileName).toLowerCase()
    const mime = ASSET_MIME[ext]
    if (!mime) return false
    const key = `${webDir}:asset:${fileName}`
    let cached = cache.get(key)
    if (!cached) {
      try {
        const body = await fs.readFile(path.join(webDir, 'assets', fileName))
        cached = buildCachedEntry(body, mime, ext, true)
        cache.set(key, cached)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Not found')
        return true
      }
    }
    writeResponse(res, cached, acceptEncoding)
    return true
  }

  const entry = ROOT_FILES[pathname]
  if (!entry) return false
  const key = `${webDir}:${entry.file}`
  let cached = cache.get(key)
  if (!cached) {
    try {
      const body = await fs.readFile(path.join(webDir, entry.file))
      const ext = path.extname(entry.file).toLowerCase()
      cached = buildCachedEntry(body, entry.type, ext, false)
      cache.set(key, cached)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return true
    }
  }
  writeResponse(res, cached, acceptEncoding)
  return true
}
