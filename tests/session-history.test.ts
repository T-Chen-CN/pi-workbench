import { describe, expect, it } from 'vitest'
import { buildSessionMessagesFromEntries } from '../pi-bridge/src/session-history'
import type { TimelineItem } from '../pi-bridge/src/session-entries'

const options = {
  thinkingDurations: {} as Record<string, number[]>,
  toolFilePath: () => undefined,
}

function userMessage(content: string, timestamp = 1000): TimelineItem {
  return { kind: 'message', message: { role: 'user', content, timestamp } }
}

function assistantMessage(content: unknown, timestamp = 1000): TimelineItem {
  return { kind: 'message', message: { role: 'assistant', content, timestamp } }
}

function toolResult(toolCallId: string, content: unknown, timestamp = 1000): TimelineItem {
  return {
    kind: 'message',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'read',
      content,
      isError: false,
      timestamp,
    },
  }
}

function compaction(entryId: string, tokensBefore?: number, timestamp = 1500): TimelineItem {
  return { kind: 'compaction', entryId, tokensBefore, timestamp }
}

function types(item: ReturnType<typeof buildSessionMessagesFromEntries>[number]) {
  return (item.parts ?? []).map((part) => part.type)
}

describe('buildSessionMessagesFromEntries', () => {
  it('keeps a mid-turn compaction in output order', () => {
    const history = buildSessionMessagesFromEntries(
      [
        userMessage('question'),
        assistantMessage([{ type: 'text', text: 'before compaction' }], 1100),
        compaction('c1', 90_000),
        assistantMessage(
          [
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'text', text: 'after compaction' },
          ],
          1200
        ),
        toolResult('call-1', [{ type: 'text', text: 'file body' }], 1300),
      ],
      options
    )

    expect(history).toHaveLength(2)
    expect(history[1].parts?.map((part) => part.type)).toEqual([
      'text',
      'compaction',
      'tool',
      'text',
    ])
    expect(history[1].parts?.[1]).toMatchObject({
      type: 'compaction',
      id: 'compaction-c1',
      entryId: 'c1',
      tokensBefore: 90_000,
    })
  })

  it('places a between-turn compaction at the end of the previous turn', () => {
    const history = buildSessionMessagesFromEntries(
      [
        userMessage('first'),
        assistantMessage([{ type: 'text', text: 'first answer' }], 1100),
        compaction('c1', 60_000),
        userMessage('second', 2000),
        assistantMessage([{ type: 'text', text: 'second answer' }], 2100),
      ],
      options
    )

    expect(history.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(types(history[1])).toEqual(['text', 'compaction'])
    expect(types(history[3])).toEqual(['text'])
  })

  it('keeps multiple compactions in occurrence order', () => {
    const history = buildSessionMessagesFromEntries(
      [
        userMessage('go'),
        assistantMessage([{ type: 'text', text: 'one' }], 1100),
        compaction('c1', 10),
        assistantMessage([{ type: 'text', text: 'two' }], 1200),
        compaction('c2', 20),
        assistantMessage([{ type: 'text', text: 'three' }], 1300),
      ],
      options
    )

    expect(history).toHaveLength(2)
    expect(history[1].parts?.map((part) => part.id ?? part.type)).toEqual([
      'text-1',
      'compaction-c1',
      'text-2',
      'compaction-c2',
      'text-3',
    ])
  })

  it('keeps a compaction that happens before the first assistant output', () => {
    const history = buildSessionMessagesFromEntries(
      [
        userMessage('go'),
        compaction('c1', 30_000, 1050),
        assistantMessage([{ type: 'text', text: 'answer' }], 1100),
      ],
      options
    )

    expect(types(history[1])).toEqual(['compaction', 'text'])
  })

  it('renders tool results against their tool call part', () => {
    const history = buildSessionMessagesFromEntries(
      [
        userMessage('inspect'),
        assistantMessage(
          [
            { type: 'thinking', thinking: 'plan' },
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
          ],
          1100
        ),
        toolResult('call-1', [{ type: 'text', text: 'file body' }], 1200),
      ],
      options
    )

    expect(history[1].parts?.map((part) => part.type)).toEqual(['thinking', 'tool'])
    expect(history[1].parts?.[1]).toMatchObject({
      type: 'tool',
      toolCallId: 'call-1',
      status: 'success',
      resultPreview: 'file body',
    })
  })

  it('matches the previous behaviour when no compaction happened', () => {
    const history = buildSessionMessagesFromEntries(
      [
        userMessage('question'),
        assistantMessage([{ type: 'text', text: 'part one' }], 1100),
        assistantMessage([{ type: 'text', text: 'part two' }], 1200),
      ],
      options
    )

    expect(history).toEqual([
      { role: 'user', content: 'question', images: undefined, timestamp: 1000 },
      {
        role: 'assistant',
        content: 'part one\npart two',
        parts: [
          { type: 'text', id: 'text-1', text: 'part one' },
          { type: 'text', id: 'text-2', text: 'part two' },
        ],
        timestamp: 1100,
      },
    ])
  })
})
