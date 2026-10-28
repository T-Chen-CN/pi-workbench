// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelWindowFrame } from '../src/components/PanelWindowFrame'
import { WindowControls } from '../src/components/WindowControls'
import { useI18nStore } from '../src/store/i18nStore'
import { usePanelStore } from '../src/store/panelStore'
import { MAIN_HOST } from '../src/panelHost/types'
import { WorkspaceScopeProvider } from '../src/workspace/WorkspaceScope'

const WORKSPACE = '/tmp/ws'

type MaxListener = (state: { host: string; maximized: boolean }) => void

const bridge = {
  platform: 'win32',
  minimizeWindow: vi.fn(async () => ({ success: true })),
  toggleMaximizeWindow: vi.fn(async () => ({ success: true, maximized: true })),
  closeWindow: vi.fn(async () => ({ success: true })),
  isWindowMaximized: vi.fn(async () => ({ success: true, maximized: false })),
  auxWindowCommand: vi.fn(async () => ({ success: true, maximized: true })),
  auxWindowState: vi.fn(async () => ({ success: true, maximized: false })),
  listeners: [] as MaxListener[],
  onWindowMaximizedChange: vi.fn((callback: MaxListener) => {
    bridge.listeners.push(callback)
    return () => {
      bridge.listeners = bridge.listeners.filter((item) => item !== callback)
    }
  })
}

beforeEach(() => {
  bridge.listeners = []
  bridge.onWindowMaximizedChange.mockClear()
  bridge.auxWindowCommand.mockClear()
  bridge.auxWindowState.mockClear()
  bridge.toggleMaximizeWindow.mockClear()
  bridge.closeWindow.mockClear()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = bridge
  usePanelStore.setState({ panelHost: {}, windows: {} })
  useI18nStore.getState().setLanguage?.('zh')
})

afterEach(() => {
  cleanup()
  usePanelStore.setState({ panelHost: {}, windows: {} })
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('WindowControls', () => {
  it('drives the main window through the window service', async () => {
    render(<WindowControls />)
    await waitFor(() => expect(bridge.isWindowMaximized).toHaveBeenCalled())

    screen.getByRole('button', { name: '关闭' }).click()
    await waitFor(() => expect(bridge.closeWindow).toHaveBeenCalled())
    expect(bridge.auxWindowCommand).not.toHaveBeenCalled()
  })

  it('addresses an auxiliary window by frame name instead of the main window', async () => {
    render(<WindowControls host="aux:4" compact />)
    // 主进程只认带前缀的 frameName：少了 `pi-panel:` 会静默变成无效命令
    await waitFor(() => expect(bridge.auxWindowState).toHaveBeenCalledWith('pi-panel:aux:4'))

    screen.getByRole('button', { name: '关闭' }).click()
    screen.getByRole('button', { name: '最小化' }).click()
    screen.getByRole('button', { name: '最大化' }).click()

    await waitFor(() => expect(bridge.auxWindowCommand).toHaveBeenCalledWith('pi-panel:aux:4', 'close'))
    expect(bridge.auxWindowCommand).toHaveBeenCalledWith('pi-panel:aux:4', 'minimize')
    expect(bridge.auxWindowCommand).toHaveBeenCalledWith('pi-panel:aux:4', 'toggleMaximize')
    // 绝不能顺手关掉主窗口
    expect(bridge.closeWindow).not.toHaveBeenCalled()
  })

  it('only reacts to maximize events of its own window', async () => {
    render(<WindowControls host="aux:5" compact />)
    await waitFor(() => expect(bridge.onWindowMaximizedChange).toHaveBeenCalled())

    await waitFor(() => expect(screen.getByRole('button', { name: '最大化' })).toBeTruthy())
    bridge.listeners.forEach((listener) => listener({ host: 'main', maximized: true }))
    expect(screen.getByRole('button', { name: '最大化' })).toBeTruthy()

    await waitFor(() => {
      // 主进程上报的是 frameName（带 `pi-panel:`），组件必须能对上
      bridge.listeners.forEach((listener) => listener({ host: 'pi-panel:aux:5', maximized: true }))
      expect(screen.getByRole('button', { name: '还原' })).toBeTruthy()
    })
  })
})

describe('PanelWindowFrame', () => {
  it('uses the bar as a draggable window title bar showing the workspace name', async () => {
    const { container } = render(
      <WorkspaceScopeProvider value={WORKSPACE}>
        <PanelWindowFrame panel="chat" workspacePath={WORKSPACE} host="aux:6">
          <div>panel body</div>
        </PanelWindowFrame>
      </WorkspaceScopeProvider>
    )

    const bar = container.querySelector('.app-drag')
    expect(bar).toBeTruthy()
    // 标题只写工作区名：面板名在这个窗口里不再出现
    expect(bar?.textContent?.trim()).toBe('ws')
    expect(container.textContent).not.toContain('Pi Agent 对话')
    // 标题只出现一次：不与系统标题栏或面板内头部重复
    expect(container.querySelectorAll('.app-drag').length).toBe(1)

    screen.getByRole('button', { name: '还原到主窗口' }).click()
    await waitFor(() => expect(usePanelStore.getState().panelHost[WORKSPACE]?.chat).toBeUndefined())
  })

  it('renders the dock-back action even for a detached panel', () => {
    render(
      <WorkspaceScopeProvider value={WORKSPACE}>
        <PanelWindowFrame panel="files" workspacePath={WORKSPACE} host={MAIN_HOST}>
          <div>panel body</div>
        </PanelWindowFrame>
      </WorkspaceScopeProvider>
    )
    expect(screen.getByRole('button', { name: '还原到主窗口' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy()
  })
})
