import { beforeEach, describe, expect, it } from 'vitest'
import { isTerminalRun, upsertPart, useCloudStore } from '../src/store/cloudStore'
import type { CloudTracePart } from '../src/types/cloud'

const text = (id: string, body: string): CloudTracePart => ({
  type: 'text',
  id,
  role: 'assistant',
  text: body,
})

beforeEach(() => {
  useCloudStore.setState({
    parts: [],
    pendingDisconnect: null,
    runState: null,
    runError: null,
    draft: '',
    pending: null,
  })
})

describe('upsertPart', () => {
  it('appends new parts and replaces existing ones in place', () => {
    const first = upsertPart([], text('a', 'one'))
    expect(first).toHaveLength(1)

    const updated = upsertPart(first, text('a', 'one two'))
    expect(updated).toHaveLength(1)
    expect((updated[0] as { text: string }).text).toBe('one two')

    const appended = upsertPart(updated, text('b', 'three'))
    expect(appended.map((part) => part.id)).toEqual(['a', 'b'])
  })
})

describe('isTerminalRun', () => {
  it('knows which states end a turn', () => {
    expect(isTerminalRun('completed')).toBe(true)
    expect(isTerminalRun('cancelled')).toBe(true)
    expect(isTerminalRun('failed')).toBe(true)
    expect(isTerminalRun('running')).toBe(false)
    expect(isTerminalRun(null)).toBe(false)
  })
})

describe('applyFrame', () => {
  it('replaces the timeline on a correction frame', () => {
    useCloudStore.getState().applyFrame({ kind: 'parts', parts: [text('h:1', 'history')] })
    expect(useCloudStore.getState().parts).toHaveLength(1)
  })

  it('leaves a disconnect marker after a broken stream', () => {
    useCloudStore.getState().applyFrame({ kind: 'error', runId: 'run_1', error: '断流' })
    expect(useCloudStore.getState().runState).toBe('failed')

    useCloudStore.getState().applyFrame({ kind: 'parts', parts: [text('h:1', 'history')] })
    const parts = useCloudStore.getState().parts
    expect(parts.map((part) => part.type)).toEqual(['text', 'divider'])
    expect(parts[1]).toMatchObject({ kind: 'disconnect' })
    expect(useCloudStore.getState().pendingDisconnect).toBeNull()
  })

  it('marks the session id from the session frame', () => {
    useCloudStore.getState().applyFrame({ kind: 'session', sessionId: 'run_session' })
    expect(useCloudStore.getState().activeSessionId).toBe('run_session')
    expect(useCloudStore.getState().sessionMeta?.id).toBe('run_session')
  })
})
