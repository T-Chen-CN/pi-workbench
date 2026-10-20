import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchBatcher } from '../electron/watch-batcher'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('WatchBatcher', () => {
  it('flushes every change in the window, not just the last one', () => {
    const flush = vi.fn()
    const batcher = new WatchBatcher(flush, 300)

    batcher.add({ path: '/ws/a.ts', type: 'change' })
    batcher.add({ path: '/ws/b.ts', type: 'change' })
    expect(flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)

    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith([
      { path: '/ws/a.ts', type: 'change' },
      { path: '/ws/b.ts', type: 'change' },
    ])
  })

  it('deduplicates by key and keeps the latest event type', () => {
    const flush = vi.fn()
    const batcher = new WatchBatcher(flush, 300)

    batcher.add({ path: '/ws/A.ts', type: 'rename' }, '/ws/a.ts')
    batcher.add({ path: '/ws/A.ts', type: 'change' }, '/ws/a.ts')

    vi.advanceTimersByTime(300)

    expect(flush).toHaveBeenCalledWith([{ path: '/ws/A.ts', type: 'change' }])
  })

  it('flushes immediately on demand', () => {
    const flush = vi.fn()
    const batcher = new WatchBatcher(flush, 300)

    batcher.add({ path: '/ws/a.ts', type: 'change' })
    batcher.flushNow()

    expect(flush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(300)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('drops pending changes when cancelled', () => {
    const flush = vi.fn()
    const batcher = new WatchBatcher(flush, 300)

    batcher.add({ path: '/ws/a.ts', type: 'change' })
    batcher.cancel()

    vi.advanceTimersByTime(300)
    expect(flush).not.toHaveBeenCalled()
    expect(batcher.size()).toBe(0)
  })
})
