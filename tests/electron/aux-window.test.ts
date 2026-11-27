import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeBrowserWindowInstance {
  options: Record<string, unknown>
  loadedUrls: string[]
  sent: Array<[string, unknown]>
  openHandler: ((details: { url: string; referrer?: { url?: string } }) => { action: string }) | null
  willNavigateHandler: ((event: { preventDefault: () => void }, url: string) => void) | null
  willAttachWebviewHandler: ((event: { preventDefault: () => void }) => void) | null
  closedHandler: (() => void) | null
  maximizeHandler: (() => void) | null
  unmaximizeHandler: (() => void) | null
  maximized: boolean
  minimized: boolean
  closed: boolean
  destroyed: boolean
  menuBarVisible: boolean
  webContentsId: number
  webContents: Record<string, unknown>
  isDestroyed: () => boolean
  isMaximized: () => boolean
  isMinimized: () => boolean
  maximize: () => void
  unmaximize: () => void
  minimize: () => void
  restore: () => void
  show: () => void
  focus: () => void
  close: () => void
  setMenuBarVisibility: (visible: boolean) => void
  loadURL: (url: string) => Promise<void>
  on: (event: string, handler: () => void) => void
}

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const windows: FakeBrowserWindowInstance[] = []
  let nextWcId = 900

  class MockBrowserWindow implements FakeBrowserWindowInstance {
    static getAllWindows(): FakeBrowserWindowInstance[] {
      return windows.filter((w) => !w.destroyed)
    }

    options: Record<string, unknown>
    loadedUrls: string[] = []
    sent: Array<[string, unknown]> = []
    openHandler: ((details: { url: string; referrer?: { url?: string } }) => { action: string }) | null =
      null
    willNavigateHandler: ((event: { preventDefault: () => void }, url: string) => void) | null = null
    willAttachWebviewHandler: ((event: { preventDefault: () => void }) => void) | null = null
    closedHandler: (() => void) | null = null
    maximizeHandler: (() => void) | null = null
    unmaximizeHandler: (() => void) | null = null
    maximized = false
    minimized = false
    closed = false
    destroyed = false
    menuBarVisible = true
    webContentsId: number
    private webContentsReadable = true
    private contents: Record<string, unknown>

    constructor(options: Record<string, unknown> = {}) {
      this.options = options
      this.webContentsId = nextWcId++
      this.contents = {
        id: this.webContentsId,
        isDestroyed: () => this.destroyed,
        send: (channel: string, payload: unknown) => {
          this.sent.push([channel, payload])
        },
        setWindowOpenHandler: (
          handler: (details: { url: string; referrer?: { url?: string } }) => { action: string }
        ) => {
          this.openHandler = handler
        },
        on: (event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'will-navigate') {
            this.willNavigateHandler = handler as (
              event: { preventDefault: () => void },
              url: string
            ) => void
          } else if (event === 'will-attach-webview') {
            this.willAttachWebviewHandler = handler as (event: { preventDefault: () => void }) => void
          }
        },
      }
      windows.push(this)
    }

    // 与真实 Electron 一致：窗口销毁后读 `webContents` 抛 `Object has been destroyed`
    get webContents(): Record<string, unknown> {
      if (!this.webContentsReadable) throw new Error('Object has been destroyed')
      return this.contents
    }

    isDestroyed = () => this.destroyed
    isMaximized = () => this.maximized
    isMinimized = () => this.minimized
    maximize = () => {
      this.maximized = true
      this.maximizeHandler?.()
    }
    unmaximize = () => {
      this.maximized = false
      this.unmaximizeHandler?.()
    }
    minimize = () => {
      this.minimized = true
    }
    restore = () => {
      this.minimized = false
    }
    show = () => {}
    focus = () => {}
    close = () => {
      if (this.destroyed) return
      this.closed = true
      this.destroyed = true
      this.webContentsReadable = false
      this.closedHandler?.()
    }
    setMenuBarVisibility = (visible: boolean) => {
      this.menuBarVisible = visible
    }
    loadURL = async (url: string) => {
      this.loadedUrls.push(url)
    }
    on = (event: string, handler: () => void) => {
      if (event === 'closed') this.closedHandler = handler
      if (event === 'maximize') this.maximizeHandler = handler
      if (event === 'unmaximize') this.unmaximizeHandler = handler
    }
  }

  return {
    handlers,
    windows,
    MockBrowserWindow,
    cursor: { x: 500, y: 400 },
    display: { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    externalUrls: [] as string[],
  }
})

