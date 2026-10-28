// @vitest-environment jsdom
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostIdFromFrameName, panelHostOf, rectFromPointer, usePanelStore } from '../src/store/panelStore'
import { focusedHostId, setFocusedHostResolver } from '../src/panelHost/focus'
import { openPanelWindow, type AuxWindowHandle } from '../src/panelHost/auxWindow'
import { MAIN_HOST } from '../src/panelHost/types'
import { useI18nStore } from '../src/store/i18nStore'

const WORKSPACE = '/tmp/ws'

function reset(): void {
  usePanelStore.setState({ panelHost: {}, windows: {} })
}

function installPopup() {
  const popup = {
    document: document.implementation.createHTMLDocument('blank'),
    closed: false,
    close() {
      this.closed = true
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: vi.fn()
  }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  return popup
}

async function detach(panel: 'chat' | 'files' = 'chat', id = 'aux:1'): Promise<AuxWindowHandle> {
  const handle = await openPanelWindow({
    id,
    title: panel,
    rect: { x: 0, y: 0, width: 480, height: 600 }
  })
  act(() => {
    usePanelStore.setState({
      panelHost: { [WORKSPACE]: { [panel]: id } },
      windows: { [id]: { workspaceDir: WORKSPACE, panel, handle } }
    })
  })
  return handle
}

beforeEach(() => {
  reset()
  useI18nStore.getState().setLanguage?.('zh')
  installPopup()
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
    await usePanelStore.getState().detachPanel(WORKSPACE, 'chat')

    expect(Object.keys(usePanelStore.getState().windows)).toEqual(['aux:1'])
  })

  it('surfaces a toast when the popup is blocked', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)

    await usePanelStore.getState().detachPanel(WORKSPACE, 'chat')

    expect(usePanelStore.getState().panelHost[WORKSPACE]).toBeUndefined()
  })

  it('docks every detached panel of a workspace', async () => {
    await detach('chat', 'aux:1')
    const second = await openPanelWindow({
      id: 'aux:2',
      title: 'files',
      rect: { x: 0, y: 0, width: 480, height: 600 }
    })
    act(() => {
      usePanelStore.setState({
        panelHost: { [WORKSPACE]: { chat: 'aux:1', files: 'aux:2' } },
        windows: {
          ...usePanelStore.getState().windows,
          'aux:2': { workspaceDir: WORKSPACE, panel: 'files', handle: second }
        }
      })
    })

    act(() => usePanelStore.getState().dockWorkspace(WORKSPACE))

    expect(panelHostOf(WORKSPACE, 'chat')).toBe(MAIN_HOST)
    expect(panelHostOf(WORKSPACE, 'files')).toBe(MAIN_HOST)
    expect(usePanelStore.getState().windows).toEqual({})
    expect(second.window?.closed).toBe(true)
  })

  it('disposes every window on shutdown', async () => {
    const handle = await detach('chat')

    act(() => usePanelStore.getState().disposeAllWindows())

    expect(handle.window?.closed).toBe(true)
    expect(usePanelStore.getState().windows).toEqual({})
    expect(usePanelStore.getState().panelHost).toEqual({})
  })

  it('moves focus to the auxiliary window and ignores unknown hosts', async () => {
    const handle = await detach('chat')
    const focus = vi.spyOn(handle.window as Window, 'focus')

    act(() => usePanelStore.getState().focusPanelWindow(WORKSPACE, 'chat'))
    expect(focus).toHaveBeenCalled()

    focus.mockRestore()
    // 面板不在辅助窗口里：什么都不做，也不抛错
    expect(() => usePanelStore.getState().focusPanelWindow(WORKSPACE, 'files')).not.toThrow()
  })

  it('docks the panel again when its window disappears', async () => {
    const handle = await detach('chat')
    Object.defineProperty(handle.window, 'closed', { value: true, configurable: true })

    act(() => usePanelStore.getState().focusPanelWindow(WORKSPACE, 'chat'))

    expect(panelHostOf(WORKSPACE, 'chat')).toBe(MAIN_HOST)
    expect(usePanelStore.getState().windows).toEqual({})
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
