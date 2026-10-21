import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeltaBuffer } from '../src/utils/streamBuffer'

describe('createDeltaBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces deltas into one flush per interval', () => {
    const flush = vi.fn()
    const buffer = createDeltaBuffer(flush, 50)

    buffer.push('a')
    buffer.push('b')
    buffer.push('c')
    expect(flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(50)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith('abc')
  })

  it('flushes immediately once the buffer reaches maxChars', () => {
    const flush = vi.fn()
    const buffer = createDeltaBuffer(flush, 50, 4)

    buffer.push('ab')
    buffer.push('cd')
    expect(flush).toHaveBeenCalledWith('abcd')

    buffer.push('e')
    vi.advanceTimersByTime(50)
    expect(flush).toHaveBeenLastCalledWith('e')
  })

  it('flush emits pending text before the interval elapses', () => {
    const flush = vi.fn()
    const buffer = createDeltaBuffer(flush, 50)

    buffer.push('partial')
    buffer.flush()
    expect(flush).toHaveBeenCalledWith('partial')

    vi.advanceTimersByTime(100)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('dispose drops pending text and cancels the timer', () => {
    const flush = vi.fn()
    const buffer = createDeltaBuffer(flush, 50)

    buffer.push('lost')
    buffer.dispose()
    vi.advanceTimersByTime(100)

    expect(flush).not.toHaveBeenCalled()
  })
})
