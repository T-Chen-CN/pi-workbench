import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TemplateItem = { label?: string; type?: string; click?: () => void }

const mocks = vi.hoisted(() => {
  class FakeTray {
    static instances: FakeTray[] = []
    destroyed = false
    tooltip = ''
    menu: { template: TemplateItem[] } | null = null
    balloons: Array<Record<string, unknown>> = []
    listeners = new Map<string, () => void>()
    constructor(public image: unknown) {
      FakeTray.instances.push(this)
    }
    isDestroyed() {
      return this.destroyed
    }
    setToolTip(value: string) {
      this.tooltip = value
    }
    setContextMenu(menu: { template: TemplateItem[] }) {
      this.menu = menu
    }
    setIgnoreDoubleClickEvents() {}
    on(name: string, listener: () => void) {
      this.listeners.set(name, listener)
    }
    displayBalloon(options: Record<string, unknown>) {
      this.balloons.push(options)
    }
    destroy() {
      this.destroyed = true
    }
    click() {
      this.listeners.get('click')?.()
    }
  }

  const image = {
    isEmpty: () => false,
    resize: () => image,
    setTemplateImage: () => {}
  }

  return {
    FakeTray,
    image,
    Menu: { buildFromTemplate: (template: unknown) => ({ template }) },
    nativeImage: { createFromPath: () => image }
  }
})

vi.mock('electron', () => ({
  Tray: mocks.FakeTray,
  Menu: mocks.Menu,
  nativeImage: mocks.nativeImage
}))

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/** 每个用例都重新加载模块，避免托盘单例在用例间串味 */
async function loadTray(platform: NodeJS.Platform) {
  vi.resetModules()
  mocks.FakeTray.instances = []
  setPlatform(platform)
  const module = await import('../electron/tray')
  return module
}

beforeEach(() => {
  mocks.FakeTray.instances = []
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('resolveCloseAction', () => {
  it('hides the window on windows when the tray is ready', async () => {
    const { resolveCloseAction } = await loadTray('win32')
    expect(
      resolveCloseAction({ closeToTray: true, quitting: false, trayReady: true, platform: 'win32' })
    ).toBe('hide')
  })

  it('hides the window on macOS even without a tray icon, because the dock is still there', async () => {
    const { resolveCloseAction } = await loadTray('darwin')
    expect(
      resolveCloseAction({ closeToTray: true, quitting: false, trayReady: false, platform: 'darwin' })
    ).toBe('hide')
  })

  it('falls back to a real close on windows when the tray could not be created', async () => {
    const { resolveCloseAction } = await loadTray('win32')
    expect(
      resolveCloseAction({ closeToTray: true, quitting: false, trayReady: false, platform: 'win32' })
    ).toBe('close')
  })

  it('minimizes on linux instead of hiding, because tray support is unreliable', async () => {
    const { resolveCloseAction } = await loadTray('linux')
    expect(
      resolveCloseAction({ closeToTray: true, quitting: false, trayReady: true, platform: 'linux' })
    ).toBe('minimize')
  })

  it('closes for real while quitting or when the user turned the setting off', async () => {
    const { resolveCloseAction } = await loadTray('win32')
    expect(
      resolveCloseAction({ closeToTray: true, quitting: true, trayReady: true, platform: 'win32' })
    ).toBe('close')
    expect(
      resolveCloseAction({ closeToTray: false, quitting: false, trayReady: true, platform: 'win32' })
    ).toBe('close')
  })
})

describe('trayMenuTemplate', () => {
  it('lists show / separator / quit in the requested language', async () => {
    const { trayMenuTemplate } = await loadTray('win32')
    const actions = { showMainWindow: () => {}, quit: () => {} }
    const zh = trayMenuTemplate('zh', actions)
    expect(zh.map((item) => item.label ?? item.type)).toEqual(['显示主窗口', 'separator', '退出'])
    const en = trayMenuTemplate('en', actions)
    expect(en.map((item) => item.label ?? item.type)).toEqual([
      'Show Main Window',
      'separator',
      'Quit'
    ])
  })

  it('treats unknown languages as chinese', async () => {
    const { trayMenuTemplate } = await loadTray('win32')
    const menu = trayMenuTemplate(undefined, { showMainWindow: () => {}, quit: () => {} })
    expect(menu[0].label).toBe('显示主窗口')
  })
})

describe('installTray', () => {
  it('creates one tray that opens the main window on click and offers quit', async () => {
    const { installTray, isTrayReady } = await loadTray('win32')
    const showMainWindow = vi.fn()
    const quit = vi.fn()
    installTray({
      getEnabled: () => true,
      getLanguage: () => 'zh',
      showMainWindow,
      quit
    })

    expect(isTrayReady()).toBe(true)
    const tray = mocks.FakeTray.instances[0]
    expect(tray.menu?.template.map((item) => item.label ?? item.type)).toEqual([
      '显示主窗口',
      'separator',
      '退出'
    ])

    tray.click()
    expect(showMainWindow).toHaveBeenCalledTimes(1)
    tray.menu?.template[2].click?.()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the menu in the new language and keeps a single tray', async () => {
    const { installTray, refreshTray } = await loadTray('win32')
    let language = 'zh'
    installTray({
      getEnabled: () => true,
      getLanguage: () => language,
      showMainWindow: () => {},
      quit: () => {}
    })
    language = 'en'
    refreshTray()

    expect(mocks.FakeTray.instances).toHaveLength(1)
    expect(mocks.FakeTray.instances[0].menu?.template[0].label).toBe('Show Main Window')
  })

  it('tears the tray down when the setting is turned off, and does not create one on linux', async () => {
    const { installTray, refreshTray, isTrayReady } = await loadTray('win32')
    let enabled = true
    installTray({
      getEnabled: () => enabled,
      getLanguage: () => 'zh',
      showMainWindow: () => {},
      quit: () => {}
    })
    enabled = false
    refreshTray()
    expect(isTrayReady()).toBe(false)

    const linux = await loadTray('linux')
    linux.installTray({
      getEnabled: () => true,
      getLanguage: () => 'zh',
      showMainWindow: () => {},
      quit: () => {}
    })
    expect(mocks.FakeTray.instances).toHaveLength(0)
    expect(linux.isTrayReady()).toBe(false)
  })
})

describe('showTrayHintOnce', () => {
  it('shows the balloon only for the first hide on windows', async () => {
    const { installTray, showTrayHintOnce } = await loadTray('win32')
    installTray({
      getEnabled: () => true,
      getLanguage: () => 'zh',
      showMainWindow: () => {},
      quit: () => {}
    })
    showTrayHintOnce()
    showTrayHintOnce()
    const tray = mocks.FakeTray.instances[0]
    expect(tray.balloons).toHaveLength(1)
    expect(tray.balloons[0].title).toBe('仍在后台运行')
  })

  it('stays quiet off windows', async () => {
    const { installTray, showTrayHintOnce } = await loadTray('darwin')
    installTray({
      getEnabled: () => true,
      getLanguage: () => 'zh',
      showMainWindow: () => {},
      quit: () => {}
    })
    showTrayHintOnce()
    expect(mocks.FakeTray.instances[0].balloons).toHaveLength(0)
  })
})
