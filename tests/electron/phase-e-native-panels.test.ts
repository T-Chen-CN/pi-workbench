// @vitest-environment node
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeWindow {
  options: Record<string, unknown>
  loadedUrls: string[]
  sent: Array<[string, unknown]>
  openHandler: ((details: { url: string; referrer?: { url?: string } }) => { action: string }) | null
  willNavigateHandler: ((event: { preventDefault: () => void }, url: string) => void) | null
  willAttachWebviewHandler: ((event: { preventDefault: () => void }) => void) | null
  closedHandler: (() => void) | null
  destroyed: boolean
  webContentsId: number
  webContents: {
    id: number
    mainFrame: { url: string }
    isDestroyed: () => boolean
    send: (channel: string, payload: unknown) => void
    setWindowOpenHandler: (
      handler: (details: { url: string; referrer?: { url?: string } }) => { action: string }
    ) => void
    on: (event: string, handler: (...args: unknown[]) => void) => void
  }
  isDestroyed: () => boolean
  isMaximized: () => boolean
  isMinimized: () => boolean
  isVisible: () => boolean
  show: () => void
  focus: () => void
  restore: () => void
  close: () => void
  setMenuBarVisibility: (visible: boolean) => void
  loadURL: (url: string) => Promise<void>
  on: (event: string, handler: () => void) => void
}

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const allWindows: FakeWindow[] = []
  let nextWcId = 200
  const externalUrls: string[] = []

  class FakeBrowserWindow implements FakeWindow {
    static getAllWindows(): FakeWindow[] {
      return allWindows.filter((win) => !win.destroyed)
    }

    options: Record<string, unknown>
    loadedUrls: string[] = []
    sent: Array<[string, unknown]> = []
    openHandler: ((details: { url: string; referrer?: { url?: string } }) => { action: string }) | null =
      null
    willNavigateHandler: ((event: { preventDefault: () => void }, url: string) => void) | null = null
    willAttachWebviewHandler: ((event: { preventDefault: () => void }) => void) | null = null
    closedHandler: (() => void) | null = null
    destroyed = false
    webContentsId: number
    private readable = true
    private innerWebContents: FakeWindow['webContents']

    constructor(options: Record<string, unknown> = {}) {
      this.options = options
      this.webContentsId = nextWcId++
      this.innerWebContents = {
        id: this.webContentsId,
        mainFrame: { url: 'pw-app://bundle/index.html' },
        isDestroyed: () => this.destroyed,
        send: (channel: string, payload: unknown) => {
          this.sent.push([channel, payload])
        },
        setWindowOpenHandler: (handler) => {
          this.openHandler = handler
        },
        on: (event, handler) => {
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
      allWindows.push(this)
    }

    get webContents(): FakeWindow['webContents'] {
      if (!this.readable) throw new Error('Object has been destroyed')
      return this.innerWebContents
    }

    isDestroyed = () => this.destroyed
    isMaximized = () => false
    isMinimized = () => false
    isVisible = () => !this.destroyed
    show = () => {}
    focus = () => {}
    restore = () => {}
    close = () => {
      if (this.destroyed) return
      this.destroyed = true
      this.readable = false
      this.closedHandler?.()
    }
    setMenuBarVisibility = () => {}
    loadURL = async (url: string) => {
      this.loadedUrls.push(url)
      this.innerWebContents.mainFrame.url = url
    }
    on = (event: string, handler: () => void) => {
      if (event === 'closed') this.closedHandler = handler
    }
  }

  return {
    handlers,
    allWindows,
    FakeBrowserWindow,
    externalUrls,
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    isReady: () => true,
    getAppPath: () => os.tmpdir(),
    getPath: () => os.tmpdir(),
  },
  BrowserWindow: mocks.FakeBrowserWindow,
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    },
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 500, y: 400 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  shell: {
    openExternal: async (url: string) => {
      mocks.externalUrls.push(url)
    },
  },
}))

const { trustWorkspace } = await import('../../electron/workspace-trust')
const { configureIpcWindow, isTrustedIpcSender } = await import('../../electron/ipc/register')
const { TerminalManager } = await import('../../electron/terminal-manager')
const {
  AUX_FRAME_PREFIX,
  closeAllDetachedPanelWindows,
  getAuxWindow,
  installAuxWindowSupport,
  registerAuxWindowIpc,
} = await import('../../electron/aux-window')

let workspaceDir = ''
let mainWin: FakeWindow

function createMainEvent() {
  return {
    sender: mainWin.webContents,
    senderFrame: mainWin.webContents.mainFrame,
  }
}

beforeAll(() => {
  workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-phase-e-panels-')))
  trustWorkspace(workspaceDir)
})

