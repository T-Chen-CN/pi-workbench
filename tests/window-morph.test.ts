import { describe, expect, it, vi } from 'vitest'
import { animateBounds, easeOutCubic, interpolateBounds } from '../electron/window-morph'

describe('easeOutCubic', () => {
  it('clamps outside 0..1', () => {
    expect(easeOutCubic(-1)).toBe(0)
    expect(easeOutCubic(2)).toBe(1)
  })
})

describe('interpolateBounds', () => {
  const from = { x: 100, y: 80, width: 420, height: 260 }
  const to = { x: 20, y: 10, width: 1200, height: 800 }

  it('returns the exact start and end frames', () => {
    expect(interpolateBounds(from, to, 0)).toEqual(from)
    expect(interpolateBounds(from, to, 1)).toEqual(to)
  })

  it('eases out: already past halfway at 50%', () => {
    const middle = interpolateBounds(from, to, 0.5)
    expect(middle.width).toBeGreaterThan((from.width + to.width) / 2)
    expect(middle.height).toBeGreaterThan((from.height + to.height) / 2)
  })
})

describe('animateBounds', () => {
  it('applies the start frame, reaches the target and finishes once', () => {
    let time = 0
    const pending: { run: (() => void) | null } = { run: null }
    const widths: number[] = []
    const onDone = vi.fn()

    animateBounds({
      from: { x: 0, y: 0, width: 100, height: 100 },
      to: { x: 0, y: 0, width: 200, height: 200 },
      durationMs: 32,
      stepMs: 16,
      now: () => time,
      schedule: (callback) => {
        pending.run = callback
        return 1
      },
      apply: (bounds) => widths.push(bounds.width),
      onDone,
    })

    expect(widths).toEqual([100])

    time = 16
    pending.run?.()
    time = 32
    pending.run?.()

    expect(widths[widths.length - 1]).toBe(200)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('stops applying frames after cancel', () => {
    let time = 0
    const pending: { run: (() => void) | null } = { run: null }
    const apply = vi.fn()

    const cancel = animateBounds({
      from: { x: 0, y: 0, width: 100, height: 100 },
      to: { x: 0, y: 0, width: 200, height: 200 },
      durationMs: 32,
      stepMs: 16,
      now: () => time,
      schedule: (callback) => {
        pending.run = callback
        return 1
      },
      cancel: () => {
        pending.run = null
      },
      apply,
    })

    cancel()
    time = 16
    expect(pending.run).toBeNull()
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
