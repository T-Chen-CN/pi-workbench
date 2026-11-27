import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// 协议层只依赖 electron 的 protocol 注册与路径信任校验，单测里替换掉两者
vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
  session: {
    defaultSession: {
      webRequest: {
        onBeforeRequest: vi.fn(),
      },
    },
  },
}))

const allowedRoot = { current: '' }
vi.mock('../../electron/workspace-trust', () => ({
  resolveAllowedFileTarget: (targetPath: string) => {
    const root = allowedRoot.current
    if (!root) return null
    const relative = path.relative(root, targetPath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null
    return targetPath
  },
}))

const {
  createPreviewNetworkGuard,
  decodeFilePath,
  mimeForPath,
  parseRangeHeader,
  serveFileRequest,
} = await import('../../electron/file-protocol')

let workDir = ''

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-file-'))
  allowedRoot.current = workDir
})

afterEach(() => {
  allowedRoot.current = ''
  fs.rmSync(workDir, { recursive: true, force: true })
})

const toUrl = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `pw-file://local${encoded.startsWith('/') ? encoded : `/${encoded}`}`
}

describe('decodeFilePath', () => {
  it('rejects foreign schemes and hosts', () => {
    expect(decodeFilePath('file:///etc/passwd')).toBeNull()
    expect(decodeFilePath('pw-file://evil/a.png')).toBeNull()
    expect(decodeFilePath('not a url')).toBeNull()
  })

  it('rejects traversal and encoded separators', () => {
    // URL 解析器会先折叠 `..`，剩下的结果仍会经过工作区包含校验
    expect(decodeFilePath('pw-file://local/a/../b.png')).not.toContain('..')
    expect(decodeFilePath('pw-file://local/a/%2e%2e/b.png')).not.toContain('..')
    expect(decodeFilePath('pw-file://local/a%2fb.png')).toBeNull()
    expect(decodeFilePath('pw-file://local/a%5Cb.png')).toBeNull()
    expect(decodeFilePath('pw-file://local/')).toBeNull()
  })

  it('restores an absolute path from the encoded segments', () => {
    const target = path.join(workDir, 'my docs', 'a b.png')
    expect(decodeFilePath(toUrl(target))).toBe(path.resolve(target))
  })
})

