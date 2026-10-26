// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 每次挂载时 github:auth:status 的待决 promise，用来观察校验返回前的渲染 */
const pendingStatus: Array<(value: unknown) => void> = []
/** 提交详情请求：由测试决定何时、以什么顺序返回 */
const pendingDetails: Array<{ sha: string; resolve: (value: unknown) => void }> = []
let logCommits: unknown[] = []

vi.mock('../src/api', () => ({
  api: {
    gitRepoInfo: vi.fn(async () => ({
      success: true,
      repo: { root: '/repo', branch: 'main' },
      worktrees: [],
    })),
    gitSessionBinding: vi.fn(async () => ({ success: true })),
    gitBranches: vi.fn(async () => ({ success: true, branches: [] })),
    gitLog: vi.fn(async () => ({ success: true, commits: logCommits })),
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

function commit(sha: string) {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    author: 'Test',
    email: 'test@example.com',
    date: '2026-01-01T00:00:00Z',
    subject: `subject ${sha.slice(0, 4)}`,
    refs: '',
    parents: [] as string[],
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

describe('GitView 提交详情加载', () => {
  const shaA = 'a'.repeat(40)

  beforeEach(() => {
    pendingStatus.length = 0
    pendingDetails.length = 0
    logCommits = [commit(shaA)]
    useGitStore.setState({ byWorkspace: {} })
  })

  afterEach(cleanup)

  it('点击提交立即高亮并显示加载态，返回后替换为详情', async () => {
    render(<GitView workspacePath="/repo" />)
    const row = await screen.findByRole('button', { name: /subject aaaa/ })

    await act(async () => {
      fireEvent.click(row)
    })

    expect(row.className).toContain('bg-active')
    expect(document.querySelector('.animate-spin')).not.toBeNull()
    expect(screen.queryByText('body aaaa')).toBeNull()

    await act(async () => {
      pendingDetails.pop()?.resolve({ success: true, detail: detail(shaA) })
    })

    await waitFor(() => expect(screen.queryByText('body aaaa')).not.toBeNull())
    expect(document.querySelector('.animate-spin')).toBeNull()
  })

  it('提交标题按两行排版，元信息单独一行', async () => {
    render(<GitView workspacePath="/repo" />)
    const row = await screen.findByRole('button', { name: /subject aaaa/ })
    const title = row.querySelector('.line-clamp-2')
    expect(title?.textContent).toBe('subject aaaa')
    expect(row.textContent).toContain('aaaaaaa · Test')
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
