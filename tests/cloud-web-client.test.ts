/** Web 客户端静态服务与零 XSS 约束（D-19 / D-26） */

// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
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

describe('serveStatic', () => {
  it('根路径回 index.html', async () => {
    const { res, out } = capture()
    const served = await serveStatic(defaultWebDir(), '/', res)
    expect(served).toBe(true)
    expect(out.status).toBe(200)
    expect(out.headers?.['content-type']).toContain('text/html')
    expect(out.body).toContain('Pi Cloud')
  })

  it('app.js 以 module 的 MIME 返回', async () => {
    const { res, out } = capture()
    await serveStatic(defaultWebDir(), '/app.js', res)
    expect(out.headers?.['content-type']).toContain('text/javascript')
  })

  it('未登记的路径不接管（交给 REST 路由处理）', async () => {
    const { res } = capture()
    expect(await serveStatic(defaultWebDir(), '/v1/health', res)).toBe(false)
  })

  it('不允许路径穿越：白名单外的 ../ 一律不接管', async () => {
    const { res } = capture()
    expect(await serveStatic(defaultWebDir(), '/../package.json', res)).toBe(false)
    expect(await serveStatic(defaultWebDir(), '/web/../dist/main.js', res)).toBe(false)
  })
})

const XSS_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'innerHTML', pattern: /[.]innerHTML\b/ },
  { label: 'outerHTML', pattern: /[.]outerHTML\b/ },
  { label: 'insertAdjacentHTML', pattern: /insertAdjacentHTML/ },
  { label: 'document.write', pattern: /document[.]write\(/ },
  { label: 'eval', pattern: /\beval\(/ },
]

describe('零 XSS', () => {
  it('app.js 不用 HTML 字符串注入 DOM', () => {
    const source = readFileSync(path.join(defaultWebDir(), 'app.js'), 'utf-8')
    for (const { label, pattern } of XSS_PATTERNS) {
      expect(pattern.test(source), `${label} must not appear in the web client`).toBe(false)
    }
  })

  it('index.html 不内联脚本与事件处理器，只引用同源 app.js', () => {
    const html = readFileSync(path.join(defaultWebDir(), 'index.html'), 'utf-8')
    expect(html).toContain('src="/app.js"')
    expect(html).not.toMatch(/\son[a-z]+="/)
    expect(html).not.toContain('http://')
  })
})
