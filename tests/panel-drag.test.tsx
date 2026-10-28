// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelDragHandle } from '../src/components/PanelDragHandle'
import { openPanelWindow } from '../src/panelHost/auxWindow'
import { usePanelStore } from '../src/store/panelStore'
import { useI18nStore } from '../src/store/i18nStore'
import { WorkspaceScopeProvider } from '../src/workspace/WorkspaceScope'
import { api } from '../src/api'

vi.mock('../src/api', () => ({
  api: { auxDetachAt: vi.fn(), auxDragBegin: vi.fn(async () => ({ success: true })) }
}))

const WORKSPACE = '/tmp/ws'

function installPopup() {
  const popup = {
    document: document.implementation.createHTMLDocument('blank'),
    close: vi.fn(),
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {}
  }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  return popup
}

function fakeDataTransfer(dropEffect = 'move') {
  const data = new Map<string, string>()
  return {
    data,
    dropEffect,
    effectAllowed: 'all',
    setData: vi.fn((type: string, value: string) => {
      data.set(type, value)
    }),
    getData: (type: string) => data.get(type) ?? '',
    setDragImage: vi.fn()
  }
}

function renderHandle(panel: 'chat' | 'files' = 'chat') {
  return render(
    <WorkspaceScopeProvider value={WORKSPACE}>
      <PanelDragHandle panel={panel} />
    </WorkspaceScopeProvider>
  )
}

/** 拖动柄是头部里唯一的 draggable 元素 */
function grabHandle(): HTMLElement {
  const handle = document.querySelector<HTMLElement>('[draggable="true"]')
  if (!handle) throw new Error('drag handle missing')
  return handle
}

beforeEach(() => {
  usePanelStore.setState({ panelHost: {}, windows: {} })
  useI18nStore.getState().setLanguage?.('zh')
  installPopup()
})

afterEach(() => {
  cleanup()
  usePanelStore.setState({ panelHost: {}, windows: {} })
  vi.restoreAllMocks()
})

describe('PanelDragHandle', () => {
  it('is only offered while the panel is docked in the main window', async () => {
    renderHandle()
    expect(grabHandle()).toBeTruthy()

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

    expect(document.querySelector('[draggable="true"]')).toBeNull()

    act(() => usePanelStore.getState().dockPanel(WORKSPACE, 'chat'))
    expect(grabHandle()).toBeTruthy()
  })

  it('tags the drag with the panel id', () => {
    renderHandle()
    const dataTransfer = fakeDataTransfer()

    fireEvent.dragStart(grabHandle(), { dataTransfer })

    expect(dataTransfer.data.get('application/x-pi-panel')).toBe('chat')
    expect(dataTransfer.effectAllowed).toBe('move')
    // 拖动起点由主进程记录：距离与落点必须来自同一坐标源
    expect(api.auxDragBegin).toHaveBeenCalled()
  })

  it('detaches the panel when released outside the main window', async () => {
    vi.mocked(api.auxDetachAt).mockResolvedValue({
      success: true,
      inside: false,
      rect: { x: 900, y: 200, width: 520, height: 640 }
    })
    renderHandle()
    const dataTransfer = fakeDataTransfer()

    fireEvent.dragStart(grabHandle(), { dataTransfer })
    fireEvent.dragEnd(grabHandle(), { dataTransfer })

    await waitFor(() => expect(usePanelStore.getState().panelHost[WORKSPACE]?.chat).toMatch(/^aux:/))
    expect(Object.values(usePanelStore.getState().windows)[0]?.panel).toBe('chat')
  })

  it('keeps the panel docked when released inside the main window', async () => {
    vi.mocked(api.auxDetachAt).mockResolvedValue({ success: true, inside: true })
    renderHandle()
    const dataTransfer = fakeDataTransfer()

    fireEvent.dragStart(grabHandle(), { dataTransfer })
    fireEvent.dragEnd(grabHandle(), { dataTransfer })

    await waitFor(() => expect(api.auxDetachAt).toHaveBeenCalled())
    expect(usePanelStore.getState().panelHost[WORKSPACE]).toBeUndefined()
  })

  it('detaches even when the drop lands on nothing (dropEffect none)', async () => {
    // 拖到窗口外松手时没有任何 drop 目标，Chromium 报 dropEffect 'none'。
    // 这不是取消，而是最常发生的拆窗时机。
    vi.mocked(api.auxDetachAt).mockResolvedValue({
      success: true,
      inside: false,
      rect: { x: 900, y: 200, width: 520, height: 640 }
    })
    renderHandle()
    const dataTransfer = fakeDataTransfer('none')

    fireEvent.dragStart(grabHandle(), { dataTransfer })
    fireEvent.dragEnd(grabHandle(), { dataTransfer })

    await waitFor(() => expect(api.auxDetachAt).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(usePanelStore.getState().panelHost[WORKSPACE]?.chat).toMatch(/^aux:/))
  })

  // 拖动距离足够长就拆窗，不看落点是否还在窗口内
  it('detaches when the drag travels far enough even inside the window', async () => {
    vi.mocked(api.auxDetachAt).mockResolvedValue({
      success: true,
      inside: true,
      distance: 240,
      rect: { x: 900, y: 200, width: 520, height: 640 }
    })
    renderHandle()
    const dataTransfer = fakeDataTransfer()

    fireEvent.dragStart(grabHandle(), { dataTransfer })
    fireEvent.dragEnd(grabHandle(), { dataTransfer })

    await waitFor(() => expect(usePanelStore.getState().panelHost[WORKSPACE]?.chat).toMatch(/^aux:/))
  })

  it('does not detach when the drag is abandoned inside the window', async () => {
    vi.mocked(api.auxDetachAt).mockResolvedValue({ success: true, inside: true })
    renderHandle()
    const dataTransfer = fakeDataTransfer('none')

    fireEvent.dragStart(grabHandle(), { dataTransfer })
    fireEvent.dragEnd(grabHandle(), { dataTransfer })

    await waitFor(() => expect(api.auxDetachAt).toHaveBeenCalledTimes(1))
    expect(usePanelStore.getState().panelHost[WORKSPACE]).toBeUndefined()
  })

  it('stays docked when the main process cannot resolve a target', async () => {
    vi.mocked(api.auxDetachAt).mockResolvedValue({ success: false, error: 'No window' })
    renderHandle()
    const dataTransfer = fakeDataTransfer('none')

    fireEvent.dragStart(grabHandle(), { dataTransfer })
    fireEvent.dragEnd(grabHandle(), { dataTransfer })

    await waitFor(() => expect(api.auxDetachAt).toHaveBeenCalledTimes(1))
    expect(usePanelStore.getState().panelHost[WORKSPACE]).toBeUndefined()
  })
})
