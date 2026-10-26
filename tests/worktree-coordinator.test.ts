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

import { WorktreeCoordinator } from '../electron/worktree-coordinator'
import { commitDetail } from '../electron/git-worktrees'

let workspace = ''

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
    await fs.rm(workspace, { recursive: true, force: true })
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
})
