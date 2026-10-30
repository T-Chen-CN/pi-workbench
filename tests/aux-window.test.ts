import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  cursor: { x: 500, y: 400 },
  display: { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
  externalUrls: [] as string[]
}))

vi.mock('electron', () => ({
  // 测试替身不提供 isReady：isTrustedIpcSender 会直接放行
  app: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  },
  screen: {
    getCursorScreenPoint: () => mocks.cursor,
    getDisplayNearestPoint: () => mocks.display,
    getDisplayMatching: () => mocks.display
  },
  // 外链交给系统浏览器：测试里只记录调用
  shell: {
    openExternal: (url: string) => {
      mocks.externalUrls.push(url)
      return Promise.resolve()
    }
  }
}))

const {
  AUX_FRAME_PREFIX,
  AUX_MIN_HEIGHT,
  AUX_MIN_WIDTH,
  computeDetachedRect,
  getAuxWindow,
  installAuxWindowSupport,
  isPointInBounds,
  parseAuxWindowFeatures,
  readAuxWindowState,
  registerAuxWindowIpc,
  runAuxWindowCommand
} = await import('../electron/aux-window')

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 }

beforeEach(() => {
  mocks.cursor = { x: 500, y: 400 }
  mocks.display = { workArea: WORK_AREA }
  mocks.handlers.clear()
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
    // 光标偏下时整体上移，避免窗口底部超出工作区
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
          getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 })
        }) as never
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
          getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 })
        }) as never
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
      error: 'No window'
    })
  })
})

interface FakeChild {
  menuOverridden: boolean
  openHandler: ((details: { url: string }) => { action: string }) | null
  navigations: string[]
  closedHandler: (() => void) | null
  maximizeHandler: (() => void) | null
  unmaximizeHandler: (() => void) | null
  maximized: boolean
  minimized: boolean
  closed: boolean
  destroyed: boolean
  webContentsId: number
  webContents: Record<string, unknown>
  setMenu: (menu: unknown) => void
  setMenuBarVisibility: (visible: boolean) => void
  on: (event: string, handler: () => void) => void
  isDestroyed: () => boolean
  maximize: () => void
  unmaximize: () => void
  minimize: () => void
  isMaximized: () => boolean
  close: () => void
}

function createHost() {
  let openHandler:
    | ((details: { url: string; frameName: string; features: string }) => {
        action: string
        overrideBrowserWindowOptions?: Record<string, unknown>
      })
    | null = null
  let createWindowHandler: ((child: FakeChild, details: { frameName: string }) => void) | null = null

  const children: FakeChild[] = []
  const sent: unknown[][] = []
  const webContents = {
    setWindowOpenHandler: (handler: typeof openHandler) => {
      openHandler = handler
    },
    on: (event: string, handler: never) => {
      if (event === 'did-create-window') createWindowHandler = handler
    },
    send: (channel: string, payload: unknown) => {
      sent.push([channel, payload])
    }
  }

  return {
    children,
    sent,
    webContents,
    isDestroyed: () => false,
    open: (details: { url: string; frameName: string; features: string }) =>
      openHandler?.(details) ?? { action: 'missing' },
    createWindow: (frameName: string) => {
      let webContentsReadable = true
      const contents: Record<string, unknown> = {
        id: 900 + children.length,
        setWindowOpenHandler: (handler: typeof openHandler) => {
          child.openHandler = handler as never
        },
        on: (event: string, handler: (payload: unknown, url: string) => void) => {
          if (event === 'will-navigate') {
            child.navigations.push('registered')
            ;(child as unknown as { navigate: typeof handler }).navigate = handler
          }
        }
      }
      const child: FakeChild = {
        menuOverridden: false,
        openHandler: null,
        navigations: [],
        closedHandler: null,
        maximizeHandler: null,
        unmaximizeHandler: null,
        maximized: false,
        minimized: false,
        closed: false,
        destroyed: false,
        webContentsId: contents.id as number,
        // 与真实 Electron 一致：窗口销毁后读 `webContents` 抛 `Object has been destroyed`。
        // 这正是 `closed` 回调里最容易踩的坑。
        get webContents() {
          if (!webContentsReadable) throw new Error('Object has been destroyed')
          return contents
        },
        isDestroyed: () => child.destroyed,
        maximize: () => {
          child.maximized = true
          child.maximizeHandler?.()
        },
        unmaximize: () => {
          child.maximized = false
          child.unmaximizeHandler?.()
        },
        minimize: () => {
          child.minimized = true
        },
        isMaximized: () => child.maximized,
        close: () => {
          child.closed = true
          child.destroyed = true
          // 先销毁再回调：真实 Electron 的 `closed` 就是跑在窗口销毁之后的
          webContentsReadable = false
          child.closedHandler?.()
        },
        setMenu: () => {
          child.menuOverridden = true
        },
        setMenuBarVisibility: () => {},
        on: (event: string, handler: () => void) => {
          if (event === 'closed') child.closedHandler = handler
          if (event === 'maximize') child.maximizeHandler = handler
          if (event === 'unmaximize') child.unmaximizeHandler = handler
        }
      }
      children.push(child)
      createWindowHandler?.(child, { frameName })
      return child
    }
  }
}

