import { describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '',
    getPath: () => '',
  },
}))

import {
  APP_DATA_DIR_NAME,
  getAppDir,
  getBridgeEntryUrl,
  piAgentDir,
  PORTABLE_MARKER_FILE,
  resolveAppPaths,
} from '../../electron/app-paths'

describe('getBridgeEntryUrl', () => {
  it('解析到仓库根目录下的 pi-bridge 构建产物', () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const expected = pathToFileURL(path.join(repoRoot, 'pi-bridge', 'dist', 'index.js')).href
    expect(getBridgeEntryUrl()).toBe(expected)
  })

  it('不会拼出 dist-electron 内的多余层级', () => {
    expect(getBridgeEntryUrl()).not.toContain('dist-electron')
  })
})

describe('resolveAppPaths（严格两目录 + 可选便携模式）', () => {
  it('开发模式返回仓库根目录且非便携', () => {
    const resolved = resolveAppPaths({
      isPackaged: false,
      appPath: '/repo/pi-workbench',
      argv: [],
    })
    expect(resolved).toEqual({
      dataDir: '/repo/pi-workbench',
      installDir: '/repo/pi-workbench',
      portable: false,
    })
  })

  it('打包版默认走各平台标准用户数据目录（两目录模型）', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const resolved = resolveAppPaths({
        isPackaged: true,
        platform,
        exePath: '/opt/pi/Pi Workbench.exe',
        appDataPath: '/users/me/appdata',
        appImagePath: '',
        argv: [],
        existsSync: () => false,
      })
      expect(resolved).toEqual({
        dataDir: path.join('/users/me/appdata', APP_DATA_DIR_NAME),
        installDir: path.dirname('/opt/pi/Pi Workbench.exe'),
        portable: false,
      })
    }
  })

  it('Windows/Linux 打包版在安装目录存在 portable 标记时切入单目录便携模式', () => {
    const installDir = path.dirname('/portable/pi/Pi Workbench.exe')
    const resolved = resolveAppPaths({
      isPackaged: true,
      platform: 'win32',
      exePath: '/portable/pi/Pi Workbench.exe',
      appDataPath: '/users/me/appdata',
      appImagePath: '',
      argv: [],
      existsSync: (target) => target === path.join(installDir, PORTABLE_MARKER_FILE),
    })
    expect(resolved).toEqual({
      dataDir: installDir,
      installDir,
      portable: true,
    })
  })

  it('macOS 忽略 .app 包内 portable 标记，始终保持标准数据目录', () => {
    const resolved = resolveAppPaths({
      isPackaged: true,
      platform: 'darwin',
      exePath: '/Applications/Pi Workbench.app/Contents/MacOS/Pi Workbench',
      appDataPath: '/Users/me/Library/Application Support',
      appImagePath: '',
      argv: [],
      existsSync: () => true,
    })
    expect(resolved.portable).toBe(false)
    expect(resolved.dataDir).toBe(
      path.join('/Users/me/Library/Application Support', APP_DATA_DIR_NAME)
    )
  })

  it('支持 --data-dir 显式覆盖数据目录并启用便携模式', () => {
    const resolved = resolveAppPaths({
      isPackaged: true,
      platform: 'win32',
      exePath: '/opt/pi/Pi Workbench.exe',
      appDataPath: '/users/me/appdata',
      appImagePath: '',
      argv: ['Pi Workbench.exe', '--data-dir=/custom/data'],
      existsSync: () => false,
    })
    expect(resolved.portable).toBe(true)
    expect(resolved.dataDir).toBe(path.resolve('/custom/data'))
  })

  it('Linux AppImage 的 installDir 取 .AppImage 文件所在目录', () => {
    const resolved = resolveAppPaths({
      isPackaged: true,
      platform: 'linux',
      exePath: '/tmp/.mount_Pi/pi-workbench',
      appImagePath: '/home/me/Apps/Pi-Workbench.AppImage',
      appDataPath: '/home/me/.config',
      argv: [],
      existsSync: (target) =>
        target === path.join('/home/me/Apps', PORTABLE_MARKER_FILE),
    })
    expect(resolved).toEqual({
      dataDir: '/home/me/Apps',
      installDir: '/home/me/Apps',
      portable: true,
    })
  })
})

describe('Pi SDK directories', () => {
  it('固定在应用数据目录内，并通过环境变量交给 SDK', () => {
    expect(piAgentDir).toBe(path.join(getAppDir(), 'data', 'agent'))
    expect(process.env.PI_CODING_AGENT_DIR).toBe(piAgentDir)
    expect(process.env.PI_CODING_AGENT_SESSION_DIR).toBe(path.join(piAgentDir, 'sessions'))
  })
})
