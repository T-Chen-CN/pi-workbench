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

import { AutoFetcher } from '../electron/repo-autofetch'
import { fetchRemote, readRefsSnapshot } from '../electron/git-worktrees'

function run(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  run(['init', '-b', 'main'], dir)
  run(['config', 'user.email', 'test@example.com'], dir)
  run(['config', 'user.name', 'Test'], dir)
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n')
  run(['add', '.'], dir)
  run(['commit', '-m', 'init'], dir)
}

describe('AutoFetcher', () => {
  it('fetches once and reports success', async () => {
    const fetch = vi.fn(async () => ({ ok: true, stderr: '' }))
    const fetcher = new AutoFetcher({ repoRoot: '/repo', fetch })
    try {
      const outcome = await fetcher.fetchNow({ force: true })
      expect(outcome).toMatchObject({ success: true })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      fetcher.dispose()
    }
  })

  it('shares an in-flight fetch instead of starting a second one', async () => {
    const pending: { release?: () => void } = {}
    const fetch = vi.fn(
      () =>
        new Promise<{ ok: boolean; stderr: string }>((resolve) => {
          pending.release = () => resolve({ ok: true, stderr: '' })
        })
    )
    const fetcher = new AutoFetcher({ repoRoot: '/repo', fetch })
    try {
      const first = fetcher.fetchNow({ force: true })
      const second = fetcher.fetchNow({ force: true })
      expect(fetch).toHaveBeenCalledTimes(1)
      pending.release?.()
      await Promise.all([first, second])
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      fetcher.dispose()
    }
  })

  it('backs off after an authentication failure', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      stderr: 'fatal: could not read Username for https://example.com: terminal prompts disabled',
    }))
    const fetcher = new AutoFetcher({ repoRoot: '/repo', fetch, minGapMs: 0 })
    try {
      const outcome = await fetcher.fetchNow({ force: true })
      expect(outcome).toMatchObject({ success: false, authFailed: true })

      fetch.mockClear()
      fetcher.touch()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetcher.dispose()
    }
  })

  it('skips while a git operation is in progress', async () => {
    const fetch = vi.fn(async () => ({ ok: true, stderr: '' }))
    const fetcher = new AutoFetcher({
      repoRoot: '/repo',
      fetch,
      canFetch: () => false,
    })
    try {
      const outcome = await fetcher.fetchNow({ force: true })
      expect(outcome).toMatchObject({ success: true, skipped: true })
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetcher.dispose()
    }
  })
})

describe('fetchRemote', () => {
  let root = ''
  let origin = ''
  let cloneA = ''
  let cloneB = ''

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'pi-fetch-test-'))
    origin = path.join(root, 'origin.git')
    await fs.mkdir(origin, { recursive: true })
    run(['init', '--bare', '-b', 'main'], origin)

    const seed = path.join(root, 'seed')
    await initRepo(seed)
    run(['remote', 'add', 'origin', origin], seed)
    run(['push', '-u', 'origin', 'main'], seed)

    cloneA = path.join(root, 'a')
    cloneB = path.join(root, 'b')
    run(['clone', origin, cloneA], root)
    run(['clone', origin, cloneB], root)
    run(['config', 'user.email', 'test@example.com'], cloneB)
    run(['config', 'user.name', 'Test'], cloneB)
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('updates remote-tracking refs without touching the working tree', async () => {
    const before = await readRefsSnapshot(cloneA)

    await fs.writeFile(path.join(cloneB, 'b.txt'), 'two\n')
    run(['add', '.'], cloneB)
    run(['commit', '-m', 'from b'], cloneB)
    run(['push', 'origin', 'main'], cloneB)
    const remoteHead = run(['rev-parse', 'HEAD'], cloneB).trim()

    const result = await fetchRemote(cloneA)
    expect(result.ok).toBe(true)

    expect(run(['rev-parse', 'origin/main'], cloneA).trim()).toBe(remoteHead)
    expect(await readRefsSnapshot(cloneA)).not.toBe(before)
    // 只更新引用，不合并工作区
    expect(run(['rev-parse', 'HEAD'], cloneA).trim()).not.toBe(remoteHead)
  })

  it('returns the git error when the remote is unreachable', async () => {
    run(['remote', 'set-url', 'origin', path.join(root, 'missing.git')], cloneA)
    const result = await fetchRemote(cloneA, { interactive: false })
    expect(result.ok).toBe(false)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
