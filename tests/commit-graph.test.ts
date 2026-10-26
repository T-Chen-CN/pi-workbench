import { describe, expect, it } from 'vitest'
import { buildCommitGraph } from '../src/utils/commitGraph'

describe('buildCommitGraph', () => {
  it('lays out a linear history in one lane', () => {
    const graph = buildCommitGraph([
      { sha: 'a', parents: ['b'] },
      { sha: 'b', parents: ['c'] },
      { sha: 'c', parents: [] },
    ])
    expect(graph.laneCount).toBe(1)
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0, 0])
    expect(graph.rows[0].incoming).toEqual([])
    expect(graph.rows[1].incoming).toEqual([0])
    expect(graph.rows[2].parentEdges).toEqual([])
    expect(graph.rows[0].after[0]).toBe('b')
    expect(graph.rows[2].after[0]).toBeNull()
  })

  it('opens a second lane for a merge and closes it at the shared parent', () => {
    const graph = buildCommitGraph([
      { sha: 'a', parents: ['b', 'c'] },
      { sha: 'b', parents: ['d'] },
      { sha: 'c', parents: ['d'] },
      { sha: 'd', parents: [] },
    ])
    expect(graph.laneCount).toBe(2)
    expect(graph.rows[0].lane).toBe(0)
    expect(graph.rows[0].after).toEqual(['b', 'c'])
    expect(graph.rows[0].parentEdges).toContainEqual({ from: 0, to: 0 })
    expect(graph.rows[0].parentEdges).toContainEqual({ from: 0, to: 1 })

    expect(graph.rows[2].lane).toBe(1)
    expect(graph.rows[2].parentEdges).toContainEqual({ from: 1, to: 1 })
    expect(graph.rows[3].incoming).toEqual([0, 1])
    expect(graph.rows[3].after).toEqual([null, null])
  })

  it('merges multiple incoming lanes into a single commit', () => {
    const graph = buildCommitGraph([
      { sha: 'm', parents: ['a', 'b'] },
      { sha: 'a', parents: ['root'] },
      { sha: 'b', parents: ['root'] },
      { sha: 'root', parents: [] },
    ])
    const rootRow = graph.rows[3]
    expect(rootRow.incoming).toEqual([0, 1])
    expect(rootRow.lane).toBe(0)
    expect(rootRow.after).toEqual([null, null])
  })

  it('reuses a freed lane for a later branch tip', () => {
    const graph = buildCommitGraph([
      { sha: 'main1', parents: [] },
      { sha: 'side1', parents: [] },
    ])
    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0])
    expect(graph.laneCount).toBe(1)
  })

  it('handles a branch that starts later in the log', () => {
    const graph = buildCommitGraph([
      { sha: 'a', parents: ['c'] },
      { sha: 'b', parents: ['c'] },
      { sha: 'c', parents: [] },
    ])
    expect(graph.rows[0].lane).toBe(0)
    expect(graph.rows[1].lane).toBe(1)
    expect(graph.laneCount).toBe(2)
    expect(graph.rows[2].incoming).toEqual([0, 1])
  })
})
