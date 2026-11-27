import { describe, expect, it } from 'vitest'
import { computeDiff, DiffLineType, formatDiffStats, mergeFileEdits } from '../../src/api/diff'

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

  it('keeps following lines unchanged after an insertion', () => {
    const result = computeDiff('a\nb\nc', 'x\na\nb\nc')
    expect(result.addedCount).toBe(1)
    expect(result.removedCount).toBe(0)
    const unchanged = result.lines.filter((line) => line.type === DiffLineType.Unchanged)
    expect(unchanged.map((line) => line.content)).toEqual(['a', 'b', 'c'])
    expect(unchanged.map((line) => line.originalLineNumber)).toEqual([1, 2, 3])
    expect(unchanged.map((line) => line.modifiedLineNumber)).toEqual([2, 3, 4])
  })

  it('handles large inputs (>5000 lines) with fast-diff without OOM and preserves exact 1-based line numbers', () => {
    const total = 6_000
    const oldLines = Array.from({ length: total }, (_, idx) => `line-${idx + 1}`)
    const newLines = [...oldLines]
    // 在头部、中部、尾部各做增删改（迫使 diffMiddle 处理接近全量 6000 行而非前后缀直接剥完）
    newLines[10] = 'line-11-edited'
    newLines.splice(2_500, 2) // 删除原 2501、2502
    newLines.splice(4_000, 0, 'inserted-a', 'inserted-b', 'inserted-c')
    newLines[newLines.length - 12] = 'near-end-edited'

    const result = computeDiff(oldLines.join('\n'), newLines.join('\n'), 'big.ts', 'big.ts')

    // 2 处修改 (+2 -2) + 2 行删除 (-2) + 3 行新增 (+3) => +5 -4
    expect(result.addedCount).toBe(5)
    expect(result.removedCount).toBe(4)

    // 逐行校验重建原文 / 新文以及 1-based 行号严格递增
    const reconstructedOld: string[] = []
    const reconstructedNew: string[] = []
    let expectedOldLine = 1
    let expectedNewLine = 1

    for (const line of result.lines) {
      if (line.type === DiffLineType.Unchanged) {
        expect(line.originalLineNumber).toBe(expectedOldLine++)
        expect(line.modifiedLineNumber).toBe(expectedNewLine++)
        reconstructedOld.push(line.content)
        reconstructedNew.push(line.content)
      } else if (line.type === DiffLineType.Removed) {
        expect(line.originalLineNumber).toBe(expectedOldLine++)
        expect(line.modifiedLineNumber).toBeUndefined()
        reconstructedOld.push(line.content)
      } else if (line.type === DiffLineType.Added) {
        expect(line.originalLineNumber).toBeUndefined()
        expect(line.modifiedLineNumber).toBe(expectedNewLine++)
        reconstructedNew.push(line.content)
      }
    }

    expect(reconstructedOld).toEqual(oldLines)
    expect(reconstructedNew).toEqual(newLines)
  })

  it('handles completely disjoint middle regions with exact line numbers', () => {
    const result = computeDiff('head\nold1\nold2\ntail', 'head\nnew1\nnew2\nnew3\ntail')
    expect(result.removedCount).toBe(2)
    expect(result.addedCount).toBe(3)
    const tail = result.lines[result.lines.length - 1]
    expect(tail).toEqual({
      type: DiffLineType.Unchanged,
      originalLineNumber: 4,
      modifiedLineNumber: 5,
      content: 'tail',
    })
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
