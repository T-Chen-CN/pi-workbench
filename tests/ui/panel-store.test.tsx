// @vitest-environment jsdom
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostIdFromFrameName, panelHostOf, rectFromPointer, usePanelStore } from '../../src/store/panelStore'
import { focusedHostId, setFocusedHostResolver } from '../../src/panelHost/focus'
import { openPanelWindow, type AuxWindowHandle } from '../../src/panelHost/auxWindow'
import { MAIN_HOST } from '../../src/panelHost/types'
import { useI18nStore } from '../../src/store/i18nStore'

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

function reset(): void {
  usePanelStore.setState({ panelHost: {}, windows: {} })
}

async function detach(panel: 'chat' | 'files' = 'chat', id = 'aux:1'): Promise<AuxWindowHandle> {
  const handle = await openPanelWindow({
    id,
    workspaceDir: WORKSPACE,
    panel,
    title: 'ws',
    rect: { x: 0, y: 0, width: 480, height: 600 },
  })
  act(() => {
    usePanelStore.setState({
      panelHost: { [WORKSPACE]: { ...usePanelStore.getState().panelHost[WORKSPACE], [panel]: id } },
      windows: { ...usePanelStore.getState().windows, [id]: { workspaceDir: WORKSPACE, panel, handle } },
    })
  })
  return handle
}

beforeEach(() => {
  reset()
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
  reset()
  vi.restoreAllMocks()
})

describe('panelStore', () => {
  it('reports the main window as the default host', () => {
    expect(panelHostOf(WORKSPACE, 'chat')).toBe(MAIN_HOST)
  })

  it('ignores a second detach while the panel is already out', async () => {
    await detach('chat')
    vi.mocked(api.panelDetach).mockClear()
    await usePanelStore.getState().detachPanel(WORKSPACE, 'chat')

    expect(api.panelDetach).not.toHaveBeenCalled()
    expect(Object.keys(usePanelStore.getState().windows)).toEqual(['aux:1'])
  })

  it('titles the detached native window after the workspace, not the panel', async () => {
    await usePanelStore.getState().detachPanel(WORKSPACE, 'chat')
    expect(api.panelDetach).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: WORKSPACE,
        panel: 'chat',
        title: 'ws',
      })
    )
  })

  it('cleans up cleanly when panel:detach fails', async () => {
    vi.mocked(api.panelDetach).mockResolvedValueOnce({
      success: false,
      error: 'aux-window-blocked',
    })

    await usePanelStore.getState().detachPanel(WORKSPACE, 'chat')

    expect(usePanelStore.getState().panelHost[WORKSPACE]).toBeUndefined()
  })

  it('docks every detached panel of a workspace', async () => {
    await detach('chat', 'aux:1')
    await detach('files', 'aux:2')

    act(() => usePanelStore.getState().dockWorkspace(WORKSPACE))

    expect(panelHostOf(WORKSPACE, 'chat')).toBe(MAIN_HOST)
    expect(panelHostOf(WORKSPACE, 'files')).toBe(MAIN_HOST)
    expect(usePanelStore.getState().windows).toEqual({})
    expect(api.panelDock).toHaveBeenCalledWith('aux:1')
    expect(api.panelDock).toHaveBeenCalledWith('aux:2')
  })

  it('calls panel:dock when invoked inside a detached native window with explicit host', () => {
    act(() => usePanelStore.getState().dockPanel(WORKSPACE, 'files', 'aux:7'))
    expect(api.panelDock).toHaveBeenCalledWith('aux:7')
  })

  it('disposes every window on shutdown', async () => {
    await detach('chat', 'aux:5')

    act(() => usePanelStore.getState().disposeAllWindows())

    expect(api.panelDock).toHaveBeenCalledWith('aux:5')
    expect(usePanelStore.getState().windows).toEqual({})
    expect(usePanelStore.getState().panelHost).toEqual({})
  })

  it('ignores close notifications for unknown windows', () => {
    expect(() => usePanelStore.getState().handleWindowClosed('aux:99')).not.toThrow()
  })
})

describe('focusedHostId', () => {
  it('follows the resolver and falls back to the main window', () => {
    setFocusedHostResolver(() => 'aux:7')
    expect(focusedHostId()).toBe('aux:7')

    setFocusedHostResolver(() => {
      throw new Error('window gone')
    })
    expect(focusedHostId()).toBe(MAIN_HOST)
  })
})

describe('rectFromPointer', () => {
  it('anchors the new window near the cursor', () => {
    const rect = rectFromPointer(400, 300)
    expect(rect).toMatchObject({ x: 360, y: 288, width: 520, height: 640 })
  })
})

describe('hostIdFromFrameName', () => {
  it('parses panel window names and rejects everything else', () => {
    expect(hostIdFromFrameName('pi-panel:aux:3')).toBe('aux:3')
    expect(hostIdFromFrameName('pi-panel:')).toBeNull()
    expect(hostIdFromFrameName('main')).toBeNull()
  })
})
