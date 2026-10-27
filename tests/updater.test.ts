import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  fetch: vi.fn(),
  openExternal: vi.fn(async () => {}),
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.2.0',
    getName: () => 'Pi Workbench',
    getPath: () => '/tmp/user-data',
    isPackaged: true,
    whenReady: async () => {},
    relaunch: () => {},
    quit: () => {},
    once: () => {},
  },
  net: { fetch: electronMock.fetch },
  shell: { openExternal: electronMock.openExternal },
}))

import {
  cleanupCompletedUpdateCache,
  pruneUpdateCache,
  resolveUpdaterCacheBase,
  UpdateController,
  classifyUpdateError,
  isNewerVersion,
  normalizeReleaseNotes,
  UPDATE_ERROR,
} from '../electron/updater'
import type { UpdateControllerOptions, UpdateState } from '../electron/updater'

type Listener = (...args: any[]) => void

interface FakeResult {
  isUpdateAvailable: boolean
  updateInfo?: { version: string; releaseNotes?: unknown }
}

function createFakeUpdater(result: FakeResult) {
  const listeners = new Map<string, Listener[]>()
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    on: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    checkForUpdates: async () => result,
    downloadUpdate: async () => {
      emit('download-progress', { percent: 42 })
      emit('download-progress', { percent: 100 })
      emit('update-downloaded', { version: result.updateInfo?.version })
    },
    quitAndInstall: vi.fn(),
    emit,
  }
  return updater
}

function createController(
  overrides: Partial<UpdateControllerOptions> = {},
  result: FakeResult = { isUpdateAvailable: false, updateInfo: { version: '0.2.0' } }
) {
  const states: UpdateState[] = []
  const fake = createFakeUpdater(result)
  const controller = new UpdateController({
    appDir: '/tmp/app',
    emit: (state) => states.push(state),
    currentVersion: '0.2.0',
    platform: 'win32',
    supported: true,
    resourcesPath: '/tmp/resources',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    publishTarget: {
      owner: 'T-Chen-CN',
      repo: 'pi-workbench',
      updaterCacheDirName: 'pi-workbench-updater',
    },
    createUpdater: () => fake,
    ...overrides,
  })
  return { controller, states, fake }
}

describe('update helpers', () => {
  it('compares semantic versions', () => {
    expect(isNewerVersion('0.3.0', '0.2.0')).toBe(true)
    expect(isNewerVersion('v0.2.1', '0.2.0')).toBe(true)
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false)
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(false)
    expect(isNewerVersion('not-a-version', '0.2.0')).toBe(false)
  })

  it('normalizes string and array release notes', () => {
    expect(normalizeReleaseNotes('<b>Fixes</b>\n\n- one')).toBe('Fixes\n\n- one')
    expect(
      normalizeReleaseNotes([
        { version: '0.3.0', note: '<p>New</p>' },
        { version: '0.2.1', note: 'Fix' },
      ])
    ).toBe('0.3.0\nNew\n\n0.2.1\nFix')
  })

  it('classifies common updater failures', () => {
    expect(classifyUpdateError('HttpError: 404 Not Found')).toBe(UPDATE_ERROR.noRelease)
    expect(classifyUpdateError('No published versions on GitHub')).toBe(
      UPDATE_ERROR.noRelease
    )
    expect(classifyUpdateError('getaddrinfo ENOTFOUND api.github.com')).toBe(
      UPDATE_ERROR.network
    )
    expect(classifyUpdateError('API rate limit exceeded')).toBe(UPDATE_ERROR.rateLimit)
    expect(classifyUpdateError('unexpected')).toBe('unexpected')
  })
})

