// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelSlot } from '../../src/components/panels/PanelSlot'
import { openPanelWindow, type AuxWindowHandle } from '../../src/panelHost/auxWindow'
import { usePanelStore } from '../../src/store/panelStore'
import { useI18nStore } from '../../src/store/i18nStore'
import { WorkspaceScopeProvider } from '../../src/workspace/WorkspaceScope'

vi.mock('../../src/api', () => ({
  api: {
    panelDetach: vi.fn(async (req: { hostId: string }) => ({
      success: true,
      hostId: req.hostId,
      frameName: `pi-panel:${req.hostId}`,
    })),
    panelDock: vi.fn(async () => ({ success: true })),
  },
}))

const { api } = await import('../../src/api')
const WORKSPACE = '/tmp/ws'

function resetStore(): void {
  usePanelStore.setState({ panelHost: {}, windows: {} })
}

beforeEach(() => {
  resetStore()
  useI18nStore.getState().setLanguage?.('zh')
  vi.mocked(api.panelDetach).mockClear()
  vi.mocked(api.panelDock).mockClear()
  vi.mocked(api.panelDetach).mockImplementation(async (req) => ({
    success: true,
    hostId: req.hostId,
    frameName: `pi-panel:${req.hostId}`,
  }))
  vi.mocked(api.panelDock).mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  resetStore()
  vi.restoreAllMocks()
})

describe('openPanelWindow', () => {
  it('requests a native detached BrowserWindow via panel:detach IPC', async () => {
    const handle = await openPanelWindow({
      id: 'aux:1',
      workspaceDir: WORKSPACE,
      panel: 'files',
      title: 'ws',
      rect: { x: 100, y: 120, width: 480, height: 600 },
      theme: 'dark',
      language: 'zh',
    })

    expect(api.panelDetach).toHaveBeenCalledWith({
      workspaceDir: WORKSPACE,
      panel: 'files',
      hostId: 'aux:1',
      title: 'ws',
      rect: { x: 100, y: 120, width: 480, height: 600 },
      theme: 'dark',
      language: 'zh',
    })
    expect(handle.id).toBe('aux:1')
  })

  it('throws when main process rejects panel:detach', async () => {
    vi.mocked(api.panelDetach).mockResolvedValueOnce({
      success: false,
      error: 'aux-window-blocked',
    })
    await expect(
      openPanelWindow({
        id: 'aux:1',
        workspaceDir: WORKSPACE,
        panel: 'chat',
        title: 'x',
        rect: { x: 0, y: 0, width: 400, height: 400 },
      })
    ).rejects.toThrow('aux-window-blocked')
  })

  it('docks the native window idempotently on dispose', async () => {
    const handle = await openPanelWindow({
      id: 'aux:1',
      workspaceDir: WORKSPACE,
      panel: 'terminal',
      title: 'ws',
      rect: { x: 0, y: 0, width: 400, height: 400 },
    })

    handle.dispose()
    handle.dispose()
    expect(api.panelDock).toHaveBeenCalledTimes(1)
    expect(api.panelDock).toHaveBeenCalledWith('aux:1')
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

  it('returns null in the main window when the panel is detached to a native BrowserWindow', async () => {
    const handle = await openPanelWindow({
      id: 'aux:1',
      workspaceDir: WORKSPACE,
      panel: 'chat',
      title: 'ws',
      rect: { x: 0, y: 0, width: 480, height: 600 },
    })

    act(() => {
      usePanelStore.setState({
        panelHost: { [WORKSPACE]: { chat: 'aux:1' } },
        windows: { 'aux:1': { workspaceDir: WORKSPACE, panel: 'chat', handle } },
      })
    })
    const { container } = renderSlot(<div data-testid="chat-body">chat</div>)

    expect(screen.queryByTestId('chat-body')).toBeNull()
    expect(container.textContent).toBe('')
    expect(container.querySelector('*')).toBeNull()
  })

  it('brings the panel back when the native detached window closes', async () => {
    const handle: AuxWindowHandle = await openPanelWindow({
      id: 'aux:1',
      workspaceDir: WORKSPACE,
      panel: 'chat',
      title: 'ws',
      rect: { x: 0, y: 0, width: 480, height: 600 },
    })

    act(() => {
      usePanelStore.setState({
        panelHost: { [WORKSPACE]: { chat: 'aux:1' } },
        windows: { 'aux:1': { workspaceDir: WORKSPACE, panel: 'chat', handle } },
      })
    })
    renderSlot(<div data-testid="chat-body">chat</div>)

    act(() => {
      usePanelStore.getState().handleWindowClosed('aux:1')
    })

    // 窗口已关闭：handleWindowClosed 不应再重复触发 panel:dock
    expect(api.panelDock).not.toHaveBeenCalled()
    expect(screen.getByTestId('chat-body')).toBeTruthy()
    expect(usePanelStore.getState().panelHost[WORKSPACE]?.chat).toBeUndefined()
  })
})

describe('panelStore.dockPanel', () => {
  it('calls panel:dock and clears the mapping', async () => {
    const handle = await openPanelWindow({
      id: 'aux:1',
      workspaceDir: WORKSPACE,
      panel: 'chat',
      title: 'ws',
      rect: { x: 0, y: 0, width: 480, height: 600 },
    })
    act(() => {
      usePanelStore.setState({
        panelHost: { [WORKSPACE]: { chat: 'aux:1' } },
        windows: { 'aux:1': { workspaceDir: WORKSPACE, panel: 'chat', handle } },
      })
    })

    act(() => {
      usePanelStore.getState().dockPanel(WORKSPACE, 'chat')
    })

    expect(api.panelDock).toHaveBeenCalledWith('aux:1')
    expect(usePanelStore.getState().windows['aux:1']).toBeUndefined()
    expect(usePanelStore.getState().panelHost[WORKSPACE]?.chat).toBeUndefined()
  })

  it('does nothing for panels that are already docked in main window', () => {
    act(() => {
      usePanelStore.getState().dockPanel(WORKSPACE, 'chat')
    })
    expect(api.panelDock).not.toHaveBeenCalled()
    expect(usePanelStore.getState().windows).toEqual({})
  })
})

describe('rectFromPointer', () => {
  it('converts viewport coordinates into a screen-space window rect', async () => {
    const { rectFromPointer } = await import('../../src/store/panelStore')
    const rect = rectFromPointer(300, 200)
    expect(rect.width).toBeGreaterThan(0)
    expect(Number.isFinite(rect.x)).toBe(true)
    expect(Number.isFinite(rect.y)).toBe(true)
  })
})
