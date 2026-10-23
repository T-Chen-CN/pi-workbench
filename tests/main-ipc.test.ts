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
  const state = { appDir: '', pickedPath: '' }
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
    setPath: () => {},
    setAppUserModelId: () => {},
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
    showOpenDialog: async () => ({ canceled: false, filePaths: [mocks.state.pickedPath] }),
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
  appDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-app-')))
  mocks.state.appDir = appDir
  // 真实应用启动时会先创建 config/，这里模拟同样的前置状态
  await fs.mkdir(path.join(appDir, 'config'), { recursive: true })
  await import('../electron/main')
})

afterAll(async () => {
  // Fleet 的 SQLite 连接在主进程模块里保持打开，Windows 上可能暂时无法删除目录
  await fs.rm(appDir, { recursive: true, force: true }).catch(() => undefined)
})

beforeEach(async () => {
  await fs.rm(path.join(appDir, 'config'), { recursive: true, force: true })
  await fs.mkdir(path.join(appDir, 'config'), { recursive: true })
  workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-ipc-')))
  // 模拟用户通过原生目录选择器打开工作区（主进程据此批准工作区根）
  // 主进程会 realpath 规范化路径（macOS /var → /private/var，Windows 8.3 短名），
  // 测试里同样先规范化，避免断言比较两种写法。
  mocks.state.pickedPath = workDir
  await call('dialog:openDirectory')
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await call('workspace:dispose', workDir).catch(() => undefined)
  await fs.rm(workDir, { recursive: true, force: true })
})

