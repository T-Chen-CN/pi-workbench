// @vitest-environment jsdom
/**
 * 拆窗不能丢掉面板的就地手感：文件树的展开目录与滚动位置要在
 * 「主窗口 → 独立原生窗口 → 主窗口」的往返里活下来。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileExplorer } from '../../src/components/files/FileExplorer'
import { PanelSlot } from '../../src/components/panels/PanelSlot'
import { openPanelWindow, type AuxWindowHandle } from '../../src/panelHost/auxWindow'
import { clearPanelUi, readPanelUi, writePanelUiLocal } from '../../src/panelHost/panelUiState'
import { usePanelStore } from '../../src/store/panelStore'
import { useI18nStore } from '../../src/store/i18nStore'
import { WorkspaceScopeProvider } from '../../src/workspace/WorkspaceScope'

vi.mock('../../src/api', () => ({
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
    saveSettings: vi.fn(async () => ({ success: true })),
    panelDetach: vi.fn(async (req: { hostId: string }) => ({
      success: true,
      hostId: req.hostId,
      frameName: `pi-panel:${req.hostId}`,
    })),
    panelDock: vi.fn(async () => ({ success: true })),
  },
}))

const { api } = await import('../../src/api')
// Windows 路径：面板保存的是 api.listDirectory 给出的原始分隔符，骨架树必须逐字复用
const WORKSPACE = 'C:\\work\\ws-detach'
/** Windows 风格子路径：保持与 api.listDirectory 完全一致的分隔符 */
const childPath = (...segments: string[]) => [WORKSPACE, ...segments].join('\\')

function mockTree(): void {
  vi.mocked(api.listDirectory).mockImplementation(async (dirPath: string) => {
    if (dirPath === WORKSPACE) {
      return { success: true, items: [{ name: 'src', path: childPath('src'), isDirectory: true }] }
    }
    if (dirPath === childPath('src')) {
      return {
        success: true,
        items: [{ name: 'index.ts', path: childPath('src', 'index.ts'), isDirectory: false }],
      }
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
  const handle = await openPanelWindow({
    id: 'aux:1',
    workspaceDir: WORKSPACE,
    panel: 'files',
    title: 'ws-detach',
    rect: { x: 10, y: 10, width: 420, height: 520 },
  })
  act(() => {
    usePanelStore.setState({
      panelHost: { [WORKSPACE]: { files: 'aux:1' } },
      windows: { 'aux:1': { workspaceDir: WORKSPACE, panel: 'files', handle } },
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

describe('FileExplorer across native windows', () => {
  it('persists expanded folders in panelUiState and hydrates when synced into a detached window', async () => {
    renderSlot()
    fireEvent.click(await screen.findByText('src'))
    await screen.findByText('index.ts')

    await detachFiles()
    // 拆出后主窗口侧不渲染文件树，但展开目录已存入 panelUiState
    expect(screen.queryByText('src')).toBeNull()
    expect(readPanelUi<{ expanded: string[] }>(WORKSPACE, 'files')?.expanded).toContain(
      childPath('src')
    )

    // 模拟独立原生窗口启动后异步收到主窗口推送的 panel-ui-state 快照
    clearPanelUi(WORKSPACE)
    const detachedView = render(
      <WorkspaceScopeProvider value={WORKSPACE}>
        <FileExplorer workspacePath={WORKSPACE} />
      </WorkspaceScopeProvider>
    )
    await detachedView.findByText('src')
    act(() => {
      writePanelUiLocal(WORKSPACE, 'files', { expanded: [childPath('src')], scrollTop: 0 })
    })
    await waitFor(() => expect(detachedView.getByText('index.ts')).toBeTruthy())
  })

  it('keeps the expansion after the panel docks back to the main window', async () => {
    renderSlot()
    fireEvent.click(await screen.findByText('src'))
    await screen.findByText('index.ts')

    await detachFiles()
    act(() => {
      usePanelStore.getState().dockPanel(WORKSPACE, 'files')
    })

    // 回位后的骨架树要靠 loadRootDirectory 回填才能渲染出子节点
    await waitFor(
      () =>
        expect(
          [...document.querySelectorAll('[role="treeitem"]')].map((row) => row.textContent)
        ).toContain('index.ts'),
      { timeout: 3000 }
    )
    expect(readPanelUi<{ expanded: string[] }>(WORKSPACE, 'files')?.expanded).toContain(
      childPath('src')
    )
  })
})
