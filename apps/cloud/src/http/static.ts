/**
 * Web 客户端静态文件（D-19 / D-26）。
 *
 * 零构建：固定白名单路由 + 本地自托管 `@fontsource` 字体，不接受任意路径拼接，
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

/**
 * 与桌面端 `src/main.tsx` 保持完全一致的 5 套 `@fontsource` 字体包。
 * 生产运行包由 `scripts/build-cloud-bundle.mjs` 预置到 `<webDir>/fonts/<slug>/`；
 * 本地开发与单测回落到仓库根 `node_modules/`。
 */
const FONT_PACKAGES: ReadonlyArray<{
  slug: string
  pkgPath: string[]
  cssFiles: string[]
}> = [
  {
    slug: 'instrument-serif',
    pkgPath: ['@fontsource', 'instrument-serif'],
    cssFiles: ['400.css', '400-italic.css'],
  },
  {
    slug: 'noto-serif-sc',
    pkgPath: ['@fontsource-variable', 'noto-serif-sc'],
    cssFiles: ['index.css'],
  },
  {
    slug: 'noto-sans',
    pkgPath: ['@fontsource-variable', 'noto-sans'],
    cssFiles: ['index.css'],
  },
  {
    slug: 'noto-sans-sc',
    pkgPath: ['@fontsource-variable', 'noto-sans-sc'],
    cssFiles: ['index.css'],
  },
  {
    slug: 'geist-mono',
    pkgPath: ['@fontsource-variable', 'geist-mono'],
    cssFiles: ['index.css'],
  },
]

const FONT_PACKAGE_BY_SLUG = new Map(FONT_PACKAGES.map((entry) => [entry.slug, entry]))
const SAFE_WOFF2 = /^[a-z0-9._-]+\.woff2$/i

const CSP_HEADER =
  "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"

const cache = new Map<string, { body: Buffer; type: string; immutable?: boolean }>()

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  return null
}

function repoNodeModulesDir(): string {
  // apps/cloud/dist/http → 仓库根 node_modules
  return path.resolve(HERE, '..', '..', '..', '..', 'node_modules')
}

async function resolveFontPackageDir(webDir: string, slug: string): Promise<string | null> {
  const pkg = FONT_PACKAGE_BY_SLUG.get(slug)
  if (!pkg) return null
  return firstExisting([
    path.join(webDir, 'fonts', slug),
    path.join(repoNodeModulesDir(), ...pkg.pkgPath),
  ])
}

async function loadFontsCss(webDir: string): Promise<Buffer> {
  const prebuilt = path.join(webDir, 'fonts', 'fonts.css')
  try {
    return await fs.readFile(prebuilt)
  } catch {
    // 开发/测试环境按 5 个 @fontsource 包现场拼接并改写为 /fonts/<slug>/<file>
  }
  const chunks: string[] = []
  for (const pkg of FONT_PACKAGES) {
    const dir = await resolveFontPackageDir(webDir, pkg.slug)
    if (!dir) continue
    for (const cssFile of pkg.cssFiles) {
      try {
        const raw = await fs.readFile(path.join(dir, cssFile), 'utf8')
        const rewritten = raw.replace(/url\(\s*['"]?\.\/files\/([^'")]+)['"]?\s*\)/g, `url('/fonts/${pkg.slug}/$1')`)
        chunks.push(rewritten)
      } catch {
        // 单个 css 缺失时跳过，保持系统字体回退可用
      }
    }
  }
  return Buffer.from(chunks.join('\n'), 'utf8')
}

async function loadFontFile(webDir: string, slug: string, fileName: string): Promise<Buffer | null> {
  if (!SAFE_WOFF2.test(fileName)) return null
  const dir = await resolveFontPackageDir(webDir, slug)
  if (!dir) return null
  const candidate = await firstExisting([
    path.join(dir, 'files', fileName),
    path.join(dir, fileName),
  ])
  if (!candidate) return null
  return fs.readFile(candidate)
}

function writeResponse(
  res: ServerResponse,
  cached: { body: Buffer; type: string; immutable?: boolean }
): void {
  res.writeHead(200, {
    'content-type': cached.type,
    'cache-control': cached.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    // 客户端只需要连自己这一个源；不允许被别的站点嵌入，并强制 CSP
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
  if (pathname === '/fonts.css') {
    const key = `${webDir}:fonts.css`
    let cached = cache.get(key)
    if (!cached) {
      const body = await loadFontsCss(webDir)
      cached = { body, type: 'text/css; charset=utf-8' }
      cache.set(key, cached)
    }
    writeResponse(res, cached)
    return true
  }

  if (pathname.startsWith('/fonts/')) {
    const parts = pathname.slice('/fonts/'.length).split('/')
    if (parts.length !== 2) return false
    const [slug, fileName] = parts
    if (!FONT_PACKAGE_BY_SLUG.has(slug) || !SAFE_WOFF2.test(fileName)) return false
    const key = `${webDir}:font:${slug}:${fileName}`
    let cached = cache.get(key)
    if (!cached) {
      const body = await loadFontFile(webDir, slug, fileName)
      if (!body) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Not found')
        return true
      }
      cached = { body, type: 'font/woff2', immutable: true }
      cache.set(key, cached)
    }
    writeResponse(res, cached)
    return true
  }

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
  writeResponse(res, cached)
  return true
}