afterAll(() => {
  closeAllDetachedPanelWindows()
  fs.rmSync(workspaceDir, { recursive: true, force: true })
})

beforeEach(() => {
  closeAllDetachedPanelWindows()
  mocks.allWindows.length = 0
  mocks.handlers.clear()
  mocks.externalUrls.length = 0

  mainWin = new mocks.FakeBrowserWindow({})
  mainWin.webContents.mainFrame.url = 'pw-app://bundle/index.html'
  configureIpcWindow(() => mainWin as unknown as Electron.BrowserWindow)
  registerAuxWindowIpc({
    getMainWindow: () => mainWin as unknown as Electron.BrowserWindow,
    preloadPath: '/dist-electron/preload.cjs',
    resolveTheme: () => 'light',
    resolveLanguage: () => 'zh',
  })
})

describe('Phase E · Native Multi-BrowserWindow Panel Detachment', () => {
  it('creates a native BrowserWindow with preload, trustIpcSender, NO parent (Q5), and pw-app panel URL', () => {
    const detach = mocks.handlers.get('panel:detach')!
    const result = detach(createMainEvent(), {
      workspaceDir,
      panel: 'files',
      hostId: 'aux:1',
      title: 'demo-ws',
      rect: { x: 100, y: 120, width: 520, height: 640 },
      theme: 'dark',
      language: 'en',
    })

    expect(result).toEqual({
      success: true,
      hostId: 'aux:1',
      frameName: `${AUX_FRAME_PREFIX}aux:1`,
    })

    const child = getAuxWindow(`${AUX_FRAME_PREFIX}aux:1`) as unknown as FakeWindow
    expect(child).toBeTruthy()
    // Q5 铁律：拆出窗口绝不能设 parent，确保主窗口收托盘 hide() 时拆窗留在屏幕上
    expect(child.options.parent).toBeUndefined()
    expect(child.options.webPreferences).toMatchObject({
      preload: '/dist-electron/preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    })

    expect(child.loadedUrls).toHaveLength(1)
    const parsed = new URL(child.loadedUrls[0])
    expect(parsed.protocol).toBe('pw-app:')
    expect(parsed.hostname).toBe('bundle')
    expect(parsed.pathname).toBe('/index.html')
    expect(parsed.searchParams.get('windowMode')).toBe('panel')
    expect(parsed.searchParams.get('panel')).toBe('files')
    expect(parsed.searchParams.get('workspace')).toBe(workspaceDir)
    expect(parsed.searchParams.get('hostId')).toBe('aux:1')
    expect(parsed.searchParams.get('theme')).toBe('dark')
    expect(parsed.searchParams.get('lang')).toBe('en')
    expect(parsed.searchParams.get('boot')).toBe('0')

    // 拆出窗口已登记为受信任 IPC 来源，且只放行 pw-app:// 帧（拒绝 about:blank）
    expect(
      isTrustedIpcSender({
        sender: child.webContents,
        senderFrame: child.webContents.mainFrame,
      } as unknown as Electron.IpcMainInvokeEvent)
    ).toBe(true)

    const blankFrame = { url: 'about:blank' }
    expect(
      isTrustedIpcSender({
        sender: { id: child.webContentsId, mainFrame: blankFrame },
        senderFrame: blankFrame,
      } as unknown as Electron.IpcMainInvokeEvent)
    ).toBe(false)
  })

  it('rejects untrusted workspaces, invalid panels, and invalid hostIds on panel:detach', () => {
    const detach = mocks.handlers.get('panel:detach')!
    expect(
      detach(createMainEvent(), {
        workspaceDir: path.join(os.tmpdir(), 'untrusted-phase-e-dir'),
        panel: 'files',
        hostId: 'aux:1',
      })
    ).toMatchObject({ success: false })

    expect(
      detach(createMainEvent(), {
        workspaceDir,
        panel: 'settings',
        hostId: 'aux:1',
      })
    ).toMatchObject({ success: false })

    expect(
      detach(createMainEvent(), {
        workspaceDir,
        panel: 'files',
        hostId: 'main',
      })
    ).toMatchObject({ success: false })
  })

  it('denies legacy window.open(about:blank, pi-panel:aux:1) via setWindowOpenHandler', () => {
    installAuxWindowSupport(mainWin as unknown as Electron.BrowserWindow)
    expect(mainWin.openHandler).toBeTypeOf('function')
    expect(
      mainWin.openHandler!({
        url: 'about:blank',
        referrer: { url: 'pw-app://bundle/index.html' },
      })
    ).toEqual({ action: 'deny' })
  })

  it('relays sync:broadcast to all other open windows without echoing back to sender', () => {
    const detach = mocks.handlers.get('panel:detach')!
    detach(createMainEvent(), { workspaceDir, panel: 'files', hostId: 'aux:1' })
    detach(createMainEvent(), { workspaceDir, panel: 'chat', hostId: 'aux:2' })

    const child1 = getAuxWindow(`${AUX_FRAME_PREFIX}aux:1`) as unknown as FakeWindow
    const child2 = getAuxWindow(`${AUX_FRAME_PREFIX}aux:2`) as unknown as FakeWindow
    mainWin.sent.length = 0
    child1.sent.length = 0
    child2.sent.length = 0

    const syncBroadcast = mocks.handlers.get('sync:broadcast')!
    const message = { sourceHost: 'main', kind: 'theme', mode: 'dark' }
    expect(syncBroadcast(createMainEvent(), message)).toEqual({ success: true })

    // 发送者（主窗口）不回声，两个拆出窗口都收到 sync:state
    expect(mainWin.sent).toEqual([])
    expect(child1.sent).toEqual([['sync:state', message]])
    expect(child2.sent).toEqual([['sync:state', message]])
  })

  it('untrusts webContents.id, notifies aux:window-closed, and broadcasts panel-docked on close', () => {
    const detach = mocks.handlers.get('panel:detach')!
    detach(createMainEvent(), { workspaceDir, panel: 'git', hostId: 'aux:3' })
    const child = getAuxWindow(`${AUX_FRAME_PREFIX}aux:3`) as unknown as FakeWindow
    const wcId = child.webContentsId
    const frameUrl = child.webContents.mainFrame.url

    mainWin.sent.length = 0
    expect(() => child.close()).not.toThrow()

    // 关闭后立即撤销 IPC 信任
    const fakeFrame = { url: frameUrl }
    expect(
      isTrustedIpcSender({
        sender: { id: wcId, mainFrame: fakeFrame },
        senderFrame: fakeFrame,
      } as unknown as Electron.IpcMainInvokeEvent)
    ).toBe(false)

    // 主窗口收到 aux:window-closed 与 sync:state(panel-docked)
    expect(mainWin.sent).toContainEqual(['aux:window-closed', `${AUX_FRAME_PREFIX}aux:3`])
    expect(mainWin.sent).toContainEqual([
      'sync:state',
      {
        sourceHost: 'aux:3',
        kind: 'panel-docked',
        workspaceDir,
        panel: 'git',
        hostId: 'aux:3',
      },
    ])
  })

  it('cleans up windows reliably via panel:dock and closeAllDetachedPanelWindows', () => {
    const detach = mocks.handlers.get('panel:detach')!
    const dock = mocks.handlers.get('panel:dock')!
    detach(createMainEvent(), { workspaceDir, panel: 'files', hostId: 'aux:10' })
    detach(createMainEvent(), { workspaceDir, panel: 'terminal', hostId: 'aux:11' })

    const w10 = getAuxWindow(`${AUX_FRAME_PREFIX}aux:10`) as unknown as FakeWindow
    const w11 = getAuxWindow(`${AUX_FRAME_PREFIX}aux:11`) as unknown as FakeWindow

    expect(dock(createMainEvent(), 'aux:10')).toEqual({ success: true })
    expect(w10.destroyed).toBe(true)
    expect(getAuxWindow(`${AUX_FRAME_PREFIX}aux:10`)).toBeNull()
    // 幂等：重复 dock 已关闭窗口也返回成功
    expect(dock(createMainEvent(), 'aux:10')).toEqual({ success: true })

    closeAllDetachedPanelWindows()
    expect(w11.destroyed).toBe(true)
    expect(getAuxWindow(`${AUX_FRAME_PREFIX}aux:11`)).toBeNull()
  })

  it('preserves live PTY metadata and rolling scrollback snapshots in TerminalManager.listForWorkspace', () => {
    const dataListeners: Array<(chunk: string) => void> = []
    const manager = new TerminalManager({
      spawn: () => ({
        onData: (listener) => {
          dataListeners.push(listener)
        },
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill: () => {},
      }),
      shell: 'pwsh.exe',
      logPathFor: () => null,
    })

    const created = manager.create(workspaceDir, 80, 24)
    expect(created.success).toBe(true)
    for (const listener of dataListeners) {
      listener('hello ')
      listener('world\r\n')
    }

    const snapshots = manager.listForWorkspace(workspaceDir)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      id: created.id,
      workspaceDir,
      cwd: workspaceDir,
      shell: 'pwsh.exe',
      replay: 'hello world\r\n',
    })
  })
})
