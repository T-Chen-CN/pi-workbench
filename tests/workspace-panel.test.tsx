// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoMapCanvasState, RepoMapFile, RepoMapResult } from '../src/types/electron'
import { translations } from '../src/i18n/translations'
import { useI18nStore } from '../src/store/i18nStore'

const gitHandlers = vi.hoisted(() => [] as Array<(payload: { workspaceDir: string }) => void>)

const scan = vi.fn()
const describePaths = vi.fn()
const canvasGet = vi.fn()
const canvasSet = vi.fn()

vi.mock('../src/api', () => ({
  api: {
    repoMapScan: (workspaceDir: string, options?: unknown) => scan(workspaceDir, options),
    repoMapDescribe: (workspaceDir: string, paths: string[]) => describePaths(workspaceDir, paths),
    repoMapCanvasGet: (workspaceDir: string) => canvasGet(workspaceDir),
    repoMapCanvasSet: (workspaceDir: string, state: unknown) => canvasSet(workspaceDir, state),
    onGitChanged: (callback: (payload: { workspaceDir: string }) => void) => {
      gitHandlers.push(callback)
      return () => {
        const index = gitHandlers.indexOf(callback)
        if (index >= 0) gitHandlers.splice(index, 1)
      }
    }
  }
}))

vi.mock('../src/workspace/openFileInEditor', () => ({
  openFileInEditor: vi.fn(async () => ({ status: 'opened', kind: 'text' }))
}))

const { WorkspacePanel } = await import('../src/components/WorkspacePanel')
const { useRepoMapStore, resetRepoMapStore } = await import('../src/store/repoMapStore')
const { openFileInEditor } = await import('../src/workspace/openFileInEditor')

const zh = translations.zh

const emptyState = (): RepoMapCanvasState => ({
  version: 1,
  layoutVersion: 4,
  zoom: 1,
  pan: { x: 0, y: 0 },
  folders: {},
  files: {}
})

const file = (overrides: Partial<RepoMapFile> & { path: string }): RepoMapFile => ({
  role: 'util',
  binary: false,
  size: 10,
  mtimeMs: 1,
  described: true,
  ...overrides
})

const fixture: RepoMapResult = {
  success: true,
  isRepo: true,
  repoRoot: '/ws',
  total: 4,
  described: 4,
  truncated: false,
  files: [
    file({ path: 'AGENTS.md', role: 'doc' }),
    file({ path: 'src/components/FileView.tsx', role: 'component', headComment: '编辑区容器', symbol: 'FileView' }),
    file({ path: 'src/store/editorStore.ts', role: 'state', headComment: '编辑器状态' }),
    file({ path: 'src/utils/fileKind.ts', role: 'util', exports: ['detectFileKind'] })
  ]
}

function seed(result: RepoMapResult, workspaceDir = '/ws') {
  useRepoMapStore.setState({
    byWorkspace: {
      [workspaceDir]: {
        status: 'ready',
        scanned: true,
        scanning: false,
        isRepo: result.isRepo,
        repoRoot: result.repoRoot ?? null,
        files: result.files,
        total: result.total,
        described: result.described,
        truncated: result.truncated,
        error: null,
        updatedAt: Date.now()
      }
    }
  })
}

async function renderPanel(options: { active?: boolean } = {}) {
  const utils = render(<WorkspacePanel workspacePath="/ws" active={options.active ?? true} />)
  await waitFor(() => expect(screen.getByTestId('repo-map-canvas')).toBeTruthy())
  return utils
}

const cardPaths = () =>
  screen.getAllByTestId(/repo-map-(card|folder)/).map((node) => node.dataset.path)

const cardByPath = (path: string) =>
  screen.getAllByTestId(/repo-map-(card|folder)/).find((node) => node.dataset.path === path)!

/** 点开一个目录 → 等那张卡抬起来 */
async function openFolder(path: string) {
  const target = cardByPath(path)
  expect(target).toBeTruthy()
  fireEvent.click(target)
  await waitFor(() => expect(cardByPath(path).dataset.elevated).toBe('true'))
  return cardByPath(path)
}

const elevatedPaths = () =>
  screen
    .getAllByTestId(/repo-map-(card|folder)/)
    .filter((node) => node.dataset.elevated === 'true')
    .map((node) => node.dataset.path)

