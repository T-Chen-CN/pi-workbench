// @vitest-environment node

import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { Connect, Plugin, ViteDevServer } from 'vite'
import {
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  IPC_INVOKE_SCHEMAS,
  IPC_SEND_CHANNELS,
  createContractApiCall,
  normalizeIpcError,
  type IpcEventChannel,
  type IpcEventMethod,
  type IpcInvokeChannel,
  type IpcInvokeMethod,
} from '../../electron/ipc/contract'

const ROOT = path.resolve(__dirname, '../..')

interface FakeDevAgentManager {
  initialize(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }>
  chat(
    sessionOrMessage: string,
    messageOrOptions?: string | Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>
  abort(sessionId?: string): Promise<unknown>
  dispose(): Promise<void>
  listSessions(): Promise<unknown>
  openSession(sessionId?: unknown): Promise<unknown>
  createSession(): Promise<unknown>
  closeSession(sessionId: string): Promise<unknown>
  renameSession(sessionId: string, name: string): Promise<unknown>
  deleteSession(sessionId: string): Promise<unknown>
}

interface DevAgentBridgeModule {
  devAgentBridge: (options?: {
    token?: string
    loadAgentManager?: () => Promise<new () => FakeDevAgentManager>
  }) => Plugin
}

interface FontSubsetFilterModule {
  fontSubsetFilter: () => Plugin
}

function createMockReq(options: {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
}): http.IncomingMessage {
  const emitter = new EventEmitter() as http.IncomingMessage & {
    destroy: () => http.IncomingMessage
  }
  emitter.method = options.method
  emitter.url = options.url
  emitter.headers = options.headers
  emitter.destroy = () => emitter
  queueMicrotask(() => {
    if (options.body !== undefined) {
      emitter.emit('data', Buffer.from(JSON.stringify(options.body), 'utf8'))
    }
    emitter.emit('end')
  })
  return emitter
}

interface CapturedResponse {
  res: http.ServerResponse
  done: Promise<{ statusCode: number; body: string }>
}

function createMockRes(): CapturedResponse {
  const headers = new Map<string, string>()
  const chunks: string[] = []
  let resolveDone: (value: { statusCode: number; body: string }) => void = () => {}
  const done = new Promise<{ statusCode: number; body: string }>((resolve) => {
    resolveDone = resolve
  })

  const state = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value)
    },
    writeHead(status: number) {
      state.statusCode = status
      state.headersSent = true
      return state
    },
    write(chunk: string | Buffer) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      return true
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      }
      state.writableEnded = true
      resolveDone({ statusCode: state.statusCode, body: chunks.join('') })
      return state
    },
  }

  return { res: state as unknown as http.ServerResponse, done }
}

function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function buildPreloadBundle(): string {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-preload.mjs')], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  const bundlePath = path.join(ROOT, 'dist-electron/preload.cjs')
  expect(fs.existsSync(bundlePath)).toBe(true)
  return fs.readFileSync(bundlePath, 'utf-8')
}

