// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelSlot } from '../src/components/PanelSlot'
import { openPanelWindow, type AuxWindowHandle } from '../src/panelHost/auxWindow'
import { usePanelStore } from '../src/store/panelStore'
import { useI18nStore } from '../src/store/i18nStore'
import { WorkspaceScopeProvider } from '../src/workspace/WorkspaceScope'

const WORKSPACE = '/tmp/ws'

interface FakePopup {
  document: Document
  closed: boolean
  close: () => void
  addEventListener: () => void
  removeEventListener: () => void
  focus: () => void
}

/** 用同源文档模拟 about:blank 子窗口：与真实 Electron 一样可被 opener 直接写入 */
function createFakePopup(): FakePopup {
  const doc = document.implementation.createHTMLDocument('blank')
  return {
    document: doc,
    closed: false,
    close() {
      this.closed = true
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {}
  }
}

function resetStore(): void {
  usePanelStore.setState({ panelHost: {}, windows: {} })
}

beforeEach(() => {
  resetStore()
  useI18nStore.getState().setLanguage?.('zh')
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/assets/index.css'
  link.dataset.testStylesheet = 'true'
  document.head.appendChild(link)
})

afterEach(() => {
  cleanup()
  resetStore()
  document.head.querySelectorAll('[data-test-stylesheet]').forEach((node) => node.remove())
  vi.restoreAllMocks()
})

describe('openPanelWindow', () => {
  it('prepares the child document with styles, CSP and theme attributes', async () => {
    const popup = createFakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    document.documentElement.classList.add('dark')

    const handle = await openPanelWindow({
      id: 'aux:1',
      title: '文件',
      rect: { x: 100, y: 120, width: 480, height: 600 }
    })

    expect(open).toHaveBeenCalledWith('about:blank', 'pi-panel:aux:1', expect.stringContaining('width=480,height=600'))
    expect(handle.document.title).toBe('文件')
    expect(handle.document.documentElement.classList.contains('dark')).toBe(true)

    const base = handle.document.querySelector('base')
    expect(base?.getAttribute('href')).toBe(document.baseURI)

    const csp = handle.document.querySelector('meta[http-equiv="Content-Security-Policy"]')
    expect(csp?.getAttribute('content')).toContain("script-src 'none'")

    const stylesheet = handle.document.querySelector('link[rel="stylesheet"]')
    expect(stylesheet?.getAttribute('href')).toBe(new URL('/assets/index.css', document.baseURI).href)

    expect(handle.document.body.contains(handle.container)).toBe(true)
    expect(handle.container.className).toContain('bg-panel')

    document.documentElement.classList.remove('dark')
  })

  it('closes the popup when the browser refuses to open one', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    await expect(
      openPanelWindow({ id: 'aux:1', title: 'x', rect: { x: 0, y: 0, width: 400, height: 400 } })
    ).rejects.toThrow('aux-window-blocked')
  })

  it('disposes the container and closes the window', async () => {
    const popup = createFakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const handle = await openPanelWindow({
      id: 'aux:1',
      title: 'Terminal',
      rect: { x: 0, y: 0, width: 400, height: 400 }
    })

    handle.dispose()
    expect(popup.closed).toBe(true)
    expect(popup.document.body.contains(handle.container)).toBe(false)
  })
})

