/**
 * Phase C · Track C1（主进程成熟库替换）综合回归测试：
 * - `fflate` ZIP64 解析、CRC32 校验与 ZIP 炸弹防线
 * - `saxes` 流式 XML 扫描（命名空间、CDATA、DTD/XXE 隔离、`&nbsp;`、截断容错）
 * - `https-proxy-agent` + `socks-proxy-agent` 通用 PAC 解析与真实本地隧道
 * - `chokidar` v4 忽略过滤（跳过 `node_modules` / `.git`）及工作区 / 插件 watcher 生命周期
 */

// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import chokidar from 'chokidar'

vi.mock('electron', () => ({
  app: {
    isReady: () => true,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '',
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  net: {
    fetch: vi.fn(),
  },
}))

import { ZipArchive, ZipError } from '../../electron/documents/zip'
import { htmlToText, scanXml } from '../../electron/documents/xml'
import {
  createWsProxyAgent,
  parseFirstProxyEntry,
} from '../../electron/system-proxy'
import { createWorkspaceWatchIgnored } from '../../electron/ipc/workspace'
import { PluginManager } from '../../electron/plugin-manager'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** 构造合法 ZIP64 归档，可按需覆盖声明的未压缩大小以模拟伪造头 ZIP 炸弹 */
function buildZip64WithOverrides(
  entries: Array<{
    name: string
    raw: Buffer
    deflate?: boolean
    declaredUncompressedSize?: number
    overrideCrc32?: number
  }>
): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const item of entries) {
    const nameBuf = Buffer.from(item.name, 'utf8')
    const method = item.deflate === false ? 0 : 8
    const compressed = method === 8 ? deflateRawSync(item.raw, { level: 1 }) : item.raw
    const checksum = (item.overrideCrc32 ?? crc32(item.raw)) >>> 0
    const declaredSize = item.declaredUncompressedSize ?? item.raw.length

    const localExtra = Buffer.alloc(20)
    localExtra.writeUInt16LE(0x0001, 0)
    localExtra.writeUInt16LE(16, 2)
    localExtra.writeBigUInt64LE(BigInt(declaredSize), 4)
    localExtra.writeBigUInt64LE(BigInt(compressed.length), 12)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(45, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(0xffffffff, 18)
    local.writeUInt32LE(0xffffffff, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(localExtra.length, 28)
    locals.push(local, nameBuf, localExtra, compressed)

    const cdExtra = Buffer.alloc(28)
    cdExtra.writeUInt16LE(0x0001, 0)
    cdExtra.writeUInt16LE(24, 2)
    cdExtra.writeBigUInt64LE(BigInt(declaredSize), 4)
    cdExtra.writeBigUInt64LE(BigInt(compressed.length), 12)
    cdExtra.writeBigUInt64LE(BigInt(offset), 20)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(45, 4)
    cd.writeUInt16LE(45, 6)
    cd.writeUInt16LE(0x800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(checksum, 16)
    cd.writeUInt32LE(0xffffffff, 20)
    cd.writeUInt32LE(0xffffffff, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(cdExtra.length, 30)
    cd.writeUInt32LE(0xffffffff, 42)
    centrals.push(Buffer.concat([cd, nameBuf, cdExtra]))

    offset += local.length + nameBuf.length + localExtra.length + compressed.length
  }

  const directory = Buffer.concat(centrals)
  const zip64EocdOffset = offset + directory.length

  const z64Eocd = Buffer.alloc(56)
  z64Eocd.writeUInt32LE(0x06064b50, 0)
  z64Eocd.writeBigUInt64LE(44n, 4)
  z64Eocd.writeUInt16LE(45, 12)
  z64Eocd.writeUInt16LE(45, 14)
  z64Eocd.writeBigUInt64LE(BigInt(entries.length), 24)
  z64Eocd.writeBigUInt64LE(BigInt(entries.length), 32)
  z64Eocd.writeBigUInt64LE(BigInt(directory.length), 40)
  z64Eocd.writeBigUInt64LE(BigInt(offset), 48)

  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8)
  locator.writeUInt32LE(1, 16)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0xffff, 8)
  eocd.writeUInt16LE(0xffff, 10)
  eocd.writeUInt32LE(0xffffffff, 12)
  eocd.writeUInt32LE(0xffffffff, 16)

  return Buffer.concat([...locals, directory, z64Eocd, locator, eocd])
}

describe('Phase C · fflate ZipArchive (ZIP64 / CRC32 / bomb guard)', () => {
  it('opens valid ZIP64 archives lazily and verifies CRC32', () => {
    const buf = buildZip64WithOverrides([
      { name: 'word/document.xml', raw: Buffer.from('<w:document>hello zip64</w:document>') },
      { name: 'corrupt.txt', raw: Buffer.from('payload'), overrideCrc32: 0x12345678 },
    ])

    // open() 仅解析中央目录，不预解压损坏条目
    const archive = ZipArchive.open(buf)
    expect(archive.names()).toEqual(['word/document.xml', 'corrupt.txt'])
    expect(archive.readText('word/document.xml')).toBe('<w:document>hello zip64</w:document>')
    expect(() => archive.read('corrupt.txt')).toThrow(ZipError)
  })

  it('rejects entries whose declared size exceeds 64 MiB before allocating', () => {
    const buf = buildZip64WithOverrides([
      {
        name: 'huge.bin',
        raw: Buffer.from('tiny'),
        declaredUncompressedSize: 65 * 1024 * 1024,
      },
    ])
    const archive = ZipArchive.open(buf)
    expect(archive.entrySize('huge.bin')).toBe(65 * 1024 * 1024)
    expect(() => archive.read('huge.bin')).toThrow(ZipError)
  })

  it('aborts spoofed-header DEFLATE zip bombs exceeding 64 MiB during streaming inflate', () => {
    const bombRaw = Buffer.alloc(65 * 1024 * 1024, 0)
    const buf = buildZip64WithOverrides([
      {
        name: 'bomb.xml',
        raw: bombRaw,
        deflate: true,
        // 谎称只有 16 字节，测试流式解压上限是否仍能截停
        declaredUncompressedSize: 16,
      },
    ])
    const archive = ZipArchive.open(buf)
    expect(() => archive.read('bomb.xml')).toThrow(ZipError)
  })
})

describe('Phase C · saxes XML scanner', () => {
  it('preserves namespaces, self-closing token parity, CDATA, and &nbsp;', () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<p:root xmlns:p="urn:p" xmlns:r="urn:r">' +
      '<p:sldId r:id="rId2" id="256" __proto__="evil" p:constructor="bad"/>' +
      '<p:t>Hello&nbsp;<![CDATA[<raw & text>]]></p:t>' +
      '</p:root>'

    const tokens = [...scanXml(xml)]
    const sldOpen = tokens.find((t) => t.type === 'open' && t.name === 'sldId')
    expect(sldOpen).toBeDefined()
    expect(sldOpen!.selfClosing).toBe(true)
    expect(sldOpen!.attrs['r:id']).toBe('rId2')
    expect(sldOpen!.attrs.id).toBe('256')
    expect(Object.prototype.hasOwnProperty.call(sldOpen!.attrs, '__proto__')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(sldOpen!.attrs, 'constructor')).toBe(false)

    // 自闭合标签绝不可紧跟 close token
    expect(tokens.filter((t) => t.type === 'close' && t.name === 'sldId')).toHaveLength(0)

    const textCombined = tokens
      .filter((t) => t.type === 'text')
      .map((t) => t.text)
      .join('')
    expect(textCombined).toBe('Hello\u00a0<raw & text>')
  })

  it('ignores DTD declarations without expanding XXE or entity bombs', () => {
    const xxeXml =
      '<?xml version="1.0"?>' +
      '<!DOCTYPE foo [' +
      '  <!ENTITY xxe SYSTEM "file:///etc/passwd">' +
      '  <!ENTITY lol "lololol">' +
      '  <!ENTITY lol2 "&lol;&lol;&lol;&lol;">' +
      ']>' +
      '<root><p>&xxe;-&lol2;-&nbsp;safe</p></root>'

    const text = htmlToText(xxeXml)
    expect(text).not.toContain('root:')
    expect(text).not.toContain('lololol')
    expect(text).toContain('safe')
  })

  it('stops gracefully on truncated/malformed XML without throwing or leaking half-attributes', () => {
    const truncated = '<doc><p>valid text</p><broken attr="unterminated-secret'
    const tokens = [...scanXml(truncated)]
    const texts = tokens.filter((t) => t.type === 'text').map((t) => t.text)
    expect(texts).toEqual(['valid text'])
    expect(texts.join('')).not.toContain('unterminated-secret')
  })
})

