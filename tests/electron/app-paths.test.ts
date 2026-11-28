import { afterEach, describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const mockState = vi.hoisted(() => ({
  isPackaged: false,
  appPath: '',
  exePath: '',
  appDataPath: '',
  existsSync: vi.fn<(target: string) => boolean>(() => false),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (target: string) => mockState.existsSync(target),
  }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockState.isPackaged
    },
    getAppPath: () => mockState.appPath,
    getPath: (name: string) => {
      if (name === 'exe') return mockState.exePath
      if (name === 'appData') return mockState.appDataPath
      return ''
    },
  },
}))

import {
  APP_DATA_DIR_NAME,
  getAppDir,
  getBridgeEntryUrl,
  getInstallDir,
  isPortableMode,
  piAgentDir,
  PORTABLE_MARKER_FILE,
  resetAppPathsCache,
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

  it('主进程直接导入的内部 workspace 包必须声明在根 package.json dependencies 中，确保打进 app.asar/node_modules', async () => {
    const fs = await import('node:fs')
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(rootPkg.dependencies?.['@pi-workbench/i18n']).toBeTruthy()
    expect(rootPkg.dependencies?.['pi-bridge']).toBeTruthy()
  })
})

describe('resolveAppPaths 无参生产调用缓存', () => {
  const originalAppImage = process.env.APPIMAGE

  afterEach(() => {
    mockState.isPackaged = false
    mockState.appPath = ''
    mockState.exePath = ''
    mockState.appDataPath = ''
    mockState.existsSync.mockReset()
    mockState.existsSync.mockReturnValue(false)
    if (originalAppImage === undefined) delete process.env.APPIMAGE
    else process.env.APPIMAGE = originalAppImage
    resetAppPathsCache()
  })

  it('打包模式下重复调用 getAppDir / getInstallDir / isPortableMode / resolveAppPaths 只触发一次 fs.existsSync', () => {
    resetAppPathsCache()
    mockState.isPackaged = true
    mockState.exePath = '/opt/pi/Pi Workbench.exe'
    mockState.appDataPath = '/users/me/appdata'
    delete process.env.APPIMAGE
    mockState.existsSync.mockClear()
    mockState.existsSync.mockReturnValue(false)

    const firstDataDir = getAppDir()
    const firstInstallDir = getInstallDir()
    const firstPortable = isPortableMode()
    const snapshot = resolveAppPaths()

    expect(firstDataDir).toBe(path.join('/users/me/appdata', APP_DATA_DIR_NAME))
    expect(firstInstallDir).toBe(path.dirname('/opt/pi/Pi Workbench.exe'))
    expect(firstPortable).toBe(false)
    expect(snapshot).toEqual({
      dataDir: firstDataDir,
      installDir: firstInstallDir,
      portable: false,
    })

    // 多次热路径访问全部命中缓存，不重复同步探盘
    for (let i = 0; i < 20; i += 1) {
      expect(getAppDir()).toBe(firstDataDir)
      expect(getInstallDir()).toBe(firstInstallDir)
      expect(isPortableMode()).toBe(false)
      expect(resolveAppPaths()).toEqual(snapshot)
    }

    const expectedCalls = process.platform === 'darwin' ? 0 : 1
    expect(mockState.existsSync).toHaveBeenCalledTimes(expectedCalls)
  })

  it('resetAppPathsCache 与环境键变化都会正确失效缓存，显式传 options 不污染默认缓存', () => {
    resetAppPathsCache()
    mockState.isPackaged = true
    mockState.exePath = '/opt/pi-a/Pi Workbench.exe'
    mockState.appDataPath = '/users/me/appdata'
    delete process.env.APPIMAGE
    mockState.existsSync.mockClear()
    mockState.existsSync.mockReturnValue(false)

    expect(isPortableMode()).toBe(false)
    const firstCount = mockState.existsSync.mock.calls.length

    // 显式传 options 始终即时计算且不改写默认缓存
    const custom = resolveAppPaths({
      isPackaged: true,
      platform: 'win32',
      exePath: '/portable/pi/Pi Workbench.exe',
      appDataPath: '/users/me/appdata',
      appImagePath: '',
      argv: [],
      existsSync: () => true,
    })
    expect(custom.portable).toBe(true)
    expect(isPortableMode()).toBe(false)
    expect(mockState.existsSync).toHaveBeenCalledTimes(firstCount)

    // resetAppPathsCache 后重新探测 portable 标记
    mockState.existsSync.mockReturnValue(true)
    resetAppPathsCache()
    if (process.platform !== 'darwin') {
      expect(isPortableMode()).toBe(true)
      expect(mockState.existsSync).toHaveBeenCalledTimes(firstCount + 1)
    }

    // 启动环境键变化（如 exePath 变化）无需手动 reset 也会自动失效缓存
    mockState.exePath = '/opt/pi-b/Pi Workbench.exe'
    mockState.existsSync.mockReturnValue(false)
    expect(getInstallDir()).toBe(path.dirname('/opt/pi-b/Pi Workbench.exe'))
    expect(isPortableMode()).toBe(false)
    if (process.platform !== 'darwin') {
      expect(mockState.existsSync).toHaveBeenCalledTimes(firstCount + 2)
    }
  })
})
