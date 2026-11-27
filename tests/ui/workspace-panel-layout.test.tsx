// @vitest-environment jsdom
/**
 * 面板拆到独立原生 BrowserWindow 后，主窗口这一侧必须彻底让位（不占宽、不占高、不留占位与隐藏 DOM），
 * 空间 100% 交还给编辑器。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceView } from '../../src/components/workspace/WorkspaceView'
import { usePanelStore } from '../../src/store/panelStore'
import { useI18nStore } from '../../src/store/i18nStore'
import { emitAppEvent } from '../../src/utils/appEvents'

vi.mock('../../src/api', () => ({
  api: {
    onGitChanged: vi.fn(() => () => {}),
    onGitWorktreeDeps: vi.fn(() => () => {}),
    onAgentSessionRootChanged: vi.fn(() => () => {}),
    editorTabsSet: vi.fn(async () => ({ success: true })),
    panelDetach: vi.fn(async () => ({ success: true, hostId: 'aux:1', frameName: 'pi-panel:aux:1' })),
    panelDock: vi.fn(async () => ({ success: true })),
  },
}))

// 面板与编辑器实现与布局无关，替换成可断言的占位
vi.mock('../../src/components/chat/ChatPanel', () => ({
  ChatPanel: () => <div data-testid="chat-panel" />,
}))
vi.mock('../../src/components/files/FileExplorer', () => ({
  FileExplorer: () => <div data-testid="files-panel" />,
}))
vi.mock('../../src/components/git/GitView', () => ({
  GitView: () => <div data-testid="git-panel" />,
}))
vi.mock('../../src/components/editor/TerminalPanel', () => ({
  TerminalPanel: () => <div data-testid="terminal-panel" />,
}))
vi.mock('../../src/components/editor/DiffViewer', () => ({ DiffViewer: () => null }))
vi.mock('../../src/components/git/CommitDetailView', () => ({ CommitDetailView: () => null }))
vi.mock('../../src/components/editor/FileView', () => ({
  FileView: () => <div data-testid="file-view" />,
}))

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
  return (
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label) ??
    null
  )
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
  it('gives the chat column, seam, and rail back to the editor without hidden DOM', () => {
    const { container } = renderView()
    expect(separators(container)).toBe(2)
    expect(container.querySelectorAll('aside').length).toBe(2)

    act(() => usePanelStore.setState({ panelHost: { [WORKSPACE]: { chat: 'aux:1' } } }))

    // 接缝、聊天气泡栏与展开导轨全部让位，编辑器吃掉 100% 宽度
    expect(separators(container)).toBe(1)
    expect(container.querySelectorAll('aside').length).toBe(1)
    expect(screen.queryByTestId('chat-panel')).toBeNull()
    expect(screen.queryByLabelText(useI18nStore.getState().t('expandChat'))).toBeNull()
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
    // 两个都拆出：侧栏连接缝一起让位，不留隐藏 aside 或导轨
    expect(separators(container)).toBe(1)
    expect(container.querySelectorAll('aside').length).toBe(1)
    expect(screen.queryByLabelText(useI18nStore.getState().t('expandSidebar'))).toBeNull()
  })

  it('drops the terminal row and horizontal separator cleanly when detached', async () => {
    const { container } = renderView()

    act(() => emitAppEvent('workspace-toggle-terminal'))
    const terminalNode = await screen.findByTestId('terminal-panel')
    expect(terminalNode).toBeTruthy()
    expect(separators(container)).toBe(3)

    act(() =>
      usePanelStore.setState({
        panelHost: { [WORKSPACE]: { terminal: 'aux:1' } },
      })
    )

    // 终端已迁至独立原生窗口：主窗口无隐藏行、无水平分隔线、无终端 DOM
    expect(container.querySelector('[data-testid="terminal-panel"]')).toBeNull()
    expect(separators(container)).toBe(2)
  })
})
