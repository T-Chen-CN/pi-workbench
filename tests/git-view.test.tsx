// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 每次挂载时 github:auth:status 的待决 promise，用来观察校验返回前的渲染 */
const pendingStatus: Array<(value: unknown) => void> = []
/** 提交详情请求：由测试决定何时、以什么顺序返回 */
const pendingDetails: Array<{ sha: string; resolve: (value: unknown) => void }> = []
let logCommits: unknown[] = []
let repoWorktrees: unknown[] = []

vi.mock('../src/api', () => ({
  api: {
    gitRepoInfo: vi.fn(async () => ({
      success: true,
      repo: { root: '/repo', branch: 'main', userEmail: null },
      worktrees: repoWorktrees,
    })),
    gitSessionBinding: vi.fn(async () => ({ success: true })),
    gitBranches: vi.fn(async () => ({ success: true, branches: [] })),
    gitLog: vi.fn(async () => ({ success: true, commits: logCommits })),
    gitCommitStats: vi.fn(async () => ({
      success: true,
      stats: {
        ['a'.repeat(40)]: {
          additions: 10,
          deletions: 2,
          addedFiles: 1,
          modifiedFiles: 1,
          deletedFiles: 0,
        },
      },
    })),
    gitCreateBranch: vi.fn(async () => ({ success: true })),
    gitCommitDetail: vi.fn(
      (_dir: string, sha: string) =>
        new Promise((resolve) => {
          pendingDetails.push({ sha, resolve })
        })
    ),
    gitPrStatus: vi.fn(async () => ({ success: true, status: null })),
    githubAuthStatus: vi.fn(
      () =>
        new Promise((resolve) => {
          pendingStatus.push(resolve)
        })
    ),
    onGithubAuthComplete: vi.fn(() => () => {}),
    onAgentSessionRootChanged: vi.fn(() => () => {}),
  },
}))

import { GitView } from '../src/components/GitView'
import { useGitStore } from '../src/store/gitStore'
import { translations } from '../src/i18n/translations'
import type { GitCommitDetail } from '../src/types/electron'

const NOT_LINKED = translations.zh.githubNotLinked

function detail(sha: string): GitCommitDetail {
  return {
    commit: {
      sha,
      shortSha: sha.slice(0, 7),
      author: 'Test',
      email: 'test@example.com',
      date: '2026-01-01T00:00:00Z',
      subject: `subject ${sha.slice(0, 4)}`,
      refs: '',
      parents: [],
    },
    body: `body ${sha.slice(0, 4)}`,
    files: [],
    patch: '',
    truncated: false,
  }
}

function commit(sha: string, refs = '', parents: string[] = []) {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    author: 'Test',
    email: 'test@example.com',
    date: '2026-01-01T00:00:00Z',
    subject: `subject ${sha.slice(0, 4)}`,
    refs,
    parents,
  }
}

describe('GitView GitHub 关联提示', () => {
  beforeEach(() => {
    pendingStatus.length = 0
    pendingDetails.length = 0
    logCommits = []
    useGitStore.setState({ byWorkspace: {} })
  })

  afterEach(cleanup)

  it('校验返回前不显示“未关联”，已关联时始终不显示', async () => {
    render(<GitView workspacePath="/repo" />)
    expect(screen.queryByText(NOT_LINKED)).toBeNull()

    await act(async () => {
      pendingStatus.pop()?.({ success: true, configured: true })
    })

    expect(screen.queryByText(NOT_LINKED)).toBeNull()
  })

  it('校验确认未关联后才显示“未关联”与关联入口', async () => {
    render(<GitView workspacePath="/repo" />)
    expect(screen.queryByText(NOT_LINKED)).toBeNull()

    await act(async () => {
      pendingStatus.pop()?.({ success: true, configured: false })
    })

    await waitFor(() => expect(screen.queryByText(NOT_LINKED)).not.toBeNull())
    expect(screen.queryByText(translations.zh.githubLink)).not.toBeNull()
  })
})