beforeEach(() => {
  resetRepoMapStore()
  gitHandlers.length = 0
  useI18nStore.getState().setLanguage('zh')
  scan.mockReset()
  describePaths.mockReset()
  canvasGet.mockReset()
  canvasSet.mockReset()
  scan.mockResolvedValue(fixture)
  describePaths.mockResolvedValue(fixture)
  canvasGet.mockResolvedValue({ success: true, state: emptyState() })
  canvasSet.mockResolvedValue({ success: true })
  vi.mocked(openFileInEditor).mockClear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WorkspacePanel', () => {
  it('把顶层目录画成文件夹卡，根目录文件直接成卡', async () => {
    await renderPanel()

    const folders = screen.getAllByTestId('repo-map-folder')
    const cards = screen.getAllByTestId('repo-map-card')
    expect(folders.map((node) => node.dataset.path)).toEqual(['src'])
    expect(cards.map((node) => node.dataset.path)).toEqual(['AGENTS.md'])
  })

  it('点根目录文件卡在编辑器打开（绝对路径按仓库根拼）', async () => {
    await renderPanel()

    fireEvent.click(screen.getByTestId('repo-map-card'))
    expect(openFileInEditor).toHaveBeenCalledWith('/ws', '/ws/AGENTS.md')
  })

  it('点文件夹：那张卡原地抬起，子目录在右侧展开', async () => {
    await renderPanel()
    const beforeLeft = Number.parseFloat(cardByPath('src').style.left)
    const beforeTop = cardByPath('src').style.top

    await openFolder('src')

    expect(cardByPath('src').style.left).toBe(`${beforeLeft}px`)
    expect(cardByPath('src').style.top).toBe(beforeTop)
    // src 的直接子项全部抬起，并排在右侧一列
    expect(elevatedPaths()).toEqual([
      'src',
      'src/components',
      'src/store',
      'src/utils'
    ])
    expect(Number.parseFloat(cardByPath('src/components').style.left)).toBe(beforeLeft + 176 + 40)
    // 底层其他卡压暗且不可点
    expect(cardByPath('AGENTS.md').style.pointerEvents).toBe('none')
    // 当前层 = 被点的文件夹 + 它展开出的子项，两者都拿强调边
    expect(cardByPath('src').dataset.depth).toBe('0')
    expect(cardByPath('src').dataset.emphasized).toBe('true')
    expect(cardByPath('src/components').dataset.depth).toBe('1')
    expect(cardByPath('src/components').dataset.emphasized).toBe('true')
  })

  it('再点一层，文件卡显示职责与角色标签', async () => {
    await renderPanel()

    await openFolder('src')
    await openFolder('src/components')

    await waitFor(() =>
      expect(cardByPath('src/components/FileView.tsx')).toBeTruthy()
    )
    const card = cardByPath('src/components/FileView.tsx')
    expect(card.dataset.elevated).toBe('true')
    expect(card.textContent).toContain('FileView：编辑区容器')
    expect(card.textContent).toContain(zh.repoMapRoleComponent)
  })

  it('搜索时自动把祖先目录逐层抬起来', async () => {
    await renderPanel()

    fireEvent.change(screen.getByRole('textbox', { name: zh.repoMapSearchLabel }), {
      target: { value: 'editorstore' }
    })

    await waitFor(() => expect(cardByPath('src/store/editorStore.ts')).toBeTruthy())
    expect(elevatedPaths()).toEqual([
      'src',
      'src/components',
      'src/store',
      'src/utils',
      'src/store/editorStore.ts'
    ])
    expect(cardByPath('src/store/editorStore.ts').className).toContain('border-accent')
  })

  it('搜索不到时画布保持原状', async () => {
    await renderPanel()

    fireEvent.change(screen.getByRole('textbox', { name: zh.repoMapSearchLabel }), {
      target: { value: '没有这个东西' }
    })

    expect(cardPaths()).toEqual(['src', 'AGENTS.md'])
    expect(screen.getByTestId('repo-map-card').className).toContain('opacity-25')
  })

  it('打开浮层时按需补描述', async () => {
    seed({
      ...fixture,
      truncated: true,
      described: 1,
      files: fixture.files.map((item) => ({ ...item, described: false }))
    })
    render(<WorkspacePanel workspacePath="/ws" active />)
    await waitFor(() => expect(screen.getByTestId('repo-map-canvas')).toBeTruthy())

    await openFolder('src')
    await waitFor(() =>
      expect(describePaths).toHaveBeenCalledWith('/ws', [
        'src/components/FileView.tsx',
        'src/store/editorStore.ts',
        'src/utils/fileKind.ts'
      ])
    )
  })

  it('降级时显示「描述不全」提示条', async () => {
    seed({ ...fixture, truncated: true, described: 2 })
    render(<WorkspacePanel workspacePath="/ws" active />)

    expect(screen.getByTestId('repo-map-truncated')).toBeTruthy()
    expect(screen.getByText(zh.repoMapTruncated.split('{')[0].trim(), { exact: false })).toBeTruthy()
  })

  it('非 git 仓库显示说明而不是画布', async () => {
    scan.mockResolvedValue({ ...fixture, isRepo: false, total: 0, described: 0, files: [] })
    render(<WorkspacePanel workspacePath="/ws" active />)

    await waitFor(() => expect(screen.getByText(zh.repoMapNotRepo)).toBeTruthy())
    expect(screen.queryByTestId('repo-map-canvas')).toBeNull()
  })

  it('刷新按钮强制重扫', async () => {
    await renderPanel()
    scan.mockClear()

    fireEvent.click(screen.getByRole('button', { name: zh.repoMapRefresh }))
    await waitFor(() => expect(scan).toHaveBeenCalledWith('/ws', { force: true }))
  })

  it('工具条提供缩放 / 适应窗口 / 还原布局，并带小地图', async () => {
    await renderPanel()

    expect(screen.getByRole('button', { name: zh.repoMapCanvasFit })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.repoMapCanvasReset })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.repoMapCanvasZoomIn })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.repoMapCanvasZoomOut })).toBeTruthy()
    expect(screen.getByTestId('repo-map-minimap')).toBeTruthy()
    expect(screen.getByLabelText(zh.repoMapCanvasZoomLevel.replace('{percent}', '100'))).toBeTruthy()
  })

  it('还原布局会清空已保存的位置并重新落盘', async () => {
    canvasGet.mockResolvedValue({
      success: true,
      state: {
        ...emptyState(),
        folders: { src: { x: 400, y: 40 } }
      }
    })
    await renderPanel()

    fireEvent.click(screen.getByRole('button', { name: zh.repoMapCanvasReset }))
    await waitFor(() => expect(canvasSet).toHaveBeenCalled())
    const calls = canvasSet.mock.calls
    const saved = calls[calls.length - 1][1] as RepoMapCanvasState
    // 手摆的坐标一起清空，位置交回底层布局
    expect(saved.folders).toEqual({})
    expect(saved.files).toEqual({})
  })

  it('面板不可见时 git 变化不重扫，重新可见后补一次', async () => {
    seed(fixture)
    const { rerender } = render(<WorkspacePanel workspacePath="/ws" active />)
    await waitFor(() => expect(screen.getByTestId('repo-map-canvas')).toBeTruthy())
    scan.mockClear()

    rerender(<WorkspacePanel workspacePath="/ws" active={false} />)
    act(() => {
      for (const handler of [...gitHandlers]) handler({ workspaceDir: '/ws' })
    })
    expect(scan).not.toHaveBeenCalled()

    rerender(<WorkspacePanel workspacePath="/ws" active />)
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
  })

  it('节点数达到阈值（≥600）才提示逐层查看或搜索', async () => {
    seed({ ...fixture, total: 599 })
    await renderPanel()
    expect(screen.queryByText(new RegExp('个文件：点开文件夹逐层查看'))).toBeNull()
  })

  it('节点数到 600 就提示', async () => {
    seed({ ...fixture, total: 600 })
    await renderPanel()
    expect(screen.getByText(new RegExp('600 个文件：点开文件夹逐层查看'))).toBeTruthy()
  })

  it('面板不可见时不扫描', () => {
    render(<WorkspacePanel workspacePath="/ws" active={false} />)
    expect(scan).not.toHaveBeenCalled()
  })

  it('扫描失败时给出说明和重试入口', async () => {
    scan.mockResolvedValue({ ...fixture, success: false, error: 'git exploded' })
    render(<WorkspacePanel workspacePath="/ws" active />)

    await waitFor(() => expect(screen.getByText(new RegExp('git exploded'))).toBeTruthy())
    expect(screen.getByRole('button', { name: zh.repoMapRetry })).toBeTruthy()
  })
})
