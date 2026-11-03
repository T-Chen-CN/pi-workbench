import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => void

/**
 * electron 在主进程之外不存在：这里造一个最小的 WebContentsView 替身，
 * 记录 webPreferences、bounds、可见性与各事件处理器，用来验证安全硬化与布局同步。
 */
const mocks = vi.hoisted(() => {
  class FakeWebContents {
    destroyed = false
    handlers = new Map<string, Handler>()
    windowOpenHandler: ((details: { url: string }) => unknown) | null = null
    permissionHandler:
      | ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void)
      | null = null
    loadedUrl = ''
    reloads = 0
    sessionHandlers = new Map<string, Handler>()
    session = {
      setPermissionRequestHandler: (
        handler: (
          contents: unknown,
          permission: string,
          callback: (granted: boolean) => void
        ) => void
      ) => {
        this.permissionHandler = handler
      },
      on: (event: string, handler: Handler) => {
        this.sessionHandlers.set(event, handler)
      },
    }

    setWindowOpenHandler(handler: (details: { url: string }) => unknown): void {
      this.windowOpenHandler = handler
    }

    on(event: string, handler: Handler): void {
      this.handlers.set(event, handler)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    close(): void {
      this.destroyed = true
    }

    async loadURL(url: string): Promise<void> {
      this.loadedUrl = url
    }

    reload(): void {
      this.reloads += 1
    }

    emit(event: string, ...args: unknown[]): void {
      this.handlers.get(event)?.(...args)
    }
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents()
    options: { webPreferences?: Record<string, unknown> } = {}
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    visible = true

    constructor(options: { webPreferences?: Record<string, unknown> } = {}) {
      this.options = options
    }

    setBackgroundColor(): void {}

    setBounds(bounds: { x: 0, y: 0; width: number; height: number }): void {
      this.bounds = bounds as typeof this.bounds
    }

    setVisible(visible: boolean): void {
      this.visible = visible
    }

    getVisible(): boolean {
      return this.visible
    }
  }

  const views: FakeWebContentsView[] = []
  const external: string[] = []
  const window = {
    contentView: {
      children: [] as FakeWebContentsView[],
      addChildView(view: FakeWebContentsView) {
        if (!this.children.includes(view)) this.children.push(view)
      },
      removeChildView(view: FakeWebContentsView) {
        this.children = this.children.filter((item) => item !== view)
      },
    },
    isDestroyed: () => false,
    on: () => {},
  }

  class WebContentsView extends FakeWebContentsView {
    constructor(options: { webPreferences?: Record<string, unknown> } = {}) {
      super(options)
      views.push(this)
    }
  }

  return { views, external, window, WebContentsView }
})

vi.mock('electron', () => ({
  WebContentsView: mocks.WebContentsView,
  shell: {
    openExternal: async (url: string) => {
      mocks.external.push(url)
    },
  },
}))

import { CloudDashboard } from '../electron/cloud/dashboard'

const DASH_URL = 'https://dash.tchen-xiaoxiao.com/'

function makeDashboard() {
  const events = {
    loadFailed: [] as Array<{ code: number; description: string }>,
    closed: 0,
  }
  const dashboard = new CloudDashboard({
    getWindow: () => mocks.window as never,
    onLoadFailed: (payload) => events.loadFailed.push(payload),
    onRequestClose: () => {
      events.closed += 1
    },
  })
  const view = () => mocks.views[mocks.views.length - 1]
  return { dashboard, events, view }
}

beforeEach(() => {
  mocks.views.length = 0
  mocks.external.length = 0
  mocks.window.contentView.children = []
})

describe('CloudDashboard', () => {
  it('creates a sandboxed view in its own partition and loads the dashboard', async () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)

    const created = view()
    expect(created.options.webPreferences).toMatchObject({
      partition: 'persist:hermes-dashboard',
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    })
    expect(created.options.webPreferences).not.toHaveProperty('preload')
    await Promise.resolve()
    expect(created.webContents.loadedUrl).toBe(DASH_URL)
    expect(mocks.window.contentView.children).toContain(created)
    expect(created.visible).toBe(true)
    expect(dashboard.snapshot().visible).toBe(true)
  })

  it('hides on close and reuses the same view on reopen', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    dashboard.close()
    expect(view().visible).toBe(false)
    expect(dashboard.snapshot().visible).toBe(false)

    dashboard.open(DASH_URL)
    expect(mocks.views).toHaveLength(1)
    expect(view().visible).toBe(true)
  })

  it('applies reported bounds and hides when the renderer says so', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    dashboard.setBounds({ x: 10, y: 20, width: 400, height: 300 }, true)
    expect(view().bounds).toEqual({ x: 10, y: 20, width: 400, height: 300 })

    dashboard.setBounds({ x: 10, y: 20, width: 400, height: 300 }, false)
    expect(view().visible).toBe(false)
  })

  it('clamps tiny bounds so the view never collapses to 0px', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    dashboard.setBounds({ x: 0, y: 0, width: 1, height: 1 }, true)
    expect(view().bounds.width).toBeGreaterThanOrEqual(80)
    expect(view().bounds.height).toBeGreaterThanOrEqual(80)
  })

  it('blocks navigation away from the dashboard host', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    const contents = view().webContents

    const blocked = {
      prevented: false,
      preventDefault() {
        blocked.prevented = true
      },
    }
    contents.emit('will-navigate', blocked, 'https://evil.example.com/')
    expect(blocked.prevented).toBe(true)

    const allowed = {
      prevented: false,
      preventDefault() {
        allowed.prevented = true
      },
    }
    contents.emit('will-navigate', allowed, `${DASH_URL}settings`)
    expect(allowed.prevented).toBe(false)
  })

  it('denies in-app windows and hands http links to the system browser', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    const result = view().webContents.windowOpenHandler?.({ url: 'https://example.com/docs' })
    expect(result).toEqual({ action: 'deny' })
    expect(mocks.external).toEqual(['https://example.com/docs'])
  })

  it('denies every permission request', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    const handler = view().webContents.permissionHandler
    expect(handler).toBeTruthy()
    let granted: boolean | null = null
    handler?.(null, 'geolocation', (value) => {
      granted = value
    })
    expect(granted).toBe(false)
  })

  it('reports main-frame load failures but ignores aborted navigations', () => {
    const { dashboard, events, view } = makeDashboard()
    dashboard.open(DASH_URL)
    const contents = view().webContents

    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', DASH_URL, true)
    expect(events.loadFailed).toHaveLength(0)

    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', DASH_URL, true)
    expect(events.loadFailed).toEqual([{ code: -105, description: 'ERR_NAME_NOT_RESOLVED' }])
    expect(dashboard.snapshot().error).toBe('ERR_NAME_NOT_RESOLVED')
  })

  it('asks the renderer to close on Escape', () => {
    const { dashboard, events, view } = makeDashboard()
    dashboard.open(DASH_URL)
    view().webContents.emit('before-input-event', { preventDefault() {} }, {
      type: 'keyDown',
      key: 'Escape',
    })
    expect(events.closed).toBe(1)
  })

  it('reloads the loaded page', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    dashboard.reload()
    expect(view().webContents.reloads).toBe(1)
  })

  it('detaches and closes the view on destroy', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    const created = view()
    dashboard.destroy()
    expect(mocks.window.contentView.children).not.toContain(created)
    expect(created.webContents.destroyed).toBe(true)
  })
})