vi.mock('electron', () => ({
  // 测试替身不提供 isReady：isTrustedIpcSender 会直接放行
  app: {
    isPackaged: false,
    getAppPath: () => os.tmpdir(),
    getPath: () => os.tmpdir(),
  },
  BrowserWindow: mocks.MockBrowserWindow,
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    },
  },
  screen: {
    getCursorScreenPoint: () => mocks.cursor,
    getDisplayNearestPoint: () => mocks.display,
    getDisplayMatching: () => mocks.display,
  },
  // 外链交给系统浏览器：测试里只记录调用
  shell: {
    openExternal: (url: string) => {
      mocks.externalUrls.push(url)
      return Promise.resolve()
    },
  },
}))

const { trustWorkspace } = await import('../../electron/workspace-trust')
const {
  AUX_FRAME_PREFIX,
  AUX_MIN_HEIGHT,
  AUX_MIN_WIDTH,
  closeAllDetachedPanelWindows,
  computeDetachedRect,
  createDetachedPanelWindow,
  getAuxWindow,
  installAuxWindowSupport,
  isPointInBounds,
  parseAuxWindowFeatures,
  readAuxWindowState,
  registerAuxWindowIpc,
  runAuxWindowCommand,
} = await import('../../electron/aux-window')

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 }
const APP_REFERRER = { url: 'pw-app://bundle/index.html' }

let workspaceDir = ''

beforeAll(() => {
  workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-aux-win-')))
  trustWorkspace(workspaceDir)
})

afterAll(() => {
  closeAllDetachedPanelWindows()
  fs.rmSync(workspaceDir, { recursive: true, force: true })
})

beforeEach(() => {
  closeAllDetachedPanelWindows()
  mocks.windows.length = 0
  mocks.cursor = { x: 500, y: 400 }
  mocks.display = { workArea: WORK_AREA }
  mocks.handlers.clear()
  mocks.externalUrls.length = 0
})

describe('parseAuxWindowFeatures', () => {
  it('reads geometry from the feature string', () => {
    const result = parseAuxWindowFeatures('width=600,height=400,left=120,top=80', WORK_AREA)
    expect(result).toEqual({ width: 600, height: 400, x: 120, y: 80, backgroundColor: '#f4f1ea' })
  })

  it('falls back to centered defaults when features are empty', () => {
    const result = parseAuxWindowFeatures('', WORK_AREA)
    expect(result.width).toBe(520)
    expect(result.height).toBe(640)
    expect(result.x).toBe(Math.round((1920 - 520) / 2))
    expect(result.y).toBe(Math.round((1080 - 640) / 2))
  })

  it('clamps to the minimum size and keeps the window on screen', () => {
    const result = parseAuxWindowFeatures('width=10,height=10,left=-500,top=99999', WORK_AREA)
    expect(result.width).toBe(AUX_MIN_WIDTH)
    expect(result.height).toBe(AUX_MIN_HEIGHT)
    expect(result.x).toBe(0)
    expect(result.y).toBe(1080 - AUX_MIN_HEIGHT)
  })

  it('clamps to the work area size', () => {
    const small = { x: 0, y: 0, width: 800, height: 600 }
    const result = parseAuxWindowFeatures('width=4000,height=4000', small)
    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
  })

  it('accepts only plain hex background colors', () => {
    expect(parseAuxWindowFeatures('bg=%231b1b1a', WORK_AREA).backgroundColor).toBe('#1b1b1a')
    expect(parseAuxWindowFeatures('bg=red', WORK_AREA).backgroundColor).toBe('#f4f1ea')
    expect(parseAuxWindowFeatures('bg=#fff', WORK_AREA).backgroundColor).toBe('#f4f1ea')
  })

  it('ignores privileges such as nodeIntegration or frame flags', () => {
    const result = parseAuxWindowFeatures(
      'nodeIntegration=yes,frame=no,webPreferences=evil,width=500,height=500',
      WORK_AREA
    )
    expect(Object.keys(result).sort()).toEqual(['backgroundColor', 'height', 'width', 'x', 'y'].sort())
  })

  it('survives malformed percent encoding', () => {
    expect(() => parseAuxWindowFeatures('bg=%E0%A4%A,width=500', WORK_AREA)).not.toThrow()
  })
})

