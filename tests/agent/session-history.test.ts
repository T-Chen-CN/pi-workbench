import { describe, expect, it } from 'vitest'
import { buildSessionMessagesFromEntries } from '../../pi-bridge/src/session-history'
import type { TimelineItem } from '../../pi-bridge/src/session-entries'
import { buildContextPrompt, CONTEXT_BLOCK_END, CONTEXT_BLOCK_START } from '../../src/api/chatContext'

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
    expect(history[0].context).toBeUndefined()
  })

  it('restores quotes and files attached to a user message', () => {
    const prompt = buildContextPrompt('看这段', [
      { kind: 'quote', path: '/w/README.md', label: 'README.md', content: '原文', startLine: 3, endLine: 4 },
      { kind: 'file', path: '/w/a.pdf', size: 2048 },
    ])
    const history = buildSessionMessagesFromEntries([userMessage(prompt)], options)

    expect(history[0].content).toBe('看这段')
    expect(history[0].context).toEqual({
      quotes: [{ content: '原文', path: '/w/README.md', label: 'README.md', startLine: 3, endLine: 4 }],
      files: [{ path: '/w/a.pdf', size: 2048 }],
    })
  })

  it('keeps the message text clean when the worktree block precedes the attachment block', () => {
    const worktree = `${CONTEXT_BLOCK_START}\n[工作树上下文]\n当前工作树：主工作树\n${CONTEXT_BLOCK_END}`
    const prompt = buildContextPrompt('这是问题', [
      { kind: 'quote', label: '对话引用', content: '被引用的原文' },
    ])
    const history = buildSessionMessagesFromEntries([userMessage(`${worktree}\n\n${prompt}`)], options)

    expect(history[0].content).toBe('这是问题')
    expect(history[0].content).not.toContain('pi-workbench-context')
    expect(history[0].context?.quotes).toEqual([{ content: '被引用的原文', label: '对话引用' }])
  })

  it('drops trailing empty or whitespace-only text blocks from multi-turn tool calls (Gemini toolUse)', () => {
    const history = buildSessionMessagesFromEntries(
      [
        userMessage('发布 v0.11.2'),
        assistantMessage(
          [
            { type: 'thinking', thinking: '先检查状态' },
            { type: 'toolCall', id: 'c-1', name: 'bash', arguments: { command: 'git status' } },
            { type: 'text', text: '' },
          ],
          1100
        ),
        toolResult('c-1', [{ type: 'text', text: 'clean' }], 1200),
        assistantMessage(
          [
            { type: 'toolCall', id: 'c-2', name: 'bash', arguments: { command: 'npm test' } },
            { type: 'text', text: '   \n\n  ' },
          ],
          1300
        ),
        toolResult('c-2', [{ type: 'text', text: 'ok' }], 1400),
        assistantMessage([{ type: 'text', text: 'Pi Workbench v0.11.2 已发布完成。' }], 1500),
      ],
      options
    )

    expect(history).toHaveLength(2)
    expect(types(history[1])).toEqual(['thinking', 'tool', 'tool', 'text'])
    expect(history[1].content).toBe('Pi Workbench v0.11.2 已发布完成。')
  })

  it('does not let a pre-turn compaction entryId hijack the assistant turn entryId', () => {
    const history = buildSessionMessagesFromEntries(
      [
        { kind: 'message', entryId: 'u-1', message: { role: 'user', content: 'go', timestamp: 1000 } },
        compaction('c-1', 42_000, 1050),
        {
          kind: 'message',
          entryId: 'a-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }], timestamp: 1100 },
        },
      ],
      options
    )

    expect(history).toHaveLength(2)
    expect(history[1].entryId).toBe('a-1')
    expect(history[1].parts?.[0]).toMatchObject({ type: 'compaction', entryId: 'c-1' })
  })

  it('flushes separate assistant turns across task-event custom_message boundaries without faking user bubbles', () => {
    const history = buildSessionMessagesFromEntries(
      [
        { kind: 'message', entryId: 'u-1', message: { role: 'user', content: 'dispatch', timestamp: 1000 } },
        {
          kind: 'message',
          entryId: 'a-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'dispatched' }], timestamp: 1100 },
        },
        {
          kind: 'custom_message',
          entryId: 'ev-1',
          timestamp: 2000,
          customType: 'task-event',
          content: '[task-event] T-1 done',
          display: false,
        },
        {
          kind: 'message',
          entryId: 'a-2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'T-1 finished' }], timestamp: 2100 },
        },
        {
          kind: 'custom_message',
          entryId: 'ev-2',
          timestamp: 3000,
          customType: 'task-event',
          content: '[task-event] T-2 done',
          display: false,
        },
        {
          kind: 'message',
          entryId: 'a-3',
          message: { role: 'assistant', content: [{ type: 'text', text: 'T-2 finished' }], timestamp: 3100 },
        },
      ],
      options
    )

    expect(history.map((m) => ({ role: m.role, entryId: m.entryId, content: m.content }))).toEqual([
      { role: 'user', entryId: 'u-1', content: 'dispatch' },
      { role: 'assistant', entryId: 'a-1', content: 'dispatched' },
      { role: 'assistant', entryId: 'a-2', content: 'T-1 finished' },
      { role: 'assistant', entryId: 'a-3', content: 'T-2 finished' },
    ])
  })

  it('projects nestedCalls from toolResult messages directly under their parent tool call', () => {
    const history = buildSessionMessagesFromEntries(
      [
        userMessage('run script'),
        assistantMessage(
          [
            { type: 'toolCall', id: 'call-parent', name: 'codemode', arguments: { script: 'run()' } },
            { type: 'toolCall', id: 'call-next', name: 'read', arguments: { path: 'b.ts' } },
          ],
          1100
        ),
        {
          kind: 'message',
          entryId: 'tr-1',
          message: {
            role: 'toolResult',
            toolCallId: 'call-parent',
            toolName: 'codemode',
            content: [{ type: 'text', text: 'done' }],
            isError: false,
            durationMs: 120,
            timestamp: 1200,
            nestedCalls: {
              complete: true,
              calls: [
                {
                  id: 'call-parent/1',
                  name: 'read',
                  arguments: { path: 'a.ts' },
                  status: 'ok',
                  durationMs: 15,
                },
                {
                  id: 'call-parent/2',
                  name: 'bash',
                  argumentsBytes: 512,
                  status: 'error',
                  durationMs: 30,
                  error: 'exit 1',
                },
              ],
            },
          },
        },
        toolResult('call-next', [{ type: 'text', text: 'body' }], 1300),
      ],
      options
    )

    const toolParts = (history[1].parts ?? []).filter((p) => p.type === 'tool')
    expect(toolParts.map((p) => p.toolCallId)).toEqual([
      'call-parent',
      'call-parent/1',
      'call-parent/2',
      'call-next',
    ])
    expect(toolParts[1]).toMatchObject({
      toolCallId: 'call-parent/1',
      parentToolCallId: 'call-parent',
      toolName: 'read',
      argsSummary: 'a.ts',
      status: 'success',
      isError: false,
      durationMs: 15,
    })
    expect(toolParts[2]).toMatchObject({
      toolCallId: 'call-parent/2',
      parentToolCallId: 'call-parent',
      toolName: 'bash',
      argsSummary: '(512 bytes)',
      status: 'error',
      isError: true,
      resultPreview: 'exit 1',
    })
  })

  it('preserves active running tools when isLiveStreaming is true while still marking earlier orphaned tools as error', () => {
    const items: TimelineItem[] = [
      userMessage('turn 1', 1000),
      assistantMessage(
        [{ type: 'toolCall', id: 'old-orphan', name: 'bash', arguments: { command: 'hang' } }],
        1100
      ),
      userMessage('turn 2', 2000),
      assistantMessage(
        [{ type: 'toolCall', id: 'live-tool', name: 'bash', arguments: { command: 'npm test' } }],
        2100
      ),
    ]

    const historical = buildSessionMessagesFromEntries(items, options)
    expect(historical[1].parts?.[0]).toMatchObject({ toolCallId: 'old-orphan', status: 'error', isError: true })
    expect(historical[3].parts?.[0]).toMatchObject({ toolCallId: 'live-tool', status: 'error', isError: true })

    const live = buildSessionMessagesFromEntries(items, { ...options, isLiveStreaming: true })
    expect(live[1].parts?.[0]).toMatchObject({ toolCallId: 'old-orphan', status: 'error', isError: true })
    expect(live[3].parts?.[0]).toMatchObject({ toolCallId: 'live-tool', status: 'running' })
    expect((live[3].parts?.[0] as { isError?: boolean }).isError).toBeUndefined()
  })
})
