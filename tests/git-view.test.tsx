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
    gitForgetWorktree: vi.fn(async () => ({ success: true, worktrees: [] })),
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
import { api } from '../src/api'
import { useDialogStore } from '../src/store/dialogStore'
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

describe('GitView 窄面板提交行', () => {
  const shaA = 'a'.repeat(40)
  const NARROW_WIDTH = 380

  /** jsdom 没有 ResizeObserver；模拟一次异步回调，让面板进入窄视图 */
  class NarrowResizeObserver {
    private readonly callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }
    observe(target: Element): void {
      queueMicrotask(() => {
        this.callback(
          [{ target, contentRect: { width: NARROW_WIDTH } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver
        )
      })
    }
    unobserve(): void {}
    disconnect(): void {}
  }

  async function renderNarrowRow(refs: string) {
    logCommits = [commit(shaA, refs)]
    const view = render(<GitView workspacePath="/repo" />)
    const row = await screen.findByRole('button', { name: /subject aaaa/ })
    await waitFor(() => expect(row.querySelector('[style*="52px"]')).not.toBeNull())
    return { view, row, cell: row.querySelector('[style*="52px"]') as HTMLElement }
  }

  beforeEach(() => {
    pendingStatus.length = 0
    pendingDetails.length = 0
    repoWorktrees = []
    useGitStore.setState({ byWorkspace: {} })
    vi.stubGlobal('ResizeObserver', NarrowResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('标题与时间占第一行、ref 与短哈希占第二行，时间与哈希同列右对齐', async () => {
    const { cell } = await renderNarrowRow('HEAD -> main, origin/main')

    const cells = Array.from(cell.children) as HTMLElement[]
    expect(cells).toHaveLength(4)

    expect(cells[0].textContent).toContain('subject aaaa')
    expect(cells[1].textContent?.trim()).not.toBe('')
    expect(cells[2].textContent).toContain('main')
    expect(cells[3].textContent).toBe('aaaaaaa')

    expect(cells[1].className).toContain('justify-end')
    expect(cells[3].className).toContain('text-right')
    expect(cells[2].className).toContain('overflow-hidden')
    expect(cell.style.gridTemplateColumns).toContain('52px')
  })

  it('窄面板不显示作者与变更环，短哈希不再占用 ref 行宽度', async () => {
    const { row } = await renderNarrowRow('HEAD -> main')

    expect(within(row).queryByText('Test')).toBeNull()
    expect(row.textContent).toContain('aaaaaaa')
  })

  it('放不下的 ref 折成 +N，并保留全部 ref 名的悬停提示', async () => {
    const { cell } = await renderNarrowRow('HEAD -> main, origin/main, feat/a, feat/b')

    const refsCell = cell.children[2] as HTMLElement
    expect(refsCell.textContent).toContain('main')
    expect(refsCell.textContent).toContain('+3')

    const overflow = within(refsCell).getByText('+3')
    expect(overflow.getAttribute('title')).toContain('origin/main')
    expect(overflow.getAttribute('title')).toContain('feat/b')
  })

})

describe('GitView 宽面板提交行', () => {
  const shaA = 'a'.repeat(40)

  beforeEach(() => {
    pendingStatus.length = 0
    pendingDetails.length = 0
    repoWorktrees = []
    logCommits = [commit(shaA, 'HEAD -> main, origin/main')]
    useGitStore.setState({ byWorkspace: {} })
  })

  afterEach(cleanup)

  it('保持单行布局，不出现固定 52px 列，作者仍可见', async () => {
    render(<GitView workspacePath="/repo" />)

    const row = await screen.findByRole('button', { name: /subject aaaa/ })
    expect(row.querySelector('[style*="52px"]')).toBeNull()
    expect(row.style.gridTemplateColumns).not.toContain('52px')
    expect(within(row).getByText('Test')).not.toBeNull()
    expect(within(row).getByText('main')).not.toBeNull()
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
      deps: { state: 'none' as const, manager: null, hash: null },
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
    useDialogStore.setState({ current: null })
    vi.mocked(api.gitForgetWorktree).mockClear()
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

  it('失效的工作树可以手动忘记，确认后只移除登记', async () => {
    repoWorktrees = [
      worktree({ id: 'ext-stale', branch: 'feature-stale', missing: true, managed: false }),
    ]
    vi.mocked(api.gitForgetWorktree).mockResolvedValueOnce({
      success: true,
      worktrees: [worktree({ id: 'main', branch: 'main', isMain: true })],
    })
    render(<GitView workspacePath="/repo" />)
    await openWorktreeList()

    fireEvent.click(
      await screen.findByRole('button', { name: translations.zh.worktreeForget })
    )
    await waitFor(() => expect(useDialogStore.getState().current?.kind).toBe('confirm'))
    await act(async () => {
      useDialogStore.getState().close(true)
    })

    await waitFor(() =>
      expect(api.gitForgetWorktree).toHaveBeenCalledWith('/repo', 'ext-stale', undefined)
    )
    const views = useGitStore.getState().byWorkspace['/repo'].worktrees
    expect(views.some((item) => item.id === 'ext-stale')).toBe(false)
  })

  it('取消确认时不会忘记工作树', async () => {
    repoWorktrees = [
      worktree({ id: 'ext-stale', branch: 'feature-stale', missing: true, managed: false }),
    ]
    render(<GitView workspacePath="/repo" />)
    await openWorktreeList()

    fireEvent.click(
      await screen.findByRole('button', { name: translations.zh.worktreeForget })
    )
    await waitFor(() => expect(useDialogStore.getState().current?.kind).toBe('confirm'))
    await act(async () => {
      useDialogStore.getState().close(false)
    })

    expect(api.gitForgetWorktree).not.toHaveBeenCalled()
  })
})
