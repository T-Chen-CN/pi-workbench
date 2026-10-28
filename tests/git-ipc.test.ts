import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'

/** 捕获 registerGitIpc 注册的处理器，直接按通道调用 */
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

const deviceLogin = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  open: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {},
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    },
  },
}))

const trust = vi.hoisted(() => ({ trusted: true }))

vi.mock('../electron/workspace-trust', () => ({
  isTrustedWorkspacePath: () => trust.trusted,
  isPathInWorkspace: () => true,
  canonicalizePath: (value: string) => value,
  isPathInsideRoot: () => true,
}))

const coordinatorHolder = vi.hoisted(() => ({ current: null as unknown }))
const depsConfigHolder = vi.hoisted(() => ({ current: null as any }))

vi.mock('../electron/worktree-coordinator', () => ({
  getCoordinator: async () => coordinatorHolder.current,
  configureWorktreeLogging: () => {},
  configureWorktreeDeps: (config: unknown) => {
    depsConfigHolder.current = config
  },
}))

const settingsHolder = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('../electron/ipc/settings', () => ({
  getAppSettingsCache: () => settingsHolder.current,
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

vi.mock('../electron/github-device-login', () => ({
  startGithubDeviceLogin: deviceLogin.start,
  cancelGithubDeviceLogin: deviceLogin.cancel,
  openGithubDeviceVerification: deviceLogin.open,
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
    deviceLogin.start.mockReset()
    deviceLogin.cancel.mockReset()
    deviceLogin.open.mockReset()
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

  it('按 sha 返回提交的改动统计', async () => {
    const head = git(['rev-parse', 'HEAD']).trim()
    const result = await invoke('git:commitStats', workspace, 10)

    expect(result.success).toBe(true)
    expect(result.stats[head]).toMatchObject({
      additions: 1,
      deletions: 0,
      addedFiles: 1,
      modifiedFiles: 0,
      deletedFiles: 0,
    })
  })

  it('全分支模式返回其他分支上的提交', async () => {
    git(['checkout', '-b', 'side'])
    await fs.writeFile(path.join(workspace, 'c.txt'), 'three\n')
    git(['add', '.'])
    git(['commit', '-m', 'side'])
    git(['checkout', 'main'])

    const log = await invoke('git:log', workspace, 10, undefined, true)
    expect(log.success).toBe(true)
    expect(log.commits.map((item: { subject: string }) => item.subject)).toEqual(
      expect.arrayContaining(['side', 'second', 'init'])
    )
  })

  it('可以在指定提交上创建分支', async () => {
    const previous = git(['rev-parse', 'HEAD~1']).trim()
    const result = await invoke('git:createBranch', workspace, previous, 'feature/from-test')

    expect(result.success).toBe(true)
    expect(git(['branch', '--list', 'feature/from-test']).trim()).toContain('feature/from-test')
  })

  it('非法分支名会被拒绝', async () => {
    const head = git(['rev-parse', 'HEAD']).trim()
    const result = await invoke('git:createBranch', workspace, head, 'bad name')

    expect(result.success).toBe(false)
  })

  it('设备码登录通道返回用户码', async () => {
    deviceLogin.start.mockResolvedValue({
      success: true,
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    })

    const result = await invoke('github:auth:device:start')
    expect(result).toMatchObject({ success: true, userCode: 'ABCD-1234', interval: 5 })
  })

  it('取消设备码登录', async () => {
    deviceLogin.cancel.mockReturnValue(true)

    await expect(invoke('github:auth:device:cancel')).resolves.toEqual({
      success: true,
      cancelled: true,
    })
  })

  it('重新打开设备授权页', async () => {
    deviceLogin.open.mockResolvedValue(true)

    await expect(invoke('github:auth:device:open')).resolves.toEqual({ success: true })
  })

  it('解除关联时取消进行中的设备码登录', async () => {
    deviceLogin.cancel.mockReturnValue(false)

    await invoke('github:auth:logout')
    expect(deviceLogin.cancel).toHaveBeenCalled()
  })
})

describe('git IPC worktree binding rollback', () => {
  const ws = '/ws'
  const worktreePath = '/ws/worktrees/wt'
  let coordinator: {
    hasBinding: ReturnType<typeof vi.fn>
    getSessionRoot: ReturnType<typeof vi.fn>
    bind: ReturnType<typeof vi.fn>
    unbind: ReturnType<typeof vi.fn>
    repo: { root: string }
  }
  let requestSessionRoot: ReturnType<typeof vi.fn>

  beforeAll(() => {
    registerGitIpc({
      agentRegistry: { get: () => ({ requestSessionRoot }) } as never,
      getMainWindow: () => null,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    })
  })

  beforeEach(() => {
    requestSessionRoot = vi.fn(async () => ({
      success: false,
      error: 'Failed to switch the session worktree.',
    }))
    coordinator = {
      hasBinding: vi.fn(() => true),
      getSessionRoot: vi.fn(() => ws),
      bind: vi.fn(async () => ({
        success: true,
        worktree: { id: 'wt', path: worktreePath, branch: 'pi/wt' },
        sharedWith: 0,
      })),
      unbind: vi.fn(async () => {}),
      repo: { root: ws },
    }
    coordinatorHolder.current = coordinator
  })

  afterEach(() => {
    coordinatorHolder.current = null
  })

  it('把绑定回滚到主工作树：运行时没有换根时不留下错误绑定', async () => {
    const result = await invoke('git:bindWorktree', ws, 'session-1', worktreePath)

    expect(result).toMatchObject({
      success: false,
      error: 'Failed to switch the session worktree.',
    })
    expect(coordinator.bind).toHaveBeenCalledTimes(2)
    expect(coordinator.bind).toHaveBeenLastCalledWith('session-1', 'main')
    expect(coordinator.unbind).not.toHaveBeenCalled()
  })

  it('之前没有绑定的会话在失败后直接解绑', async () => {
    coordinator.hasBinding.mockReturnValue(false)

    const result = await invoke('git:bindWorktree', ws, 'session-1', worktreePath)

    expect(result.success).toBe(false)
    expect(coordinator.unbind).toHaveBeenCalledWith('session-1')
    expect(coordinator.bind).toHaveBeenCalledTimes(1)
  })
})

describe('git IPC worktree dependencies', () => {
  const ws = '/ws'
  const sent: Array<{ channel: string; payload: unknown }> = []
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
  }
  let installDeps: ReturnType<typeof vi.fn>

  beforeAll(() => {
    registerGitIpc({
      agentRegistry: { get: () => undefined } as never,
      getMainWindow: () => window as never,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    })
  })

  beforeEach(() => {
    trust.trusted = true
    sent.length = 0
    installDeps = vi.fn(async () => ({
      success: true,
      deps: { state: 'installing', manager: 'pnpm', hash: 'pnpm:abc' },
    }))
    coordinatorHolder.current = { installDeps }
  })

  afterEach(() => {
    coordinatorHolder.current = null
    trust.trusted = true
  })

  it('把依赖安装请求交给协调器，并原样返回状态', async () => {
    const result = await invoke('git:installWorktreeDeps', ws, 'wt-1')

    expect(installDeps).toHaveBeenCalledWith('wt-1')
    expect(result).toMatchObject({ success: true, deps: { state: 'installing' } })
  })

  it('缺少工作树 id 时直接拒绝，不打到协调器', async () => {
    await expect(invoke('git:installWorktreeDeps', ws, '')).resolves.toEqual({
      success: false,
      error: 'Unknown worktree',
    })
    await expect(invoke('git:installWorktreeDeps', ws, 42)).resolves.toMatchObject({
      success: false,
    })
    expect(installDeps).not.toHaveBeenCalled()
  })

  it('未批准的工作区被拒绝', async () => {
    trust.trusted = false
    await expect(invoke('git:installWorktreeDeps', ws, 'wt-1')).resolves.toEqual({
      success: false,
      error: 'Workspace is not approved',
    })
    expect(installDeps).not.toHaveBeenCalled()
  })

  it('不是 git 仓库时返回明确错误', async () => {
    coordinatorHolder.current = null
    await expect(invoke('git:installWorktreeDeps', ws, 'wt-1')).resolves.toEqual({
      success: false,
      error: 'Not a git repository',
    })
  })

  it('依赖状态变化推送到 git:worktree-deps 频道', () => {
    const config = depsConfigHolder.current
    expect(config).toBeTruthy()

    config.onStatusChange({
      workspaceDir: ws,
      key: 'wt-1',
      status: { state: 'ready', manager: 'pnpm', hash: 'pnpm:abc', startedAt: '2026-01-01' },
    })

    expect(sent).toEqual([
      {
        channel: 'git:worktree-deps',
        payload: { workspaceDir: ws, key: 'wt-1', state: 'ready', manager: 'pnpm' },
      },
    ])
  })

  it('自动安装开关跟随设置项，默认开', () => {
    settingsHolder.current = {}
    expect(depsConfigHolder.current.isAutoInstallEnabled()).toBe(true)
    settingsHolder.current = { autoInstallWorktreeDeps: false }
    expect(depsConfigHolder.current.isAutoInstallEnabled()).toBe(false)
    settingsHolder.current = {}
  })

  it('失败状态带上截断后的错误信息', () => {
    depsConfigHolder.current.onStatusChange({
      workspaceDir: ws,
      key: 'wt-1',
      status: { state: 'failed', manager: 'npm', hash: 'npm:abc', error: 'network down' },
    })

    expect(sent[0].payload).toMatchObject({ state: 'failed', error: 'network down' })
  })
})
