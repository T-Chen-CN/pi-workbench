/** Web 客户端静态服务与零 XSS 约束（D-19 修订版 / D-26） */

// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import * as path from 'path'
import type { ServerResponse } from 'http'
import { defaultWebDir, serveStatic } from '../apps/cloud/src/http/static'

interface Captured {
  status?: number
  headers?: Record<string, string>
  body?: string
}

function capture(): { res: ServerResponse; out: Captured } {
  const out: Captured = {}
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status
      out.headers = headers
      return this
    },
    end(body?: string | Buffer) {
      out.body = body ? body.toString() : ''
      return this
    },
  } as unknown as ServerResponse
  return { res, out }
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? walkFiles(full) : [full]
  })
}

describe('serveStatic', () => {
  it('根路径回 index.html 并携带严格 CSP（无 eval / wasm-unsafe-eval）', async () => {
    const { res, out } = capture()
    const served = await serveStatic(defaultWebDir(), '/', res)
    expect(served).toBe(true)
    expect(out.status).toBe(200)
    expect(out.headers?.['content-type']).toContain('text/html')
    expect(out.headers?.['content-security-policy']).toContain("default-src 'self'")
    expect(out.headers?.['content-security-policy']).not.toContain('unsafe-eval')
    expect(out.headers?.['content-security-policy']).not.toContain('wasm-unsafe-eval')
    expect(out.body).toContain('Pi Cloud')
    expect(out.body).toContain('/assets/')
  })

  it('/favicon.svg 返回 image/svg+xml', async () => {
    const { res, out } = capture()
    const served = await serveStatic(defaultWebDir(), '/favicon.svg', res)
    expect(served).toBe(true)
    expect(out.status).toBe(200)
    expect(out.headers?.['content-type']).toContain('image/svg+xml')
    expect(out.body).toContain('#2F5D4E')
  })

  it('/assets/<built-js> 以 module MIME 和 immutable 缓存返回', async () => {
    const assetsDir = path.join(defaultWebDir(), 'assets')
    const jsFile = readdirSync(assetsDir).find((name) => name.endsWith('.js'))
    expect(jsFile).toBeTruthy()
    const { res, out } = capture()
    const served = await serveStatic(defaultWebDir(), `/assets/${jsFile}`, res)
    expect(served).toBe(true)
    expect(out.status).toBe(200)
    expect(out.headers?.['content-type']).toContain('text/javascript')
    expect(out.headers?.['cache-control']).toContain('immutable')
  })

  it('未登记的路径不接管（交给 REST 路由处理）', async () => {
    const { res } = capture()
    expect(await serveStatic(defaultWebDir(), '/v1/health', res)).toBe(false)
  })

  it('不允许路径穿越：白名单与单段 /assets/ 之外的 ../ 一律不接管', async () => {
    const { res } = capture()
    expect(await serveStatic(defaultWebDir(), '/../package.json', res)).toBe(false)
    expect(await serveStatic(defaultWebDir(), '/web/../dist/main.js', res)).toBe(false)
    expect(await serveStatic(defaultWebDir(), '/assets/../index.html', res)).toBe(false)
    expect(await serveStatic(defaultWebDir(), '/assets/sub/file.js', res)).toBe(false)
  })
})

const XSS_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'innerHTML', pattern: /[.]innerHTML\b/ },
  { label: 'outerHTML', pattern: /[.]outerHTML\b/ },
  { label: 'insertAdjacentHTML', pattern: /insertAdjacentHTML/ },
  { label: 'document.write', pattern: /document[.]write\(/ },
  { label: 'eval', pattern: /\beval\(/ },
  { label: 'dangerouslySetInnerHTML', pattern: /\bdangerouslySetInnerHTML\b/ },
]

describe('零 XSS', () => {
  it('apps/cloud/web-src 源码不用 HTML 字符串注入 DOM', () => {
    const srcDir = path.resolve(__dirname, '../apps/cloud/web-src')
    const sourceFiles = walkFiles(srcDir).filter((file) => /\.(ts|tsx)$/.test(file))
    expect(sourceFiles.length).toBeGreaterThan(0)
    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf-8')
      for (const { label, pattern } of XSS_PATTERNS) {
        expect(pattern.test(source), `${label} must not appear in ${file}`).toBe(false)
      }
    }
  })

  it('构建出的 index.html 不内联脚本与事件处理器，只引用同源 /assets/', () => {
    const html = readFileSync(path.join(defaultWebDir(), 'index.html'), 'utf-8')
    expect(html).toMatch(/<script\s+type="module"[^>]+src="\/assets\/[^"]+\.js"/)
    expect(html).not.toMatch(/<script(?:\s[^>]*)?>\s*[^<\s]/)
    expect(html).not.toMatch(/\son[a-z]+="/)
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
  })
})
