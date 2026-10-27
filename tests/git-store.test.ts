import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  gitBindWorktree: vi.fn(),
  gitRepoInfo: vi.fn(),
  gitSessionBinding: vi.fn(),
  gitBranches: vi.fn(),
  gitLog: vi.fn(),
  gitCommitStats: vi.fn(),
  gitListWorktrees: vi.fn(),
}))

vi.mock('../src/api', () => ({ api: apiMock }))

import { useGitStore, type WorkspaceGitState } from '../src/store/gitStore'

const workspaceDir = '/ws'
const worktree = {
  id: 'wt-1',
  path: '/ws/.pi-workbench/worktrees/wt-1',
  relativePath: '.pi-workbench/worktrees/wt-1',
  branch: 'pi/wt-1',
  base: 'main',
  managed: true,
  isMain: false,
  boundSessionCount: 1,
  boundToActiveSession: true,
  dirtyCount: 0,
  ahead: 0,
  behind: 0,
}

function seed(bindingPath: string): void {
  const state: WorkspaceGitState = {
    repo: null,
    worktrees: [],
    branches: [],
    bindings: {
      'session-1': { key: 'main', path: bindingPath, branch: 'main' },
    },
    status: null,
    commits: [],
    stats: {},
    commitDetail: null,
    detailOpen: false,
    detailPending: null,
    pr: null,
    loading: false,
    error: null,
  }
  useGitStore.setState({ byWorkspace: { [workspaceDir]: state } })
}

beforeEach(() => {
  apiMock.gitBindWorktree.mockReset()
  apiMock.gitRepoInfo.mockReset()
  apiMock.gitSessionBinding.mockReset()
  apiMock.gitBranches.mockReset()
  apiMock.gitLog.mockReset()
  apiMock.gitCommitStats.mockReset()
  apiMock.gitListWorktrees.mockReset()

  apiMock.gitRepoInfo.mockResolvedValue({
    success: true,
    repo: { root: workspaceDir, branch: 'main', userEmail: null },
    worktrees: [],
  })
  apiMock.gitSessionBinding.mockResolvedValue({
    success: true,
    binding: { key: 'main', path: workspaceDir, branch: 'main' },
  })
  apiMock.gitBranches.mockResolvedValue({ success: true, branches: [] })
  apiMock.gitLog.mockResolvedValue({ success: true, commits: [] })
  apiMock.gitCommitStats.mockResolvedValue({ success: true, stats: {} })
  apiMock.gitListWorktrees.mockResolvedValue({ success: true, worktrees: [] })
  useGitStore.setState({ byWorkspace: {} })
})

describe('gitStore switchWorktree', () => {
  it('updates the binding when the runtime switched', async () => {
    apiMock.gitBindWorktree.mockResolvedValue({
      success: true,
      worktree,
      switched: { success: true, scheduled: false },
    })

    const result = await useGitStore
      .getState()
      .switchWorktree(workspaceDir, 'session-1', worktree.path)

    expect(result).toEqual({ success: true, scheduled: false })
    expect(useGitStore.getState().byWorkspace[workspaceDir].bindings['session-1']).toEqual({
      key: 'wt-1',
      path: worktree.path,
      branch: 'pi/wt-1',
    })
  })

  it('reports failure and keeps the old binding when the runtime did not switch', async () => {
    seed(workspaceDir)
    apiMock.gitBindWorktree.mockResolvedValue({
      success: true,
      worktree,
      switched: { success: false, error: 'Failed to switch the session worktree.' },
    })

    const result = await useGitStore
      .getState()
      .switchWorktree(workspaceDir, 'session-1', worktree.path)

    expect(result).toEqual({
      success: false,
      error: 'Failed to switch the session worktree.',
    })
    expect(useGitStore.getState().byWorkspace[workspaceDir].bindings['session-1']).toEqual({
      key: 'main',
      path: workspaceDir,
      branch: 'main',
    })
  })
})

describe('gitStore handleChanged', () => {
  it('refreshes branches and history for the refs scope', async () => {
    await useGitStore.getState().handleChanged(workspaceDir, ['refs'], 'session-1')

    expect(apiMock.gitRepoInfo).toHaveBeenCalledWith(workspaceDir)
    expect(apiMock.gitLog).toHaveBeenCalled()
    expect(apiMock.gitCommitStats).toHaveBeenCalled()
    expect(apiMock.gitListWorktrees).not.toHaveBeenCalled()
  })

  it('refreshes worktree status only for the status scope', async () => {
    await useGitStore.getState().handleChanged(workspaceDir, ['status'], 'session-1')

    expect(apiMock.gitListWorktrees).toHaveBeenCalledWith(workspaceDir, 'session-1')
    expect(apiMock.gitRepoInfo).not.toHaveBeenCalled()
    expect(apiMock.gitLog).not.toHaveBeenCalled()
  })
})
