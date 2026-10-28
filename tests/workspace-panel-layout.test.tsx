// @vitest-environment jsdom
/**
 * 面板拆到独立窗口后，主窗口这一侧必须彻底让位（不占宽、不占高、不留占位），
 * 同时 PanelSlot 不能卸载 —— portal 的 fiber 挂在主窗口这棵树上，
 * 卸载等于把独立窗口里的面板一起拆掉。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceView } from '../src/components/WorkspaceView'
import { openPanelWindow } from '../src/panelHost/auxWindow'
import { usePanelStore } from '../src/store/panelStore'
import { useI18nStore } from '../src/store/i18nStore'
import { emitAppEvent } from '../src/utils/appEvents'

vi.mock('../src/api', () => ({
  api: {
    onGitChanged: vi.fn(() => () => {}),
    onAgentSessionRootChanged: vi.fn(() => () => {}),
    editorTabsSet: vi.fn(async () => ({ success: true }))
  }
}))

// 面板与编辑器实现与布局无关，替换成可断言的占位
vi.mock('../src/components/ChatPanel', () => ({ ChatPanel: () => <div data-testid="chat-panel" /> }))
vi.mock('../src/components/FileExplorer', () => ({ FileExplorer: () => <div data-testid="files-panel" /> }))
vi.mock('../src/components/GitView', () => ({ GitView: () => <div data-testid="git-panel" /> }))
vi.mock('../src/components/TerminalPanel', () => ({
  TerminalPanel: () => <div data-testid="terminal-panel" />
}))
vi.mock('../src/components/DiffViewer', () => ({ DiffViewer: () => null }))
vi.mock('../src/components/CommitDetailView', () => ({ CommitDetailView: () => null }))
vi.mock('../src/components/FileView', () => ({ FileView: () => <div data-testid="file-view" /> }))

const WORKSPACE = '/tmp/ws'

function renderView() {
  return render(<WorkspaceView workspacePath={WORKSPACE} active />)
}

function separators(container: HTMLElement): number {
  return container.querySelectorAll('[role="separator"]').length
}

function hidesPanel(element: HTMLElement | null): boolean {
  return Boolean(element && element.className.split(/\s+/).includes('hidden'))
}

function findTab(container: HTMLElement, label: string): HTMLElement | null {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label) ?? null
}

function createFakePopup() {
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

beforeEach(() => {
  usePanelStore.setState({ panelHost: {}, windows: {} })
  useI18nStore.getState().setLanguage?.('zh')
})

afterEach(() => {
  cleanup()
  usePanelStore.setState({ panelHost: {}, windows: {} })
  vi.restoreAllMocks()
})

describe('WorkspaceView panel detach layout', () => {
  it('gives the chat column and its seam back to the editor', () => {
    const { container } = renderView()
    expect(separators(container)).toBe(2)

    act(() => usePanelStore.setState({ panelHost: { [WORKSPACE]: { chat: 'aux:1' } } }))

    // 接缝消失，编辑器吃掉这一列
    expect(separators(container)).toBe(1)
    // 聊天栏仍然挂载（portal 在里面），但不参与布局；没有窗口句柄时主窗口不渲染内容
    expect(container.querySelectorAll('aside').length).toBe(2)
    expect(screen.queryByTestId('chat-panel')).toBeNull()
  })

  it('collapses the whole sidebar only when files and git are both out', () => {
    const { container } = renderView()

    act(() => usePanelStore.setState({ panelHost: { [WORKSPACE]: { files: 'aux:1' } } }))
    // 只剩 git：侧栏与接缝都还在
    expect(separators(container)).toBe(2)
    // 拆出的标签从标签条上隐去，避免点到死按钮
    expect(hidesPanel(findTab(container, useI18nStore.getState().t('files')))).toBe(true)
    expect(hidesPanel(findTab(container, useI18nStore.getState().t('gitView')))).toBe(false)

    act(() => usePanelStore.setState({ panelHost: { [WORKSPACE]: { files: 'aux:1', git: 'aux:2' } } }))
    // 两个都拆出：侧栏连接缝一起让位，不留导轨
    expect(separators(container)).toBe(1)
    expect(screen.queryByLabelText(useI18nStore.getState().t('expandSidebar'))).toBeNull()
  })

  it('drops the terminal row without stopping the detached panel', async () => {
    const popup = createFakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const handle = await openPanelWindow({
      id: 'aux:1',
      title: 'ws',
      rect: { x: 0, y: 0, width: 480, height: 600 }
    })
    const { container } = renderView()

    act(() => emitAppEvent('workspace-toggle-terminal'))
    expect(hidesPanel(screen.getByTestId('terminal-panel').parentElement)).toBe(false)

    act(() =>
      usePanelStore.setState({
        panelHost: { [WORKSPACE]: { terminal: 'aux:1' } },
        windows: { 'aux:1': { workspaceDir: WORKSPACE, panel: 'terminal', handle } }
      })
    )

    // 面板还在跑（进了独立窗口），主窗口这一侧不留行高
    expect(handle.document.querySelector('[data-testid="terminal-panel"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="terminal-panel"]')).toBeNull()
    const row = container.querySelector('section > div.hidden')
    expect(row).toBeTruthy()
  })
})
