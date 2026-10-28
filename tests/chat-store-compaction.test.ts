import { beforeEach, describe, expect, it } from 'vitest'
import { conversationKey, useChatStore } from '../src/store/chatStore'
import type { AgentTracePart } from '../src/types/electron'

const key = conversationKey('/ws', 's1')

const compactionPart: Extract<AgentTracePart, { type: 'compaction' }> = {
  type: 'compaction',
  id: 'compaction-c1',
  entryId: 'c1',
  timestamp: 1_500,
  tokensBefore: 128_000,
}

function messages() {
  return useChatStore.getState().conversations[key].messages
}

beforeEach(() => {
  useChatStore.setState({ conversations: {} })
  useChatStore.getState().ensureConversation(key)
})

describe('appendCompactionPart', () => {
  it('appends to the streaming assistant message that is still growing', () => {
    useChatStore.getState().addMessage(key, { role: 'user', content: 'long task' })
    const id = useChatStore.getState().startStreamingMessage(key)
    useChatStore.getState().appendTextPart(key, id, 'before')

    useChatStore.getState().appendCompactionPart(key, compactionPart)
    useChatStore.getState().appendTextPart(key, id, 'after')

    expect(messages()).toHaveLength(2)
    expect(messages()[1].parts?.map((part) => part.type)).toEqual([
      'text',
      'compaction',
      'text',
    ])
  })

  it('falls back to the last assistant message when nothing is streaming', () => {
    const id = useChatStore.getState().startStreamingMessage(key)
    useChatStore.getState().appendTextPart(key, id, 'answer')
    useChatStore.getState().finishStreamingMessage(key, id)

    useChatStore.getState().appendCompactionPart(key, compactionPart)

    expect(messages()[0].parts?.map((part) => part.type)).toEqual(['text', 'compaction'])
  })

  it('creates a divider-only assistant message when the conversation is empty', () => {
    useChatStore.getState().appendCompactionPart(key, compactionPart)

    expect(messages()).toHaveLength(1)
    expect(messages()[0]).toMatchObject({
      role: 'assistant',
      content: '',
      timestamp: 1_500,
    })
    expect(messages()[0].parts).toEqual([compactionPart])
  })

  it('keeps one divider per event, in arrival order', () => {
    useChatStore.getState().appendCompactionPart(key, compactionPart)
    useChatStore.getState().appendCompactionPart(key, {
      ...compactionPart,
      id: 'compaction-c2',
      entryId: 'c2',
      tokensBefore: 10,
    })

    expect(messages()[0].parts?.map((part) => part.id)).toEqual([
      'compaction-c1',
      'compaction-c2',
    ])
  })

  it('ignores unknown conversations', () => {
    useChatStore.getState().appendCompactionPart('missing', compactionPart)

    expect(useChatStore.getState().conversations.missing).toBeUndefined()
  })
})
