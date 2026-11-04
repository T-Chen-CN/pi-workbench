// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { filterSessions, isTerminalRun, upsertPart, useCloudStore } from '../src/store/cloudStore'
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

describe('openSession', () => {
  it('drops history that arrives after a newer session was opened', async () => {
    const pending: Record<string, (value: unknown) => void> = {}
    ;(
      window as unknown as { electronAPI: Record<string, unknown> }
    ).electronAPI = {
      cloudMessagesList: ({ sessionId }: { sessionId: string }) =>
        new Promise((resolve) => {
          pending[sessionId] = resolve
        }),
    }

    const slow = useCloudStore.getState().openSession('slow')
    const fast = useCloudStore.getState().openSession('fast')

    // 后点的会话先回来
    pending.fast({ success: true, parts: [text('h:1', 'fast')] })
    await fast
    expect(useCloudStore.getState().parts).toEqual([text('h:1', 'fast')])

    // 先点的会话晚回来：不能把界面盖成另一个会话的历史
    pending.slow({ success: true, parts: [text('h:1', 'slow')] })
    await slow
    expect(useCloudStore.getState().activeSessionId).toBe('fast')
    expect(useCloudStore.getState().parts).toEqual([text('h:1', 'fast')])
  })
})

describe('session actions', () => {
  const seed = () => {
    useCloudStore.setState({
      sessions: [
        {
          id: 's1',
          title: 'One',
          preview: '',
          lastActive: 1,
          startedAt: 1,
          messageCount: 0,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          model: 'm',
          parentSessionId: null,
          pinned: false,
          archived: false,
        },
        {
          id: 's2',
          title: 'Two',
          preview: '',
          lastActive: 2,
          startedAt: 2,
          messageCount: 0,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          model: 'm',
          parentSessionId: null,
          pinned: false,
          archived: false,
        },
      ],
      sessionActionPending: null,
      sessionsError: null,
      activeSessionId: null,
    })
  }

  it('renames optimistically and rolls back when the server rejects', async () => {
    seed()
    let release: (value: unknown) => void = () => {}
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudSessionsUpdate: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    }

    const pending = useCloudStore.getState().renameSession('s1', 'New name')
    // 请求还在飞：本地已经改了（乐观更新）
    expect(useCloudStore.getState().sessions[0].title).toBe('New name')
    expect(useCloudStore.getState().sessionActionPending).toBe('s1')

    release({ success: false, error: 'boom' })
    await expect(pending).resolves.toBe(false)
    expect(useCloudStore.getState().sessions[0].title).toBe('One')
    expect(useCloudStore.getState().sessionsError).toBe('boom')
  })

  it('applies the server row after a successful pin', async () => {
    seed()
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudSessionsUpdate: async () => ({
        success: true,
        session: { ...useCloudStore.getState().sessions[0], pinned: true },
      }),
    }
    await expect(useCloudStore.getState().togglePinned('s1')).resolves.toBe(true)
    expect(useCloudStore.getState().sessions[0].pinned).toBe(true)
  })

  it('removes a deleted session and clears it when it was open', async () => {
    seed()
    useCloudStore.setState({ activeSessionId: 's1', parts: [text('h:1', 'x')] })
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudSessionsDelete: async () => ({ success: true, deleted: true }),
    }

    await expect(useCloudStore.getState().deleteSession('s1')).resolves.toBe(true)
    expect(useCloudStore.getState().sessions.map((session) => session.id)).toEqual(['s2'])
    expect(useCloudStore.getState().activeSessionId).toBeNull()
    expect(useCloudStore.getState().parts).toEqual([])
  })

  it('restores the row when delete fails', async () => {
    seed()
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudSessionsDelete: async () => ({ success: false, error: 'nope' }),
    }
    await expect(useCloudStore.getState().deleteSession('s1')).resolves.toBe(false)
    expect(useCloudStore.getState().sessions.map((session) => session.id)).toEqual(['s1', 's2'])
    expect(useCloudStore.getState().sessionsError).toBe('nope')
  })
})

describe('会话分页与搜索', () => {
  const row = (id: string, title: string, preview = '') => ({
    id,
    title,
    preview,
    lastActive: 1,
    startedAt: 1,
    messageCount: 0,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    model: 'm',
    parentSessionId: null,
    pinned: false,
    archived: false,
  })

  it('appends the next page and drops duplicates', async () => {
    useCloudStore.setState({ sessions: [row('a', 'A')], sessionsHasMore: true, sessionQuery: '' })
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      // 翻页期间后台插进了一条新会话，导致第二页首条与已加载的重复
      cloudSessionsList: async () => ({
        success: true,
        sessions: [row('a', 'A'), row('b', 'B'), row('c', 'C')],
        hasMore: false,
      }),
    }

    await useCloudStore.getState().loadMoreSessions()
    const state = useCloudStore.getState()
    expect(state.sessions.map((session) => session.id)).toEqual(['a', 'b', 'c'])
    expect(state.sessionsHasMore).toBe(false)
    expect(state.sessionsLoadingMore).toBe(false)
  })

  it('stops asking once the server says there is nothing more', async () => {
    useCloudStore.setState({ sessions: [row('a', 'A')], sessionsHasMore: false })
    const call = vi.fn()
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudSessionsList: call,
    }
    await useCloudStore.getState().loadMoreSessions()
    expect(call).not.toHaveBeenCalled()
  })

  it('filters by title and preview, case-insensitively', () => {
    const rows = [row('a', 'Deploy notes'), row('b', 'other', 'mentions DEPLOY too'), row('c', 'x')] as never
    expect(filterSessions(rows, 'deploy').map((session) => session.id)).toEqual(['a', 'b'])
    expect(filterSessions(rows, '  ').length).toBe(3)
    expect(filterSessions(rows, 'nothing').length).toBe(0)
  })
})

describe('插话', () => {
  it('puts the interjection on the timeline and restores the draft when the request fails', async () => {
    useCloudStore.setState({ draft: '换个方向', runState: 'running', parts: [], steerError: null })
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudRunSteer: async () => ({ success: false, error: 'not running' }),
    }

    await useCloudStore.getState().steer()

    const state = useCloudStore.getState()
    expect(state.draft).toBe('换个方向')
    expect(state.steerError).toBe('not running')
    expect(state.parts.filter((part) => part.type === 'interjection')).toEqual([])
  })

  it('keeps the interjection pending until the server confirms', async () => {
    useCloudStore.setState({ draft: '换个方向', runState: 'running', parts: [], steerError: null })
    const steer = vi.fn(async () => ({ success: true }))
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudRunSteer: steer,
    }

    await useCloudStore.getState().steer()

    expect(steer).toHaveBeenCalledWith({ text: '换个方向' })
    expect(useCloudStore.getState().draft).toBe('')
    expect(useCloudStore.getState().parts[0]).toMatchObject({
      type: 'interjection',
      text: '换个方向',
      delivered: false,
    })
  })

  it('refuses to steer when nothing is running', async () => {
    useCloudStore.setState({ draft: 'hi', runState: 'completed', parts: [] })
    const steer = vi.fn()
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudRunSteer: steer,
    }
    await useCloudStore.getState().steer()
    expect(steer).not.toHaveBeenCalled()
  })
})
