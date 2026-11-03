/**
 * 程序内控制台（远程页面）。
 *
 * 它是一个原生 `WebContentsView`，盖在窗口内容之上：位置由渲染层实测后上报，
 * 可见性由主进程控制（CSS 管不到原生层）。安全上是独立的浏览器环境：
 * 独立 partition、sandbox、无 preload、外链与导航白名单、权限全拒。
 */

import { WebContentsView, shell, type BrowserWindow, type Rectangle } from 'electron'

const ALLOWED_HOSTS = new Set(['dash.tchen-xiaoxiao.com'])
const PARTITION = 'persist:hermes-dashboard'
const MIN_WIDTH = 80
const MIN_HEIGHT = 80

/** 同一个 partition 的 session 是共享的：事件处理器只挂一次，否则视图重建会越挂越多 */
const configuredSessions = new WeakSet<Electron.Session>()

export interface CloudDashboardDeps {
  getWindow: () => BrowserWindow | null
  onLoadFailed: (payload: { code: number; description: string }) => void
  /** 一次加载收尾（成功或失败都会来）：渲染层据此关掉加载态 */
  onLoadSettled: () => void
  /** 页面里按 Esc：交回渲染层改状态 */
  onRequestClose: () => void
  onTitleChange?: (title: string) => void
}

function hostAllowed(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return ALLOWED_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

export interface DashboardSnapshot {
  visible: boolean
  loading: boolean
  url: string
  error: string | null
}

export class CloudDashboard {
  private view: WebContentsView | null = null
  private bounds: Rectangle | null = null
  private wantedVisible = false
  private loading = false
  private error: string | null = null
  /** 本次加载是否已失败：失败后 did-stop-loading 不能把错误态清掉 */
  private loadFailed = false
  private currentUrl = ''

  constructor(private readonly deps: CloudDashboardDeps) {}

  /** 当前窗口挂载点；窗口重建后视图需要重新 attach */
  private attach(): void {
    const win = this.deps.getWindow()
    const view = this.view
    if (!win || !view) return
    const children = win.contentView.children
    if (!children.includes(view)) win.contentView.addChildView(view)
  }

  private ensureView(url: string): WebContentsView | null {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view
    const win = this.deps.getWindow()
    if (!win) return null

    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        // 远程页面：不给 Node、不给 preload、开沙箱
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
      },
    })

    view.setBackgroundColor('#ffffff')
    const contents = view.webContents
    contents.setWindowOpenHandler(({ url: target }) => {
      // 控制台里的外链交给系统浏览器，绝不在应用内开新窗口
      if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, target) => {
      if (!hostAllowed(target)) event.preventDefault()
    })
    contents.on('did-start-loading', () => {
      this.loading = true
      this.loadFailed = false
    })
    contents.on('did-stop-loading', () => {
      this.loading = false
      // 成功加载（或重试成功）要把上一次的错误清掉，否则渲染层会一直以为控制台是坏的
      if (!this.loadFailed) this.error = null
      this.deps.onLoadSettled()
    })
    contents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
      // -3 = ERR_ABORTED（我们自己触发的导航），不算失败
      if (!isMainFrame || code === -3) return
      this.loading = false
      this.loadFailed = true
      this.error = description || String(code)
      this.deps.onLoadFailed({ code, description: this.error })
      void validatedURL
    })
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        this.deps.onRequestClose()
      }
    })
    contents.on('page-title-updated', (_event, title) => {
      this.deps.onTitleChange?.(title)
    })

    const session = contents.session
    if (!configuredSessions.has(session)) {
      configuredSessions.add(session)
      session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      session.on('will-download', (event) => event.preventDefault())
    }

    this.view = view
    this.currentUrl = url
    this.error = null
    this.loading = true
    this.loadFailed = false
    void contents.loadURL(url).catch((loadError: unknown) => {
      this.loading = false
      this.error = loadError instanceof Error ? loadError.message : String(loadError)
    })
    return view
  }

  open(url: string): void {
    this.wantedVisible = true
    this.error = null
    const view = this.ensureView(url)
    if (!view) return
    this.attach()
    // 还没收到渲染层上报的矩形时先不显示：否则会先闪一屏 80x80 的错位窗口
    if (this.bounds) {
      view.setBounds(this.bounds)
      view.setVisible(true)
    } else {
      view.setVisible(false)
    }
  }

  close(): void {
    this.wantedVisible = false
    if (this.view && !this.view.webContents.isDestroyed()) this.view.setVisible(false)
  }

  /**
   * 渲染层实测的矩形（CSS px = DIP，zoomFactor=1）。
   * visible=false 表示页面此刻不该被看到（切页 / 弹窗 / 窗口后台）。
   */
  setBounds(rect: Rectangle, visible: boolean): void {
    const width = Math.max(MIN_WIDTH, Math.round(rect.width))
    const height = Math.max(MIN_HEIGHT, Math.round(rect.height))
    this.bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width, height }
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return
    view.setBounds(this.bounds)
    view.setVisible(this.wantedVisible && visible)
  }

  reload(): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) {
      if (this.currentUrl) this.open(this.currentUrl)
      return
    }
    this.error = null
    this.loading = true
    this.loadFailed = false
    view.webContents.reload()
  }

  /** 窗口最小化 / 隐藏到托盘时，原生层不会自己跟着消失 */
  hide(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.setVisible(false)
  }

  show(): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed() || !this.wantedVisible || !this.bounds) return
    view.setVisible(true)
  }

  destroy(): void {
    const view = this.view
    this.view = null
    this.wantedVisible = false
    if (!view) return
    const win = this.deps.getWindow()
    if (win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(view)
      } catch {
        // 窗口已销毁：不用清理父子关系
      }
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  snapshot(): DashboardSnapshot {
    return {
      visible: Boolean(this.view && this.wantedVisible),
      loading: this.loading,
      url: this.currentUrl,
      error: this.error,
    }
  }
}
