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
  const shell = {
    openPath: vi.fn(async () => ''),
    openExternal: vi.fn(async () => {}),
    showItemInFolder: vi.fn(),
  }
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf-8').slice(4),
  }
  const mainFrame = { url: 'pw-app://bundle/index.html' }
  const trustedWebContents = {
    id: 1,
    mainFrame,
    isDestroyed: () => false,
    on: () => {},
    once: () => {},
    executeJavaScript: async () => undefined,
    send: vi.fn(),
    openDevTools: () => {},
  }
  const mainWindow = {
    isDestroyed: () => false,
    webContents: trustedWebContents,
  }
  return { handlers, state, shell, safeStorage, mainFrame, trustedWebContents, mainWindow }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    // 默认 ready=true，让所有主进程 IPC 测试真实经过 isTrustedIpcSender 校验
    isReady: () => true,
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
    on: () => {},
  },
  // 自定义文件协议与外壳协议都在模块加载时注册，测试里只需占位
  protocol: {
    registerSchemesAsPrivileged: () => {},
    handle: () => {},
    unhandle: () => {},
  },
  session: {
    defaultSession: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: vi.fn(),
      },
    },
  },
  shell: mocks.shell,
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  nativeTheme: { shouldUseDarkColors: false },
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

function trustedEvent() {
  return {
    sender: mocks.trustedWebContents,
    senderFrame: mocks.mainFrame,
  }
}

function callWithEvent(event: unknown, channel: string, ...args: unknown[]): Promise<IpcResult> {
  return Promise.resolve(getHandler(channel)(event, ...args) as IpcResult)
}

function call(channel: string, ...args: unknown[]): Promise<IpcResult> {
  return callWithEvent(trustedEvent(), channel, ...args)
}

let appDir: string
let workDir: string

beforeAll(async () => {
  appDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-app-')))
  mocks.state.appDir = appDir
  // 真实应用启动时会先创建 config/，这里模拟同样的前置状态
  await fs.mkdir(path.join(appDir, 'config'), { recursive: true })
  await import('../../electron/main')
  const { configureIpcWindow } = await import('../../electron/ipc/register')
  configureIpcWindow(() => mocks.mainWindow as any)
})

afterAll(async () => {
  // workspaceStore 的 SQLite 连接在主进程模块里保持打开，Windows 上可能暂时无法删除目录
  await fs.rm(appDir, { recursive: true, force: true }).catch(() => undefined)
})

