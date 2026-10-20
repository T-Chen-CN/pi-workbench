import { describe, expect, it } from 'vitest'
import { computeDiff, DiffLineType, formatDiffStats, mergeFileEdits } from '../src/api/diff'

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

describe('mergeFileEdits', () => {
  it('keeps one entry per file with the full before/after range', () => {
    const merged = mergeFileEdits([
      { path: '/a.ts', oldContent: 'v0', newContent: 'v1' },
      { path: '/b.ts', oldContent: 'b0', newContent: 'b1' },
      { path: '/a.ts', oldContent: 'v1', newContent: 'v2' },
    ])

    expect(merged).toEqual([
      { path: '/a.ts', oldContent: 'v0', newContent: 'v2' },
      { path: '/b.ts', oldContent: 'b0', newContent: 'b1' },
    ])
  })

  it('does not mutate the input edits', () => {
    const edits = [{ path: '/a.ts', oldContent: 'v0', newContent: 'v1' }]
    mergeFileEdits(edits)
    expect(edits).toEqual([{ path: '/a.ts', oldContent: 'v0', newContent: 'v1' }])
  })
})
