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

import { WorktreeBar } from '../src/components/WorktreeBar'
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

describe('WorktreeBar 工作树菜单', () => {
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
    render(<WorktreeBar workspacePath="/repo" />)
    await openMenu()

    const item = await screen.findByRole('menuitemradio', { name: /feature-stale/ })
    expect(item.textContent).toContain(translations.zh.worktreeMissing)
    expect((item as HTMLButtonElement).disabled).toBe(true)
  })

  it('正常条目仍然可选', async () => {
    render(<WorktreeBar workspacePath="/repo" />)
    await openMenu()

    const item = await screen.findByRole('menuitemradio', { name: /pi\/wt-live/ })
    expect((item as HTMLButtonElement).disabled).toBe(false)
    expect(item.textContent).toContain(translations.zh.gitIdle)
  })

  it('主工作树始终可选', async () => {
    render(<WorktreeBar workspacePath="/repo" />)
    await openMenu()

    const main = await screen.findByRole('menuitemradio', { name: translations.zh.mainWorktree })
    expect((main as HTMLButtonElement).disabled).toBe(false)
  })
})
