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

import { RepoWatcher, type RepoChangeScope } from '../electron/repo-watcher'
import { getRepoInfo } from '../electron/git-worktrees'

let workspace = ''

function git(args: string[], cwd = workspace): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for watcher event')
}

describe('RepoWatcher', () => {
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(tmpdir(), 'pi-repo-watcher-'))
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

  it('reports refs when a commit lands', async () => {
    const repo = await getRepoInfo(workspace)
    expect(repo).not.toBeNull()
    const scopes: RepoChangeScope[] = []
    const watcher = new RepoWatcher({
      gitDir: repo!.gitDir,
      commonDir: repo!.commonDir,
      onScopes: (next) => scopes.push(...next),
    })
    watcher.start()
    try {
      await fs.writeFile(path.join(workspace, 'b.txt'), 'two\n')
      git(['add', '.'])
      git(['commit', '-m', 'second'])

      await waitFor(() => scopes.includes('refs'))
      expect(scopes).toContain('refs')
    } finally {
      watcher.dispose()
    }
  })

  it('reports status when only the index changes', async () => {
    const repo = await getRepoInfo(workspace)
    const scopes: RepoChangeScope[] = []
    const watcher = new RepoWatcher({
      gitDir: repo!.gitDir,
      commonDir: repo!.commonDir,
      onScopes: (next) => scopes.push(...next),
    })
    watcher.start()
    try {
      await fs.writeFile(path.join(workspace, 'a.txt'), 'changed\n')
      git(['add', 'a.txt'])

      await waitFor(() => scopes.includes('status'))
      expect(scopes).toContain('status')
    } finally {
      watcher.dispose()
    }
  })

  it('stops reporting after dispose', async () => {
    const repo = await getRepoInfo(workspace)
    const scopes: RepoChangeScope[] = []
    const watcher = new RepoWatcher({
      gitDir: repo!.gitDir,
      commonDir: repo!.commonDir,
      debounceMs: 20,
      onScopes: (next) => scopes.push(...next),
    })
    watcher.start()
    watcher.dispose()

    await fs.writeFile(path.join(workspace, 'c.txt'), 'three\n')
    git(['add', '.'])
    git(['commit', '-m', 'third'])
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(scopes).toHaveLength(0)
  })
})
