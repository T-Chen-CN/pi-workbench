// @vitest-environment jsdom
/**
 * 拆窗不能丢掉面板的就地手感：文件树的展开目录与滚动位置要在
 * 「主窗口 → 辅助窗口 → 主窗口」的往返里活下来。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileExplorer } from '../src/components/FileExplorer'
import { PanelSlot } from '../src/components/PanelSlot'
import { openPanelWindow, type AuxWindowHandle } from '../src/panelHost/auxWindow'
import { clearPanelUi, readPanelUi } from '../src/panelHost/panelUiState'
import { usePanelStore } from '../src/store/panelStore'
import { useI18nStore } from '../src/store/i18nStore'
import { WorkspaceScopeProvider } from '../src/workspace/WorkspaceScope'

vi.mock('../src/api', () => ({
  api: {
    listDirectory: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deletePath: vi.fn(),
    renamePath: vi.fn(),
    exists: vi.fn(),
    stat: vi.fn(),
    onFsChanged: vi.fn(() => () => {}),
    getSettings: vi.fn(async () => ({ success: true })),
    saveSettings: vi.fn(async () => ({ success: true }))
  }
}))

const { api } = await import('../src/api')
// Windows 路径：面板保存的是 api.listDirectory 给出的原始分隔符，骨架树必须逐字复用
const WORKSPACE = 'C:\\work\\ws-detach'
/** Windows 风格子路径：保持与 api.listDirectory 完全一致的分隔符 */
const childPath = (...segments: string[]) => [WORKSPACE, ...segments].join('\\')

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

function mockTree(): void {
  vi.mocked(api.listDirectory).mockImplementation(async (dirPath: string) => {
    if (dirPath === WORKSPACE) {
      return { success: true, items: [{ name: 'src', path: childPath('src'), isDirectory: true }] }
    }
    if (dirPath === childPath('src')) {
      return { success: true, items: [{ name: 'index.ts', path: childPath('src', 'index.ts'), isDirectory: false }] }
    }
    return { success: true, items: [] }
  })
}

function renderSlot() {
  return render(
    <WorkspaceScopeProvider value={WORKSPACE}>
      <PanelSlot panel="files">
        <FileExplorer workspacePath={WORKSPACE} />
      </PanelSlot>
    </WorkspaceScopeProvider>
  )
}

async function detachFiles(): Promise<AuxWindowHandle> {
  const popup = createFakePopup()
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  const handle = await openPanelWindow({
    id: 'aux:files',
    title: 'files',
    rect: { x: 10, y: 10, width: 420, height: 520 }
  })
  act(() => {
    usePanelStore.setState({
      panelHost: { [WORKSPACE]: { files: 'aux:files' } },
      windows: { 'aux:files': { workspaceDir: WORKSPACE, panel: 'files', handle } }
    })
  })
  return handle
}

beforeEach(() => {
  usePanelStore.setState({ panelHost: {}, windows: {} })
  clearPanelUi(WORKSPACE)
  useI18nStore.getState().setLanguage('zh')
  mockTree()
})

afterEach(() => {
  cleanup()
  usePanelStore.setState({ panelHost: {}, windows: {} })
  clearPanelUi(WORKSPACE)
  vi.restoreAllMocks()
})

describe('FileExplorer across windows', () => {
  it('carries the expanded folders into the auxiliary window', async () => {
    renderSlot()
    fireEvent.click(await screen.findByText('src'))
    await screen.findByText('index.ts')

    const handle = await detachFiles()

    await waitFor(() => {
      expect(handle.container.textContent).toContain('src')
      expect(handle.container.textContent).toContain('index.ts')
    })
  })

  it('keeps the expansion after the panel comes back to the main window', async () => {
    renderSlot()
    fireEvent.click(await screen.findByText('src'))
    await screen.findByText('index.ts')

    await detachFiles()
    act(() => {
      usePanelStore.getState().dockPanel(WORKSPACE, 'files')
    })

    // 回位后的骨架树要靠 listRootDirectory 回填才能渲染出子节点
    await waitFor(
      () =>
        expect([...document.querySelectorAll('[role="treeitem"]')].map((row) => row.textContent)).toContain('index.ts'),
      { timeout: 3000 }
    )
    expect(readPanelUi<{ expanded: string[] }>(WORKSPACE, 'files')?.expanded).toContain(childPath('src'))
  })
})
