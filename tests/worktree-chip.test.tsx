// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  gitRepoInfo: vi.fn(),
  gitSessionBinding: vi.fn(async () => ({ success: true })),
  gitBranches: vi.fn(async () => ({ success: true, branches: [] })),
  gitListWorktrees: vi.fn(async () => ({ success: true, worktrees: [] })),
  gitBindWorktree: vi.fn(),
  onAgentSessionRootChanged: vi.fn(() => () => {}),
}))

vi.mock('../src/api', () => ({ api: apiMock }))

import { WorktreeChip } from '../src/components/WorktreeChip'
import { ChatPanelHeader } from '../src/components/ChatPanelHeader'
import { useGitStore } from '../src/store/gitStore'
import { useSessionStore } from '../src/store/sessionStore'
import { translations } from '../src/i18n/translations'

const REPO = {
  root: '/repo',
  gitDir: '/repo/.git',
  commonDir: '/repo/.git',
  bare: false,
  linkedWorktree: false,
  branch: 'main',
  head: 'a'.repeat(40),
  userEmail: null,
}

function worktree(overrides: Record<string, unknown>) {
  return {
    id: 'wt-1',
    path: '/repo/.claude/worktrees/wt-1',
    relativePath: '.claude/worktrees/wt-1',
    branch: 'pi/wt-1',
    base: 'main',
    managed: true,
    isMain: false,
    missing: false,
    boundSessionCount: 0,
    boundToActiveSession: false,
    dirtyCount: 0,
    ahead: 0,
    behind: 0,
    ...overrides,
  }
}

async function openMenu(): Promise<void> {
  fireEvent.click(await screen.findByTitle('/repo'))
}

describe('WorktreeChip 工作树菜单', () => {
  beforeEach(() => {
    useGitStore.setState({ byWorkspace: {} })
    useSessionStore.setState({
      byWorkspace: {
        '/repo': { sessions: [], open: ['session-1'], active: 'session-1', panelOpen: false },
      },
    })
    apiMock.gitRepoInfo.mockResolvedValue({
      success: true,
      repo: REPO,
      worktrees: [
        worktree({ id: 'main', path: '/repo', relativePath: '', branch: 'main', isMain: true }),
        worktree({ id: 'ext-stale', branch: 'feature-stale', relativePath: '.claude/worktrees/stale', missing: true, managed: false }),
        worktree({ id: 'wt-live', branch: 'pi/wt-live', relativePath: '.pi-workbench/worktrees/wt-live' }),
      ],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('失效条目标注“已失效”且不可选', async () => {
    render(<WorktreeChip workspacePath="/repo" />)
    await openMenu()

    const item = await screen.findByRole('menuitemradio', { name: /feature-stale/ })
    expect(item.textContent).toContain(translations.zh.worktreeMissing)
    expect((item as HTMLButtonElement).disabled).toBe(true)
  })

  it('正常条目仍然可选', async () => {
    render(<WorktreeChip workspacePath="/repo" />)
    await openMenu()

    const item = await screen.findByRole('menuitemradio', { name: /pi\/wt-live/ })
    expect((item as HTMLButtonElement).disabled).toBe(false)
    expect(item.textContent).toContain(translations.zh.gitIdle)
  })

  it('主工作树始终可选', async () => {
    render(<WorktreeChip workspacePath="/repo" />)
    await openMenu()

    const main = await screen.findByRole('menuitemradio', { name: translations.zh.mainWorktree })
    expect((main as HTMLButtonElement).disabled).toBe(false)
  })

  it('chip 自身声明下拉语义并带当前分支', async () => {
    render(<WorktreeChip workspacePath="/repo" />)

    const chip = await screen.findByRole('button', {
      name: translations.zh.worktreeChipLabel.replace('{branch}', 'main'),
    })
    expect(chip.getAttribute('aria-haspopup')).toBe('menu')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(chip.textContent).toContain(translations.zh.mainWorktree)

    fireEvent.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
  })

  it('非 git 仓库时整块不渲染，头部高度不变', () => {
    apiMock.gitRepoInfo.mockResolvedValue({ success: false })
    render(<WorktreeChip workspacePath="/plain" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('ChatPanelHeader', () => {
  const t = (key: keyof typeof translations.zh) => translations.zh[key]

  beforeEach(() => {
    useGitStore.setState({ byWorkspace: {} })
    useSessionStore.setState({ byWorkspace: {} })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('就绪状态不再显示，只保留标题', () => {
    render(<ChatPanelHeader t={t} initialized />)
    expect(screen.getByText(translations.zh.agentChatTitle)).toBeTruthy()
    expect(screen.queryByText(translations.zh.agentReadyStatus)).toBeNull()
  })

  it('初始化期间标题退为「初始化中…」', () => {
    render(<ChatPanelHeader t={t} initialized={false} />)
    expect(screen.getByText(translations.zh.agentInitializingStatus)).toBeTruthy()
    expect(screen.queryByText(translations.zh.agentChatTitle)).toBeNull()
  })

  it('传入工作区时渲染工作树 chip', async () => {
    useSessionStore.setState({
      byWorkspace: {
        '/repo': { sessions: [], open: ['session-1'], active: 'session-1', panelOpen: false },
      },
    })
    apiMock.gitRepoInfo.mockResolvedValue({ success: true, repo: REPO, worktrees: [worktree({ id: 'main', path: '/repo', relativePath: '', branch: 'main', isMain: true })] })

    render(<ChatPanelHeader t={t} initialized workspacePath="/repo" />)
    expect(await screen.findByTitle('/repo')).toBeTruthy()
  })
})