describe('Phase C · https-proxy-agent & socks-proxy-agent', () => {
  it('parses PROXY / HTTPS / SOCKS / SOCKS4 / SOCKS5 with optional auth and tunnels locally', async () => {
    expect(parseFirstProxyEntry('PROXY 127.0.0.1:8080')).toEqual({
      host: '127.0.0.1',
      port: 8080,
      protocol: 'http:',
    })
    expect(parseFirstProxyEntry('HTTPS user:pw@proxy.local:8443')).toEqual({
      host: 'proxy.local',
      port: 8443,
      protocol: 'https:',
      username: 'user',
      password: 'pw',
    })
    expect(parseFirstProxyEntry('SOCKS 127.0.0.1:1080')).toEqual({
      host: '127.0.0.1',
      port: 1080,
      protocol: 'socks:',
    })
    expect(parseFirstProxyEntry('SOCKS4 127.0.0.1:1081')).toEqual({
      host: '127.0.0.1',
      port: 1081,
      protocol: 'socks4:',
    })
    expect(parseFirstProxyEntry('SOCKS5 admin:secret@[::1]:1085')).toEqual({
      host: '[::1]',
      port: 1085,
      protocol: 'socks5:',
      username: 'admin',
      password: 'secret',
    })

    // 真实本地 HTTP CONNECT 隧道端到端验证
    const echoServer = http.createServer((_req, res) => {
      res.writeHead(200)
      res.end('phase-c-proxy-ok')
    })
    await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve))
    const echoAddr = echoServer.address() as net.AddressInfo

    const sockets = new Set<{ destroy(): void }>()
    const proxy = http.createServer()
    proxy.on('connect', (req, clientSocket, head) => {
      sockets.add(clientSocket)
      clientSocket.once('close', () => sockets.delete(clientSocket))
      const [h, p] = (req.url ?? '').split(':')
      const up = net.connect(Number(p), h, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) up.write(head)
        up.pipe(clientSocket)
        clientSocket.pipe(up)
      })
      sockets.add(up)
      up.once('close', () => sockets.delete(up))
      up.on('error', () => clientSocket.destroy())
      clientSocket.on('error', () => up.destroy())
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const proxyAddr = proxy.address() as net.AddressInfo

    try {
      const entry = parseFirstProxyEntry(`PROXY 127.0.0.1:${proxyAddr.port}`)!
      const agent = createWsProxyAgent(entry, false, { connectTimeoutMs: 2000 })
      const text = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port: echoAddr.port, path: '/', agent },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          }
        )
        req.on('error', reject)
        req.end()
      })
      expect(text).toBe('phase-c-proxy-ok')
    } finally {
      for (const s of sockets) s.destroy()
      proxy.closeAllConnections?.()
      echoServer.closeAllConnections?.()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      await new Promise<void>((resolve) => echoServer.close(() => resolve()))
    }
  })
})

