import { describe, expect, it } from 'vitest'
import { computeDiff, DiffLineType, formatDiffStats } from '../src/api/diff'

describe('computeDiff', () => {
  it('returns no additions or removals for identical text', () => {
    const result = computeDiff('a\nb', 'a\nb')
    expect(result.addedCount).toBe(0)
    expect(result.removedCount).toBe(0)
    expect(result.lines.every((line) => line.type === DiffLineType.Unchanged)).toBe(true)
  })

  it('marks modified lines as removed + added', () => {
    const result = computeDiff('a\nb\nc', 'a\nB\nc')
    expect(result.addedCount).toBe(1)
    expect(result.removedCount).toBe(1)
    expect(result.lines.some((line) => line.type === DiffLineType.Added && line.content === 'B')).toBe(true)
    expect(result.lines.some((line) => line.type === DiffLineType.Removed && line.content === 'b')).toBe(true)
  })

  it('counts appended lines', () => {
    const result = computeDiff('a', 'a\nb\nc')
    expect(result.addedCount).toBe(2)
    expect(result.removedCount).toBe(0)
    expect(formatDiffStats(result)).toBe('+2 -0')
  })
})
