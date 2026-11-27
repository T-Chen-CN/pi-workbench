import { describe, expect, it } from 'vitest'
import { deriveMessage, deriveMessages, mergeAgentUsage } from '../pi-bridge/src/session-view'
import { activeTimeline } from '../pi-bridge/src/session-entries'
import { buildBranchGroups } from '../pi-bridge/src/session-branch'
import { aggregateTurnUsage, collectRunAssistants } from '../pi-bridge/src/agent-runtime-types'
import { useChatStore, conversationKey } from '../src/store/chatStore'

describe('Phase 2 Milestone 3: single-source session view & entryId parity', () => {
  it('propagates entryId, aggregates multi-step usage, preserves parentToolCallId, and stays deterministic without Date.now()', () => {
    const fakeManager = {
      getBranch: () => [
        {
          id: 'u-1',
          type: 'message',
          timestamp: '2026-11-27T00:00:01.000Z',
          message: { role: 'user', content: 'Refactor module', timestamp: 1000 },
        },
        {
          id: 'a-1',
          type: 'message',
          timestamp: '2026-11-27T00:00:02.000Z',
          message: {
            role: 'assistant',
            usage: { input: 100, output: 40, reasoning: 10, cacheRead: 5, cacheWrite: 0, totalTokens: 140, cost: { total: 0.01 } },
            content: [
              { type: 'toolCall', id: 'tc-1', name: 'edit', arguments: { path: 'a.ts' }, parentToolCallId: 'parent-1' },
            ],
          },
        },
        {
          id: 'tr-1',
          type: 'message',
          timestamp: '2026-11-27T00:00:03.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 'tc-1',
            toolName: 'edit',
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
            durationMs: 25,
          },
        },
        {
          id: 'a-2',
          type: 'message',
          timestamp: '2026-11-27T00:00:04.000Z',
          message: {
            role: 'assistant',
            usage: { input: 120, output: 60, reasoning: 20, cacheRead: 15, cacheWrite: 5, totalTokens: 180, cost: { total: 0.02 } },
            content: [{ type: 'text', text: 'Done!' }],
          },
        },
      ],
    } as any

    const timeline = activeTimeline(fakeManager)
    const first = deriveMessages(timeline, { thinkingDurations: {}, toolFilePath: () => '/ws/a.ts' })
    const second = deriveMessages(timeline, { thinkingDurations: {}, toolFilePath: () => '/ws/a.ts' })
    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
    expect(first[0].entryId).toBe('u-1')
    expect(first[1].entryId).toBe('a-1')
    expect(first[1].usage).toEqual({
      input: 220,
      output: 100,
      reasoning: 30,
      cacheRead: 20,
      cacheWrite: 5,
      totalTokens: 320,
      cost: 0.03,
    })
    const toolPart = first[1].parts?.find((p) => p.type === 'tool')
    expect(toolPart && toolPart.type === 'tool' ? toolPart.parentToolCallId : null).toBe('parent-1')
    expect(deriveMessage(timeline, { thinkingDurations: {}, toolFilePath: () => undefined })?.content).toBe('Done!')
  })

  it('matches conversation branches by persistent userEntryId even when client/server timestamps drift', () => {
    const fakeManager = {
      getBranch: () => [
        { id: 'entry-u1', type: 'message', timestamp: 10_000, message: { role: 'user', content: 'hi', timestamp: 10_000 } },
        { id: 'entry-a2', type: 'message', timestamp: 10_500, message: { role: 'assistant', content: 'v2' } },
      ],
      getTree: () => [
        {
          entry: { id: 'entry-u1', type: 'message', timestamp: 10_000, message: { role: 'user', content: 'hi', timestamp: 10_000 } },
          children: [
            { entry: { id: 'entry-a1', type: 'message', timestamp: 10_200, message: { role: 'assistant', content: 'v1' } }, children: [] },
            { entry: { id: 'entry-a2', type: 'message', timestamp: 10_500, message: { role: 'assistant', content: 'v2' } }, children: [] },
          ],
        },
      ],
    } as any

    const groups = buildBranchGroups(fakeManager)
    expect(groups).toHaveLength(1)
    expect(groups[0].userEntryId).toBe('entry-u1')

    const key = conversationKey('/ws', 's1')
    useChatStore.getState().reset()
    useChatStore.getState().ensureConversation(key)
    useChatStore.getState().setMessages(key, [
      { entryId: 'entry-u1', role: 'user', content: 'hi', timestamp: 99_999 },
      { entryId: 'entry-a2', role: 'assistant', content: 'v2', timestamp: 100_000 },
    ])
    useChatStore.getState().setMessageBranches(key, groups)

    const assistant = useChatStore.getState().conversations[key].messages[1]
    expect(assistant.branch?.activeIndex).toBe(1)
    expect(assistant.branch?.entryIds).toEqual(['entry-a1', 'entry-a2'])
  })

  it('reconciles live turns with disk messages while preserving edits and plan cards', () => {
    const key = conversationKey('/ws', 's2')
    useChatStore.getState().reset()
    useChatStore.getState().ensureConversation(key)
    useChatStore.getState().addMessage(key, { role: 'user', content: 'hello' })
    const aId = useChatStore.getState().startStreamingMessage(key)
    useChatStore.getState().setMessageEdits(key, aId, [
      { path: '/ws/a.ts', oldContent: 'old', newContent: 'new' },
    ])

    useChatStore.getState().reconcileMessages(key, [
      { entryId: 'u-disk', role: 'user', content: 'hello', timestamp: 100 },
      {
        entryId: 'a-disk',
        role: 'assistant',
        content: 'done',
        timestamp: 101,
        usage: mergeAgentUsage(undefined, {
          input: 10,
          output: 5,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: 0.001,
        }),
      },
    ])

    const msgs = useChatStore.getState().conversations[key].messages
    expect(msgs[0].entryId).toBe('u-disk')
    expect(msgs[1].entryId).toBe('a-disk')
    expect(msgs[1].id).toBe(aId)
    expect(msgs[1].edits).toHaveLength(1)
    expect(msgs[1].usage?.totalTokens).toBe(15)
  })

  it('aggregates usage across all assistant messages in a multi-step turn', () => {
    const assistants = collectRunAssistants(
      [
        { role: 'assistant', timestamp: 500, usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } } },
        { role: 'assistant', timestamp: 1000, usage: { input: 20, output: 10, totalTokens: 30, cost: { total: 0.02 } } },
        { role: 'assistant', timestamp: 1200, usage: { input: 30, output: 15, totalTokens: 45, cost: { total: 0.03 } } },
      ],
      1,
      900
    )
    expect(assistants).toHaveLength(2)
    expect(aggregateTurnUsage(assistants)).toEqual({
      input: 50,
      output: 25,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 75,
      cost: 0.05,
    })
  })
})
