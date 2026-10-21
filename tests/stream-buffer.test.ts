import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeltaBuffer, createTraceBuffer } from '../src/utils/streamBuffer'

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

describe('createTraceBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces adjacent deltas without changing event order', () => {
    const flush = vi.fn()
    const buffer = createTraceBuffer(flush, 50)

    buffer.push({ type: 'thinking_delta', delta: 'think ' })
    buffer.push({ type: 'thinking_delta', delta: 'more' })
    buffer.push({ type: 'text_delta', delta: 'answer' })
    buffer.push({
      type: 'tool_start',
      toolCallId: 'call-1',
      toolName: 'read',
      argsSummary: 'a.ts',
      startedAt: 1,
    })
    buffer.push({ type: 'text_delta', delta: 'after' })

    vi.advanceTimersByTime(50)
    const events = flush.mock.calls[0][0]
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      'thinking_delta',
      'text_delta',
      'tool_start',
      'text_delta',
    ])
    expect(events[0]).toMatchObject({ delta: 'think more' })
    expect(events[2]).toMatchObject({ toolCallId: 'call-1' })
  })

  it('preserves thinking_redacted and tool_end events', () => {
    const flush = vi.fn()
    const buffer = createTraceBuffer(flush, 50)

    buffer.push({ type: 'thinking_redacted' })
    buffer.push({
      type: 'tool_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      status: 'error',
      durationMs: 12,
    })

    vi.advanceTimersByTime(50)
    expect(flush.mock.calls[0][0]).toEqual([
      { type: 'thinking_redacted' },
      {
        type: 'tool_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        status: 'error',
        durationMs: 12,
      },
    ])
  })

  it('flushes immediately when accumulated text exceeds maxChars', () => {
    const flush = vi.fn()
    const buffer = createTraceBuffer(flush, 50, 4)

    buffer.push({ type: 'text_delta', delta: 'abcd' })
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0][0][0]).toMatchObject({ delta: 'abcd' })
  })
})
