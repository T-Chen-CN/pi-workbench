import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const { spawnMock, state } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  state: { appDir: '' },
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.6.1',
  },
}))

vi.mock('../electron/app-paths', () => ({
  getAppDir: () => state.appDir,
}))

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

import { app } from 'electron'
import {
  platformRefreshCommands,
  refreshShellCachesIfUpdated,
  shouldRefresh,
} from '../electron/shell-refresh'

const packagedApp = app as unknown as { isPackaged: boolean; getVersion: () => string }

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shell-'))
  state.appDir = dir
  packagedApp.isPackaged = true
  spawnMock.mockReset()
  spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('platformRefreshCommands', () => {
  it('rebuilds the Windows icon cache with ie4uinit', () => {
    const commands = platformRefreshCommands('win32', 'C:\\App\\Pi.exe', { SystemRoot: 'D:\\Win' }, 'C:\\Users\\u')

    expect(commands).toEqual([{ command: path.win32.join('D:\\Win', 'System32', 'ie4uinit.exe'), args: ['-show'] }])
  })

  it('touches the bundle and refreshes LaunchServices on macOS', () => {
    const execPath = '/Applications/Pi Workbench.app/Contents/MacOS/Pi Workbench'
    const commands = platformRefreshCommands('darwin', execPath, {}, '/Users/u')

    expect(commands).toHaveLength(2)
    expect(commands[0]).toEqual({ command: '/usr/bin/touch', args: ['-m', '/Applications/Pi Workbench.app'] })
    expect(commands[1].args).toEqual(['-f', '/Applications/Pi Workbench.app'])
    expect(commands[1].command).toContain('lsregister')
  })

  it('refreshes the desktop database and icon cache on Linux when they exist', () => {
    const commands = platformRefreshCommands(
      'linux',
      '/home/u/Apps/Pi.AppImage',
      { APPIMAGE: '/home/u/Apps/Pi.AppImage' },
      '/home/u',
      () => true
    )

    expect(commands.map((entry) => entry.command)).toEqual([
      '/usr/bin/touch',
      'update-desktop-database',
      'gtk-update-icon-cache',
    ])
  })

  it('skips the desktop refresh on Linux when nothing is installed', () => {
    expect(platformRefreshCommands('linux', '/usr/bin/pi', {}, '/home/u', () => false)).toEqual([])
  })
})

describe('shouldRefresh', () => {
  it('refreshes only when the running version differs from the recorded one', () => {
    expect(shouldRefresh(null, '0.6.1')).toBe(true)
    expect(shouldRefresh('0.6.0', '0.6.1')).toBe(true)
    expect(shouldRefresh('0.6.1', '0.6.1')).toBe(false)
  })
})

describe('refreshShellCachesIfUpdated', () => {
  it('records the version and runs the refresh once per version', () => {
    const versionFile = path.join(dir, 'config', 'last-run-version.json')

    const first = refreshShellCachesIfUpdated()
    expect(first).toMatchObject({ previousVersion: null, currentVersion: '0.6.1' })
    const recorded = JSON.parse(fs.readFileSync(versionFile, 'utf-8')) as { version: string }
    expect(recorded.version).toBe('0.6.1')

    const callsAfterFirstRun = spawnMock.mock.calls.length
    const second = refreshShellCachesIfUpdated()
    expect(second).toMatchObject({ refreshed: false, previousVersion: '0.6.1' })
    expect(spawnMock.mock.calls.length).toBe(callsAfterFirstRun)
  })

  it('does nothing in development builds', () => {
    packagedApp.isPackaged = false

    expect(refreshShellCachesIfUpdated()).toMatchObject({ refreshed: false, previousVersion: null })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(dir, 'config', 'last-run-version.json'))).toBe(false)
  })
})
