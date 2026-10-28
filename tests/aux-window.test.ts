import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  cursor: { x: 500, y: 400 },
  display: { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
}))

vi.mock('electron', () => ({
  // 测试替身不提供 isReady：isTrustedIpcSender 会直接放行
  app: {},
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
}))

const {
  AUX_FRAME_PREFIX,
  AUX_MIN_HEIGHT,
  AUX_MIN_WIDTH,
  computeDetachedRect,
  installAuxWindowSupport,
  isPointInBounds,
  parseAuxWindowFeatures,
  registerAuxWindowIpc,
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
    expect(Object.keys(result).sort()).toEqual(
      ['backgroundColor', 'height', 'width', 'x', 'y'].sort()
    )
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

interface FakeChild {
  menuCleared: boolean
  openHandler: ((details: { url: string }) => { action: string }) | null
  navigations: string[]
  closedHandler: (() => void) | null
  webContents: Record<string, unknown>
  setMenu: (menu: unknown) => void
  setMenuBarVisibility: (visible: boolean) => void
  on: (event: string, handler: () => void) => void
}

function createHost() {
  let openHandler: ((details: {
    url: string
    frameName: string
    features: string
  }) => { action: string; overrideBrowserWindowOptions?: Record<string, unknown> }) | null = null
  let createWindowHandler: ((child: FakeChild, details: { frameName: string }) => void) | null = null

  const children: FakeChild[] = []
  const webContents = {
    setWindowOpenHandler: (handler: typeof openHandler) => {
      openHandler = handler
    },
    on: (event: string, handler: never) => {
      if (event === 'did-create-window') createWindowHandler = handler
    },
  }

  return {
    children,
    webContents,
    isDestroyed: () => false,
    open: (details: { url: string; frameName: string; features: string }) =>
      openHandler?.(details) ?? { action: 'missing' },
    createWindow: (frameName: string) => {
      const child: FakeChild = {
        menuCleared: false,
        openHandler: null,
        navigations: [],
        closedHandler: null,
        webContents: {
          setWindowOpenHandler: (handler: typeof openHandler) => {
            child.openHandler = handler as never
          },
          on: (event: string, handler: (payload: unknown, url: string) => void) => {
            if (event === 'will-navigate') {
              child.navigations.push('registered')
              ;(child as unknown as { navigate: typeof handler }).navigate = handler
            }
          },
        },
        setMenu: () => {
          child.menuCleared = true
        },
        setMenuBarVisibility: () => {},
        on: (event: string, handler: () => void) => {
          if (event === 'closed') child.closedHandler = handler
        },
      }
      children.push(child)
      createWindowHandler?.(child, { frameName })
      return child
    },
  }
}

describe('installAuxWindowSupport', () => {
  it('allows only about:blank windows with the panel frame prefix', () => {
    const host = createHost()
    installAuxWindowSupport(host as never, { onClosed: () => {} })

    expect(host.open({ url: 'https://example.com', frameName: 'x', features: '' }).action).toBe(
      'deny'
    )
    expect(host.open({ url: 'about:blank', frameName: 'other', features: '' }).action).toBe('deny')
    expect(
      host.open({ url: 'about:blank', frameName: `${AUX_FRAME_PREFIX}aux:1`, features: '' }).action
    ).toBe('allow')
  })

  it('returns hardened window options with a native frame', () => {
    const host = createHost()
    installAuxWindowSupport(host as never, { onClosed: () => {} })
    const result = host.open({
      url: 'about:blank',
      frameName: `${AUX_FRAME_PREFIX}aux:2`,
      features: 'width=600,height=500,left=40,top=40,bg=%231b1b1a',
    }) as { action: string; overrideBrowserWindowOptions: Record<string, unknown> }

    expect(result.action).toBe('allow')
    expect(result.overrideBrowserWindowOptions).toMatchObject({
      frame: true,
      minWidth: AUX_MIN_WIDTH,
      minHeight: AUX_MIN_HEIGHT,
      backgroundColor: '#1b1b1a',
      width: 600,
      height: 500,
      x: 40,
      y: 40,
    })
  })

  it('hardens the child window and reports its close event', () => {
    const onClosed = vi.fn()
    const host = createHost()
    installAuxWindowSupport(host as never, { onClosed })
    host.open({ url: 'about:blank', frameName: `${AUX_FRAME_PREFIX}aux:3`, features: '' })

    const child = host.createWindow(`${AUX_FRAME_PREFIX}aux:3`)
    expect(child.menuCleared).toBe(true)
    expect(child.openHandler?.({ url: 'about:blank' })).toEqual({ action: 'deny' })
    expect(child.closedHandler).toBeTypeOf('function')

    child.closedHandler?.()
    expect(onClosed).toHaveBeenCalledWith(`${AUX_FRAME_PREFIX}aux:3`)
  })
})