describe('Phase D2-A · Single-Source IPC Contract', () => {
  it('ensures every invoke and event channel in the contract is unique and Node-free', () => {
    const invokeValues = Object.values(IPC_INVOKE_CHANNELS)
    const eventValues = Object.values(IPC_EVENT_CHANNELS)
    expect(invokeValues.length).toBeGreaterThan(100)
    expect(new Set(invokeValues).size).toBe(invokeValues.length)
    expect(new Set(eventValues).size).toBe(eventValues.length)

    // Invoke 与 Event 通道命名空间互不冲突
    const invokeSet = new Set<string>(invokeValues)
    for (const ev of eventValues) {
      expect(invokeSet.has(ev)).toBe(false)
    }

    // electron/ipc/contract.ts 必须零 electron / node:* / Buffer 运行时依赖
    const contractCode = stripJsComments(
      fs.readFileSync(path.join(ROOT, 'electron/ipc/contract.ts'), 'utf-8')
    )
    expect(contractCode).not.toMatch(/from\s+['"]electron['"]/)
    expect(contractCode).not.toMatch(/from\s+['"]node:/)
    expect(contractCode).not.toMatch(/\bBuffer\b/)

    // 验证所有 electron/ 中通过 handleIpc / handleTypedIpc 注册的通道均已登记进 IPC_INVOKE_CHANNELS
    const registeredChannels = new Set<string>()
    const collect = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) collect(full)
        else if (entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf-8')
          for (const match of content.matchAll(/handle(?:Typed)?Ipc\(\s*'([^']+)'/g)) {
            registeredChannels.add(match[1])
          }
        }
      }
    }
    collect(path.join(ROOT, 'electron'))
    const missingFromContract = [...registeredChannels].filter((ch) => !invokeSet.has(ch))
    expect(missingFromContract).toEqual([])
  })

  it('bundles a self-contained dist-electron/preload.cjs requiring only electron and exposing all contract channels', async () => {
    const bundle = buildPreloadBundle()

    // 沙盒 preload 里只能 require('electron')，禁止任何本地相对路径或其它依赖 require
    const requires = [...bundle.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2])
    expect(requires.length).toBeGreaterThan(0)
    expect(new Set(requires)).toEqual(new Set(['electron']))

    let exposedKey = ''
    let exposedApi: Record<string, unknown> = {}
    const invokeMock = vi.fn(async (_channel: string, ..._args: unknown[]) => ({ success: true }))
    const sendMock = vi.fn()
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const onMock = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
    })
    const removeListenerMock = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(listener)
    })
    const getPathForFileMock = vi.fn(() => '/resolved/dropped.txt')

    const electronStub = {
      contextBridge: {
        exposeInMainWorld: (key: string, api: Record<string, unknown>) => {
          exposedKey = key
          exposedApi = api
        },
      },
      ipcRenderer: {
        invoke: invokeMock,
        send: sendMock,
        on: onMock,
        removeListener: removeListenerMock,
      },
      webUtils: {
        getPathForFile: getPathForFileMock,
      },
    }

    const sandboxRequire = (id: string): unknown => {
      if (id === 'electron') return electronStub
      throw new Error(`Unexpected sandbox require in preload.cjs: ${id}`)
    }

    const moduleObj: { exports: Record<string, unknown> } = { exports: {} }
    const runner = vm.runInNewContext(
      `(function(require, module, exports, process) {\n${bundle}\n})`,
      { console, TextEncoder }
    ) as (
      req: (id: string) => unknown,
      mod: { exports: Record<string, unknown> },
      exp: Record<string, unknown>,
      proc: { platform: string }
    ) => void
    runner(sandboxRequire, moduleObj, moduleObj.exports, { platform: 'win32' })

    expect(exposedKey).toBe('electronAPI')
    expect(exposedApi.platform).toBe('win32')
    expect(exposedApi.nativeTitleBarOverlay).toBe(true)

    // 所有 156 个 invoke 方法均暴露且转发到契约指定的精确通道名
    for (const [method, channel] of Object.entries(IPC_INVOKE_CHANNELS) as Array<
      [IpcInvokeMethod, IpcInvokeChannel]
    >) {
      const fn = exposedApi[method]
      expect(typeof fn, `preload should expose invoke method ${method}`).toBe('function')
      invokeMock.mockClear()
      await (fn as (...args: unknown[]) => Promise<unknown>)('arg-1')
      expect(invokeMock).toHaveBeenCalledTimes(1)
      expect(invokeMock.mock.calls[0]?.[0]).toBe(channel)
    }

    // 特殊参数规整：writeClipboardText 强转字符串、providersRefresh 收敛为严格布尔
    invokeMock.mockClear()
    await (exposedApi.writeClipboardText as (value: unknown) => Promise<unknown>)(undefined)
    expect(invokeMock).toHaveBeenCalledWith('clipboard:writeText', '')

    invokeMock.mockClear()
    await (exposedApi.providersRefresh as (force?: unknown) => Promise<unknown>)('yes')
    expect(invokeMock).toHaveBeenCalledWith('providers:refresh', false)

    // 所有 23 个 event 订阅方法均正确绑定并支持取消订阅
    for (const [method, channel] of Object.entries(IPC_EVENT_CHANNELS) as Array<
      [IpcEventMethod, IpcEventChannel]
    >) {
      const fn = exposedApi[method]
      expect(typeof fn, `preload should expose event subscriber ${method}`).toBe('function')
      const cb = vi.fn()
      const unsubscribe = (fn as (callback: (...args: unknown[]) => void) => () => void)(cb)
      expect(typeof unsubscribe).toBe('function')

      const registered = [...(listeners.get(channel) ?? [])]
      expect(registered.length).toBe(1)
      registered[0]({}, { marker: channel })
      if (channel === IPC_EVENT_CHANNELS.onAppBootExpanded) {
        expect(cb).toHaveBeenCalledWith()
      } else {
        expect(cb).toHaveBeenCalledWith({ marker: channel })
      }

      unsubscribe()
      expect(listeners.get(channel)?.size ?? 0).toBe(0)
    }

    // 单向通知与 webUtils 桥接
    ;(exposedApi.appBootReady as () => void)()
    expect(sendMock).toHaveBeenCalledWith(IPC_SEND_CHANNELS.appBootReady)

    const fakeFile = {} as File
    expect((exposedApi.getPathForFile as (file: File) => string)(fakeFile)).toBe(
      '/resolved/dropped.txt'
    )
    expect(getPathForFileMock).toHaveBeenCalledWith(fakeFile)
  })

  it('normalizes Electron IPC error messages and forwards cleanly via createContractApiCall', async () => {
    expect(
      normalizeIpcError(
        new Error("Error invoking remote method 'fs:readFile': Error: EACCES: permission denied")
      )
    ).toBe('EACCES: permission denied')
    expect(normalizeIpcError('plain failure')).toBe('plain failure')

    const failingCall = createContractApiCall(
      () => ({
        readFile: async () => {
          throw new Error("Error invoking remote method 'fs:readFile': Error: boom")
        },
      }),
      'readFile'
    )
    await expect(failingCall('/demo.txt')).resolves.toEqual({ success: false, error: 'boom' })

    const fallbackCall = createContractApiCall(() => ({}), 'repoMapCanvasSet', {
      fallback: () => ({ success: false, error: 'unavailable' }),
    })
    await expect(
      fallbackCall('/ws', {
        version: 1,
        layoutVersion: 1,
        zoom: 1,
        pan: { x: 0, y: 0 },
        folders: {},
        files: {},
      })
    ).resolves.toEqual({ success: false, error: 'unavailable' })
  })

  it('handleTypedIpc enforces isTrustedIpcSender fail-closed and validates schemas', async () => {
    vi.resetModules()

    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    let ready = true
    const mainFrame = { url: 'pw-app://bundle/index.html' }
    const mainWebContents = { id: 1, mainFrame }
    const mainWindow = {
      isDestroyed: () => false,
      webContents: mainWebContents,
    }

    vi.doMock('electron', () => ({
      app: {
        isReady: () => ready,
      },
      ipcMain: {
        handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
          handlers.set(channel, listener)
        },
      },
    }))

    try {
      const { configureIpcWindow, handleTypedIpc } = await import('../../electron/ipc/register')
      configureIpcWindow(() => mainWindow as unknown as Electron.BrowserWindow)

      const listener = vi.fn(async (_event: Electron.IpcMainInvokeEvent, filePath: string) => ({
        success: true,
        code: filePath,
      }))
      handleTypedIpc('fs:createFile', listener)

      const registered = handlers.get('fs:createFile')
      expect(registered).toBeDefined()

      // 未受信任发送方必须 fail-closed
      const untrustedEvent = {
        sender: { id: 999, mainFrame: { url: 'https://evil.example/' } },
        senderFrame: { url: 'https://evil.example/' },
      }
      await expect(registered!(untrustedEvent, '/ws/a.txt')).toEqual({
        success: false,
        error: 'Untrusted IPC sender',
      })
      expect(listener).not.toHaveBeenCalled()

      // 受信任发送方 + 非法入参（含 NUL 字节）被 IPC_INVOKE_SCHEMAS 拦截
      expect(IPC_INVOKE_SCHEMAS['fs:createFile']).toBeDefined()
      const trustedEvent = { sender: mainWebContents, senderFrame: mainFrame }
      const badRes = await registered!(trustedEvent, '/ws/bad\0.txt')
      expect(badRes).toMatchObject({ success: false })
      expect(listener).not.toHaveBeenCalled()

      // 受信任发送方 + 合法入参正常透传并返回强类型结果
      const okRes = await registered!(trustedEvent, '/ws/ok.txt')
      expect(okRes).toEqual({ success: true, code: '/ws/ok.txt' })
      expect(listener).toHaveBeenCalledWith(trustedEvent, '/ws/ok.txt')

      // app 未 ready 时测试模式允许放行
      ready = false
      const preReadyRes = await registered!(untrustedEvent, '/ws/early.txt')
      expect(preReadyRes).toEqual({ success: true, code: '/ws/early.txt' })
    } finally {
      vi.doUnmock('electron')
    }
  })

  it('disposes all active devAgentBridge workspace agents when httpServer emits close', async () => {
    const modUrl = pathToFileURL(path.join(ROOT, 'scripts/vite-dev-agent-bridge.ts')).href
    const { devAgentBridge } = (await import(/* @vite-ignore */ modUrl)) as DevAgentBridgeModule

    const disposedWorkspaces: string[] = []
    let instanceCount = 0

    class FakeAgentManager implements FakeDevAgentManager {
      private ws = ''
      async initialize(config: Record<string, unknown>) {
        instanceCount += 1
        this.ws = String(config.workspaceDir ?? '')
        return { success: true }
      }
      async chat() {
        return { success: true }
      }
      async abort() {
        return { success: true }
      }
      async dispose() {
        disposedWorkspaces.push(this.ws)
      }
      async listSessions() {
        return []
      }
      async openSession() {
        return { success: true }
      }
      async createSession() {
        return { success: true }
      }
      async closeSession() {
        return { success: true }
      }
      async renameSession() {
        return { success: true }
      }
      async deleteSession() {
        return { success: true }
      }
    }

    const token = 'test-dev-token-1234'
    const plugin = devAgentBridge({
      token,
      loadAgentManager: async () => FakeAgentManager,
    })

    const routes = new Map<string, Connect.NextHandleFunction[]>()
    const httpServer = new EventEmitter()
    const fakeServer = {
      httpServer,
      middlewares: {
        use: (route: string, fn: Connect.NextHandleFunction) => {
          const list = routes.get(route) ?? []
          list.push(fn)
          routes.set(route, list)
        },
      },
    } as unknown as ViteDevServer

    const configure =
      typeof plugin.configureServer === 'function'
        ? plugin.configureServer
        : plugin.configureServer?.handler
    expect(configure).toBeDefined()
    await configure!.call({} as never, fakeServer)

    const dispatchPost = async (
      endpoint: string,
      body: Record<string, unknown>
    ): Promise<{ statusCode: number; body: string }> => {
      const req = createMockReq({
        method: 'POST',
        url: endpoint,
        headers: {
          host: 'localhost:5173',
          origin: 'http://localhost:5173',
          'content-type': 'application/json',
          'x-pi-dev-token': token,
        },
        body,
      })
      const captured = createMockRes()
      const guard = routes.get('/__pi/agent')?.[0]
      const handler = routes.get(endpoint)?.[0]
      expect(guard).toBeDefined()
      expect(handler).toBeDefined()
      guard!(req, captured.res, () => {
        handler!(req, captured.res, () => {})
      })
      return captured.done
    }

    // 初始化两个独立工作区目录（使用真实存在的仓库目录）
    const wsA = path.join(ROOT, 'src')
    const wsB = path.join(ROOT, 'electron')
    const resA = await dispatchPost('/__pi/agent/init', { workspaceDir: wsA })
    const resB = await dispatchPost('/__pi/agent/init', { workspaceDir: wsB })
    expect(JSON.parse(resA.body)).toEqual({ success: true })
    expect(JSON.parse(resB.body)).toEqual({ success: true })
    expect(instanceCount).toBe(2)

    // 触发 Vite httpServer close 事件，应释放全部 Agent 并清空内部映射
    httpServer.emit('close')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(disposedWorkspaces.sort()).toEqual([path.resolve(wsA), path.resolve(wsB)].sort())

    // 关闭后再次请求 chat 应返回未初始化，证明 Map 已清空
    const afterClose = await dispatchPost('/__pi/agent/chat', {
      workspaceDir: wsA,
      message: 'hello',
    })
    expect(JSON.parse(afterClose.body)).toMatchObject({
      success: false,
      error: expect.stringContaining('not initialized'),
    })
  })

  it('fontSubsetFilter drops non-CJK/Latin subsets while preserving latin and chinese blocks', async () => {
    const modUrl = pathToFileURL(path.join(ROOT, 'scripts/vite-font-subset-filter.ts')).href
    const { fontSubsetFilter } = (await import(
      /* @vite-ignore */ modUrl
    )) as FontSubsetFilterModule

    const plugin = fontSubsetFilter()
    const transform =
      typeof plugin.transform === 'function' ? plugin.transform : plugin.transform?.handler
    expect(transform).toBeDefined()

    const sampleCss = [
      '/* noto-sans-cyrillic-400 */',
      '@font-face { font-family: Noto; src: url(./cyrillic.woff2); }',
      '/* noto-sans-latin-400 */',
      '@font-face { font-family: Noto; src: url(./latin.woff2); }',
      '/* noto-sans-vietnamese-400 */',
      '@font-face { font-family: Noto; src: url(./vietnamese.woff2); }',
    ].join('\n')

    const result = transform!.call(
      {} as never,
      sampleCss,
      '/node_modules/@fontsource-variable/noto-sans/index.css'
    ) as { code: string } | null
    expect(result).not.toBeNull()
    expect(result!.code).toContain('latin.woff2')
    expect(result!.code).not.toContain('cyrillic')
    expect(result!.code).not.toContain('vietnamese')
  })
})
