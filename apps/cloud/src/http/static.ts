/**
 * Web 客户端静态文件（D-19 / D-26）。
 *
 * 零构建：三个文件（html / css / js），路径来自固定白名单，不接受拼接，
 * 因此不存在路径穿越。渲染侧只用 `textContent`，不写 `innerHTML`。
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import type { ServerResponse } from 'http'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 默认取 `apps/cloud/web`（源码布局与打包布局一致：dist/http → ../../web） */
export function defaultWebDir(): string {
  return path.resolve(HERE, '..', '..', 'web')
}

const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
}

const cache = new Map<string, { body: Buffer; type: string }>()

export async function serveStatic(
  webDir: string,
  pathname: string,
  res: ServerResponse
): Promise<boolean> {
  const entry = FILES[pathname]
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
  res.writeHead(200, {
    'content-type': cached.type,
    'cache-control': 'no-cache',
    // 客户端只需要连自己这一个源；不允许被别的站点嵌入，并强制 CSP
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
  })
  res.end(cached.body)
  return true
}
