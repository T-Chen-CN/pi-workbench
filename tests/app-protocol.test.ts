import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  APP_SCHEME,
  appUrl,
  decodeAppPath,
  isAppUrl,
  mimeForAppPath,
  registerAppProtocol,
  resolveAppTarget,
  serveAppRequest,
} from '../electron/app-protocol'

const protocolMock = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn(),
}))

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: protocolMock.registerSchemesAsPrivileged,
    handle: protocolMock.handle,
  },
}))

let distDir = ''

beforeAll(async () => {
  distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-app-protocol-'))
  await fs.mkdir(path.join(distDir, 'assets'), { recursive: true })
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>ok</title>')
  await fs.writeFile(path.join(distDir, 'assets', 'main.js'), 'console.log(1)')
  await fs.writeFile(path.join(distDir, 'assets', 'icon.svg'), '<svg />')
  await fs.writeFile(path.join(distDir, 'asset.unknown'), 'binary')
  // dist 之外的秘密文件：任何路径穿越都必须拿不到
  await fs.writeFile(path.join(path.dirname(distDir), 'pi-app-secret.txt'), 'secret')
})

afterAll(async () => {
  await fs.rm(distDir, { recursive: true, force: true })
  await fs.rm(path.join(path.dirname(distDir), 'pi-app-secret.txt'), { force: true })
})

describe('protocol handler', () => {
  it('registers the pw-app handler', () => {
    registerAppProtocol(distDir)
    expect(protocolMock.handle).toHaveBeenCalledWith(APP_SCHEME, expect.any(Function))
  })
})

describe('appUrl', () => {
  it('builds bundle URLs and encodes the query', () => {
    expect(appUrl('/index.html')).toBe('pw-app://bundle/index.html')
    expect(appUrl('index.html', { theme: 'ink', lang: 'zh-CN' })).toBe(
      'pw-app://bundle/index.html?theme=ink&lang=zh-CN'
    )
  })

  it('recognizes only its own origin', () => {
    expect(isAppUrl('pw-app://bundle/index.html')).toBe(true)
    expect(isAppUrl('pw-app://other/index.html')).toBe(false)
    expect(isAppUrl('file:///tmp/index.html')).toBe(false)
    expect(isAppUrl('https://example.com')).toBe(false)
    expect(isAppUrl('not a url')).toBe(false)
  })
})

describe('decodeAppPath', () => {
  it('decodes path segments', () => {
    expect(decodeAppPath('pw-app://bundle/index.html')).toEqual(['index.html'])
    expect(decodeAppPath('pw-app://bundle/assets/my%20file.js')).toEqual(['assets', 'my file.js'])
  })

  it('rejects encoded separators, control chars and foreign origins', () => {
    expect(decodeAppPath('pw-app://bundle/a%2fb.js')).toBeNull()
    expect(decodeAppPath('pw-app://bundle/a%5cb.js')).toBeNull()
    expect(decodeAppPath('pw-app://bundle/%00.js')).toBeNull()
    expect(decodeAppPath('pw-app://evil/index.html')).toBeNull()
    expect(decodeAppPath('https://bundle/index.html')).toBeNull()
    expect(decodeAppPath('::bad url::')).toBeNull()
  })

  it('lets the URL parser normalize dot segments (defense-in-depth stays in resolveAppTarget)', () => {
    // WHATWG URL 会就地折叠 `..` 与 `%2e%2e`，所以解码结果永远不含点段；
    // 真正的包含判断在 resolveAppTarget / serveAppRequest 里。
    expect(decodeAppPath('pw-app://bundle/../secret.txt')).toEqual(['secret.txt'])
    expect(decodeAppPath('pw-app://bundle/a/%2e%2e/secret.txt')).toEqual(['secret.txt'])
    expect(resolveAppTarget(['..', 'secret.txt'], distDir)).toBeNull()
  })
})

describe('resolveAppTarget', () => {
  it('maps the root to index.html and keeps paths inside dist', () => {
    expect(resolveAppTarget([], distDir)).toBe(path.join(path.resolve(distDir), 'index.html'))
    expect(resolveAppTarget(['assets', 'main.js'], distDir)).toBe(
      path.join(path.resolve(distDir), 'assets', 'main.js')
    )
    expect(resolveAppTarget(['..', 'secret.txt'], distDir)).toBeNull()
  })
})

describe('serveAppRequest', () => {
  it('serves files with a stable content type', async () => {
    const response = await serveAppRequest('pw-app://bundle/assets/main.js', 'GET', distDir)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('console.log(1)')
  })

  it('answers HEAD without a body', async () => {
    const response = await serveAppRequest('pw-app://bundle/index.html', 'HEAD', distDir)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('32')
    expect(await response.text()).toBe('')
  })

  it('rejects unsupported methods', async () => {
    const response = await serveAppRequest('pw-app://bundle/index.html', 'POST', distDir)
    expect(response.status).toBe(405)
  })

  it('never serves files outside dist and 404s unknown paths', async () => {
    for (const url of [
      'pw-app://bundle/../pi-app-secret.txt',
      'pw-app://bundle/%2e%2e/pi-app-secret.txt',
    ]) {
      const response = await serveAppRequest(url, 'GET', distDir)
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain('secret')
    }
    expect((await serveAppRequest('pw-app://bundle/missing.js', 'GET', distDir)).status).toBe(404)
    // 目录不是文件
    expect((await serveAppRequest('pw-app://bundle/assets', 'GET', distDir)).status).toBe(404)
  })

  it('serves the root document', async () => {
    const response = await serveAppRequest('pw-app://bundle/', 'GET', distDir)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>ok</title>')
  })
})

describe('mimeForAppPath', () => {
  it('maps known extensions and falls back to octet-stream', () => {
    expect(mimeForAppPath('/a/b/index.html')).toContain('text/html')
    expect(mimeForAppPath('/a/b/app.woff2')).toBe('font/woff2')
    expect(mimeForAppPath('/a/b/icon.svg')).toBe('image/svg+xml')
    expect(mimeForAppPath('/a/b/x.wasm')).toBe('application/wasm')
    expect(mimeForAppPath('/a/b/asset.unknown')).toBe('application/octet-stream')
  })
})
