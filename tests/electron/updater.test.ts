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
} from '../../electron/updater'
import type { UpdateControllerOptions, UpdateState } from '../../electron/updater'

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

describe('update cache and portable mode (D-01)', () => {
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

  it('unifies updater cache under {dataDir}/cache on all platforms', () => {
    expect(resolveUpdaterCacheBase({ appDir: '/tmp/data', platform: 'win32' })).toBe(
      path.join('/tmp/data', 'cache')
    )
    expect(resolveUpdaterCacheBase({ appDir: '/tmp/data', platform: 'linux' })).toBe(
      path.join('/tmp/data', 'cache')
    )
    expect(resolveUpdaterCacheBase({ appDir: '/tmp/data', platform: 'darwin' })).toBe(
      path.join('/tmp/data', 'cache')
    )
  })

  it('pins installDir (not dataDir) on Windows so NSIS receives /D=<installDir>', async () => {
    const { controller, fake } = createController({
      appDir: '/users/me/appdata/pi-workbench',
      installDir: '/apps/pi-workbench',
      platform: 'win32',
    })

    await controller.check()
    expect((fake as { installDirectory?: string }).installDirectory).toBe('/apps/pi-workbench')
  })

  it('does not pin an install directory on other platforms', async () => {
    const { controller, fake } = createController({
      platform: 'linux',
    })

    await controller.check()
    expect((fake as { installDirectory?: string }).installDirectory).toBeUndefined()
  })

  it('uses GitHub release check and disables auto-install in portable mode on Windows', async () => {
    electronMock.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v0.9.0',
        body: 'Portable update notes',
        html_url: 'https://github.com/T-Chen-CN/pi-workbench/releases/tag/v0.9.0',
      }),
    })

    const { controller } = createController({
      platform: 'win32',
      portable: true,
    })

    expect(controller.getState().canAutoInstall).toBe(false)
    const checkResult = await controller.check()
    expect(checkResult.success).toBe(true)
    expect(controller.getState().status).toBe('available')
    expect(controller.getState().version).toBe('0.9.0')

    expect(await controller.download()).toEqual({
      success: false,
      error: UPDATE_ERROR.manualDownload,
    })
    expect(controller.install()).toEqual({
      success: false,
      error: UPDATE_ERROR.manualDownload,
    })
  })

  it('keeps differential base and sibling drafts/temp when cleaning completed Windows update cache', async () => {
    const appDir = makeTempDir()
    const cacheBase = path.join(appDir, 'cache')
    const updaterDir = path.join(cacheBase, 'pi-workbench-updater')
    const draftsDir = path.join(cacheBase, 'drafts')
    const flagPath = path.join(cacheBase, 'pi-workbench-updater.flag')
    fs.mkdirSync(path.join(updaterDir, 'pending'), { recursive: true })
    fs.mkdirSync(draftsDir, { recursive: true })
    fs.writeFileSync(path.join(updaterDir, 'pending', 'Setup.exe'), 'x')
    fs.writeFileSync(path.join(updaterDir, 'installer.exe'), 'installer')
    fs.writeFileSync(path.join(updaterDir, 'current.blockmap'), 'blockmap')
    fs.writeFileSync(path.join(draftsDir, 'unsaved.json'), '{"keep":true}')
    fs.writeFileSync(flagPath, 'installed')

    const cleaned = await cleanupCompletedUpdateCache({
      appDir,
      platform: 'win32',
      retries: 1,
      delayMs: 0,
    })

    expect(cleaned).toBe(true)
    expect(fs.existsSync(path.join(updaterDir, 'pending'))).toBe(false)
    expect(fs.existsSync(path.join(updaterDir, 'installer.exe'))).toBe(true)
    expect(fs.existsSync(path.join(updaterDir, 'current.blockmap'))).toBe(true)
    expect(fs.existsSync(flagPath)).toBe(false)
    expect(fs.existsSync(path.join(draftsDir, 'unsaved.json'))).toBe(true)
  })

  it('removes updater subdir when it holds no differential base while keeping cacheBase intact', async () => {
    const appDir = makeTempDir()
    const cacheBase = path.join(appDir, 'cache')
    const updaterDir = path.join(cacheBase, 'pi-workbench-updater')
    const flagPath = path.join(cacheBase, 'pi-workbench-updater.flag')
    fs.mkdirSync(path.join(updaterDir, 'pending'), { recursive: true })
    fs.writeFileSync(path.join(updaterDir, 'pending', 'Setup.exe'), 'x')
    fs.writeFileSync(flagPath, 'installed')

    const cleaned = await cleanupCompletedUpdateCache({
      appDir,
      platform: 'win32',
      retries: 1,
      delayMs: 0,
    })

    expect(cleaned).toBe(true)
    expect(fs.existsSync(updaterDir)).toBe(false)
    expect(fs.existsSync(cacheBase)).toBe(true)
    expect(fs.existsSync(flagPath)).toBe(false)
  })

  it('leaves the cache alone when no install-completed flag exists', async () => {
    const appDir = makeTempDir()
    const updaterDir = path.join(appDir, 'cache', 'pi-workbench-updater')
    fs.mkdirSync(updaterDir, { recursive: true })
    fs.writeFileSync(path.join(updaterDir, 'pending.zip'), 'x')

    const cleaned = await cleanupCompletedUpdateCache({
      appDir,
      platform: 'win32',
      retries: 1,
      delayMs: 0,
    })

    expect(cleaned).toBe(true)
    expect(fs.existsSync(updaterDir)).toBe(true)
  })

  it('removes a stale flag even when the updater subdir is already gone', async () => {
    const appDir = makeTempDir()
    const cacheBase = path.join(appDir, 'cache')
    fs.mkdirSync(cacheBase, { recursive: true })
    const flag = path.join(cacheBase, 'pi-workbench-updater.flag')
    fs.writeFileSync(flag, 'installed')

    await cleanupCompletedUpdateCache({
      appDir,
      platform: 'win32',
      retries: 1,
      delayMs: 0,
    })

    expect(fs.existsSync(flag)).toBe(false)
  })

  it('on non-Windows only deletes the updater subdir and preserves drafts/temp cache', async () => {
    const appDir = makeTempDir()
    const cacheBase = path.join(appDir, 'cache')
    const updaterSubdir = path.join(cacheBase, 'pi-workbench-updater')
    const draftsDir = path.join(cacheBase, 'drafts')
    const tempDir = path.join(cacheBase, 'temp')
    const flagPath = path.join(cacheBase, 'pi-workbench-updater.flag')
    fs.mkdirSync(updaterSubdir, { recursive: true })
    fs.mkdirSync(draftsDir, { recursive: true })
    fs.mkdirSync(tempDir, { recursive: true })
    fs.writeFileSync(path.join(updaterSubdir, 'update.zip'), 'zip')
    fs.writeFileSync(path.join(draftsDir, 'unsaved.json'), '{"content":"keep"}')
    fs.writeFileSync(path.join(tempDir, 'img.png'), 'png')
    fs.writeFileSync(flagPath, '1')

    const cleaned = await cleanupCompletedUpdateCache({
      appDir,
      platform: 'darwin',
      retries: 1,
      delayMs: 0,
    })

    expect(cleaned).toBe(true)
    expect(fs.existsSync(flagPath)).toBe(false)
    expect(fs.existsSync(updaterSubdir)).toBe(false)
    expect(fs.existsSync(path.join(draftsDir, 'unsaved.json'))).toBe(true)
    expect(fs.existsSync(path.join(tempDir, 'img.png'))).toBe(true)
  })

  it('keeps the differential base when no update is available', async () => {
    const appDir = makeTempDir()
    const cacheDir = path.join(appDir, 'cache', 'pi-workbench-updater')
    fs.mkdirSync(path.join(cacheDir, 'pending'), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'pending', 'Setup.exe'), 'x')
    fs.writeFileSync(path.join(cacheDir, 'installer.exe'), 'installer')
    fs.writeFileSync(path.join(cacheDir, 'current.blockmap'), 'blockmap')

    const { controller } = createController(
      { appDir, platform: 'win32' },
      { isUpdateAvailable: false, updateInfo: { version: '0.2.0' } }
    )

    await controller.check()
    expect(fs.existsSync(path.join(cacheDir, 'pending'))).toBe(false)
    expect(fs.existsSync(path.join(cacheDir, 'installer.exe'))).toBe(true)
    expect(fs.existsSync(path.join(cacheDir, 'current.blockmap'))).toBe(true)
  })

  it('removes the stale updater subdir when it holds no differential base', async () => {
    const appDir = makeTempDir()
    const cacheDir = path.join(appDir, 'cache', 'pi-workbench-updater')
    fs.mkdirSync(path.join(cacheDir, 'pending'), { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'pending', 'Setup.exe'), 'x')

    const { controller } = createController(
      { appDir, platform: 'win32' },
      { isUpdateAvailable: false, updateInfo: { version: '0.2.0' } }
    )

    await controller.check()
    expect(fs.existsSync(cacheDir)).toBe(false)
  })

  it('prunes everything in updater subdir except the differential base without touching sibling cache folders', () => {
    const cacheBase = makeTempDir()
    const updaterDir = path.join(cacheBase, 'pi-workbench-updater')
    const draftsDir = path.join(cacheBase, 'drafts')
    fs.mkdirSync(path.join(updaterDir, 'pending'), { recursive: true })
    fs.mkdirSync(draftsDir, { recursive: true })
    fs.writeFileSync(path.join(updaterDir, 'pending', 'Setup.exe'), 'x')
    fs.writeFileSync(path.join(updaterDir, 'installer.exe'), 'installer')
    fs.writeFileSync(path.join(updaterDir, 'current.blockmap'), 'blockmap')
    fs.writeFileSync(path.join(draftsDir, 'keep.json'), 'ok')

    pruneUpdateCache(cacheBase, 'pi-workbench-updater')

    expect(fs.readdirSync(updaterDir).sort()).toEqual(['current.blockmap', 'installer.exe'])
    expect(fs.existsSync(path.join(draftsDir, 'keep.json'))).toBe(true)
  })

  it('removes empty updater subdir while keeping cacheBase', () => {
    const cacheBase = makeTempDir()
    const updaterDir = path.join(cacheBase, 'pi-workbench-updater')
    fs.mkdirSync(path.join(updaterDir, 'pending'), { recursive: true })
    fs.writeFileSync(path.join(updaterDir, 'pending', 'Setup.exe'), 'x')

    pruneUpdateCache(cacheBase, 'pi-workbench-updater')

    expect(fs.existsSync(updaterDir)).toBe(false)
    expect(fs.existsSync(cacheBase)).toBe(true)
  })
})