describe('Phase C · chokidar v4 workspace & plugin watchers', () => {
  it('skips node_modules and .git while watching workspace source files and worktrees', async () => {
    const root = await makeTempDir('pi-chokidar-ws-')
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    await fs.mkdir(path.join(root, '.git', 'objects'), { recursive: true })
    await fs.mkdir(path.join(root, '.pi-workbench', 'worktrees', 'wt1'), { recursive: true })
    await fs.mkdir(path.join(root, '.pi-workbench', 'cache'), { recursive: true })

    const ignored = createWorkspaceWatchIgnored(root)
    expect(ignored(root)).toBe(false)
    expect(ignored(path.join(root, 'node_modules'))).toBe(true)
    expect(ignored(path.join(root, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    expect(ignored(path.join(root, '.git'))).toBe(true)
    expect(ignored(path.join(root, '.git', 'HEAD'))).toBe(true)
    expect(ignored(path.join(root, 'dist'))).toBe(true)
    expect(ignored(path.join(root, '.pi-workbench'))).toBe(false)
    expect(ignored(path.join(root, '.pi-workbench', 'cache'))).toBe(true)
    expect(ignored(path.join(root, '.pi-workbench', 'worktrees', 'wt1', 'a.ts'))).toBe(false)
    expect(ignored(path.join(root, 'src', 'app.ts'))).toBe(false)

    const seen: string[] = []
    const watcher = chokidar.watch(root, {
      ignored,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 15 },
    })

    try {
      await new Promise<void>((resolve) => watcher.once('ready', () => resolve()))
      watcher.on('all', (_ev, p) => seen.push(path.relative(root, p).replace(/\\/g, '/')))

      await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'ignored.js'), 'x')
      await fs.writeFile(path.join(root, '.git', 'objects', 'ignored'), 'y')
      await fs.writeFile(path.join(root, 'src', 'hello.ts'), 'export const a = 1\n')

      await vi.waitFor(
        () => {
          expect(seen).toContain('src/hello.ts')
        },
        { timeout: 3000 }
      )
      expect(seen.some((p) => p.startsWith('node_modules/') || p.startsWith('.git/'))).toBe(false)
    } finally {
      await watcher.close()
    }
  })

  it('reloads PluginManager on chokidar change and cleanly closes watcher on unloadAsync', async () => {
    const workspace = await makeTempDir('pi-chokidar-plug-')
    const stateDir = await makeTempDir('pi-chokidar-plug-state-')
    const stateFilePath = path.join(stateDir, 'workspace-plugins.json')
    const pluginDir = path.join(workspace, '.pi-workbench', 'plugins', 'alpha')
    await fs.mkdir(pluginDir, { recursive: true })
    await fs.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ id: 'alpha', name: 'Alpha', main: 'index.js' }),
      'utf8'
    )
    await fs.writeFile(
      path.join(pluginDir, 'index.js'),
      `module.exports = { activate() {} }`,
      'utf8'
    )

    const onChanged = vi.fn()
    const manager = new PluginManager({ watch: true, debounceMs: 40, stateFilePath, onChanged })
    try {
      manager.loadWorkspace(workspace)
      await fs.writeFile(
        path.join(pluginDir, 'plugin.json'),
        JSON.stringify({ id: 'alpha', name: 'Alpha Updated', main: 'index.js' }),
        'utf8'
      )

      await vi.waitFor(
        () => {
          expect(onChanged).toHaveBeenCalledWith(workspace)
        },
        { timeout: 3000 }
      )
      expect(manager.list(workspace)[0]?.name).toBe('Alpha Updated')

      await manager.unloadAsync(workspace)
      const callsAfterUnload = onChanged.mock.calls.length
      await fs.writeFile(
        path.join(pluginDir, 'plugin.json'),
        JSON.stringify({ id: 'alpha', name: 'After Unload', main: 'index.js' }),
        'utf8'
      )
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(onChanged.mock.calls.length).toBe(callsAfterUnload)
    } finally {
      await manager.disposeAllAsync()
    }
  })
})