describe('UpdateController', () => {
  beforeEach(() => {
    electronMock.fetch.mockReset()
    electronMock.openExternal.mockClear()
  })

  it('reports unsupported outside a packaged build', async () => {
    const controller = new UpdateController({
      appDir: '/tmp/app',
      emit: () => {},
      supported: false,
      currentVersion: '0.2.0',
      platform: 'win32',
      resourcesPath: '/tmp/resources',
    })

    const result = await controller.check()
    expect(result.success).toBe(false)
    expect(result.error).toBe(UPDATE_ERROR.notPackaged)
    expect(controller.getState().status).toBe('unsupported')
  })

  it('reports not-available when checkForUpdates returns an updateInfo for the current version', async () => {
    // 回归：electron-updater 在“无更新”时同样返回 updateInfo，不能据此判断有新版本
    const { controller } = createController({}, {
      isUpdateAvailable: false,
      updateInfo: { version: '0.2.0' },
    })

    const result = await controller.check()
    expect(result.success).toBe(true)
    expect(controller.getState().status).toBe('not-available')
  })

  it('downloads automatically and only installs after the user asks', async () => {
    const { controller, fake } = createController({}, {
      isUpdateAvailable: true,
      updateInfo: { version: '0.3.0', releaseNotes: '<b>Fixes</b>' },
    })

    const check = await controller.check()
    expect(check.success).toBe(true)
    expect(controller.getState()).toMatchObject({
      status: 'available',
      version: '0.3.0',
      releaseNotes: 'Fixes',
    })

    // 未下载完成时不允许安装
    expect(controller.install().success).toBe(false)

    await controller.download()
    expect(controller.getState()).toMatchObject({
      status: 'downloaded',
      version: '0.3.0',
      percent: 100,
    })

    expect(controller.install().success).toBe(true)
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('does not re-check while an update is downloaded and waiting to install', async () => {
    const { controller, fake } = createController(
      {},
      { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } }
    )
    await controller.check()
    await controller.download()
    expect(controller.getState().status).toBe('downloaded')

    const checkSpy = vi.fn(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '0.3.0' },
    }))
    ;(fake as unknown as { checkForUpdates: typeof checkSpy }).checkForUpdates = checkSpy

    const result = await controller.check()

    expect(checkSpy).not.toHaveBeenCalled()
    expect(result.state.status).toBe('downloaded')
  })

  it('checks macOS releases through GitHub and never auto-installs', async () => {
    electronMock.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.3.0',
        body: 'Release notes',
        html_url: 'https://github.com/T-Chen-CN/pi-workbench/releases/tag/v0.3.0',
      }),
    })

    const { controller } = createController({
      platform: 'darwin',
      createUpdater: () => {
        throw new Error('electron-updater must not be used on macOS')
      },
    })

    const result = await controller.check()
    expect(result.success).toBe(true)
    expect(controller.getState()).toMatchObject({
      status: 'available',
      version: '0.3.0',
      canAutoInstall: false,
      releaseNotes: 'Release notes',
    })
    const download = await controller.download()
    expect(download).toMatchObject({
      success: false,
      error: UPDATE_ERROR.manualDownload,
    })

    await controller.openDownloadPage()
    expect(electronMock.openExternal).toHaveBeenCalledWith(
      'https://github.com/T-Chen-CN/pi-workbench/releases/tag/v0.3.0'
    )
  })

  it('maps a missing GitHub release to a friendly error code', async () => {
    electronMock.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    })

    const { controller } = createController({ platform: 'darwin' })

    const result = await controller.check()
    expect(result.success).toBe(false)
    expect(result.error).toBe(UPDATE_ERROR.noRelease)
    expect(controller.getState().status).toBe('error')
  })
})