describe('filesystem IPC handlers', () => {
  it('writes and reads a file', async () => {
    await call('workspace:init', workDir)
    const target = path.join(workDir, 'a.txt')

    await expect(call('fs:writeFile', target, 'hello')).resolves.toMatchObject({ success: true })
    await expect(call('fs:readFile', target)).resolves.toEqual({ success: true, content: 'hello' })
  })

  it('rejects writes outside the approved workspaces', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-outside-'))
    try {
      const result = await call('fs:writeFile', path.join(outside, 'x.txt'), 'x')
      expect(result.success).toBe(false)
      expect(result.error).toContain('outside')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects reads outside the approved workspaces', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-outside-'))
    try {
      const file = path.join(outside, 'secret.txt')
      await fs.writeFile(file, 'secret')

      await expect(call('fs:readFile', file)).resolves.toMatchObject({ success: false })
      await expect(call('fs:listDirectory', outside)).resolves.toMatchObject({ success: false })
      await expect(call('fs:stat', file)).resolves.toMatchObject({ success: false })
      await expect(call('fs:exists', file)).resolves.toEqual({ success: true, exists: false })
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses to delete or rename a workspace root', async () => {
    const deleteResult = await call('fs:delete', workDir)
    expect(deleteResult.success).toBe(false)
    expect(deleteResult.error).toContain('root')

    const renameResult = await call('fs:rename', workDir, path.join(workDir, 'moved'))
    expect(renameResult.success).toBe(false)
    expect(renameResult.error).toContain('root')

    await expect(fs.stat(workDir)).resolves.toBeTruthy()
  })

  it('rejects terminal, plugin and fleet calls for unapproved workspaces', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-outside-'))
    try {
      await expect(call('terminal:create', outside, 80, 24)).resolves.toMatchObject({
        success: false,
      })
      await expect(call('plugins:list', outside)).resolves.toMatchObject({ success: false })
      await expect(call('fleet:list', outside)).resolves.toMatchObject({ success: false })
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
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
    await call('workspace:init', workDir)
    const source = path.join(workDir, 'old.txt')
    const target = path.join(workDir, 'new.txt')
    await fs.writeFile(source, 'x')

    await expect(call('fs:rename', source, target)).resolves.toMatchObject({ success: true })
    await expect(call('fs:exists', source)).resolves.toMatchObject({ exists: false })
    await expect(call('fs:exists', target)).resolves.toMatchObject({ exists: true })

    await expect(call('fs:delete', target)).resolves.toMatchObject({ success: true })
    await expect(call('fs:exists', target)).resolves.toMatchObject({ exists: false })
  })

  it('saves and lists crash-recovery drafts only inside the workspace', async () => {
    const file = path.join(workDir, 'draft.ts')
    await fs.writeFile(file, 'on disk', 'utf-8')

    await expect(call('draft:save', workDir, file, 'unsaved')).resolves.toMatchObject({
      success: true,
    })
    const list = await call('draft:list', workDir)
    expect(list.drafts).toMatchObject([{ path: file, content: 'unsaved' }])

    const outside = path.join(workDir, '..', 'outside.ts')
    await expect(call('draft:save', workDir, outside, 'x')).resolves.toMatchObject({
      success: false,
    })

    await expect(call('draft:clear', workDir)).resolves.toMatchObject({ success: true })
    expect((await call('draft:list', workDir)).drafts).toEqual([])
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
      language: 'zh',
      theme: 'light',
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

  it('recovers settings from the backup when settings.json is corrupted', async () => {
    const settingsPath = path.join(appDir, 'config', 'settings.json')
    await fs.writeFile(settingsPath, '{ truncated', 'utf-8')
    await fs.writeFile(
      `${settingsPath}.bak`,
      JSON.stringify({ language: 'en', theme: 'dark' }),
      'utf-8'
    )

    const result = await call('app:getSettings')
    expect(result.success).toBe(true)
    expect(result.settings).toMatchObject({
      language: 'en',
      theme: 'dark',
      autoSave: true,
    })
  })

  it('falls back to defaults when settings.json is corrupted and has no backup', async () => {
    await fs.writeFile(path.join(appDir, 'config', 'settings.json'), '{ truncated', 'utf-8')

    const result = await call('app:getSettings')
    expect(result.success).toBe(true)
    expect(result.settings).toMatchObject({ language: 'zh', theme: 'light' })
  })

  it('moves recent workspaces to the front, deduplicates and caps at 10', async () => {
    const recentRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-recent-'))
    try {
      for (let i = 0; i < 11; i++) {
        const dir = path.join(recentRoot, `ws-${i}`)
        await fs.mkdir(dir)
        mocks.state.pickedPath = dir
        await call('dialog:openDirectory')
        await call('app:addRecentWorkspace', dir)
      }

      let workspaces = (await call('app:getRecentWorkspaces')).workspaces as string[]
      expect(workspaces).toHaveLength(10)
      expect(workspaces[0]).toBe(path.join(recentRoot, 'ws-10'))
      expect(workspaces).not.toContain(path.join(recentRoot, 'ws-0'))

      const again = path.join(recentRoot, 'ws-5')
      workspaces = (await call('app:addRecentWorkspace', again)).workspaces as string[]
      expect(workspaces[0]).toBe(again)
      expect(workspaces.filter((w) => w === again)).toHaveLength(1)
    } finally {
      await fs.rm(recentRoot, { recursive: true, force: true })
    }
  })
})

describe('workspace lifecycle handlers', () => {
  it('rejects a workspace path the user never approved', async () => {
    const untrusted = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-untrusted-'))
    try {
      const result = await call('workspace:init', untrusted)
      expect(result.success).toBe(false)
      expect(result.error).toContain('not approved')
    } finally {
      await fs.rm(untrusted, { recursive: true, force: true })
    }
  })

  it('initializes the .pi-workbench directory with a default config', async () => {
    await expect(call('workspace:init', workDir)).resolves.toMatchObject({ success: true })

    await expect(fs.stat(path.join(workDir, '.pi-workbench', 'plugins'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(workDir, '.pi-workbench', 'sessions'))).resolves.toBeTruthy()

    const configPath = path.join(workDir, '.pi-workbench', 'config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'))
    expect(config).toEqual({
      version: '1.0',
      enabledPlugins: [],
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

  it('saves workspace config while preserving plugin-owned fields', async () => {
    await call('workspace:init', workDir)
    const config = { version: '1.1', enabledPlugins: ['git'], notes: 'custom' }
    const expected = {
      version: '1.1',
      // 插件字段由 PluginManager 独占，保存普通配置时以磁盘上的值为准
      enabledPlugins: [],
      notes: 'custom',
    }

    await expect(call('workspace:saveConfig', workDir, config)).resolves.toMatchObject({
      success: true,
    })
    await expect(call('workspace:getConfig', workDir)).resolves.toEqual({
      success: true,
      config: expected,
    })
  })
})

describe('pending message handlers', () => {
  it('persists pending messages with sanitized values', async () => {
    const stored = {
      'session-1': [
        { id: 'p1', text: 'next turn', behavior: 'queue' },
        { id: 'p2', text: 'inject now', behavior: 'invalid' },
        { id: 'p3', text: '   ', behavior: 'queue' },
      ],
      '': [{ id: 'p4', text: 'no session', behavior: 'queue' }],
    }

    await expect(call('chat:pending:set', workDir, stored)).resolves.toMatchObject({
      success: true,
    })

    await expect(call('chat:pending:get', workDir)).resolves.toEqual({
      success: true,
      sessions: {
        'session-1': [
          { id: 'p1', text: 'next turn', behavior: 'queue' },
          { id: 'p2', text: 'inject now', behavior: 'queue' },
        ],
      },
    })

    const file = path.join(workDir, '.pi-workbench', 'pending-messages.json')
    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({
      sessions: {
        'session-1': [
          { id: 'p1', text: 'next turn', behavior: 'queue' },
          { id: 'p2', text: 'inject now', behavior: 'queue' },
        ],
      },
    })
  })

  it('rejects untrusted workspaces for pending messages', async () => {
    const untrusted = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-pending-'))
    try {
      await expect(call('chat:pending:get', untrusted)).resolves.toMatchObject({
        success: false,
      })
      await expect(call('chat:pending:set', untrusted, {})).resolves.toMatchObject({
        success: false,
      })
    } finally {
      await fs.rm(untrusted, { recursive: true, force: true })
    }
  })
})

describe('API configuration handlers', () => {
  it('encrypts the API key on disk and decrypts it on read', async () => {
    const config = {
      provider: 'custom',
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
      provider: 'custom',
      apiUrl: '',
      availableModels: [],
      selectedModel: '',
    })
  })

  it('reads legacy plaintext API keys', async () => {
    await fs.writeFile(
      path.join(appDir, 'config', 'api-config.json'),
      JSON.stringify({ provider: 'custom', apiKey: 'legacy-key' }),
      'utf-8'
    )

    const result = await call('apiConfig:get')
    expect((result.config as Record<string, unknown>).apiKey).toBe('legacy-key')
  })

  it('clears legacy provider configs and keeps a backup', async () => {
    const legacy = {
      provider: 'anthropic',
      apiUrl: 'https://api.anthropic.com/v1',
      apiKey: 'enc:whatever',
      availableModels: ['claude-model'],
      selectedModel: 'claude-model',
    }
    await fs.writeFile(
      path.join(appDir, 'config', 'api-config.json'),
      JSON.stringify(legacy),
      'utf-8'
    )

    const result = await call('apiConfig:get')

    expect(result.config).toMatchObject({
      provider: 'custom',
      apiUrl: '',
      apiKey: '',
      availableModels: [],
      selectedModel: '',
    })
    await expect(
      fs.readFile(path.join(appDir, 'config', 'api-config.legacy.json'), 'utf-8')
    ).resolves.toContain('anthropic')
    await expect(fs.access(path.join(appDir, 'config', 'api-config.json'))).rejects.toThrow()
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
  it('returns the selected directory and approves it as a workspace', async () => {
    const result = await call('dialog:openDirectory')

    expect(result.success).toBe(true)
    expect(result.canceled).toBe(false)
    expect(typeof result.path).toBe('string')
  })
})