describe('PanelSlot', () => {
  const renderSlot = (children: React.ReactNode) =>
    render(
      <WorkspaceScopeProvider value={WORKSPACE}>
        <PanelSlot panel="chat">{children}</PanelSlot>
      </WorkspaceScopeProvider>
    )

  it('renders docked panels in place', () => {
    renderSlot(<div data-testid="chat-body">chat</div>)
    expect(screen.getByTestId('chat-body')).toBeTruthy()
  })

  it('portals detached panels into the auxiliary window', async () => {
    const popup = createFakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const handle = await openPanelWindow({
      id: 'aux:1',
      title: 'chat',
      rect: { x: 0, y: 0, width: 480, height: 600 }
    })

    act(() => {
      usePanelStore.setState({
        panelHost: { [WORKSPACE]: { chat: 'aux:1' } },
        windows: { 'aux:1': { workspaceDir: WORKSPACE, panel: 'chat', handle } }
      })
    })
    const { container } = renderSlot(<div data-testid="chat-body">chat</div>)

    // 面板内容进了子文档；主窗口这一侧什么都不留，宽度全部让给编辑器
    expect(handle.document.querySelector('[data-testid="chat-body"]')).toBeTruthy()
    expect(screen.queryByTestId('chat-body')).toBeNull()
    expect(container.textContent).toBe('')
    expect(container.querySelector('*')).toBeNull()
  })

  it('brings the panel back when the window is closed', async () => {
    const popup = createFakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const handle: AuxWindowHandle = await openPanelWindow({
      id: 'aux:1',
      title: 'chat',
      rect: { x: 0, y: 0, width: 480, height: 600 }
    })

    act(() => {
      usePanelStore.setState({
        panelHost: { [WORKSPACE]: { chat: 'aux:1' } },
        windows: { 'aux:1': { workspaceDir: WORKSPACE, panel: 'chat', handle } }
      })
    })
    renderSlot(<div data-testid="chat-body">chat</div>)

    act(() => {
      usePanelStore.getState().handleWindowClosed('aux:1')
    })

    expect(screen.getByTestId('chat-body')).toBeTruthy()
    expect(usePanelStore.getState().panelHost[WORKSPACE]?.chat).toBeUndefined()
  })

  it('docks the panel back when the user closed the window directly', async () => {
    const popup = createFakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const handle: AuxWindowHandle = await openPanelWindow({
      id: 'aux:1',
      title: 'chat',
      rect: { x: 0, y: 0, width: 480, height: 600 }
    })

    act(() => {
      usePanelStore.setState({
        panelHost: { [WORKSPACE]: { chat: 'aux:1' } },
        windows: { 'aux:1': { workspaceDir: WORKSPACE, panel: 'chat', handle } }
      })
    })
    renderSlot(<div data-testid="chat-body">chat</div>)

    // 用户点了窗口 X：文档已随窗口销毁，回收时不能再碰 container
    const remove = vi.spyOn(handle.container, 'remove')
    popup.closed = true
    act(() => {
      usePanelStore.getState().handleWindowClosed('aux:1')
    })

    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByTestId('chat-body')).toBeTruthy()
    expect(usePanelStore.getState().panelHost[WORKSPACE]?.chat).toBeUndefined()
  })
})

describe('panelStore.dockPanel', () => {
  it('closes the window and clears the mapping', async () => {
    const popup = createFakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const handle = await openPanelWindow({
      id: 'aux:1',
      title: 'chat',
      rect: { x: 0, y: 0, width: 480, height: 600 }
    })
    act(() => {
      usePanelStore.setState({
        panelHost: { [WORKSPACE]: { chat: 'aux:1' } },
        windows: { 'aux:1': { workspaceDir: WORKSPACE, panel: 'chat', handle } }
      })
    })

    act(() => {
      usePanelStore.getState().dockPanel(WORKSPACE, 'chat')
    })

    expect(popup.closed).toBe(true)
    expect(usePanelStore.getState().windows['aux:1']).toBeUndefined()
    expect(usePanelStore.getState().panelHost[WORKSPACE]?.chat).toBeUndefined()
  })

  it('does nothing for panels that are already docked', () => {
    act(() => {
      usePanelStore.getState().dockPanel(WORKSPACE, 'chat')
    })
    expect(usePanelStore.getState().windows).toEqual({})
  })
})

describe('rectFromPointer', () => {
  it('converts viewport coordinates into a screen-space window rect', async () => {
    const { rectFromPointer } = await import('../src/store/panelStore')
    const rect = rectFromPointer(300, 200)
    expect(rect.width).toBeGreaterThan(0)
    expect(Number.isFinite(rect.x)).toBe(true)
    expect(Number.isFinite(rect.y)).toBe(true)
  })
})
