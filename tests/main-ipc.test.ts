import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

interface IpcResult {
  success: boolean
  error?: string
  [key: string]: unknown
}

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<IpcResult> | IpcResult

/**
 * electron 模块在主进程里只有运行时才存在，测试中用最小替身：
 * - ipcMain.handle 把 channel -> handler 收集起来
 * - app.whenReady 返回永不 resolve 的 Promise，阻止测试创建真实窗口
 * - appDir 由每个测试文件指向独立临时目录
 */
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>()
  const state = { appDir: '' }
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf-8').slice(4),
  }
  return { handlers, state, safeStorage }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => mocks.state.appDir,
    getPath: () => mocks.state.appDir,
    whenReady: () => new Promise(() => {}),
    on: () => {},
    quit: () => {},
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    },
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return []
    }
    webContents = {
      on: () => {},
      once: () => {},
      executeJavaScript: async () => undefined,
      send: () => {},
      openDevTools: () => {},
    }
    loadURL = async () => {}
    loadFile = async () => {}
    on = () => {}
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/picked'] }),
  },
  safeStorage: mocks.safeStorage,
}))

function getHandler(channel: string): IpcHandler {
  const handler = mocks.handlers.get(channel)
  if (!handler) {
    throw new Error(`IPC handler not registered: ${channel}`)
  }
  return handler
}

function call(channel: string, ...args: unknown[]): Promise<IpcResult> {
  return Promise.resolve(getHandler(channel)({}, ...args) as IpcResult)
}

let appDir: string
let workDir: string

beforeAll(async () => {
  appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-app-'))
  mocks.state.appDir = appDir
  // 真实应用启动时会先创建 config/，这里模拟同样的前置状态
  await fs.mkdir(path.join(appDir, 'config'), { recursive: true })
  await import('../electron/main')
})

