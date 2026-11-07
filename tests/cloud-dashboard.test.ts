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
    session = mocks.session

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
  /** 同一个 partition 的 session 在真实 Electron 里是共享的：测试里也共享 */
  const session = {
    permissionHandler: null as
      | ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void)
      | null,
    onCounts: new Map<string, number>(),
    handlers: new Map<string, Handler>(),
    setPermissionRequestHandler(
      handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void
    ) {
      this.permissionHandler = handler
    },
    on(event: string, handler: Handler) {
      this.onCounts.set(event, (this.onCounts.get(event) ?? 0) + 1)
      this.handlers.set(event, handler)
    },
  }
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

  return { views, external, window, session, WebContentsView }
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

const DASH_URL = 'https://dash.example.com/'

function makeDashboard() {
  const events = {
    loadFailed: [] as Array<{ code: number; description: string }>,
    loadSettled: 0,
    closed: 0,
  }
  const dashboard = new CloudDashboard({
    getWindow: () => mocks.window as never,
    onLoadFailed: (payload) => events.loadFailed.push(payload),
    onLoadSettled: () => {
      events.loadSettled += 1
    },
    onRequestClose: () => {
      events.closed += 1
    },
    getAllowedUrl: () => DASH_URL,
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
    // 页面还没说它在前台：视图不该挂在窗口上（挂上就有可能被窗口事件点亮）
    expect(mocks.window.contentView.children).not.toContain(created)
    // 也还没收到渲染层上报的矩形：先不显示，避免闪一屏 80x80 的错位窗口
    expect(created.visible).toBe(false)
    dashboard.setBounds({ x: 0, y: 34, width: 1200, height: 766 }, true)
    expect(mocks.window.contentView.children).toContain(created)
    expect(created.visible).toBe(true)
    expect(dashboard.snapshot().visible).toBe(true)
  })

  it('hides on close and reuses the same view on reopen', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    dashboard.setBounds({ x: 0, y: 34, width: 800, height: 600 }, true)
    dashboard.close()
    expect(view().visible).toBe(false)
    expect(dashboard.snapshot().visible).toBe(false)
    // 关闭之后窗口再怎么唤回也不该出现
    dashboard.sync()
    expect(view().visible).toBe(false)

    dashboard.open(DASH_URL)
    expect(mocks.views).toHaveLength(1)
    dashboard.setBounds({ x: 0, y: 34, width: 1200, height: 766 }, true)
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

  it('detaches from the window whenever the page says it is not on screen', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    const created = view()

    dashboard.setBounds({ x: 0, y: 34, width: 800, height: 600 }, true)
    expect(mocks.window.contentView.children).toContain(created)

    // 切页 / 卸下控制台页：直接摘掉，没挂着的视图不可能被任何路径点亮
    dashboard.setBounds({ x: 0, y: 34, width: 800, height: 600 }, false)
    expect(mocks.window.contentView.children).not.toContain(created)
    expect(dashboard.snapshot().visible).toBe(false)
    // 页面状态不丢，回来还是热的
    expect(mocks.views).toHaveLength(1)
  })

  it('window show/restore never lights the console up on its own', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    const created = view()

    // 用户在一次控制台访问之后切走（页面推 visible:false）
    dashboard.setBounds({ x: 0, y: 34, width: 800, height: 600 }, true)
    dashboard.setBounds({ x: 0, y: 34, width: 800, height: 600 }, false)

    // 托盘唤回 / 通知点击 / 第二实例：窗口 show 与 restore 都会来一遍
    dashboard.sync()
    expect(created.visible).toBe(false)
    expect(mocks.window.contentView.children).not.toContain(created)
    dashboard.sync()
    expect(created.visible).toBe(false)

    // 只有页面重新说「我可见」时才回来
    dashboard.setBounds({ x: 0, y: 34, width: 800, height: 600 }, true)
    dashboard.sync()
    expect(created.visible).toBe(true)
    expect(mocks.window.contentView.children).toContain(created)
  })

  it('restores the page-requested state after a minimize/restore cycle', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    const created = view()
    dashboard.setBounds({ x: 0, y: 34, width: 800, height: 600 }, true)

    dashboard.hide()
    expect(created.visible).toBe(false)
    // 页面没切走：窗口回来时该恢复原样
    dashboard.sync()
    expect(created.visible).toBe(true)
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
    const { dashboard } = makeDashboard()
    dashboard.open(DASH_URL)
    const handler = mocks.session.permissionHandler
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

  it('stays hidden until the renderer reports its rectangle', () => {
    const { dashboard, view } = makeDashboard()
    dashboard.open(DASH_URL)
    expect(view().visible).toBe(false)

    dashboard.setBounds({ x: 0, y: 34, width: 800, height: 600 }, true)
    expect(view().visible).toBe(true)

    // 切页只隐藏，不销毁：回来是热的
    dashboard.setBounds({ x: 0, y: 34, width: 800, height: 600 }, false)
    expect(view().visible).toBe(false)
    dashboard.setBounds({ x: 0, y: 34, width: 800, height: 600 }, true)
    expect(view().visible).toBe(true)
    expect(mocks.views).toHaveLength(1)
  })

  it('clears a previous failure once a later load settles', () => {
    const { dashboard, events, view } = makeDashboard()
    dashboard.open(DASH_URL)
    const contents = view().webContents

    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', DASH_URL, true)
    contents.emit('did-stop-loading')
    // 失败后 did-stop-loading 也会来：不能顺手把错误抹掉
    expect(dashboard.snapshot().error).toBe('ERR_NAME_NOT_RESOLVED')
    expect(events.loadSettled).toBe(1)

    // 重试成功：did-start-loading 重置失败标记，收尾时才清错误
    contents.emit('did-start-loading')
    contents.emit('did-stop-loading')
    expect(dashboard.snapshot().error).toBeNull()
    expect(dashboard.snapshot().loading).toBe(false)
    expect(events.loadSettled).toBe(2)
  })

  it('configures the shared session only once across view recreations', () => {
    const { dashboard } = makeDashboard()
    dashboard.open(DASH_URL)
    expect(mocks.session.onCounts.get('will-download')).toBe(1)
    dashboard.destroy()
    dashboard.open(DASH_URL)
    expect(mocks.views).toHaveLength(2)
    expect(mocks.session.onCounts.get('will-download')).toBe(1)
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

describe('白名单跟着配置走', () => {
  it('only allows the configured console host, not a hardcoded one', async () => {
    const { hostAllowed } = await import('../electron/cloud/dashboard')
    expect(hostAllowed('https://dash.my-own.host/settings', 'https://dash.my-own.host')).toBe(true)
    expect(hostAllowed('https://dash.example.com/', 'https://dash.my-own.host')).toBe(false)
    // 明文不放行
    expect(hostAllowed('http://dash.my-own.host/', 'https://dash.my-own.host')).toBe(false)
    expect(hostAllowed('not a url', 'https://dash.my-own.host')).toBe(false)
  })
})