describe('GitView 提交列表', () => {
  const shaA = 'a'.repeat(40)

  beforeEach(() => {
    pendingStatus.length = 0
    pendingDetails.length = 0
    logCommits = [commit(shaA, 'HEAD -> main, origin/main')]
    useGitStore.setState({ byWorkspace: {} })
  })

  afterEach(cleanup)

  it('行内显示标题、作者、短 SHA 与 ref 徽章', async () => {
    render(<GitView workspacePath="/repo" />)

    const row = await screen.findByRole('button', { name: /subject aaaa/ })
    expect(row.textContent).toContain('subject aaaa')
    expect(row.textContent).toContain('Test')
    expect(row.textContent).toContain('aaaaaaa')
    expect(within(row).getByText('main')).not.toBeNull()
    expect(within(row).getByText('origin')).not.toBeNull()
  })

  it('ref 过滤 chip 可以隐藏对应徽章', async () => {
    render(<GitView workspacePath="/repo" />)
    const row = await screen.findByRole('button', { name: /subject aaaa/ })

    fireEvent.click(screen.getByRole('button', { name: translations.zh.gitLocalRefs }))
    expect(within(row).queryByText('main')).toBeNull()
    expect(within(row).getByText('origin')).not.toBeNull()
  })

  it('合并提交在标题前显示合并图标', async () => {
    logCommits = [commit(shaA, '', ['b'.repeat(40), 'c'.repeat(40)])]
    render(<GitView workspacePath="/repo" />)

    const row = await screen.findByRole('button', { name: /subject aaaa/ })
    expect(within(row).getByTitle(translations.zh.gitMergeCommit)).not.toBeNull()
  })

  it('点击提交立即高亮并进入详情加载态，返回后写入详情', async () => {
    render(<GitView workspacePath="/repo" />)
    const row = await screen.findByRole('button', { name: /subject aaaa/ })

    await act(async () => {
      fireEvent.click(row)
    })

    const state = useGitStore.getState().byWorkspace['/repo']
    expect(state.detailOpen).toBe(true)
    expect(row.className).toContain('border-accent')
    expect(document.querySelector('.animate-spin')).not.toBeNull()

    await act(async () => {
      pendingDetails.pop()?.resolve({ success: true, detail: detail(shaA) })
    })

    const after = useGitStore.getState().byWorkspace['/repo']
    expect(after.commitDetail?.commit.sha).toBe(shaA)
    expect(after.detailPending).toBeNull()
    expect(document.querySelector('.animate-spin')).toBeNull()
  })

  it('后发的请求先返回时，先发的旧响应不会覆盖新选择', async () => {
    const shaB = 'b'.repeat(40)
    const store = useGitStore.getState()
    const first = store.loadCommitDetail('/repo', shaA)
    const second = store.loadCommitDetail('/repo', shaB)

    pendingDetails.find((item) => item.sha === shaB)!.resolve({
      success: true,
      detail: detail(shaB),
    })
    await second

    pendingDetails.find((item) => item.sha === shaA)!.resolve({
      success: true,
      detail: detail(shaA),
    })
    await first

    const state = useGitStore.getState().byWorkspace['/repo']
    expect(state.commitDetail?.commit.sha).toBe(shaB)
    expect(state.detailPending).toBeNull()
  })
})

describe('GitView 工作树列表', () => {
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

  async function openWorktreeList(): Promise<void> {
    const toggle = await screen.findByRole('button', {
      name: new RegExp(translations.zh.gitWorktrees),
    })
    fireEvent.click(toggle)
  }

  beforeEach(() => {
    pendingStatus.length = 0
    pendingDetails.length = 0
    logCommits = []
    repoWorktrees = []
    useGitStore.setState({ byWorkspace: {} })
  })

  afterEach(() => {
    cleanup()
    repoWorktrees = []
  })

  it('失效的工作树显示“已失效”且不提供切换入口', async () => {
    repoWorktrees = [
      worktree({ id: 'ext-stale', branch: 'feature-stale', missing: true, managed: false }),
    ]
    render(<GitView workspacePath="/repo" />)
    await openWorktreeList()

    expect(await screen.findAllByText(translations.zh.worktreeMissing)).not.toHaveLength(0)
    expect(screen.queryByRole('button', { name: translations.zh.gitUseWorktree })).toBeNull()
  })

  it('正常的工作树仍提供切换入口', async () => {
    repoWorktrees = [worktree({})]
    render(<GitView workspacePath="/repo" />)
    await openWorktreeList()

    expect(
      await screen.findByRole('button', { name: translations.zh.gitUseWorktree })
    ).not.toBeNull()
    expect(screen.queryByText(translations.zh.worktreeMissing)).toBeNull()
  })
})