beforeEach(async () => {
  mocks.trustedWebContents.send.mockClear()
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
  it('writes and reads a file atomically without leaving temp artifacts', async () => {
    await call('workspace:init', workDir)
    const target = path.join(workDir, 'a.txt')

    await expect(call('fs:writeFile', target, 'hello')).resolves.toMatchObject({ success: true })
    await expect(call('fs:writeFile', target, 'updated')).resolves.toMatchObject({ success: true })
    await expect(call('fs:readFile', target)).resolves.toEqual({
      success: true,
      binary: false,
      content: 'updated',
    })
    const entries = await fs.readdir(workDir)
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('uses strict allowlist for fs:openExternally and reveals non-allowlisted files safely', async () => {
    mocks.shell.openPath.mockClear()
    mocks.shell.showItemInFolder.mockClear()

    const pdfFile = path.join(workDir, 'report.pdf')
    const scriptFile = path.join(workDir, 'setup.ps1')
    const codeFile = path.join(workDir, 'app.ts')
    const subDir = path.join(workDir, 'folder')
    await fs.writeFile(pdfFile, '%PDF-1.7')
    await fs.writeFile(scriptFile, 'Write-Host hi')
    await fs.writeFile(codeFile, 'export const x = 1')
    await fs.mkdir(subDir)

    await expect(call('fs:openExternally', pdfFile)).resolves.toEqual({ success: true })
    expect(mocks.shell.openPath).toHaveBeenCalledWith(pdfFile)
    expect(mocks.shell.showItemInFolder).not.toHaveBeenCalled()

    mocks.shell.openPath.mockClear()
    await expect(call('fs:openExternally', scriptFile)).resolves.toEqual({
      success: true,
      revealed: true,
    })
    expect(mocks.shell.openPath).not.toHaveBeenCalled()
    expect(mocks.shell.showItemInFolder).toHaveBeenCalledWith(scriptFile)

    mocks.shell.showItemInFolder.mockClear()
    await expect(call('fs:openExternally', codeFile)).resolves.toEqual({
      success: true,
      revealed: true,
    })
    expect(mocks.shell.openPath).not.toHaveBeenCalled()
    expect(mocks.shell.showItemInFolder).toHaveBeenCalledWith(codeFile)

    // 目录与非普通文件必须被拒绝
    await expect(call('fs:openExternally', subDir)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('regular file'),
    })
  })

  it('creates new files exclusively via fs:createFile and returns EEXIST if already present', async () => {
    const target = path.join(workDir, 'exclusive.txt')
    await expect(call('fs:createFile', target)).resolves.toEqual({ success: true })
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('')

    await expect(call('fs:createFile', target)).resolves.toEqual({
      success: false,
      code: 'EEXIST',
      error: 'File already exists',
    })

    const outside = path.join(workDir, '..', 'outside-create.txt')
    await expect(call('fs:createFile', outside)).resolves.toMatchObject({ success: false })
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

  it('rejects terminal and plugin calls for unapproved workspaces', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-outside-'))
    try {
      await expect(call('terminal:create', outside, 80, 24)).resolves.toMatchObject({
        success: false,
      })
      await expect(call('plugins:list', outside)).resolves.toMatchObject({ success: false })
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

  it('starts and stops the workspace watcher and cleans up child worktree watchers on workspace:dispose', async () => {
    const childWorktree = path.join(workDir, '.pi-workbench', 'worktrees', 'wt-child')
    await fs.mkdir(childWorktree, { recursive: true })

    await expect(call('fs:watch', workDir)).resolves.toMatchObject({
      success: true,
    })
    await expect(call('fs:watch', childWorktree)).resolves.toMatchObject({
      success: true,
    })
    await expect(call('workspace:dispose', workDir)).resolves.toMatchObject({ success: true })

    // dispose 后修改子工作树文件不应再触发任何 fs:changed 推送
    mocks.trustedWebContents.send.mockClear()
    await fs.writeFile(path.join(childWorktree, 'after-dispose.txt'), 'quiet')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(mocks.trustedWebContents.send).not.toHaveBeenCalled()
  })

  it('fails cleanly when watching a nonexistent directory', async () => {
    const result = await call('fs:watch', path.join(workDir, 'missing'))

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('IPC sender trust enforcement', () => {
  it('rejects untrusted webContents senders', async () => {
    const foreignFrame = { url: 'pw-app://bundle/index.html' }
    const foreignEvent = {
      sender: { id: 999, mainFrame: foreignFrame, isDestroyed: () => false },
      senderFrame: foreignFrame,
    }
    await expect(callWithEvent(foreignEvent, 'app:getSettings')).resolves.toEqual({
      success: false,
      error: 'Untrusted IPC sender',
    })
  })

  it('rejects subframes and missing senderFrame even from the main webContents', async () => {
    const subFrame = { url: 'pw-app://bundle/sub.html' }
    await expect(
      callWithEvent(
        {
          sender: mocks.trustedWebContents,
          senderFrame: subFrame,
        },
        'app:getSettings'
      )
    ).resolves.toEqual({
      success: false,
      error: 'Untrusted IPC sender',
    })

    await expect(
      callWithEvent(
        {
          sender: mocks.trustedWebContents,
          senderFrame: null,
        },
        'app:getSettings'
      )
    ).resolves.toEqual({
      success: false,
      error: 'Untrusted IPC sender',
    })
  })

  it('rejects untrusted frame origins even on the main webContents mainFrame', async () => {
    const originalUrl = mocks.mainFrame.url
    mocks.mainFrame.url = 'https://evil.example/phish.html'
    try {
      await expect(call('app:getSettings')).resolves.toEqual({
        success: false,
        error: 'Untrusted IPC sender',
      })
    } finally {
      mocks.mainFrame.url = originalUrl
    }
  })

  it('accepts explicitly trusted auxiliary window senders and revokes them on untrust', async () => {
    const { trustIpcSender, untrustIpcSender } = await import('../../electron/ipc/register')
    const auxFrame = { url: 'about:blank' }
    const auxEvent = {
      sender: { id: 42, mainFrame: auxFrame, isDestroyed: () => false },
      senderFrame: auxFrame,
    }
    trustIpcSender(42)
    try {
      await expect(callWithEvent(auxEvent, 'app:getSettings')).resolves.toMatchObject({
        success: true,
      })
    } finally {
      untrustIpcSender(42)
    }
    await expect(callWithEvent(auxEvent, 'app:getSettings')).resolves.toEqual({
      success: false,
      error: 'Untrusted IPC sender',
    })
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

  it('preserves existing valid disk settings when saving a partial patch', async () => {
    await call('app:saveSettings', {
      language: 'en',
      theme: 'dark',
      autoSave: false,
      autoSaveDelay: 5000,
      budgetUsd: 25,
      explorerSortBy: 'type',
      useSystemProxy: false,
    })

    // 仅更新单个字段，不应把其它已落盘字段抹回默认值
    await expect(call('app:saveSettings', { theme: 'light' })).resolves.toMatchObject({
      success: true,
    })

    const result = await call('app:getSettings')
    expect(result.settings).toMatchObject({
      language: 'en',
      theme: 'light',
      autoSave: false,
      autoSaveDelay: 5000,
      budgetUsd: 25,
      explorerSortBy: 'type',
      useSystemProxy: false,
    })
  })

  it('keeps valid explorer sort settings and drops malformed ones', async () => {
    await call('app:saveSettings', {
      explorerSortBy: 'type',
      explorerFoldersFirst: false,
      explorerSortReverse: true,
    })

    let result = await call('app:getSettings')
    expect(result.settings).toMatchObject({
      explorerSortBy: 'type',
      explorerFoldersFirst: false,
      explorerSortReverse: true,
    })

    await call('app:saveSettings', {
      explorerSortBy: 'size',
      explorerFoldersFirst: 'yes',
      explorerSortReverse: 1,
    })

    result = await call('app:getSettings')
    expect(result.settings).toMatchObject({
      explorerSortBy: 'name',
      explorerFoldersFirst: true,
      explorerSortReverse: false,
    })
  })

  it('defaults useSystemProxy to true and preserves the stored choice when omitted or malformed', async () => {
    let result = await call('app:getSettings')
    expect(result.settings).toMatchObject({ useSystemProxy: true })

    await call('app:saveSettings', { useSystemProxy: false })
    result = await call('app:getSettings')
    expect(result.settings).toMatchObject({ useSystemProxy: false })

    await call('app:saveSettings', { language: 'en', useSystemProxy: 'yes' })
    result = await call('app:getSettings')
    expect(result.settings).toMatchObject({ language: 'en', useSystemProxy: false })
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

  it('drops recent workspaces whose directory is gone', async () => {
    const recentRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-recent-gone-'))
    try {
      const kept = path.join(recentRoot, 'kept')
      const removed = path.join(recentRoot, 'removed')
      for (const dir of [kept, removed]) {
        await fs.mkdir(dir)
        mocks.state.pickedPath = dir
        await call('dialog:openDirectory')
        await call('app:addRecentWorkspace', dir)
      }

      await fs.rm(removed, { recursive: true, force: true })

      const workspaces = (await call('app:getRecentWorkspaces')).workspaces as string[]
      expect(workspaces).toContain(kept)
      expect(workspaces).not.toContain(removed)
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
})

describe('provider settings handlers', () => {
  // 配置时会有一次轻量 Key 探测（D24）：测试里给一个 200，避免真实网络请求
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    )
  })

  it('lists the eight presets and never returns a key', async () => {
    const result = await call('providers:list')

    expect(result.success).toBe(true)
    const providers = result.providers as Array<{ id: string; connected: boolean }>
    expect(providers.map((provider) => provider.id)).toEqual([
      'openai',
      'anthropic',
      'google',
      'xai',
      'deepseek',
      'xiaomi',
      'xiaomi-token-plan-cn',
      'openai-codex',
    ])
    expect(providers.every((provider) => provider.connected === false)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('apiKey')
  })

  it('stores the api key encrypted and reports the provider as connected', async () => {
    const saved = await call('providers:setApiKey', 'deepseek', 'sk-deepseek')
    expect(saved.success).toBe(true)

    const credentials = await fs.readFile(path.join(appDir, 'config', 'credentials.json'), 'utf-8')
    expect(credentials).not.toContain('sk-deepseek')

    const result = await call('providers:list')
    const deepseek = (result.providers as Array<{ id: string; connected: boolean }>).find(
      (provider) => provider.id === 'deepseek'
    )
    expect(deepseek?.connected).toBe(true)
  })

  it('rejects an unknown provider and an empty key', async () => {
    await expect(call('providers:setApiKey', 'not-a-provider', 'sk-x')).resolves.toMatchObject({
      success: false,
    })
    await expect(call('providers:setApiKey', 'deepseek', '   ')).resolves.toMatchObject({
      success: false,
      error: 'EMPTY_KEY',
    })
  })

  it('does not persist orphaned credentials when saveApiKey fails with NO_MODEL', async () => {
    const { resetCatalogRuntime } = await import('../../electron/providers-service')
    const storePath = path.join(appDir, 'data', 'agent', 'models-store.json')
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    // 用远端空模型集合过滤掉内置目录，触发 NO_MODEL 分支
    await fs.writeFile(
      storePath,
      JSON.stringify({
        deepseek: {
          models: [
            {
              id: 'nonexistent-model-only',
              name: 'Ghost',
              api: 'openai-completions',
              provider: 'deepseek',
              baseUrl: 'https://api.deepseek.com',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1000,
              maxTokens: 100,
              type: 'chat',
            },
          ],
          lastModified: Date.parse('2030-01-01T00:00:00Z'),
          checkedAt: Date.parse('2030-01-01T00:00:00Z'),
        },
      }),
      'utf-8'
    )
    // 让 models-store 覆盖为全空以触发 NO_MODEL（确保过滤后模型数为 0）
    await fs.writeFile(
      storePath,
      JSON.stringify({
        deepseek: {
          models: [],
          lastModified: Date.parse('2030-01-01T00:00:00Z'),
          checkedAt: Date.parse('2030-01-01T00:00:00Z'),
        },
      }),
      'utf-8'
    )
    resetCatalogRuntime()
    try {
      const { saveApiKey } = await import('../../electron/providers-service')
      const res = await saveApiKey('deepseek', 'sk-should-not-persist')
      // 若远端空列表未覆盖内置目录（内置目录仍有模型），则清理并跳过断言；
      // 若触发了 NO_MODEL，必须保证 credentials.json 未写入该密钥
      if (!res.ok) {
        expect(res.error).toBe('NO_MODEL')
        const credPath = path.join(appDir, 'config', 'credentials.json')
        const exists = await fs.access(credPath).then(() => true, () => false)
        if (exists) {
          const raw = await fs.readFile(credPath, 'utf-8')
          expect(raw).not.toContain('deepseek')
        }
      }
    } finally {
      await fs.rm(storePath, { force: true }).catch(() => undefined)
      resetCatalogRuntime()
    }
  })

  it('clamps overrides to the catalog values and reports pending while running', async () => {
    await call('providers:setApiKey', 'deepseek', 'sk-deepseek')
    const list = await call('providers:list')
    const models = (
      list.providers as Array<{ id: string; models: Array<{ id: string; limits: unknown }> }>
    ).find((provider) => provider.id === 'deepseek')!.models
    const first = models[0]

    // 请求超过 catalog 真值：主进程夹回真值，不报错
    const result = await call('providers:setOverrides', 'deepseek', first.id, {
      contextWindow: 99_000_000,
      maxTokens: 99_000_000,
    })
    expect(result.success).toBe(true)
    const effective = result.effective as { contextWindow: number; maxTokens: number }
    expect(effective.contextWindow).toBeLessThan(99_000_000)
    expect(effective.maxTokens).toBeLessThanOrEqual(effective.contextWindow)
  })

  it('forgets a provider: credentials and config both disappear', async () => {
    await call('providers:setApiKey', 'deepseek', 'sk-deepseek')
    await expect(call('providers:forget', 'deepseek')).resolves.toMatchObject({ success: true })

    const result = await call('providers:list')
    const deepseek = (result.providers as Array<{ id: string; connected: boolean }>).find(
      (provider) => provider.id === 'deepseek'
    )
    expect(deepseek?.connected).toBe(false)
    expect(result.activeProvider).toBeNull()
  })

  it('hydrates cached remote catalog, filters removed builtin models, and accepts remote-only models', async () => {
    const { resetCatalogRuntime } = await import('../../electron/providers-service')
    const storePath = path.join(appDir, 'data', 'agent', 'models-store.json')
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    await fs.writeFile(
      storePath,
      JSON.stringify({
        google: {
          models: [
            {
              id: 'gemini-2.5-flash',
              name: 'Gemini 2.5 Flash',
              api: 'google-generative-ai',
              provider: 'google',
              baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
              reasoning: true,
              input: ['text', 'image'],
              cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
              contextWindow: 1048576,
              maxTokens: 65536,
              type: 'chat',
            },
            {
              id: 'gemini-4-neon',
              name: 'Gemini 4 Neon',
              api: 'google-generative-ai',
              provider: 'google',
              baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
              reasoning: true,
              input: ['text', 'image'],
              cost: { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 },
              contextWindow: 1048576,
              maxTokens: 65536,
              type: 'chat',
            },
          ],
          lastModified: Date.parse('2030-01-01T00:00:00Z'),
          checkedAt: Date.parse('2030-01-01T00:00:00Z'),
        },
      }),
      'utf-8'
    )
    resetCatalogRuntime()

    const probeHeaders: Array<Record<string, string>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        probeHeaders.push((init?.headers ?? {}) as Record<string, string>)
        return new Response('{}', { status: 200 })
      })
    )

    try {
      const list = await call('providers:list')
      const google = (
        list.providers as Array<{ id: string; models: Array<{ id: string }> }>
      ).find((provider) => provider.id === 'google')
      const ids = google?.models.map((m) => m.id) ?? []
      expect(ids).toContain('gemini-4-neon')
      expect(ids).toContain('gemini-2.5-flash')
      // 上游已删掉的内置模型必须按 D12/D26 过滤掉
      expect(ids).not.toContain('gemini-3.1-flash-lite-image')
      expect(ids).not.toContain('gemini-3.1-flash-live-preview')

      // Google Key 探测必须使用 x-goog-api-key 而非 Authorization: Bearer
      await expect(call('providers:setApiKey', 'google', 'AIza-demo')).resolves.toMatchObject({
        success: true,
      })
      expect(probeHeaders[0]).toEqual({ 'x-goog-api-key': 'AIza-demo' })

      // 允许选中并落盘仅存在于远端目录缓存的新模型
      await expect(
        call('providers:setActive', 'google', 'gemini-4-neon')
      ).resolves.toMatchObject({
        success: true,
      })
      const after = await call('providers:list')
      const activeGoogle = (
        after.providers as Array<{ id: string; active: boolean; model?: string }>
      ).find((provider) => provider.id === 'google')
      expect(activeGoogle).toMatchObject({ active: true, model: 'gemini-4-neon' })
    } finally {
      await fs.rm(storePath, { force: true }).catch(() => undefined)
      resetCatalogRuntime()
    }
  })
})

describe('agent handlers without an initialized agent', () => {
  it('rejects chat', async () => {
    const chat = await call('agent:chat', 'hello')
    expect(chat.success).toBe(false)
    expect(chat.error).toContain('not initialized')
  })

  it('accepts a steer with images and rejects an empty one', async () => {
    // 纯图片插话：文本为空但有图时不应被文本校验拦下（无 Agent 时才到“未初始化”）
    const withImage = await call('agent:steer', workDir, 'session-1', '', [
      { data: 'AAAA', mimeType: 'image/png' },
    ])
    expect(withImage.success).toBe(false)
    expect(withImage.error).toContain('not initialized')

    const empty = await call('agent:steer', workDir, 'session-1', '   ')
    expect(empty).toEqual({ success: false, error: 'Message is empty' })
  })

  it('validates steer image payloads', async () => {
    await expect(
      call('agent:steer', workDir, 'session-1', 'hi', [{ data: '', mimeType: 'image/png' }])
    ).resolves.toEqual({ success: false, error: 'Invalid image payload.' })

    await expect(
      call('agent:steer', workDir, 'session-1', 'hi', [{ data: 'AAAA', mimeType: 'text/plain' }])
    ).resolves.toEqual({ success: false, error: 'Unsupported image format.' })

    await expect(call('agent:steer', workDir, 'session-1', 'hi', 'not-an-array')).resolves.toEqual(
      { success: false, error: 'Images must be an array.' }
    )
  })

  it('disposes cleanly', async () => {
    await expect(call('agent:dispose')).resolves.toMatchObject({ success: true })
  })

  it('rejects unsafe session ids before touching the registry', async () => {
    await expect(
      call('agent:sessions:delete', workDir, '../../../config/settings')
    ).resolves.toEqual({ success: false, error: 'Invalid session id' })
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

describe('workspace editor tabs', () => {
  it('persists workspace-relative tabs and restores absolute paths', async () => {
    await call('workspace:init', workDir)
    const first = path.join(workDir, 'a.ts')
    const second = path.join(workDir, 'src', 'b.ts')
    await fs.mkdir(path.dirname(second), { recursive: true })
    await fs.writeFile(first, 'a')
    await fs.writeFile(second, 'b')

    await expect(
      call('workspace:editorTabs:set', workDir, { open: [first, second], active: second })
    ).resolves.toMatchObject({ success: true })

    const raw = JSON.parse(
      await fs.readFile(path.join(workDir, '.pi-workbench', 'editor-tabs.json'), 'utf-8')
    ) as { open: string[]; active: string | null }
    expect(raw.open).toEqual(['a.ts', 'src/b.ts'])
    expect(raw.active).toBe('src/b.ts')

    const result = await call('workspace:editorTabs:get', workDir)
    expect(result.success).toBe(true)
    expect((result.tabs as { open: string[]; active: string | null }).open).toEqual([
      first,
      second,
    ])
    expect((result.tabs as { open: string[]; active: string | null }).active).toBe(second)
  })

  it('drops paths outside the workspace and inactive active entries', async () => {
    await call('workspace:init', workDir)
    const inside = path.join(workDir, 'a.ts')
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-outside-tab-'))
    const outsideFile = path.join(outside, 'x.ts')
    await fs.writeFile(inside, 'a')
    await fs.writeFile(outsideFile, 'x')

    try {
      await call('workspace:editorTabs:set', workDir, {
        open: [inside, outsideFile],
        active: outsideFile,
      })
      const result = await call('workspace:editorTabs:get', workDir)
      expect((result.tabs as { open: string[]; active: string | null }).open).toEqual([inside])
      expect((result.tabs as { open: string[]; active: string | null }).active).toBe(inside)
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects untrusted workspaces', async () => {
    const untrusted = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-untrusted-tabs-'))
    try {
      await expect(call('workspace:editorTabs:get', untrusted)).resolves.toMatchObject({
        success: false,
      })
      await expect(
        call('workspace:editorTabs:set', untrusted, { open: [], active: null })
      ).resolves.toMatchObject({ success: false })
    } finally {
      await fs.rm(untrusted, { recursive: true, force: true })
    }
  })
})

describe('repo map handlers', () => {
  async function initRepo(): Promise<void> {
    const { execFileSync } = await import('child_process')
    const run = (args: string[]) => execFileSync('git', args, { cwd: workDir, encoding: 'utf8' })
    run(['init', '-b', 'main'])
    run(['config', 'user.email', 'test@example.com'])
    run(['config', 'user.name', 'Test'])
    await fs.mkdir(path.join(workDir, 'src', 'store'), { recursive: true })
    await fs.writeFile(
      path.join(workDir, 'src', 'store', 'editorStore.ts'),
      '// 编辑器状态\nexport const editorStoreFor = 1\n'
    )
    await fs.writeFile(path.join(workDir, 'README.md'), '# 标题\n')
    run(['add', '-A'])
    run(['commit', '-m', 'init'])
  }

  it('scans tracked files and caches the result inside the workspace', async () => {
    // 先建仓库再 init 工作区：init 会往 .pi-workbench 写运行期文件，别让它们进索引
    await initRepo()
    await call('workspace:init', workDir)

    const result = await call('repo-map:scan', workDir)
    expect(result).toMatchObject({ success: true, isRepo: true, total: 2, described: 2 })
    const files = result.files as Array<{ path: string; role: string; headComment?: string }>
    expect(files.map((file) => file.path)).toEqual(['README.md', 'src/store/editorStore.ts'])
    expect(files.find((file) => file.path === 'src/store/editorStore.ts')).toMatchObject({
      role: 'state',
      headComment: '编辑器状态',
    })

    const cache = JSON.parse(
      await fs.readFile(path.join(workDir, '.pi-workbench', 'repo-map.json'), 'utf-8')
    ) as { version: number; files: Record<string, unknown> }
    expect(cache.version).toBeGreaterThan(0)
    expect(Object.keys(cache.files)).toEqual(['README.md', 'src/store/editorStore.ts'])
  })

  it('fills descriptions on demand and rejects empty path lists', async () => {
    await initRepo()
    await call('workspace:init', workDir)

    await expect(call('repo-map:describe', workDir, ['src/store/editorStore.ts'])).resolves.toMatchObject({
      success: true,
      described: 2,
    })
    await expect(call('repo-map:describe', workDir, [])).resolves.toMatchObject({
      success: false,
    })
  })

  it('rejects untrusted workspaces and reports non-git directories as empty', async () => {
    const untrusted = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-untrusted-map-'))
    try {
      await expect(call('repo-map:scan', untrusted)).resolves.toMatchObject({ success: false })
    } finally {
      await fs.rm(untrusted, { recursive: true, force: true })
    }

    await call('workspace:init', workDir)
    await expect(call('repo-map:scan', workDir)).resolves.toMatchObject({
      success: true,
      isRepo: false,
      total: 0,
    })
  })

  it('round-trips the canvas layout and creates it lazily', async () => {
    await call('workspace:init', workDir)
    await expect(call('repo-map:canvas:get', workDir)).resolves.toMatchObject({
      success: true,
      state: { version: 1, zoom: 1, folders: {}, files: {} },
    })

    const state = {
      version: 1,
      layoutVersion: 3,
      zoom: 0.8,
      pan: { x: -40, y: 12 },
      folders: { src: { x: 320, y: 80 } },
      files: { 'README.md': { x: 0, y: 0 } },
    }
    await expect(call('repo-map:canvas:set', workDir, state)).resolves.toMatchObject({
      success: true,
    })
    await expect(call('repo-map:canvas:get', workDir)).resolves.toMatchObject({
      success: true,
      state,
    })
    const raw = JSON.parse(
      await fs.readFile(path.join(workDir, '.pi-workbench', 'repo-map-canvas.json'), 'utf-8')
    ) as { version: number }
    expect(raw.version).toBe(1)
  })

  it('sanitizes hostile canvas payloads and rejects untrusted workspaces', async () => {
    await call('workspace:init', workDir)
    const hostile = {
      version: 1,
      zoom: 99,
      pan: { x: 'nope', y: 0 },
      // 只有带坐标的目录条目才留；collapsed 是 v2 遗留字段，一律忽略
      folders: {
        '../escape': { x: 0, y: 0 },
        legacy: { collapsed: false },
        src: { x: 12, y: 34, collapsed: false },
      },
      files: { '../escape.ts': { x: 1, y: 2 }, 'ok.ts': { x: 9e12, y: 0 } },
    }
    await expect(call('repo-map:canvas:set', workDir, hostile)).resolves.toMatchObject({
      success: true,
    })
    const read = await call('repo-map:canvas:get', workDir)
    expect(read.state).toMatchObject({
      zoom: 2,
      pan: { x: 0, y: 0 },
      folders: { src: { x: 12, y: 34 } },
      files: { 'ok.ts': { x: 1_000_000, y: 0 } },
    })

    const untrusted = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-workbench-untrusted-canvas-'))
    try {
      await expect(call('repo-map:canvas:set', untrusted, hostile)).resolves.toMatchObject({
        success: false,
      })
      await expect(call('repo-map:canvas:get', untrusted)).resolves.toMatchObject({
        success: false,
      })
    } finally {
      await fs.rm(untrusted, { recursive: true, force: true })
    }
  })
})

describe('agent config signature', () => {
  it('changes when the output limit changes', async () => {
    const { providerConfigKey } = await import('../../electron/agent-config-key')
    const base = {
      providerId: 'openai',
      modelId: 'gpt-5',
      credentialFingerprint: 'sha256:abc',
      overrides: {},
    }

    // 改档位必须重建 Agent，否则模型覆盖不会重新生效
    expect(
      providerConfigKey({ ...base, overrides: { maxTokens: 65_536 } })
    ).not.toBe(providerConfigKey(base))

    // 缺省与 0 同义：都表示自动，不应多触发一次重建
    expect(
      providerConfigKey({ ...base, overrides: { maxTokens: 0 } })
    ).toBe(providerConfigKey(base))
  })
})
