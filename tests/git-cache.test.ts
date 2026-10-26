import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LruCache,
  cachedCommitDetail,
  cachedRepoRoot,
  clearGitCaches,
} from '../electron/git-cache'
import type { GitCommitDetail } from '../electron/git-worktrees'

function detail(sha: string, patch = 'diff'): GitCommitDetail {
  return {
    commit: {
      sha,
      shortSha: sha.slice(0, 7),
      author: 'Test',
      email: 'test@example.com',
      date: '2026-01-01T00:00:00Z',
      subject: `commit ${sha}`,
      refs: '',
      parents: [],
    },
    body: '',
    files: [],
    patch,
    truncated: false,
  }
}

describe('LruCache', () => {
  it('evicts the least recently used entry and refreshes recency on get', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
  })

  it('stays under the byte budget', () => {
    const cache = new LruCache<string, string>(10, 10, (value) => value.length)
    cache.set('a', '12345')
    cache.set('b', '12345')
    cache.set('c', '12345')
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('c')).toBe('12345')
  })
})

describe('cachedRepoRoot', () => {
  beforeEach(() => clearGitCaches())

  it('probes the repository only once per workspace', async () => {
    const load = vi.fn(async () => '/repo')
    expect(await cachedRepoRoot('/work', load)).toBe('/repo')
    expect(await cachedRepoRoot('/work', load)).toBe('/repo')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight probe between concurrent callers', async () => {
    let release: (value: string | null) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve
        })
    )
    const first = cachedRepoRoot('/work', load)
    const second = cachedRepoRoot('/work', load)
    release('/repo')
    expect(await first).toBe('/repo')
    expect(await second).toBe('/repo')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not cache folders that are not repositories', async () => {
    const load = vi.fn(async () => null)
    await cachedRepoRoot('/plain', load)
    await cachedRepoRoot('/plain', load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('cachedCommitDetail', () => {
  beforeEach(() => clearGitCaches())

  it('loads an immutable commit once and reuses it afterwards', async () => {
    const load = vi.fn(async () => detail('abcdef1'))
    const first = await cachedCommitDetail('/repo', 'abcdef1', load)
    const second = await cachedCommitDetail('/repo', 'abcdef1', load)
    expect(first?.commit.sha).toBe('abcdef1')
    expect(second).toBe(first)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent requests for the same commit', async () => {
    let release: (value: GitCommitDetail | null) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<GitCommitDetail | null>((resolve) => {
          release = resolve
        })
    )
    const first = cachedCommitDetail('/repo', 'abcdef1', load)
    const second = cachedCommitDetail('/repo', 'abcdef1', load)
    release(detail('abcdef1'))
    expect((await first)?.commit.sha).toBe('abcdef1')
    expect((await second)?.commit.sha).toBe('abcdef1')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not cache failures', async () => {
    const load = vi.fn(async () => null)
    await cachedCommitDetail('/repo', 'missing', load)
    await cachedCommitDetail('/repo', 'missing', load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps the same sha separate across repositories', async () => {
    const loadA = vi.fn(async () => detail('abcdef1', 'a'))
    const loadB = vi.fn(async () => detail('abcdef1', 'b'))
    expect((await cachedCommitDetail('/a', 'abcdef1', loadA))?.patch).toBe('a')
    expect((await cachedCommitDetail('/b', 'abcdef1', loadB))?.patch).toBe('b')
  })
})
