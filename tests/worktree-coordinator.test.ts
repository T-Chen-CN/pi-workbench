import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '',
  },
}))

import { WorktreeCoordinator, configureWorktreeDeps, disposeCoordinator } from '../electron/worktree-coordinator'
import { clearLockfileHashCache, detectLockfile, WorktreeDepsInstaller, type SpawnFn, type SpawnedProcess } from '../electron/worktree-deps'
import { commitDetail, loadSessionGit } from '../electron/git-worktrees'

let workspace = ''

/** Windows 上 git 释放句柄有延迟，删除临时目录需要重试 */
async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

function git(args: string[], cwd = workspace): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

describe('WorktreeCoordinator', () => {
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(tmpdir(), 'pi-worktree-test-'))
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    await fs.writeFile(path.join(workspace, 'a.txt'), 'one\n')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
  })

  afterEach(async () => {
    await removeTempDir(workspace)
  })

  it('creates a managed worktree, reports it as in use, and removes it when clean', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    expect(coordinator).not.toBeNull()
    const initial = await coordinator!.listWorktrees()
    expect(initial).toHaveLength(1)
    expect(initial[0].isMain).toBe(true)

    const bound = await coordinator!.bind('session-1', 'new')
    expect(bound.success).toBe(true)
    const root = coordinator!.getSessionRoot('session-1')
    expect(root).not.toBe(workspace)
    await expect(fs.access(root)).resolves.toBeUndefined()
    expect(git(['branch', '--format=%(refname:short)'], root)).toContain('pi/')

    const views = await coordinator!.listWorktrees('session-1')
    const worktree = views.find((item) => item.path === root)
    expect(worktree?.managed).toBe(true)
    expect(worktree?.boundSessionCount).toBe(1)
    expect(worktree?.branch).toMatch(/^pi\//)

    const released = await coordinator!.release('session-1')
    expect(released.success).toBe(true)
    expect(released.removed).toBe(true)
    await expect(fs.access(root)).rejects.toThrow()
    expect(git(['branch', '--format=%(refname:short)'])).not.toContain('pi/')
  })

  it('shares a worktree between sessions and only removes it after the last binding', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-a', 'new')
    const root = coordinator!.getSessionRoot('session-a')

    const shared = await coordinator!.bind('session-b', root)
    expect(shared.success).toBe(true)
    expect(shared.sharedWith).toBe(1)

    const views = await coordinator!.listWorktrees('session-b')
    expect(views.find((item) => item.path === root)?.boundSessionCount).toBe(2)

    const first = await coordinator!.release('session-a')
    expect(first.removed).toBe(false)
    await expect(fs.access(root)).resolves.toBeUndefined()

    const second = await coordinator!.release('session-b')
    expect(second.removed).toBe(true)
    await expect(fs.access(root)).rejects.toThrow()
  })

  it('drops a session binding without touching the worktree', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-a', 'new')
    const root = coordinator!.getSessionRoot('session-a')
    expect(coordinator!.hasBinding('session-a')).toBe(true)

    await coordinator!.unbind('session-a')

    expect(coordinator!.hasBinding('session-a')).toBe(false)
    expect(path.resolve(coordinator!.getSessionRoot('session-a'))).toBe(
      path.resolve(coordinator!.repo.root)
    )
    await expect(fs.access(root)).resolves.toBeUndefined()
  })

  it('keeps a dirty worktree instead of removing it', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-dirty', 'new')
    const root = coordinator!.getSessionRoot('session-dirty')
    await fs.writeFile(path.join(root, 'a.txt'), 'dirty\n')

    const released = await coordinator!.release('session-dirty')
    expect(released.success).toBe(true)
    expect(released.removed).toBe(false)
    expect(released.dirty).toBe(true)
    await expect(fs.access(root)).resolves.toBeUndefined()
  })

  it('reuses an idle worktree inside the workspace with target=auto', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    const external = path.join(workspace, '.pi-workbench', 'worktrees', 'external-free')
    await fs.mkdir(path.dirname(external), { recursive: true })
    git(['worktree', 'add', '-b', 'feature-free', external])
    await coordinator!.listWorktrees()

    const bound = await coordinator!.bind('session-auto', 'auto')
    expect(bound.success).toBe(true)
    // Paths are canonicalised (realpath): macOS temp dirs sit behind /var -> /private/var,
    // and Windows temp dirs may use 8.3 short names, so compare real paths.
    const canonicalExternal = await fs.realpath(external)
    expect(coordinator!.getSessionRoot('session-auto')).toBe(canonicalExternal)
    const views = await coordinator!.listWorktrees('session-auto')
    expect(views.find((item) => item.path === canonicalExternal)?.branch).toBe('feature-free')
  })

  it('returns the commit body separately from the subject', async () => {
    await fs.writeFile(path.join(workspace, 'b.txt'), 'two')
    git(['add', '.'])
    git(['commit', '-m', 'Add b', '-m', 'First paragraph.\n\nSecond paragraph.'])
    const sha = git(['rev-parse', 'HEAD']).trim()
    const detail = await commitDetail(workspace, sha)
    expect(detail?.commit.subject).toBe('Add b')
    expect(detail?.body).toContain('First paragraph.')
    expect(detail?.body).toContain('Second paragraph.')
    expect(detail?.commit.author).toBe('Test')
    expect(detail?.commit.parents).toHaveLength(1)
  })

  it('reports the current worktree and other worktrees in the agent context', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-context', 'new')
    const context = await coordinator!.contextFor('session-context')
    expect(context).toContain('当前工作树')
    expect(context).toContain('其他工作树')
    expect(context).toContain('主工作树')
  })

  it('prunes the record of an external worktree whose directory is gone', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    const external = path.join(workspace, '.claude', 'worktrees', 'gone')
    await fs.mkdir(path.dirname(external), { recursive: true })
    git(['worktree', 'add', '-b', 'feature-gone', external])
    const live = await coordinator!.listWorktrees()
    expect(live).toHaveLength(2)
    const externalView = live.find((view) => !view.isMain)
    expect(externalView?.missing).toBe(false)
    expect(live[0].missing).toBe(false)
    expect(recordPaths()).toContain('.claude/worktrees/gone')

    await fs.rm(external, { recursive: true, force: true })

    const views = await coordinator!.listWorktrees()
    expect(views).toHaveLength(1)
    expect(views[0].isMain).toBe(true)
    expect(recordPaths()).toHaveLength(0)
  })

  it('keeps the record of a missing worktree while a session is bound to it', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    const external = path.join(workspace, '.claude', 'worktrees', 'bound')
    await fs.mkdir(path.dirname(external), { recursive: true })
    git(['worktree', 'add', '-b', 'feature-bound', external])
    await coordinator!.listWorktrees()
    await coordinator!.bind('session-bound', external)

    await fs.rm(external, { recursive: true, force: true })

    const views = await coordinator!.listWorktrees()
    expect(views).toHaveLength(2)
    expect(recordPaths()).toContain('.claude/worktrees/bound')
  })

  it('keeps a worktree record whose directory still exists but git no longer tracks', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    const external = path.join(workspace, '.claude', 'worktrees', 'stale')
    await fs.mkdir(path.dirname(external), { recursive: true })
    git(['worktree', 'add', '-b', 'feature-stale', external])
    await coordinator!.listWorktrees()

    // 用户用 git 自己删了工作树，但目录留下来了（可能还有文件）
    git(['worktree', 'remove', external])
    await fs.mkdir(external, { recursive: true })
    await fs.writeFile(path.join(external, 'keep.txt'), 'do not delete me\n')

    const views = await coordinator!.listWorktrees()
    expect(recordPaths()).toContain('.claude/worktrees/stale')
    expect(views).toHaveLength(2)
    // git 已不认但目录还在：标记为失效，不自动删（磁盘上可能有内容）
    expect(views.find((view) => view.relativePath === '.claude/worktrees/stale')?.missing).toBe(true)
    await expect(fs.access(path.join(external, 'keep.txt'))).resolves.toBeUndefined()
  })

  it('removes a managed worktree record and its idle branch when the directory is gone', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-managed-gone', 'new')
    const root = coordinator!.getSessionRoot('session-managed-gone')
    const branch = git(['branch', '--format=%(refname:short)', '--list', 'pi/*']).trim()
    expect(branch).not.toBe('')

    await coordinator!.unbind('session-managed-gone')
    await fs.rm(root, { recursive: true, force: true })
    await coordinator!.listWorktrees()

    expect(recordPaths()).toHaveLength(0)
    expect(git(['branch', '--format=%(refname:short)'])).not.toContain('pi/')
  })

  it('keeps the branch of a managed record when it has commits of its own', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-managed-commits', 'new')
    const root = coordinator!.getSessionRoot('session-managed-commits')
    await fs.writeFile(path.join(root, 'work.txt'), 'work\n')
    git(['add', '.'], root)
    git(['commit', '-m', 'work'], root)
    const branch = git(['branch', '--format=%(refname:short)', '--list', 'pi/*']).trim()

    await coordinator!.unbind('session-managed-commits')
    await fs.rm(root, { recursive: true, force: true })
    await coordinator!.listWorktrees()

    expect(recordPaths()).toHaveLength(0)
    expect(git(['branch', '--format=%(refname:short)'])).toContain(branch)
  })

  it('reports missing worktrees as pruned instead of dirty in cleanupOrphans', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-cleanup', 'new')
    const root = coordinator!.getSessionRoot('session-cleanup')
    await coordinator!.unbind('session-cleanup')
    await fs.rm(root, { recursive: true, force: true })

    const result = await coordinator!.cleanupOrphans()
    expect(result.pruned).toHaveLength(1)
    expect(result.dirty).toHaveLength(0)
    expect(recordPaths()).toHaveLength(0)
  })

  it('forgets a stale record whose directory is no longer a worktree', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    const external = path.join(workspace, '.claude', 'worktrees', 'stale')
    await fs.mkdir(path.dirname(external), { recursive: true })
    git(['worktree', 'add', '-b', 'feature-stale', external])
    await coordinator!.listWorktrees()
    git(['worktree', 'remove', external])
    await fs.mkdir(external, { recursive: true })
    await fs.writeFile(path.join(external, 'keep.txt'), 'keep\n')
    const id = Object.entries(loadSessionGit(workspace).worktrees).find(
      ([, record]) => record.path === '.claude/worktrees/stale'
    )?.[0]
    expect(id).toBeDefined()

    const result = await coordinator!.forget(id!)

    expect(result.success).toBe(true)
    expect(recordPaths()).not.toContain('.claude/worktrees/stale')
    expect(result.worktrees?.some((view) => view.id === id)).toBe(false)
    // 忘记只丢登记，不碰磁盘
    await expect(fs.access(path.join(external, 'keep.txt'))).resolves.toBeUndefined()
  })

  it('refuses to forget the main worktree, a bound worktree or a live one', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)

    expect((await coordinator!.forget('main')).success).toBe(false)
    expect((await coordinator!.forget('nope')).success).toBe(false)

    await coordinator!.bind('session-live', 'new')
    const id = Object.keys(loadSessionGit(workspace).worktrees)[0]
    expect((await coordinator!.forget(id)).success).toBe(false)

    await coordinator!.unbind('session-live')
    // 目录与 git 登记都还在：不允许“忘记”一个活着的工作树
    expect((await coordinator!.forget(id)).success).toBe(false)
    expect(recordPaths()).toHaveLength(1)
  })
})

