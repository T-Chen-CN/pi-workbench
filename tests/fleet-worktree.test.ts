import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { FleetWorktree, sanitizeTaskName } from '../electron/fleet-worktree'

let repo: string

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()
}

async function readText(filePath: string): Promise<string> {
  return (await fs.readFile(filePath, 'utf-8')).replace(/\r\n/g, '\n')
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-worktree-'))
  git(['init'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  await fs.writeFile(path.join(repo, 'README.md'), 'initial\n', 'utf-8')
  git(['add', '.'])
  git(['commit', '-m', 'initial'])
})

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('sanitizeTaskName', () => {
  it('normalizes spaces and accepts safe names', () => {
    expect(sanitizeTaskName('My Task')).toBe('My-Task')
    expect(sanitizeTaskName('fix_bug-2')).toBe('fix_bug-2')
  })

  it('rejects unsafe names', () => {
    expect(sanitizeTaskName('../evil')).toBeNull()
    expect(sanitizeTaskName('a/b')).toBeNull()
    expect(sanitizeTaskName('')).toBeNull()
    expect(sanitizeTaskName('x'.repeat(41))).toBeNull()
  })
})

describe('FleetWorktree', () => {
  it('creates a worktree and branch from HEAD', async () => {
    const worktrees = new FleetWorktree()
    const result = await worktrees.create(repo, 'My Task', 'fleet-100-abc123')

    expect(result.success).toBe(true)
    expect(result.worktree).toBe(path.join(repo, '.pi-worktrees', 'My-Task-abc123'))
    expect(result.branch).toBe('pi-fleet/My-Task-abc123')
    await expect(fs.stat(result.worktree as string)).resolves.toBeTruthy()
    expect(git(['branch', '--list', result.branch as string])).toContain(result.branch as string)
    const normalized = (result.worktree as string).replace(/\\/g, '/')
    expect(git(['worktree', 'list'])).toContain(normalized)
  })

  it('rejects workspaces that are not git repositories', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-plain-'))
    try {
      const worktrees = new FleetWorktree()
      const result = await worktrees.create(plain, 'task', 'fleet-1-x')
      expect(result.success).toBe(false)
      expect(result.error).toContain('not a git repository')
    } finally {
      await fs.rm(plain, { recursive: true, force: true })
    }
  })

  it('rejects unsafe task names', async () => {
    const worktrees = new FleetWorktree()
    const result = await worktrees.create(repo, '../escape', 'fleet-1-x')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Task name')
  })

  it('fails when the worktree already exists', async () => {
    const worktrees = new FleetWorktree()
    const first = await worktrees.create(repo, 'dup', 'fleet-1-abc123')
    expect(first.success).toBe(true)

    const second = await worktrees.create(repo, 'dup', 'fleet-1-abc123')
    expect(second.success).toBe(false)
    expect(second.error).toContain('already exists')
  })

  it('removes the worktree but keeps the branch', async () => {
    const worktrees = new FleetWorktree()
    const created = await worktrees.create(repo, 'cleanup', 'fleet-2-def456')
    expect(created.success).toBe(true)

    const cleaned = await worktrees.cleanup(repo, created.worktree as string)

    expect(cleaned.success).toBe(true)
    await expect(fs.stat(created.worktree as string)).rejects.toBeTruthy()
    const normalized = (created.worktree as string).replace(/\\/g, '/')
    expect(git(['worktree', 'list'])).not.toContain(normalized)
    expect(git(['branch', '--list', created.branch as string])).toContain(created.branch as string)
  })

  it('reports modified and untracked files in the worktree', async () => {
    const worktrees = new FleetWorktree()
    const created = await worktrees.create(repo, 'review', 'fleet-3-aaa111')
    const worktree = created.worktree as string

    await fs.writeFile(path.join(worktree, 'README.md'), 'changed\n', 'utf-8')
    await fs.writeFile(path.join(worktree, 'new.txt'), 'new file\n', 'utf-8')

    const diff = await worktrees.diff(repo, worktree)
    expect(diff.success).toBe(true)
    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'README.md',
          status: 'modified',
          oldContent: 'initial\n',
          newContent: 'changed\n',
        }),
        expect.objectContaining({
          path: 'new.txt',
          status: 'added',
          oldContent: '',
          newContent: 'new file\n',
        }),
      ])
    )
  })

  it('commits worktree changes and merges them into the workspace', async () => {
    const worktrees = new FleetWorktree()
    const created = await worktrees.create(repo, 'merge', 'fleet-4-bbb222')
    const worktree = created.worktree as string

    await fs.writeFile(path.join(worktree, 'README.md'), 'merged\n', 'utf-8')
    await fs.writeFile(path.join(worktree, 'feature.txt'), 'feature\n', 'utf-8')

    const result = await worktrees.merge(
      repo,
      worktree,
      created.branch as string,
      'Merge Fleet task'
    )

    expect(result.success).toBe(true)
    expect(result.merged).toBe(true)
    expect(result.committed).toBe(true)
    expect(await readText(path.join(repo, 'README.md'))).toBe('merged\n')
    expect(await readText(path.join(repo, 'feature.txt'))).toBe('feature\n')
    expect(git(['branch', '--list', created.branch as string])).toContain(created.branch as string)
  })

  it('includes commits made inside the worktree in the diff', async () => {
    const worktrees = new FleetWorktree()
    const created = await worktrees.create(repo, 'committed', 'fleet-7-eee555')
    const worktree = created.worktree as string

    await fs.writeFile(path.join(worktree, 'committed.txt'), 'agent commit\n', 'utf-8')
    git(['add', '.'], worktree)
    git(['commit', '-m', 'agent commit'], worktree)

    const diff = await worktrees.diff(repo, worktree)
    expect(diff.success).toBe(true)
    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'committed.txt',
          status: 'added',
          newContent: 'agent commit\n',
        }),
      ])
    )

    const merged = await worktrees.merge(
      repo,
      worktree,
      created.branch as string,
      'Merge Fleet task'
    )
    expect(merged.success).toBe(true)
    expect(await readText(path.join(repo, 'committed.txt'))).toBe('agent commit\n')
  })

  it('refuses to merge when the workspace has uncommitted tracked changes', async () => {
    const worktrees = new FleetWorktree()
    const created = await worktrees.create(repo, 'dirty', 'fleet-5-ccc333')
    const worktree = created.worktree as string
    await fs.writeFile(path.join(worktree, 'README.md'), 'fleet\n', 'utf-8')
    await fs.writeFile(path.join(repo, 'README.md'), 'dirty workspace\n', 'utf-8')

    const result = await worktrees.merge(
      repo,
      worktree,
      created.branch as string,
      'Merge Fleet task'
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('uncommitted')
    expect(await readText(path.join(repo, 'README.md'))).toBe('dirty workspace\n')
  })

  it('aborts and reports conflicts when the branch cannot be merged', async () => {
    const worktrees = new FleetWorktree()
    const created = await worktrees.create(repo, 'conflict', 'fleet-6-ddd444')
    const worktree = created.worktree as string

    await fs.writeFile(path.join(worktree, 'README.md'), 'fleet version\n', 'utf-8')
    await fs.writeFile(path.join(repo, 'README.md'), 'workspace version\n', 'utf-8')
    git(['commit', '-am', 'workspace change'])

    const result = await worktrees.merge(
      repo,
      worktree,
      created.branch as string,
      'Merge Fleet task'
    )

    expect(result.success).toBe(false)
    expect(result.conflictFiles).toContain('README.md')
    expect(git(['status', '--porcelain', '--untracked-files=no']).trim()).toBe('')
    expect(await readText(path.join(repo, 'README.md'))).toBe('workspace version\n')
  })
})
