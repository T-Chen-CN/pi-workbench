/**
 * 云端 Web 静态资源预压缩与内容协商（D11）：
 * - 可压缩文本资源（.js/.css/.html/.svg）首次读取压缩一次并缓存
 * - 按 Accept-Encoding 优先返回 br → gzip → raw，携带 Vary: Accept-Encoding 与精确 Content-Length
 * - 二进制资源（.woff2/.png）不重复压缩
 */

// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import type { ServerResponse } from 'node:http'
import { serveStatic } from '../../apps/cloud/src/http/static'

interface CapturedRaw {
  status?: number
  headers?: Record<string, string>
  body?: Buffer
}

function captureRaw(): { res: ServerResponse; out: CapturedRaw } {
  const out: CapturedRaw = {}
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status
      out.headers = headers
      return this
    },
    end(body?: string | Buffer) {
      if (Buffer.isBuffer(body)) out.body = body
      else if (typeof body === 'string') out.body = Buffer.from(body)
      else out.body = Buffer.alloc(0)
      return this
    },
  } as unknown as ServerResponse
  return { res, out }
}

describe('serveStatic compression (D11)', () => {
  let webDir = ''
  const htmlContent = '<!doctype html><html><body>' + 'Pi Cloud Workbench '.repeat(80) + '</body></html>'
  const svgContent = '<svg xmlns="http://www.w3.org/2000/svg">' + '<rect width="10" height="10"/>'.repeat(50) + '</svg>'
  const jsContent = 'export const msg = ' + JSON.stringify('hello cloud '.repeat(120)) + ';\n'
  const cssContent = '.cloud { color: #2F5D4E; }\n'.repeat(100)
  const woff2Bytes = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02, 0x03, 0x04])
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  beforeAll(() => {
    webDir = mkdtempSync(path.join(tmpdir(), 'pi-cloud-static-'))
    mkdirSync(path.join(webDir, 'assets'), { recursive: true })
    writeFileSync(path.join(webDir, 'index.html'), htmlContent, 'utf-8')
    writeFileSync(path.join(webDir, 'favicon.svg'), svgContent, 'utf-8')
    writeFileSync(path.join(webDir, 'assets', 'app-123.js'), jsContent, 'utf-8')
    writeFileSync(path.join(webDir, 'assets', 'style-123.css'), cssContent, 'utf-8')
    writeFileSync(path.join(webDir, 'assets', 'font-123.woff2'), woff2Bytes)
    writeFileSync(path.join(webDir, 'assets', 'icon-123.png'), pngBytes)
  })

  afterAll(() => {
    if (webDir) rmSync(webDir, { recursive: true, force: true })
  })

  it('prefers brotli over gzip for .html, .svg, .js, and .css with Vary and Content-Length', async () => {
    const cases: Array<[string, string]> = [
      ['/', htmlContent],
      ['/favicon.svg', svgContent],
      ['/assets/app-123.js', jsContent],
      ['/assets/style-123.css', cssContent],
    ]

    for (const [pathname, expected] of cases) {
      const { res, out } = captureRaw()
      const served = await serveStatic(webDir, pathname, res, 'gzip, deflate, br')
      expect(served).toBe(true)
      expect(out.status).toBe(200)
      expect(out.headers?.['content-encoding']).toBe('br')
      expect(out.headers?.['vary']).toBe('Accept-Encoding')
      expect(Number(out.headers?.['content-length'])).toBe(out.body!.length)
      expect(out.body!.length).toBeLessThan(Buffer.byteLength(expected, 'utf-8'))
      expect(brotliDecompressSync(out.body!).toString('utf-8')).toBe(expected)
    }
  })

  it('serves gzip when br is absent or rejected via q=0', async () => {
    for (const accept of ['gzip, deflate', 'br;q=0, gzip;q=0.8']) {
      const { res, out } = captureRaw()
      const served = await serveStatic(webDir, '/assets/app-123.js', res, accept)
      expect(served).toBe(true)
      expect(out.status).toBe(200)
      expect(out.headers?.['content-encoding']).toBe('gzip')
      expect(out.headers?.['vary']).toBe('Accept-Encoding')
      expect(Number(out.headers?.['content-length'])).toBe(out.body!.length)
      expect(gunzipSync(out.body!).toString('utf-8')).toBe(jsContent)
    }
  })

  it('serves raw uncompressed payload when Accept-Encoding omits br/gzip or rejects both', async () => {
    for (const accept of [undefined, '', 'deflate', 'br;q=0, gzip;q=0']) {
      const { res, out } = captureRaw()
      const served = await serveStatic(webDir, '/assets/style-123.css', res, accept)
      expect(served).toBe(true)
      expect(out.status).toBe(200)
      expect(out.headers?.['content-encoding']).toBeUndefined()
      expect(out.headers?.['vary']).toBe('Accept-Encoding')
      expect(Number(out.headers?.['content-length'])).toBe(Buffer.byteLength(cssContent, 'utf-8'))
      expect(out.body!.toString('utf-8')).toBe(cssContent)
    }
  })

  it('does not compress binary assets (.woff2, .png)', async () => {
    for (const [pathname, expected] of [
      ['/assets/font-123.woff2', woff2Bytes],
      ['/assets/icon-123.png', pngBytes],
    ] as const) {
      const { res, out } = captureRaw()
      const served = await serveStatic(webDir, pathname, res, 'br, gzip')
      expect(served).toBe(true)
      expect(out.status).toBe(200)
      expect(out.headers?.['content-encoding']).toBeUndefined()
      expect(out.headers?.['vary']).toBeUndefined()
      expect(Number(out.headers?.['content-length'])).toBe(expected.length)
      expect(out.body!.equals(expected)).toBe(true)
    }
  })

  it('caches compressed buffers after first read without re-reading disk', async () => {
    // 已经预热过 /assets/app-123.js，即便磁盘文件改写仍命中缓存的压缩结果
    writeFileSync(path.join(webDir, 'assets', 'app-123.js'), 'mutated', 'utf-8')
    const { res, out } = captureRaw()
    const served = await serveStatic(webDir, '/assets/app-123.js', res, 'br')
    expect(served).toBe(true)
    expect(out.headers?.['content-encoding']).toBe('br')
    expect(brotliDecompressSync(out.body!).toString('utf-8')).toBe(jsContent)
  })
})
