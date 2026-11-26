/**
 * Web 客户端静态文件服务（D-19 修订版 / D-26）。
 *
 * 本地由 Vite + React 构建纯静态产物到 `apps/cloud/web-dist/`（部署包位于 `web/`），
 * 服务器端零构建、固定白名单路由与严格单段 `/assets/<file>` 校验，彻底防路径穿越并强制 CSP。
 */

import { existsSync, promises as fs } from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
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

const cache = new Map<string, { body: Buffer; type: string; immutable?: boolean }>()

function writeResponse(
  res: ServerResponse,
  cached: { body: Buffer; type: string; immutable?: boolean }
): void {
  res.writeHead(200, {
    'content-type': cached.type,
    'cache-control': cached.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'content-security-policy': CSP_HEADER,
  })
  res.end(cached.body)
}

export async function serveStatic(
  webDir: string,
  pathname: string,
  res: ServerResponse
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
        cached = { body, type: mime, immutable: true }
        cache.set(key, cached)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Not found')
        return true
      }
    }
    writeResponse(res, cached)
    return true
  }

  const entry = ROOT_FILES[pathname]
  if (!entry) return false
  const key = `${webDir}:${entry.file}`
  let cached = cache.get(key)
  if (!cached) {
    try {
      const body = await fs.readFile(path.join(webDir, entry.file))
      cached = { body, type: entry.type }
      cache.set(key, cached)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return true
    }
  }
  writeResponse(res, cached)
  return true
}
