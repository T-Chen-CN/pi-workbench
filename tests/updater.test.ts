import { beforeEach, describe, expect, it, vi } from 'vitest'

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
