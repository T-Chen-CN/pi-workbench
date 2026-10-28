import { describe, expect, it } from 'vitest'
import { activeTimeline, entryTimestamp } from '../pi-bridge/src/session-entries'

function messageEntry(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant' | 'toolResult',
  content: unknown,
  timestamp = 1000
) {
  return {
    id,
    parentId,
    type: 'message',
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content, timestamp },
  }
}

function compactionEntry(id: string, parentId: string, tokensBefore = 1000) {
  return {
    id,
    parentId,
    type: 'compaction',
    timestamp: new Date(2000).toISOString(),
    summary: 'summary text',
    firstKeptEntryId: parentId,
    tokensBefore,
  }
}

function managerWith(branch: any[], entries = branch) {
  return {
    getBranch: () => branch,
    getEntries: () => entries,
  } as any
}

describe('activeTimeline', () => {
  it('walks the branch in order and skips non-message entries', () => {
    const branch = [
      messageEntry('u1', null, 'user', 'hi'),
      { id: 'model', parentId: 'u1', type: 'model_change', timestamp: '', provider: 'x', modelId: 'y' },
      messageEntry('a1', 'model', 'assistant', 'hello', 1100),
    ]

    const items = activeTimeline(managerWith(branch))

    expect(items.map((item) => item.kind)).toEqual(['message', 'message'])
    expect(items.map((item) => (item.kind === 'message' ? item.message.role : ''))).toEqual([
      'user',
      'assistant',
    ])
  })

  it('exposes compaction points with entry anchor and token count', () => {
    const branch = [
      messageEntry('u1', null, 'user', 'hi'),
      compactionEntry('c1', 'u1', 120_000),
    ]

    const items = activeTimeline(managerWith(branch))

    expect(items[1]).toEqual({
      kind: 'compaction',
      entryId: 'c1',
      timestamp: Date.parse(new Date(2000).toISOString()),
      tokensBefore: 120_000,
    })
  })

  it('only follows the active branch, never the raw file order', () => {
    const branch = [messageEntry('u1', null, 'user', 'kept')]
    const all = [
      ...branch,
      messageEntry('u2', 'u1', 'user', 'abandoned branch'),
      { id: 'other', parentId: 'u1', type: 'branch_summary', timestamp: '' },
    ] as any[]

    const items = activeTimeline(managerWith(branch, all))

    expect(items).toHaveLength(1)
    expect(items[0].kind === 'message' && items[0].message.content).toBe('kept')
  })

  it('drops entries omitted by context_edit', () => {
    const branch = [
      messageEntry('u1', null, 'user', 'question'),
      messageEntry('a1', 'u1', 'assistant', 'failed attempt', 1100),
      { id: 'e1', parentId: 'a1', type: 'context_edit', timestamp: '', targetId: 'a1', replacement: null },
      messageEntry('a2', 'e1', 'assistant', 'retry answer', 1200),
    ]

    const items = activeTimeline(managerWith(branch))

    expect(items).toHaveLength(2)
    expect(items.map((item) => (item.kind === 'message' ? item.message.content : ''))).toEqual([
      'question',
      'retry answer',
    ])
  })

  it('applies the latest replacement and keeps the message role', () => {
    const branch = [
      messageEntry('a1', null, 'assistant', 'original'),
      {
        id: 'e1',
        parentId: 'a1',
        type: 'context_edit',
        timestamp: '',
        targetId: 'a1',
        replacement: { content: [{ type: 'text', text: 'first edit' }] },
      },
      {
        id: 'e2',
        parentId: 'e1',
        type: 'context_edit',
        timestamp: '',
        targetId: 'a1',
        replacement: { content: 'second edit' },
      },
    ]

    const items = activeTimeline(managerWith(branch))

    expect(items).toHaveLength(1)
    const message = items[0].kind === 'message' ? items[0].message : null
    expect(message?.role).toBe('assistant')
    expect(message?.content).toEqual([{ type: 'text', text: 'second edit' }])
  })
})

describe('entryTimestamp', () => {
  it('accepts ISO strings, millisecond numbers and falls back to now', () => {
    expect(entryTimestamp('2026-10-28T00:00:00.000Z')).toBe(
      Date.parse('2026-10-28T00:00:00.000Z')
    )
    expect(entryTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(entryTimestamp('not-a-date')).toBeGreaterThan(0)
  })
})
