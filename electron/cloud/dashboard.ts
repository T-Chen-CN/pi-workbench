/**
 * 程序内控制台（远程页面）。
 *
 * 它是一个原生 `WebContentsView`，盖在窗口内容之上：位置与可见性都由渲染层实测后上报
 * （CSS 管不到原生层）。**可见性的唯一真相是「控制台页此刻在不在前台」**：页面说不可见时
 * 视图直接从窗口上摘掉（`removeChildView`），窗口最小化/托盘唤回这类事件只负责把视图
 * 恢复到页面最后要求的状态，绝不自己点亮它 —— 否则控制台会盖在别的页面上。
 * 安全上是独立的浏览器环境：独立 partition、sandbox、无 preload、外链与导航白名单、权限全拒。
 */

import { WebContentsView, shell, type BrowserWindow, type Rectangle } from 'electron'

/**
 * 控制台地址是用户可配的（连接页能改），域名白名单不能写死。
 * 这里只放行「当前配置的控制台主机」，其余导航一律拦掉。
 */
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
  /** 当前配置的控制台地址：导航白名单跟着它走 */
  getAllowedUrl: () => string
}

export function hostAllowed(url: string, allowedUrl: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const allowed = new URL(allowedUrl)
    return parsed.hostname.toLowerCase() === allowed.hostname.toLowerCase()
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
  /** 页面（渲染层）最后一次要求的状态：true = 控制台页此刻在前台 */
  private pageVisible = false
  private loading = false
  private error: string | null = null
  /** 本次加载是否已失败：失败后 did-stop-loading 不能把错误态清掉 */
  private loadFailed = false
  private currentUrl = ''

  constructor(private readonly deps: CloudDashboardDeps) {}

  /** 挂到当前窗口（窗口重建后需要重新挂）；只有页面要求可见时才会走到这里 */
  private attachView(): void {
    const win = this.deps.getWindow()
    const view = this.view
    if (!win || win.isDestroyed() || !view) return
    const children = win.contentView.children
    if (!children.includes(view)) win.contentView.addChildView(view)
  }

  /** 从窗口上摘掉：没挂着的视图不可能被任何路径点亮 */
  private detachView(): void {
    const view = this.view
    const win = this.deps.getWindow()
    if (!view || !win || win.isDestroyed()) return
    if (!win.contentView.children.includes(view)) return
    try {
      win.contentView.removeChildView(view)
    } catch {
      // 窗口正在销毁：父子关系交给窗口自己收
    }
  }

  private isAttached(): boolean {
    const win = this.deps.getWindow()
    const view = this.view
    if (!win || win.isDestroyed() || !view) return false
    return win.contentView.children.includes(view)
  }

  /** 把「页面要的可见性 + 最近一次矩形」落到视图上（挂载/摘除也在这里决定） */
  private apply(): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return
    if (!this.pageVisible || !this.bounds) {
      view.setVisible(false)
      this.detachView()
      return
    }
    this.attachView()
    view.setBounds(this.bounds)
    view.setVisible(true)
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
      if (!hostAllowed(target, this.deps.getAllowedUrl())) event.preventDefault()
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

  /**
   * 打开（创建/复用）远程页面。
   *
   * 这里**不显示**：渲染层紧接着会用 `setBounds` 报「此刻该不该看到」，
   * 还没报就先藏着 —— 否则会先闪一屏 80x80 的错位窗口。
   */
  open(url: string): void {
    this.error = null
    if (!this.ensureView(url)) return
    this.apply()
  }

  close(): void {
    this.pageVisible = false
    this.apply()
  }

  /**
   * 渲染层实测的矩形（CSS px = DIP，zoomFactor=1）。
   * visible=false 表示页面此刻不该被看到（切页 / 卸载 / 弹窗 / 窗口后台）：
   * 此时直接把视图从窗口上摘掉，而不是只 `setVisible(false)`。
   */
  setBounds(rect: Rectangle, visible: boolean): void {
    const width = Math.max(MIN_WIDTH, Math.round(rect.width))
    const height = Math.max(MIN_HEIGHT, Math.round(rect.height))
    this.bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width, height }
    this.pageVisible = visible
    this.apply()
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

  /**
   * 窗口最小化 / 隐藏到托盘时，原生层不会自己跟着消失。
   * 只藏起来，不改 `pageVisible` —— 窗口回来时 `sync()` 恢复成页面要的样子。
   */
  hide(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.setVisible(false)
  }

  /**
   * 窗口重新显示（restore / show）时调用。
   * 只把视图恢复到页面最后要求的状态：控制台不在前台时它连窗口都没挂着。
   * 这里刻意不叫 `show()` —— 曾经那版会无条件点亮，托盘唤回/通知点击就把控制台糊到当前页面上。
   */
  sync(): void {
    this.apply()
  }

  destroy(): void {
    const view = this.view
    this.view = null
    this.pageVisible = false
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
      visible: Boolean(this.view && this.pageVisible && this.isAttached()),
      loading: this.loading,
      url: this.currentUrl,
      error: this.error,
    }
  }
}