/** 当前 workspace 里登记的工作树相对路径 */
function recordPaths(): string[] {
  return Object.values(loadSessionGit(workspace).worktrees).map((record) => record.path)
}

// ---------------------------------------------------------------------------
// GIT-118：链接工作树的依赖安装
// ---------------------------------------------------------------------------

interface FakeChild {
  command: string
  args: string[]
  cwd: string
  killed: boolean
  exit: (code: number | null) => void
}

/** 假的安装进程：不跑真实包管理器，由用例决定何时退出 */
function createFakeInstall() {
  const children: FakeChild[] = []
  const spawn: SpawnFn = (command, args, options) => {
    const exitListeners: Array<(...listenerArgs: unknown[]) => void> = []
    const record: FakeChild = {
      command,
      args,
      cwd: options.cwd,
      killed: false,
      exit: (code) => {
        for (const listener of exitListeners) listener(code)
      },
    }
    children.push(record)
    const child: SpawnedProcess = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event, listener) => {
        if (event === 'exit') exitListeners.push(listener)
      },
      kill: () => {
        record.killed = true
        return true
      },
    }
    return child
  }
  return { children, spawn }
}

describe('WorktreeCoordinator 依赖安装（GIT-118）', () => {
  let fake: ReturnType<typeof createFakeInstall>
  let lockfileHash = ''

  beforeEach(async () => {
    clearLockfileHashCache()
    workspace = await fs.mkdtemp(path.join(tmpdir(), 'pi-worktree-deps-coord-'))
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    await fs.writeFile(path.join(workspace, 'a.txt'), 'one\n')
    git(['add', '.'])
    git(['commit', '-m', 'init'])

    fake = createFakeInstall()
    const installer = new WorktreeDepsInstaller({ spawn: fake.spawn })
    configureWorktreeDeps({
      isAutoInstallEnabled: () => true,
      createInstaller: () => installer,
    })
    await fs.writeFile(path.join(workspace, 'package-lock.json'), '{"lockfileVersion":3}\n')
    lockfileHash = (await detectLockfile(workspace))!.hash
  })

  afterEach(async () => {
    configureWorktreeDeps(null)
    disposeCoordinator(workspace)
    await removeTempDir(workspace)
  })

  function depsOf(
    views: Array<{ path: string; deps: { state: string; hash?: string | null } }>,
    root: string
  ): { state: string; hash?: string | null } | undefined {
    return views.find((view) => view.path === root)?.deps
  }

  it('新建工作树后立刻可用，依赖在后台安装', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    const bound = await coordinator!.bind('session-deps', 'new')
    const root = coordinator!.getSessionRoot('session-deps')

    // bind 已经返回，安装还没结束：会话不被阻塞
    expect(bound.success).toBe(true)
    expect(fake.children).toHaveLength(1)
    expect(fake.children[0].cwd).toBe(root)
    expect(fake.children[0].command).toBe('npm')
    expect(fake.children[0].args).toEqual(['ci'])
    expect(depsOf(await coordinator!.listWorktrees('session-deps'), root)?.state).toBe(
      'installing'
    )
  })

  it('安装成功后把 lockfile 哈希写进 session-git.json', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-hash', 'new')
    const root = coordinator!.getSessionRoot('session-hash')

    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
    fake.children[0].exit(0)

    await vi.waitFor(() => {
      const records = Object.values(loadSessionGit(workspace).worktrees)
      expect(records[0]?.installedLockfileHash).toBe(lockfileHash)
    })
    // 记录写盘后状态直接是 ready，且不再触发新的安装
    await vi.waitFor(async () => {
      const views = await coordinator!.listWorktrees('session-hash')
      expect(depsOf(views, root)?.state).toBe('ready')
    })
    expect(fake.children).toHaveLength(1)
  })

  it('lockfile 未变化时复用工作树不重复安装', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-reuse', 'new')
    const root = coordinator!.getSessionRoot('session-reuse')
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
    fake.children[0].exit(0)
    await vi.waitFor(async () => {
      const views = await coordinator!.listWorktrees('session-reuse')
      expect(depsOf(views, root)?.state).toBe('ready')
    })

    // 再进一次同一工作树（新会话复用已有工作树）
    const reused = await coordinator!.bind('session-reuse-2', root)
    expect(reused.success).toBe(true)
    expect(fake.children).toHaveLength(1)
    expect(depsOf(await coordinator!.listWorktrees('session-reuse-2'), root)?.state).toBe('ready')
  })

  it('lockfile 变化后重新安装', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-change', 'new')
    const root = coordinator!.getSessionRoot('session-change')
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
    fake.children[0].exit(0)
    await vi.waitFor(async () => {
      const views = await coordinator!.listWorktrees('session-change')
      expect(depsOf(views, root)?.state).toBe('ready')
    })

    await fs.writeFile(
      path.join(workspace, 'package-lock.json'),
      '{"lockfileVersion":3,"updated":true}\n'
    )
    // 枚举只读：状态变成「待安装」，但不会自己启动
    const idle = await coordinator!.listWorktrees('session-change')
    expect(depsOf(idle, root)?.state).toBe('idle')
    expect(fake.children).toHaveLength(1)

    // 复用（绑定）才触发重装
    await coordinator!.bind('session-change-2', root)
    expect(fake.children).toHaveLength(2)
  })

  it('工作树自己的 lockfile 变化也会重装（哈希跟着安装走）', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-own', 'new')
    const root = coordinator!.getSessionRoot('session-own')
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
    fake.children[0].exit(0)
    await vi.waitFor(async () => {
      const views = await coordinator!.listWorktrees('session-own')
      expect(depsOf(views, root)?.state).toBe('ready')
    })
    const hashBefore = depsOf(await coordinator!.listWorktrees('session-own'), root)?.hash

    // 仓库根没动，动的是工作树里的那份（现实里 = 切到 lockfile 不同的分支）
    await fs.writeFile(
      path.join(root, 'package-lock.json'),
      '{"lockfileVersion":3,"branch":true}\n'
    )
    const views = await coordinator!.listWorktrees('session-own')
    expect(depsOf(views, root)?.state).toBe('idle')
    expect(depsOf(views, root)?.hash).not.toBe(hashBefore)

    await coordinator!.bind('session-own-2', root)
    expect(fake.children).toHaveLength(2)
  })

  it('枚举工作树不会给未绑定的工作树装依赖', async () => {
    const external = path.join(workspace, '.pi-workbench', 'worktrees', 'manual-ext')
    await fs.mkdir(path.dirname(external), { recursive: true })
    git(['worktree', 'add', '-b', 'manual-ext-branch', external, 'main'])

    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    const views = await coordinator!.listWorktrees()
    const ext = views.find((view) => view.path === external)
    expect(ext?.deps.state).toBe('idle')
    // 没人绑定它：不应启动安装，更不能往用户自己的 checkout 里写 node_modules
    await coordinator!.listWorktrees()
    expect(fake.children).toHaveLength(0)
  })

  it('两个会话绑定同一工作树只跑一次安装', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-first', 'new')
    const root = coordinator!.getSessionRoot('session-first')

    await coordinator!.bind('session-second', root)
    await Promise.all([
      coordinator!.listWorktrees('session-first'),
      coordinator!.listWorktrees('session-second'),
    ])

    expect(fake.children).toHaveLength(1)
  })

  it('安装过程中删除工作树会终止安装进程', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    await coordinator!.bind('session-cancel', 'new')
    expect(fake.children).toHaveLength(1)

    const released = await coordinator!.release('session-cancel')

    expect(released.removed).toBe(true)
    expect(fake.children[0].killed).toBe(true)
  })

  it('手动重试会重新启动安装', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    const bound = await coordinator!.bind('session-retry', 'new')
    const id = bound.worktree!.id
    const root = coordinator!.getSessionRoot('session-retry')
    // 首次安装失败
    fake.children[0].exit(1)
    await vi.waitFor(async () => {
      const views = await coordinator!.listWorktrees('session-retry')
      expect(depsOf(views, root)?.state).toBe('failed')
    })

    const retry = await coordinator!.installDeps(id)
    expect(retry.success).toBe(true)
    expect(retry.deps?.state).toBe('installing')
    expect(fake.children).toHaveLength(2)
  })

  it('主工作树不参与依赖安装', async () => {
    const coordinator = await WorktreeCoordinator.forWorkspace(workspace)
    const views = await coordinator!.listWorktrees()
    expect(views[0].isMain).toBe(true)
    expect(views[0].deps).toEqual({ state: 'none', manager: null, hash: null })
    expect(fake.children).toHaveLength(0)
  })
})