describe('isPointInBounds', () => {
  const bounds = { x: 100, y: 100, width: 200, height: 100 }

  it('treats the top-left corner as inside and the bottom-right as outside', () => {
    expect(isPointInBounds({ x: 100, y: 100 }, bounds)).toBe(true)
    expect(isPointInBounds({ x: 300, y: 200 }, bounds)).toBe(false)
  })
})

describe('computeDetachedRect', () => {
  it('sizes the window relative to the host and anchors it near the cursor', () => {
    const host = { x: 0, y: 0, width: 1600, height: 900 }
    const rect = computeDetachedRect({ x: 700, y: 500 }, host, WORK_AREA)
    expect(rect.width).toBe(Math.round(1600 * 0.32))
    expect(rect.height).toBe(Math.round(900 * 0.72))
    expect(rect.x).toBe(668)
    expect(rect.y).toBe(Math.min(482, 1080 - rect.height))
  })

  it('keeps the window inside the work area when the cursor is at the edge', () => {
    const host = { x: 0, y: 0, width: 1600, height: 900 }
    const rect = computeDetachedRect({ x: 1915, y: 1075 }, host, WORK_AREA)
    expect(rect.x + rect.width).toBeLessThanOrEqual(WORK_AREA.width)
    expect(rect.y + rect.height).toBeLessThanOrEqual(WORK_AREA.height)
  })
})

describe('registerAuxWindowIpc', () => {
  it('reports the cursor as inside the host window', () => {
    registerAuxWindowIpc({
      getMainWindow: () =>
        ({
          isDestroyed: () => false,
          getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
        }) as never,
    })
    const handler = mocks.handlers.get('aux:detach-at')
    expect(handler?.({} as never)).toEqual({ success: true, inside: true })
  })

  it('returns a rect when the cursor has left the host window', () => {
    mocks.cursor = { x: 1500, y: 900 }
    registerAuxWindowIpc({
      getMainWindow: () =>
        ({
          isDestroyed: () => false,
          getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
        }) as never,
    })
    const result = mocks.handlers.get('aux:detach-at')?.({} as never) as {
      success: boolean
      inside: boolean
      rect: { x: number; width: number }
    }
    expect(result.success).toBe(true)
    expect(result.inside).toBe(false)
    expect(result.rect.width).toBeGreaterThan(0)
  })

  it('fails gracefully when there is no host window', () => {
    registerAuxWindowIpc({ getMainWindow: () => null })
    expect(mocks.handlers.get('aux:detach-at')?.({} as never)).toEqual({
      success: false,
      error: 'No window',
    })
  })
})

function createMainHost() {
  let openHandler:
    | ((details: {
        url: string
        frameName: string
        features: string
        referrer?: { url: string; policy?: string }
      }) => { action: string })
    | null = null
  const sent: Array<[string, unknown]> = []
  const webContents = {
    id: 1,
    isDestroyed: () => false,
    setWindowOpenHandler: (handler: typeof openHandler) => {
      openHandler = handler
    },
    send: (channel: string, payload: unknown) => {
      sent.push([channel, payload])
    },
  }
  return {
    sent,
    webContents,
    isDestroyed: () => false,
    open: (details: {
      url: string
      frameName: string
      features: string
      referrer?: { url: string; policy?: string }
    }) => openHandler?.(details) ?? { action: 'missing' },
  }
}

