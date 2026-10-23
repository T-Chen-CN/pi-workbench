import { describe, expect, it } from 'vitest'
import { retrySecondsRemaining } from '../src/utils/retryCountdown'

describe('retrySecondsRemaining', () => {
  it('counts down from the moment the retry event was received', () => {
    expect(retrySecondsRemaining({ delayMs: 5_000, receivedAt: 1_000 }, 1_000)).toBe(5)
    expect(retrySecondsRemaining({ delayMs: 5_000, receivedAt: 1_000 }, 4_200)).toBe(2)
  })

  it('stops at zero once the delay has elapsed', () => {
    expect(retrySecondsRemaining({ delayMs: 5_000, receivedAt: 1_000 }, 6_000)).toBe(0)
  })

  it('treats a missing receive time as just received', () => {
    expect(retrySecondsRemaining({ delayMs: 5_000 }, 7_000)).toBe(5)
  })
})