describe('parseRangeHeader', () => {
  it('returns null for a full-content request', () => {
    expect(parseRangeHeader(null, 100)).toBeNull()
    expect(parseRangeHeader('bytes=', 100)).toBeNull()
    expect(parseRangeHeader('items=0-1', 100)).toBeNull()
  })

  it('parses closed, open-ended and suffix ranges', () => {
    expect(parseRangeHeader('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRangeHeader('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRangeHeader('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRangeHeader('bytes=0-1000', 100)).toEqual({ start: 0, end: 99 })
  })

  it('flags unsatisfiable ranges', () => {
    expect(parseRangeHeader('bytes=100-', 100)).toBe('invalid')
    expect(parseRangeHeader('bytes=50-10', 100)).toBe('invalid')
    expect(parseRangeHeader('bytes=0-', 0)).toBe('invalid')
  })
})

describe('mimeForPath', () => {
  it('maps preview formats and falls back to a binary type', () => {
    expect(mimeForPath('/a/b.PNG')).toBe('image/png')
    expect(mimeForPath('/a/b.mp4')).toBe('video/mp4')
    expect(mimeForPath('/a/b.mp3')).toBe('audio/mpeg')
    expect(mimeForPath('/a/b.pdf')).toBe('application/pdf')
    expect(mimeForPath('/a/b.unknownext')).toBe('application/octet-stream')
  })
})

describe('serveFileRequest', () => {
  it('rejects write methods and untrusted paths', async () => {
    const target = path.join(workDir, 'a.txt')
    fs.writeFileSync(target, 'hello')

    expect((await serveFileRequest(toUrl(target), 'POST')).status).toBe(405)

    allowedRoot.current = ''
    expect((await serveFileRequest(toUrl(target), 'GET')).status).toBe(403)
  })

  it('serves a file with range and caching headers', async () => {
    const target = path.join(workDir, 'a.txt')
    fs.writeFileSync(target, 'hello world')

    const response = await serveFileRequest(toUrl(target), 'GET', null, 'pw-app://bundle')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('pw-app://bundle')
    expect(await response.text()).toBe('hello world')

    // 沙箱 iframe（Origin: null）或外部 origin 不得获得 CORS 读取权限
    const sandboxRes = await serveFileRequest(toUrl(target), 'GET', null, 'null')
    expect(sandboxRes.headers.get('Access-Control-Allow-Origin')).toBeNull()
    const evilRes = await serveFileRequest(toUrl(target), 'GET', null, 'https://evil.example')
    expect(evilRes.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('answers a range request with 206 and Content-Range', async () => {
    const target = path.join(workDir, 'clip.mp4')
    fs.writeFileSync(target, '0123456789')

    const response = await serveFileRequest(toUrl(target), 'GET', 'bytes=2-5')
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10')
    expect(response.headers.get('Content-Length')).toBe('4')
    expect(await response.text()).toBe('2345')
  })

  it('answers HEAD without a body and sets subrange Content-Length on 206', async () => {
    const target = path.join(workDir, 'a.png')
    fs.writeFileSync(target, 'png-bytes')

    const response = await serveFileRequest(toUrl(target), 'HEAD')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Content-Length')).toBe('9')
    expect(await response.text()).toBe('')

    const partial = await serveFileRequest(toUrl(target), 'HEAD', 'bytes=2-5')
    expect(partial.status).toBe(206)
    expect(partial.headers.get('Content-Range')).toBe('bytes 2-5/9')
    expect(partial.headers.get('Content-Length')).toBe('4')
    expect(await partial.text()).toBe('')
  })

  it('returns 416 for an unsatisfiable range', async () => {
    const target = path.join(workDir, 'a.png')
    fs.writeFileSync(target, 'png')

    const response = await serveFileRequest(toUrl(target), 'GET', 'bytes=100-200')
    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */3')
  })

  it('returns 404 for missing files and directories', async () => {
    expect((await serveFileRequest(toUrl(path.join(workDir, 'nope.png')))).status).toBe(404)

    const dir = path.join(workDir, 'dir')
    fs.mkdirSync(dir)
    expect((await serveFileRequest(toUrl(dir))).status).toBe(404)
  })

  it('attaches structural sandbox CSP header to HTML preview responses (SEC-02)', async () => {
    const htmlFile = path.join(workDir, 'preview.html')
    fs.writeFileSync(htmlFile, '<html><body>hi</body></html>')
    const txtFile = path.join(workDir, 'note.txt')
    fs.writeFileSync(txtFile, 'plain')

    const htmlRes = await serveFileRequest(toUrl(htmlFile), 'GET')
    expect(htmlRes.status).toBe(200)
    const csp = htmlRes.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("worker-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain('frame-ancestors pw-app:')

    const txtRes = await serveFileRequest(toUrl(txtFile), 'GET')
    expect(txtRes.headers.get('Content-Security-Policy')).toBeNull()
  })
})

describe('createPreviewNetworkGuard', () => {
  const callGuard = (
    guard: ReturnType<typeof createPreviewNetworkGuard>,
    details: Parameters<ReturnType<typeof createPreviewNetworkGuard>['handleRequest']>[0]
  ) =>
    new Promise<{ cancel?: boolean }>((resolve) => {
      guard.handleRequest(details, resolve)
    })

  it('passes through requests from non-preview frames without prompting', async () => {
    const prompt = vi.fn(async () => false)
    const guard = createPreviewNetworkGuard({ prompt })

    const res = await callGuard(guard, {
      url: 'https://api.example.com/v1/health',
      frame: { url: 'pw-app://bundle/index.html', parent: null },
      initiatorOrigin: 'pw-app://bundle',
    })
    expect(res).toEqual({})
    expect(prompt).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent external requests for the same HTML file and caches deny', async () => {
    let resolvePrompt!: (allowed: boolean) => void
    const prompt = vi.fn(
      (_payload: { filePath: string; requestUrl: string; targetHost: string }) =>
        new Promise<boolean>((resolve) => {
          resolvePrompt = resolve
        })
    )
    const guard = createPreviewNetworkGuard({ prompt })
    const previewUrl = toUrl(path.join(workDir, 'demo.html'))

    const p1 = callGuard(guard, {
      url: 'https://cdn.example.com/a.js',
      frame: { url: previewUrl, parent: null },
    })
    const p2 = callGuard(guard, {
      url: 'https://fonts.example.com/b.css',
      frame: { url: previewUrl, parent: null },
    })

    await Promise.resolve()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0]).toMatchObject({
      filePath: path.resolve(path.join(workDir, 'demo.html')),
      targetHost: 'cdn.example.com',
    })

    resolvePrompt(false)
    expect(await Promise.all([p1, p2])).toEqual([{ cancel: true }, { cancel: true }])

    // 后续同文件请求直接按缓存拒绝，不再重复弹窗
    expect(
      await callGuard(guard, {
        url: 'https://api.example.com/data',
        frame: { url: `${previewUrl}?v=2`, parent: null },
      })
    ).toEqual({ cancel: true })
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('allows a permitted file (including nested iframes and reloads) while prompting other files independently', async () => {
    const prompt = vi.fn(async ({ filePath }: { filePath: string }) =>
      filePath.endsWith('trusted.html')
    )
    const guard = createPreviewNetworkGuard({ prompt })
    const trustedUrl = toUrl(path.join(workDir, 'trusted.html'))
    const otherUrl = toUrl(path.join(workDir, 'other.html'))

    expect(
      await callGuard(guard, {
        url: 'https://cdn.example.com/lib.js',
        frame: { url: trustedUrl, parent: null },
      })
    ).toEqual({ cancel: false })

    // 同文件刷新与嵌套子 iframe 自动继承放行
    expect(
      await callGuard(guard, {
        url: 'https://cdn.example.com/style.css',
        frame: { url: 'about:blank', parent: { url: `${trustedUrl}?v=5`, parent: null } },
      })
    ).toEqual({ cancel: false })
    expect(prompt).toHaveBeenCalledTimes(1)

    // 另一个 HTML 文件仍独立询问并拒绝
    expect(
      await callGuard(guard, {
        url: 'https://cdn.example.com/evil.js',
        frame: { url: otherUrl, parent: null },
      })
    ).toEqual({ cancel: true })
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('fails closed when prompt throws or frame is missing for pw-file initiator', async () => {
    const prompt = vi.fn(async () => {
      throw new Error('dialog failed')
    })
    const guard = createPreviewNetworkGuard({ prompt })

    expect(
      await callGuard(guard, {
        url: 'https://evil.example/leak',
        frame: null,
        initiatorOrigin: 'pw-file://local',
      })
    ).toEqual({ cancel: true })
    expect(
      await callGuard(guard, {
        url: 'https://evil.example/sandbox-leak',
        frame: null,
        initiatorOrigin: 'null',
      })
    ).toEqual({ cancel: true })
    expect(prompt).not.toHaveBeenCalled()

    expect(
      await callGuard(guard, {
        url: 'https://evil.example/leak',
        frame: { url: toUrl(path.join(workDir, 'err.html')), parent: null },
      })
    ).toEqual({ cancel: true })
  })
})