afterAll(async () => {
  await fs.rm(appDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await fs.rm(path.join(appDir, 'config'), { recursive: true, force: true })
  await fs.mkdir(path.join(appDir, 'config'), { recursive: true })
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-ipc-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(workDir, { recursive: true, force: true })
})

describe('filesystem IPC handlers', () => {
  it('writes and reads a file', async () => {
    const target = path.join(workDir, 'a.txt')

    await expect(call('fs:writeFile', target, 'hello')).resolves.toMatchObject({ success: true })
    await expect(call('fs:readFile', target)).resolves.toEqual({ success: true, content: 'hello' })
  })

  it('returns an error for missing files', async () => {
    const result = await call('fs:readFile', path.join(workDir, 'missing.txt'))

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('lists directories with file type information', async () => {
    await fs.mkdir(path.join(workDir, 'sub'))
    await fs.writeFile(path.join(workDir, 'file.txt'), 'x')

    const result = await call('fs:listDirectory', workDir)
    const items = result.items as Array<{ name: string; path: string; isDirectory: boolean }>

    expect(result.success).toBe(true)
    expect(items).toEqual(
      expect.arrayContaining([
        { name: 'sub', path: path.join(workDir, 'sub'), isDirectory: true },
        { name: 'file.txt', path: path.join(workDir, 'file.txt'), isDirectory: false },
      ])
    )
  })

  it('reports existence and stats', async () => {
    const target = path.join(workDir, 'b.txt')
    await fs.writeFile(target, 'abc')

    await expect(call('fs:exists', target)).resolves.toEqual({ success: true, exists: true })
    await expect(call('fs:exists', path.join(workDir, 'nope'))).resolves.toEqual({
      success: true,
      exists: false,
    })
    await expect(call('fs:stat', target)).resolves.toMatchObject({
      success: true,
      isFile: true,
      isDirectory: false,
      size: 3,
    })
  })

  it('renames and deletes files', async () => {
    const source = path.join(workDir, 'old.txt')
    const target = path.join(workDir, 'new.txt')
    await fs.writeFile(source, 'x')

    await expect(call('fs:rename', source, target)).resolves.toMatchObject({ success: true })
    await expect(call('fs:exists', source)).resolves.toMatchObject({ exists: false })
    await expect(call('fs:exists', target)).resolves.toMatchObject({ exists: true })

    await expect(call('fs:delete', target)).resolves.toMatchObject({ success: true })
    await expect(call('fs:exists', target)).resolves.toMatchObject({ exists: false })
  })

  it('starts and stops the workspace watcher', async () => {
    const sender = { isDestroyed: () => false, send: vi.fn() }

    await expect(getHandler('fs:watch')({ sender }, workDir)).resolves.toMatchObject({
      success: true,
    })
    await expect(call('fs:unwatch')).resolves.toMatchObject({ success: true })
  })

  it('fails cleanly when watching a nonexistent directory', async () => {
    const sender = { isDestroyed: () => false, send: vi.fn() }

    const result = await getHandler('fs:watch')({ sender }, path.join(workDir, 'missing'))

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('app settings handlers', () => {
  it('returns defaults when no settings file exists', async () => {
    const result = await call('app:getSettings')
    const settings = result.settings as Record<string, unknown>

    expect(result.success).toBe(true)
    expect(settings).toMatchObject({
      language: 'zh-CN',
      theme: 'dark',
      autoSave: true,
      autoSaveDelay: 2000,
      recentWorkspaces: [],
    })
  })

  it('persists settings and merges them with defaults', async () => {
    await expect(
      call('app:saveSettings', { language: 'en-US', theme: 'light' })
    ).resolves.toMatchObject({ success: true })

    const result = await call('app:getSettings')
    expect(result.settings).toMatchObject({
      language: 'en-US',
      theme: 'light',
      autoSave: true,
    })
  })

  it('moves recent workspaces to the front, deduplicates and caps at 10', async () => {
    for (let i = 0; i < 11; i++) {
      await call('app:addRecentWorkspace', `/tmp/ws-${i}`)
    }

    let workspaces = (await call('app:getRecentWorkspaces')).workspaces as string[]
    expect(workspaces).toHaveLength(10)
    expect(workspaces[0]).toBe('/tmp/ws-10')
    expect(workspaces).not.toContain('/tmp/ws-0')

    workspaces = (await call('app:addRecentWorkspace', '/tmp/ws-5')).workspaces as string[]
    expect(workspaces[0]).toBe('/tmp/ws-5')
    expect(workspaces.filter((w) => w === '/tmp/ws-5')).toHaveLength(1)
  })
})

describe('workspace lifecycle handlers', () => {
  it('initializes the .pi-workbench directory with a default config', async () => {
    await expect(call('workspace:init', workDir)).resolves.toMatchObject({ success: true })

    await expect(fs.stat(path.join(workDir, '.pi-workbench', 'plugins'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(workDir, '.pi-workbench', 'sessions'))).resolves.toBeTruthy()

    const configPath = path.join(workDir, '.pi-workbench', 'config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'))
    expect(config).toEqual({
      version: '1.0',
      enabledPlugins: [],
      agentConfig: { temperature: 0.7 },
    })
  })

  it('does not overwrite an existing workspace config', async () => {
    await call('workspace:init', workDir)
    const configPath = path.join(workDir, '.pi-workbench', 'config.json')
    const custom = { version: '2.0', enabledPlugins: ['git'] }
    await fs.writeFile(configPath, JSON.stringify(custom), 'utf-8')

    await call('workspace:init', workDir)

    expect(JSON.parse(await fs.readFile(configPath, 'utf-8'))).toEqual(custom)
  })

  it('rejects config reads before initialization', async () => {
    const result = await call('workspace:getConfig', workDir)

    expect(result.success).toBe(false)
    expect(result.error).toContain('not initialized')
  })

  it('saves and reads workspace config', async () => {
    await call('workspace:init', workDir)
    const config = { version: '1.1', enabledPlugins: ['git'], agentConfig: { temperature: 0.2 } }

    await expect(call('workspace:saveConfig', workDir, config)).resolves.toMatchObject({
      success: true,
    })
    await expect(call('workspace:getConfig', workDir)).resolves.toEqual({ success: true, config })
  })
})

describe('API configuration handlers', () => {
  it('encrypts the API key on disk and decrypts it on read', async () => {
    const config = {
      provider: 'openai',
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'sk-123',
      availableModels: ['model-a'],
      selectedModel: 'model-a',
    }

    await expect(call('apiConfig:save', config)).resolves.toMatchObject({ success: true })

    const raw = await fs.readFile(path.join(appDir, 'config', 'api-config.json'), 'utf-8')
    expect(raw).not.toContain('sk-123')
    expect(JSON.parse(raw).apiKey).toMatch(/^enc:/)

    const result = await call('apiConfig:get')
    expect(result.config).toMatchObject({ ...config, apiKey: 'sk-123' })
  })

  it('falls back to defaults when no API config exists', async () => {
    const result = await call('apiConfig:get')

    expect(result.success).toBe(true)
    expect(result.config).toMatchObject({
      provider: 'anthropic',
      availableModels: [],
      selectedModel: '',
    })
  })

  it('reads legacy plaintext API keys', async () => {
    await fs.writeFile(
      path.join(appDir, 'config', 'api-config.json'),
      JSON.stringify({ provider: 'openai', apiKey: 'legacy-key' }),
      'utf-8'
    )

    const result = await call('apiConfig:get')
    expect((result.config as Record<string, unknown>).apiKey).toBe('legacy-key')
  })

  it('fetches and normalizes models from a { data: [{ id }] } response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }),
      }))
    )

    const result = await call(
      'apiConfig:fetchModels',
      'https://api.example.com/v1/',
      'sk-123',
      'openai'
    )

    expect(result).toEqual({ success: true, models: ['model-a', 'model-b'] })
  })

  it('normalizes plain array and { models: [] } responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ['m1', { id: 'm2' }] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [{ id: 'm3' }] }) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      call('apiConfig:fetchModels', 'https://api.example.com', 'k', 'openai')
    ).resolves.toEqual({ success: true, models: ['m1', 'm2'] })
    await expect(
      call('apiConfig:fetchModels', 'https://api.example.com', 'k', 'openai')
    ).resolves.toEqual({ success: true, models: ['m3'] })
  })

  it('rejects invalid API URLs', async () => {
    const placeholder = await call(
      'apiConfig:fetchModels',
      'https://your-api-endpoint.com/v1',
      'k',
      'openai'
    )
    expect(placeholder.success).toBe(false)
    expect(placeholder.error).toContain('valid API URL')

    const badScheme = await call('apiConfig:fetchModels', 'api.example.com', 'k', 'openai')
    expect(badScheme.success).toBe(false)
    expect(badScheme.error).toContain('http://')
  })

  it('surfaces provider HTTP errors with a body excerpt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'boom',
      }))
    )

    const result = await call('apiConfig:fetchModels', 'https://api.example.com', 'k', 'openai')

    expect(result.success).toBe(false)
    expect(result.error).toContain('HTTP 500')
    expect(result.error).toContain('boom')
  })
})

describe('agent handlers without an initialized agent', () => {
  it('reports not initialized and rejects chat', async () => {
    await expect(call('agent:isInitialized')).resolves.toEqual({
      success: true,
      initialized: false,
    })

    const chat = await call('agent:chat', 'hello')
    expect(chat.success).toBe(false)
    expect(chat.error).toContain('not initialized')
  })

  it('returns no history and disposes cleanly', async () => {
    const history = await call('agent:getHistory')
    expect(history.success).toBe(false)

    await expect(call('agent:dispose')).resolves.toMatchObject({ success: true })
  })
})

describe('dialog handler', () => {
  it('fails when no window is available', async () => {
    const result = await call('dialog:openDirectory')

    expect(result.success).toBe(false)
    expect(result.error).toContain('No window')
  })
})
