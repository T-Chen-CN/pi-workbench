import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'

/** 捕获 registerGitIpc 注册的处理器，直接按通道调用 */
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: {},
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    },
  },
}))

vi.mock('../electron/workspace-trust', () => ({
  isTrustedWorkspacePath: () => true,
  isPathInWorkspace: () => true,
  canonicalizePath: (value: string) => value,
  isPathInsideRoot: () => true,
}))

vi.mock('../electron/worktree-coordinator', () => ({
  getCoordinator: async () => null,
}))

vi.mock('../electron/github-auth', () => ({
  readGithubAuth: async () => ({ token: null }),
  fetchGithubUser: async () => null,
  saveGithubToken: async () => undefined,
  clearGithubToken: async () => undefined,
}))

vi.mock('../electron/github-oauth', () => ({
  readGithubOAuthConfig: async () => null,
  startGithubOAuth: async () => ({ success: false }),
}))

vi.mock('../electron/git-worktrees', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../electron/git-worktrees')>()
  return { ...actual, getRepoInfo: vi.fn(actual.getRepoInfo) }
})

import { registerGitIpc } from '../electron/ipc/git'
import { getRepoInfo } from '../electron/git-worktrees'
import { clearGitCaches } from '../electron/git-cache'

let workspace = ''

function git(args: string[], cwd = workspace): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  return Promise.resolve(handler({}, ...args))
}

describe('git IPC commit detail', () => {
  beforeAll(() => {
    registerGitIpc({
      agentRegistry: { get: () => undefined } as never,
      getMainWindow: () => null,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    })
  })

  beforeEach(async () => {
    clearGitCaches()
    vi.mocked(getRepoInfo).mockClear()
    workspace = await fs.mkdtemp(path.join(tmpdir(), 'pi-git-ipc-'))
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    await fs.writeFile(path.join(workspace, 'a.txt'), 'one\n')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
    await fs.writeFile(path.join(workspace, 'b.txt'), 'two\n')
    git(['add', '.'])
    git(['commit', '-m', 'second'])
  })

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('两次查看同一个提交只探测一次仓库，只读取一次详情', async () => {
    const sha = git(['rev-parse', 'HEAD']).trim()

    const first = await invoke('git:commitDetail', workspace, sha)
    expect(first.success).toBe(true)
    expect(first.detail.commit.subject).toBe('second')

    const second = await invoke('git:commitDetail', workspace, sha)
    expect(second.detail.commit.subject).toBe('second')
    expect(vi.mocked(getRepoInfo)).toHaveBeenCalledTimes(1)
  })

  it('同一仓库的不同提交共用一次仓库探测', async () => {
    const head = git(['rev-parse', 'HEAD']).trim()
    const previous = git(['rev-parse', 'HEAD~1']).trim()

    await invoke('git:commitDetail', workspace, head)
    const older = await invoke('git:commitDetail', workspace, previous)

    expect(older.detail.commit.subject).toBe('init')
    expect(vi.mocked(getRepoInfo)).toHaveBeenCalledTimes(1)
  })

  it('提交列表与详情共用同一次仓库探测', async () => {
    const sha = git(['rev-parse', 'HEAD']).trim()

    const log = await invoke('git:log', workspace, 10)
    expect(log.success).toBe(true)
    await invoke('git:commitDetail', workspace, sha)

    expect(vi.mocked(getRepoInfo)).toHaveBeenCalledTimes(1)
  })
})