describe('installAuxWindowSupport', () => {
  it('allows only about:blank windows with the panel frame prefix', () => {
    const host = createHost()
    installAuxWindowSupport(host as never, { onClosed: () => {} })

    expect(host.open({ url: 'https://example.com', frameName: 'x', features: '' }).action).toBe('deny')
    expect(host.open({ url: 'about:blank', frameName: 'other', features: '' }).action).toBe('deny')
    expect(host.open({ url: 'about:blank', frameName: `${AUX_FRAME_PREFIX}aux:1`, features: '' }).action).toBe('allow')
  })

  it('returns hardened window options with the same chrome as the main window', () => {
    const host = createHost()
    installAuxWindowSupport(host as never, { onClosed: () => {} })
    const result = host.open({
      url: 'about:blank',
      frameName: `${AUX_FRAME_PREFIX}aux:2`,
      features: 'width=600,height=500,left=40,top=40,bg=%231b1b1a'
    }) as { action: string; overrideBrowserWindowOptions: Record<string, unknown> }

    expect(result.action).toBe('allow')
    expect(result.overrideBrowserWindowOptions).toMatchObject({
      minWidth: AUX_MIN_WIDTH,
      minHeight: AUX_MIN_HEIGHT,
      backgroundColor: '#1b1b1a',
      width: 600,
      height: 500,
      x: 40,
      y: 40
    })
    // 与主窗口一致：Windows / Linux 无边框（自绘标题栏），macOS 保留红绿灯
    if (process.platform === 'darwin') {
      expect(result.overrideBrowserWindowOptions.frame).toBeUndefined()
      expect(result.overrideBrowserWindowOptions.titleBarStyle).toBe('hiddenInset')
      expect(result.overrideBrowserWindowOptions.trafficLightPosition).toEqual({ x: 12, y: 10 })
    } else {
      expect(result.overrideBrowserWindowOptions.frame).toBe(false)
      expect(result.overrideBrowserWindowOptions.titleBarStyle).toBeUndefined()
    }
  })

  it('hardens the child window and reports its close event', () => {
    const onClosed = vi.fn()
    const host = createHost()
    installAuxWindowSupport(host as never, { onClosed })
    host.open({ url: 'about:blank', frameName: `${AUX_FRAME_PREFIX}aux:3`, features: '' })

    const child = host.createWindow(`${AUX_FRAME_PREFIX}aux:3`)
    // 不能给子窗口单独设菜单：默认快捷键（Ctrl +/-/0、Ctrl+W）依附在继承来的应用菜单上
    expect(child.menuOverridden).toBe(false)
    expect(child.openHandler?.({ url: 'about:blank' })).toEqual({ action: 'deny' })
    expect(child.closedHandler).toBeTypeOf('function')

    child.closedHandler?.()
    expect(onClosed).toHaveBeenCalledWith(`${AUX_FRAME_PREFIX}aux:3`)
  })

  it('still docks the panel back when the window is already destroyed', () => {
    // 回归：`closed` 回调里读 `child.webContents` 会抛 `Object has been destroyed`，
    // 一旦抛在 onClosed 之前，主窗口永远收不到 `aux:window-closed`，面板就再也回不来
    const onClosed = vi.fn()
    const host = createHost()
    installAuxWindowSupport(host as never, { onClosed })
    const frameName = `${AUX_FRAME_PREFIX}aux:9`
    host.open({ url: 'about:blank', frameName, features: '' })
    const child = host.createWindow(frameName)

    expect(() => child.close()).not.toThrow()
    expect(onClosed).toHaveBeenCalledWith(frameName)
    expect(getAuxWindow(frameName)).toBeNull()
  })

  it('registers the child window so panel chrome commands address it', () => {
    const host = createHost()
    installAuxWindowSupport(host as never, { onClosed: () => {} })
    const frameName = `${AUX_FRAME_PREFIX}aux:7`
    host.open({ url: 'about:blank', frameName, features: '' })
    const child = host.createWindow(frameName)

    expect(getAuxWindow(frameName)).toBe(child)
    expect(readAuxWindowState(frameName).maximized).toBe(false)

    expect(runAuxWindowCommand(frameName, 'toggleMaximize')).toEqual({ success: true, maximized: true })
    expect(child.maximized).toBe(true)
    expect(runAuxWindowCommand(frameName, 'toggleMaximize')).toEqual({ success: true, maximized: false })
    expect(child.maximized).toBe(false)

    expect(runAuxWindowCommand(frameName, 'minimize')).toEqual({ success: true })
    expect(child.minimized).toBe(true)

    runAuxWindowCommand(frameName, 'close')
    expect(child.closed).toBe(true)
    // 关闭后不再持有窗口引用，后续命令失败而不是操作野指针
    expect(getAuxWindow(frameName)).toBeNull()
    expect(runAuxWindowCommand(frameName, 'close').success).toBe(false)
  })

  it('forwards the maximize state with the frame name', () => {
    const host = createHost()
    installAuxWindowSupport(host as never, { onClosed: () => {} })
    const frameName = `${AUX_FRAME_PREFIX}aux:8`
    host.open({ url: 'about:blank', frameName, features: '' })
    const child = host.createWindow(frameName)

    child.maximize()
    child.unmaximize()

    expect(host.sent).toEqual([
      ['window:maximized-changed', { host: frameName, maximized: true }],
      ['window:maximized-changed', { host: frameName, maximized: false }]
    ])
  })

  it('rejects unknown hosts and commands from the renderer', () => {
    const host = createHost()
    installAuxWindowSupport(host as never, { onClosed: () => {} })
    const frameName = `${AUX_FRAME_PREFIX}aux:9`
    host.open({ url: 'about:blank', frameName, features: '' })
    host.createWindow(frameName)
    registerAuxWindowIpc({ getMainWindow: () => null })

    const command = mocks.handlers.get('aux:window-command')!
    expect(command({} as never, 'main', 'close')).toEqual({ success: false, error: 'Invalid host' })
    expect(command({} as never, frameName, 'explode')).toEqual({
      success: false,
      error: 'Invalid command'
    })
    expect(command({} as never, `${AUX_FRAME_PREFIX}aux:404`, 'close')).toEqual({
      success: false,
      error: 'No such aux window'
    })

    const state = mocks.handlers.get('aux:window-state')!
    expect(state({} as never, 42)).toEqual({ success: false, error: 'Invalid host' })
    expect(state({} as never, frameName)).toEqual({ success: true, maximized: false })
  })
})