describe('external update cache', () => {
  const tempDirs: string[] = []

  const makeTempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-updater-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses %LOCALAPPDATA% on Windows and the app directory elsewhere', () => {
    expect(
      resolveUpdaterCacheBase({ appDir: '/tmp/app', platform: 'win32', localAppData: '/tmp/local' })
    ).toBe(path.join('/tmp/local', 'Pi-Workbench-Update'))
    expect(resolveUpdaterCacheBase({ appDir: '/tmp/app', platform: 'linux' })).toBe(
      path.join('/tmp/app', 'cache')
    )
  })

  it('pins the install directory on Windows so the installer receives /D=', async () => {
    const { controller, fake } = createController({
      platform: 'win32',
      localAppData: '/tmp/local',
    })

    await controller.check()
    expect((fake as { installDirectory?: string }).installDirectory).toBe('/tmp/app')
  })

  it('does not pin an install directory on other platforms', async () => {
    const { controller, fake } = createController({
      platform: 'linux',
      localAppData: '/tmp/local',
    })

    await controller.check()
    expect((fake as { installDirectory?: string }).installDirectory).toBeUndefined()
  })

  it('keeps the differential base and removes the rest after an install', async () => {
    const local = makeTempDir()
    const appDir = makeTempDir()
    const cacheBase = path.join(local, 'Pi-Workbench-Update')
    const updaterDir = path.join(cacheBase, 'pi-workbench-updater')
    fs.mkdirSync(path.join(updaterDir, 'pending'), { recursive: true })
    fs.writeFileSync(path.join(updaterDir, 'pending', 'Setup.exe'), 'x')
    fs.writeFileSync(path.join(updaterDir, 'installer.exe'), 'installer')
    fs.writeFileSync(path.join(updaterDir, 'current.blockmap'), 'blockmap')
    fs.writeFileSync(`${cacheBase}.flag`, 'installed')

    const cleaned = await cleanupCompletedUpdateCache({
      appDir,
      platform: 'win32',
      localAppData: local,
      retries: 1,
      delayMs: 0,
    })

    expect(cleaned).toBe(true)
    expect(fs.existsSync(path.join(updaterDir, 'pending'))).toBe(false)
    expect(fs.existsSync(path.join(updaterDir, 'installer.exe'))).toBe(true)
    expect(fs.existsSync(path.join(updaterDir, 'current.blockmap'))).toBe(true)
    expect(fs.existsSync(`${cacheBase}.flag`)).toBe(false)
  })

  it('removes the external cache when it holds no differential base', async () => {
    const local = makeTempDir()
    const appDir = makeTempDir()
    const cacheBase = path.join(local, 'Pi-Workbench-Update')
    fs.mkdirSync(path.join(cacheBase, 'pi-workbench-updater', 'pending'), { recursive: true })
    fs.writeFileSync(path.join(cacheBase, 'pi-workbench-updater', 'pending', 'Setup.exe'), 'x')
    fs.writeFileSync(`${cacheBase}.flag`, 'installed')

    const cleaned = await cleanupCompletedUpdateCache({
      appDir,
      platform: 'win32',
      localAppData: local,
      retries: 1,
      delayMs: 0,
    })

    expect(cleaned).toBe(true)
    expect(fs.existsSync(cacheBase)).toBe(false)
    expect(fs.existsSync(`${cacheBase}.flag`)).toBe(false)
  })

  it('leaves the cache alone when no install-completed flag exists', async () => {
    const local = makeTempDir()
    const appDir = makeTempDir()
    const cacheBase = path.join(local, 'Pi-Workbench-Update')
    fs.mkdirSync(path.join(cacheBase, 'pi-workbench-updater'), { recursive: true })
    fs.writeFileSync(path.join(cacheBase, 'pi-workbench-updater', 'pending.zip'), 'x')

    const cleaned = await cleanupCompletedUpdateCache({
      appDir,
      platform: 'win32',
      localAppData: local,
      retries: 1,
      delayMs: 0,
    })

    expect(cleaned).toBe(true)
    expect(fs.existsSync(cacheBase)).toBe(true)
  })

  it('removes a stale flag even when the cache directory is already gone', async () => {
    const local = makeTempDir()
    const appDir = makeTempDir()
    const flag = path.join(local, 'Pi-Workbench-Update.flag')
    fs.writeFileSync(flag, 'installed')

    await cleanupCompletedUpdateCache({
      appDir,
      platform: 'win32',
      localAppData: local,
      retries: 1,
      delayMs: 0,
    })

    expect(fs.existsSync(flag)).toBe(false)
  })

  it('clears the legacy in-app updater cache', async () => {
    const appDir = makeTempDir()
    const legacy = path.join(appDir, 'cache', 'pi-workbench-updater')
    fs.mkdirSync(path.join(legacy, 'pending'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'pending', 'Setup.exe'), 'x')

    await cleanupCompletedUpdateCache({
      appDir,
      platform: 'win32',
      localAppData: makeTempDir(),
      retries: 1,
      delayMs: 0,
    })

    expect(fs.existsSync(legacy)).toBe(false)
  })

  it('keeps the differential base when no update is available', async () => {
    const local = makeTempDir()
    const appDir = makeTempDir()
    const cacheDir = path.join(local, 'Pi-Workbench-Update', 'pi-workbench-updater')
    fs.mkdirSync(path.join(cacheDir, 'pending'), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'pending', 'Setup.exe'), 'x')
    fs.writeFileSync(path.join(cacheDir, 'installer.exe'), 'installer')
    fs.writeFileSync(path.join(cacheDir, 'current.blockmap'), 'blockmap')

    const { controller } = createController(
      { appDir, platform: 'win32', localAppData: local },
      { isUpdateAvailable: false, updateInfo: { version: '0.2.0' } }
    )

    await controller.check()
    expect(fs.existsSync(path.join(cacheDir, 'pending'))).toBe(false)
    expect(fs.existsSync(path.join(cacheDir, 'installer.exe'))).toBe(true)
    expect(fs.existsSync(path.join(cacheDir, 'current.blockmap'))).toBe(true)
  })

  it('removes the stale cache directory when it holds no differential base', async () => {
    const local = makeTempDir()
    const appDir = makeTempDir()
    const cacheDir = path.join(local, 'Pi-Workbench-Update', 'pi-workbench-updater')
    fs.mkdirSync(path.join(cacheDir, 'pending'), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'pending', 'Setup.exe'), 'x')

    const { controller } = createController(
      { appDir, platform: 'win32', localAppData: local },
      { isUpdateAvailable: false, updateInfo: { version: '0.2.0' } }
    )

    await controller.check()
    expect(fs.existsSync(cacheDir)).toBe(false)
  })

  it('prunes everything but the differential base', () => {
    const local = makeTempDir()
    const cacheBase = path.join(local, 'Pi-Workbench-Update')
    const updaterDir = path.join(cacheBase, 'pi-workbench-updater')
    fs.mkdirSync(path.join(updaterDir, 'pending'), { recursive: true })
    fs.writeFileSync(path.join(updaterDir, 'pending', 'Setup.exe'), 'x')
    fs.writeFileSync(path.join(updaterDir, 'installer.exe'), 'installer')
    fs.writeFileSync(path.join(updaterDir, 'current.blockmap'), 'blockmap')
    fs.writeFileSync(path.join(cacheBase, 'stray.tmp'), 'x')

    pruneUpdateCache(cacheBase, 'pi-workbench-updater')

    expect(fs.readdirSync(cacheBase)).toEqual(['pi-workbench-updater'])
    expect(fs.readdirSync(updaterDir).sort()).toEqual(['current.blockmap', 'installer.exe'])
  })

  it('removes a cache base that has no differential base', () => {
    const local = makeTempDir()
    const cacheBase = path.join(local, 'Pi-Workbench-Update')
    fs.mkdirSync(path.join(cacheBase, 'pi-workbench-updater', 'pending'), { recursive: true })
    fs.writeFileSync(path.join(cacheBase, 'pi-workbench-updater', 'pending', 'Setup.exe'), 'x')

    pruneUpdateCache(cacheBase, 'pi-workbench-updater')

    expect(fs.existsSync(cacheBase)).toBe(false)
  })
})
