import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// 协议层只依赖 electron 的 protocol 注册与路径信任校验，单测里替换掉两者
vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}))

const allowedRoot = { current: '' }
vi.mock('../electron/workspace-trust', () => ({
  resolveAllowedFileTarget: (targetPath: string) => {
    const root = allowedRoot.current
    if (!root) return null
    const relative = path.relative(root, targetPath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null
    return targetPath
  },
}))

const {
  decodeFilePath,
  mimeForPath,
  parseRangeHeader,
  serveFileRequest,
} = await import('../electron/file-protocol')

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

    const response = await serveFileRequest(toUrl(target), 'GET')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(await response.text()).toBe('hello world')
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

  it('answers HEAD without a body', async () => {
    const target = path.join(workDir, 'a.png')
    fs.writeFileSync(target, 'png-bytes')

    const response = await serveFileRequest(toUrl(target), 'HEAD')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Content-Length')).toBe('9')
    expect(await response.text()).toBe('')
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
})