describe('installAuxWindowSupport', () => {
  it('denies all internal popups including legacy about:blank pi-panel windows and forwards allowed external links', () => {
    const host = createMainHost()
    installAuxWindowSupport(host as never)

    expect(
      host.open({
        url: 'about:blank',
        frameName: `${AUX_FRAME_PREFIX}aux:1`,
        features: '',
        referrer: APP_REFERRER,
      }).action
    ).toBe('deny')
    expect(
      host.open({ url: 'about:blank', frameName: 'other', features: '', referrer: APP_REFERRER }).action
    ).toBe('deny')
    expect(
      host.open({
        url: 'https://example.com',
        frameName: '_blank',
        features: '',
        referrer: APP_REFERRER,
      }).action
    ).toBe('deny')
    expect(mocks.externalUrls).toEqual(['https://example.com'])
  })

  it('enforces referrer allowlist and blocks external links from untrusted referrers (SEC-02)', () => {
    const host = createMainHost()
    installAuxWindowSupport(host as never)

    for (const badReferrer of [
      undefined,
      { url: '' },
      { url: 'null' },
      { url: 'about:blank' },
      { url: 'pw-file://local/workspace/index.html' },
      { url: 'https://evil.example/page.html' },
    ]) {
      expect(
        host.open({
          url: 'https://evil.example',
          frameName: '_blank',
          features: '',
          referrer: badReferrer,
        }).action
      ).toBe('deny')
    }
    expect(mocks.externalUrls).toEqual([])
  })
})

describe('createDetachedPanelWindow & window commands', () => {
  it('registers the detached native window, forwards maximize state, and handles destroyed close cleanly', () => {
    const host = createMainHost()
    const onClosed = vi.fn()
    const res = createDetachedPanelWindow(
      {
        workspaceDir,
        panel: 'chat',
        hostId: 'aux:7',
        rect: { x: 40, y: 40, width: 600, height: 500 },
        theme: 'dark',
        language: 'zh',
      },
      {
        getMainWindow: () => host as never,
        preloadPath: '/app/preload.cjs',
        onClosed,
      }
    )

    const frameName = `${AUX_FRAME_PREFIX}aux:7`
    expect(res).toEqual({ success: true, hostId: 'aux:7', frameName })
    const child = getAuxWindow(frameName) as unknown as FakeBrowserWindowInstance
    expect(child).toBeTruthy()
    expect(child.options.parent).toBeUndefined()
    expect(child.options.minWidth).toBe(AUX_MIN_WIDTH)
    expect(child.options.minHeight).toBe(AUX_MIN_HEIGHT)
    expect(child.menuBarVisible).toBe(false)

    expect(readAuxWindowState(frameName)).toEqual({ success: true, maximized: false })
    expect(runAuxWindowCommand(frameName, 'toggleMaximize')).toEqual({
      success: true,
      maximized: true,
    })
    expect(runAuxWindowCommand(frameName, 'toggleMaximize')).toEqual({
      success: true,
      maximized: false,
    })
    expect(host.sent).toEqual([
      ['window:maximized-changed', { host: frameName, maximized: true }],
      ['window:maximized-changed', { host: frameName, maximized: false }],
    ])
    expect(child.sent).toEqual([
      ['window:maximized-changed', { host: frameName, maximized: true }],
      ['window:maximized-changed', { host: frameName, maximized: false }],
    ])

    expect(runAuxWindowCommand(frameName, 'minimize')).toEqual({ success: true })
    expect(child.minimized).toBe(true)

    expect(() => runAuxWindowCommand(frameName, 'close')).not.toThrow()
    expect(child.closed).toBe(true)
    expect(onClosed).toHaveBeenCalledWith(frameName)
    expect(getAuxWindow(frameName)).toBeNull()
    expect(runAuxWindowCommand(frameName, 'close').success).toBe(false)
  })

  it('rejects unknown hosts and commands from the renderer', () => {
    const host = createMainHost()
    registerAuxWindowIpc({ getMainWindow: () => host as never, preloadPath: '/app/preload.cjs' })
    createDetachedPanelWindow(
      { workspaceDir, panel: 'files', hostId: 'aux:9' },
      { getMainWindow: () => host as never, preloadPath: '/app/preload.cjs' }
    )
    const frameName = `${AUX_FRAME_PREFIX}aux:9`

    const command = mocks.handlers.get('aux:window-command')!
    expect(command({} as never, 'main', 'close')).toEqual({ success: false, error: 'Invalid host' })
    expect(command({} as never, frameName, 'explode')).toEqual({
      success: false,
      error: 'Invalid command',
    })
    expect(command({} as never, `${AUX_FRAME_PREFIX}aux:404`, 'close')).toEqual({
      success: false,
      error: 'No such aux window',
    })

    const state = mocks.handlers.get('aux:window-state')!
    expect(state({} as never, 42)).toEqual({ success: false, error: 'Invalid host' })
    expect(state({} as never, frameName)).toEqual({ success: true, maximized: false })
  })
})
