// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  filterSessions,
  isRunningEntry,
  isTerminalRun,
  resetPolicyLoadStateForTests,
  upsertPart,
  useCloudStore,
} from '../src/store/cloudStore'
import type { CloudTracePart } from '../src/types/cloud'

const text = (id: string, body: string): CloudTracePart => ({
  type: 'text',
  id,
  role: 'assistant',
  text: body,
})

beforeEach(() => {
  // 读策略的在飞 / 退避状态在模块级：不清掉会让上一个用例的 502 污染下一个
  resetPolicyLoadStateForTests()
  useCloudStore.setState({
    activeSessionId: null,
    sessionMeta: null,
    parts: [],
    pendingDisconnect: null,
    // 轮次状态按会话分开存：不清空的话上一个用例留下的 entry 会污染下一个
    sessionRuns: {},
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

  it('drops frames that belong to another session', () => {
    // A 在跑的时候切到 B：A 的增量不能写进 B 的时间线，runState 也不能被它改掉
    useCloudStore.setState({ activeSessionId: 'session-b', parts: [], runState: null })

    useCloudStore.getState().applyFrame({
      kind: 'part',
      part: text('s:1', '这是 A 的输出'),
      sessionId: 'session-a',
    })
    useCloudStore.getState().applyFrame({ kind: 'run', runId: 'run-a', state: 'running', sessionId: 'session-a' })

    expect(useCloudStore.getState().parts).toHaveLength(0)
    expect(useCloudStore.getState().runState).toBeNull()

    // 当前会话的帧照常生效
    useCloudStore.getState().applyFrame({ kind: 'part', part: text('s:2', '这是 B 的'), sessionId: 'session-b' })
    expect(useCloudStore.getState().parts).toHaveLength(1)
  })

  it('keeps the run state of a background session while another one runs', () => {
    // 并行：A 还在跑，用户切到 B 发了一轮。A 的帧不进 B 的时间线，但状态要留在 A 名下
    useCloudStore.setState({ activeSessionId: 'session-b', parts: [] })

    useCloudStore.getState().applyFrame({
      kind: 'run',
      runId: 'run-a',
      state: 'running',
      sessionId: 'session-a',
    })
    useCloudStore.getState().applyFrame({
      kind: 'run',
      runId: 'run-b',
      state: 'running',
      sessionId: 'session-b',
    })

    const state = useCloudStore.getState()
    expect(state.runId).toBe('run-b')
    expect(state.sessionRuns['session-a']).toMatchObject({ runId: 'run-a', state: 'running' })
    expect(isRunningEntry(state.sessionRuns['session-a'])).toBe(true)

    // A 结束：只改 A 的记录，当前会话的镜像不受影响
    useCloudStore.getState().applyFrame({
      kind: 'run',
      runId: 'run-a',
      state: 'completed',
      sessionId: 'session-a',
    })
    expect(useCloudStore.getState().sessionRuns['session-a']?.state).toBe('completed')
    expect(useCloudStore.getState().runId).toBe('run-b')
  })

  it('restores that session own run state when switching back to it', async () => {
    useCloudStore.setState({
      activeSessionId: 'session-a',
      sessionRuns: {
        'session-a': {
          runId: 'run-a',
          state: 'running',
          error: null,
          usage: null,
          model: null,
          partial: false,
          interrupted: false,
        },
      },
      runId: 'run-a',
      runState: 'running',
    })
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudSessionMessages: async () => ({ success: true, parts: [], hasMore: false }),
      cloudRunAttach: async () => ({ success: true, attached: false }),
      cloudLedgerList: async () => ({ success: true, entries: [] }),
    }

    await useCloudStore.getState().openSession('session-a')
    // 切回来还是「在跑」：不能因为重开了会话就当成空闲
    expect(useCloudStore.getState().runState).toBe('running')
    expect(useCloudStore.getState().runId).toBe('run-a')
  })

  it('stops a second send in the same session but allows another session', () => {
    useCloudStore.setState({
      activeSessionId: 'session-a',
      sessionRuns: {
        'session-a': {
          runId: 'run-a',
          state: 'running',
          error: null,
          usage: null,
          model: null,
          partial: false,
          interrupted: false,
        },
      },
      runState: 'running',
      draft: '继续',
    })
    // 同一会话还在跑：不发
    void useCloudStore.getState().send()
    expect(useCloudStore.getState().draft).toBe('继续')

    // 换到另一个会话：允许（并行第二轮）
    useCloudStore.setState({ activeSessionId: 'session-b', sessionRuns: { 'session-a': useCloudStore.getState().sessionRuns['session-a']! }, runState: null })
    void useCloudStore.getState().send()
    expect(useCloudStore.getState().sessionRuns['session-b']).toMatchObject({ state: 'started' })
  })

  it('refuses a third parallel run instead of letting the gateway 429', () => {
    const entry = (runId: string) => ({
      runId,
      state: 'running' as const,
      error: null,
      usage: null,
      model: null,
      partial: false,
      interrupted: false,
    })
    useCloudStore.setState({
      activeSessionId: 'session-c',
      sessionRuns: { a: entry('run-a'), b: entry('run-b') },
      runState: null,
      draft: '第三轮',
    })
    void useCloudStore.getState().send()
    expect(useCloudStore.getState().sendError).toContain('同时最多跟随 2 轮')
    expect(useCloudStore.getState().draft).toBe('第三轮')
  })

  it('moves the optimistic entry onto the session id the server returns', () => {
    useCloudStore.setState({ activeSessionId: null, sessionRuns: {} })
    useCloudStore.getState().applyFrame({ kind: 'session', sessionId: 'fresh' })
    expect(useCloudStore.getState().sessionRuns.fresh).toBeUndefined()

    useCloudStore.setState({
      sessionRuns: {
        '': { runId: '', state: 'started', error: null, usage: null, model: null, partial: false, interrupted: false },
      },
    })
    useCloudStore.setState({ activeSessionId: null })
    useCloudStore.getState().applyFrame({ kind: 'session', sessionId: 'fresh' })
    const state = useCloudStore.getState()
    expect(state.sessionRuns['']).toBeUndefined()
    expect(state.sessionRuns.fresh).toMatchObject({ state: 'started' })
  })

  it('adopts a new session id only when nothing is open', () => {
    useCloudStore.setState({ activeSessionId: null, sessionMeta: null })
    useCloudStore.getState().applyFrame({ kind: 'session', sessionId: 'fresh' })
    expect(useCloudStore.getState().activeSessionId).toBe('fresh')

    // 后台轮次建出新会话时不许抢当前视图
    useCloudStore.setState({ activeSessionId: 'session-b' })
    useCloudStore.getState().applyFrame({ kind: 'session', sessionId: 'background' })
    expect(useCloudStore.getState().activeSessionId).toBe('session-b')
  })

  it('keeps the usage and the truncation flags of a finished run', () => {
    useCloudStore.setState({ activeSessionId: 'session-a' })
    useCloudStore.getState().applyFrame({
      kind: 'run',
      runId: 'run-a',
      state: 'completed',
      sessionId: 'session-a',
      usage: { input: 1200, output: 40, total: 1240 },
      model: 'deepseek-chat',
      partial: true,
    })
    const state = useCloudStore.getState()
    expect(state.runUsage).toEqual({ input: 1200, output: 40, total: 1240 })
    expect(state.runModel).toBe('deepseek-chat')
    expect(state.runPartial).toBe(true)
    expect(state.runInterrupted).toBe(false)
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

  it('keeps a queued run distinct and flips it to running on the first content frame', () => {
    useCloudStore.getState().applyFrame({ kind: 'run', runId: 'run_q', state: 'queued' })
    expect(useCloudStore.getState().runState).toBe('queued')

    // 后端不一定推 run.started：内容帧到了就说明真的开始了
    useCloudStore.getState().applyFrame({ kind: 'part', part: text('s:1', 'hello') })
    expect(useCloudStore.getState().runState).toBe('running')
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

  it('asks for the tail of the session, not the first page', async () => {
    const calls: Array<Record<string, unknown>> = []
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudMessagesList: (input: Record<string, unknown>) => {
        calls.push(input)
        return Promise.resolve({ success: true, parts: [text('h:900', '最新')], hasMore: true })
      },
      cloudRunAttach: async () => ({ success: true, attached: false }),
      cloudLedgerList: async () => ({ success: true, entries: [] }),
    }

    await useCloudStore.getState().openSession('long')
    // `tail` 由主进程换算成 offset：渲染层不再自己写死 0（写死就只能看到最老的一页）
    expect(calls[0]).toMatchObject({ sessionId: 'long', tail: true })
    expect(useCloudStore.getState().parts).toEqual([text('h:900', '最新')])
    expect(useCloudStore.getState().partsHasMore).toBe(true)
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

  it('refuses to steer while the run is still queued', async () => {
    useCloudStore.setState({ draft: 'hi', runState: 'queued', parts: [], steerError: null })
    const steer = vi.fn()
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudRunSteer: steer,
    }
    await useCloudStore.getState().steer()
    expect(steer).not.toHaveBeenCalled()
    expect(useCloudStore.getState().steerError).toContain('排队')
    // 草稿不能被吃掉：等它开始执行用户还要发
    expect(useCloudStore.getState().draft).toBe('hi')
  })
})

describe('多端同步', () => {
  const row = (id: string, title: string, pinned = false) => ({
    id,
    title,
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
    pinned,
    archived: false,
  })

  it('merges remote rows without dropping already loaded pages', async () => {
    useCloudStore.setState({
      connection: 'connected',
      runState: null,
      sessions: [row('a', 'A'), row('b', 'B')],
      sessionActionPending: null,
      syncing: false,
      sessionsSyncedAt: null,
    })
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      // 首屏只有一条 + 一条新的；已加载的 b 不能被砍掉
      cloudSessionsList: async () => ({
        success: true,
        sessions: [row('c', 'C'), row('a', 'A renamed', true)],
        hasMore: false,
      }),
    }

    await useCloudStore.getState().syncSessions()
    const state = useCloudStore.getState()
    expect(state.sessions.map((session) => session.id)).toEqual(['c', 'a', 'b'])
    expect(state.sessions[1]).toMatchObject({ title: 'A renamed', pinned: true })
    expect(state.sessionsSyncedAt).toBeGreaterThan(0)
    expect(state.syncing).toBe(false)
  })

  it('leaves the row being edited alone', async () => {
    useCloudStore.setState({
      connection: 'connected',
      runState: null,
      sessions: [row('a', '我的新标题')],
      sessionActionPending: 'a',
      syncing: false,
    })
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudSessionsList: async () => ({ success: true, sessions: [row('a', 'Old')], hasMore: false }),
    }
    await useCloudStore.getState().syncSessions()
    expect(useCloudStore.getState().sessions[0].title).toBe('我的新标题')
  })

  it('skips polling while a run is in flight and when the list call fails', async () => {
    useCloudStore.setState({
      connection: 'connected',
      activeSessionId: 'a',
      sessionRuns: { a: { runId: 'run_1', state: 'running', error: null, usage: null, model: null, partial: false, interrupted: false } },
      runState: 'running',
      sessions: [row('a', 'A')],
      syncing: false,
    })
    const call = vi.fn()
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudSessionsList: call,
    }
    await useCloudStore.getState().syncSessions()
    expect(call).not.toHaveBeenCalled()

    useCloudStore.setState({
      connection: 'connected',
      sessionRuns: {},
      runState: null,
      syncing: false,
      sessionsError: null,
    })
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudSessionsList: async () => ({ success: false, error: 'offline', sessions: [] }),
    }
    await useCloudStore.getState().syncSessions()
    const state = useCloudStore.getState()
    // 后台刷新失败不写 sessionsError（会闪错误横幅）
    expect(state.sessionsError).toBeNull()
    expect(state.sessions).toHaveLength(1)
  })
})

describe('丢失主人的 run', () => {
  it('settles only when the backend confirms, and surfaces the reason otherwise', async () => {
    useCloudStore.setState({
      runId: 'run_lost',
      runState: 'unknown',
      resolvingUnknown: false,
      resolveError: null,
    })
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudRunResolveUnknown: async () => ({ success: false, error: '这一轮不是丢失状态' }),
    }

    await expect(useCloudStore.getState().resolveUnknown()).resolves.toBe(false)
    expect(useCloudStore.getState().resolveError).toBe('这一轮不是丢失状态')
    expect(useCloudStore.getState().runState).toBe('unknown')

    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudRunResolveUnknown: async () => ({ success: true, state: 'cancelled' }),
    }
    await expect(useCloudStore.getState().resolveUnknown()).resolves.toBe(true)
    expect(useCloudStore.getState().runState).toBe('cancelled')
    expect(useCloudStore.getState().resolvingUnknown).toBe(false)
  })

  it('does nothing unless the run is actually lost', async () => {
    useCloudStore.setState({ runId: 'run_1', runState: 'running', resolvingUnknown: false })
    const resolve = vi.fn()
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudRunResolveUnknown: resolve,
    }
    await expect(useCloudStore.getState().resolveUnknown()).resolves.toBe(false)
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('账本', () => {
  it('loads and resolves entries', async () => {
    const entries = [
      { id: 'run_1:c1', status: 'unknown' },
    ] as unknown as never[]
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudLedgerList: async () => ({ success: true, entries }),
      cloudLedgerResolve: async () => ({ success: true, entries: [] }),
    }
    await useCloudStore.getState().loadLedger()
    expect(useCloudStore.getState().pendingWrites).toHaveLength(1)

    await expect(useCloudStore.getState().resolveLedger('run_1:c1', 'done')).resolves.toBe(true)
    expect(useCloudStore.getState().pendingWrites).toEqual([])
  })

  it('surfaces the backend reason and keeps the list untouched on failure', async () => {
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudLedgerList: async () => ({ success: false, error: '读不出来' }),
    }
    await useCloudStore.getState().loadLedger()
    expect(useCloudStore.getState().ledgerError).toBe('读不出来')
  })
})

describe('任务', () => {
  it('refreshes the list after each action and surfaces a failure', async () => {
    const jobs = [{ id: 'job_1', name: 'A', state: 'scheduled', enabled: true }]
    let paused = false
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudJobsList: async () => ({ success: true, jobs: paused ? [{ ...jobs[0], state: 'paused' }] : jobs }),
      cloudJobsPause: async () => {
        paused = true
        return { success: true }
      },
      cloudJobsRun: async () => ({ success: false, error: '任务不存在' }),
    }
    await useCloudStore.getState().loadJobs()
    expect(useCloudStore.getState().jobs).toHaveLength(1)

    await expect(useCloudStore.getState().pauseJob('job_1')).resolves.toBe(true)
    expect(useCloudStore.getState().jobs[0].state).toBe('paused')
    expect(useCloudStore.getState().jobActionPending).toBeNull()

    await expect(useCloudStore.getState().runJob('job_9')).resolves.toBe(false)
    expect(useCloudStore.getState().jobsError).toBe('任务不存在')
  })

  it('creates a job, reloads the list, and keeps the form error on failure', async () => {
    const created: Array<Record<string, unknown>> = []
    let jobs = [{ id: 'job_1', name: 'A', state: 'scheduled', enabled: true }]
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudJobsList: async () => ({ success: true, jobs }),
      cloudJobsCreate: async (input: Record<string, unknown>) => {
        created.push(input)
        if (input.name === '炸') return { success: false, error: '调度表达式无法解析' }
        jobs = [...jobs, { id: 'job_2', name: String(input.name), state: 'scheduled', enabled: true }]
        return { success: true, job: { id: 'job_2', name: input.name } }
      },
    }

    await expect(
      useCloudStore.getState().createJob({ name: '每日', schedule: '30m', prompt: '汇总' })
    ).resolves.toBe(true)
    expect(created[0]).toEqual({ name: '每日', schedule: '30m', prompt: '汇总' })
    expect(useCloudStore.getState().jobCreatePending).toBe(false)
    expect(useCloudStore.getState().jobs).toHaveLength(2)

    await expect(
      useCloudStore.getState().createJob({ name: '炸', schedule: 'nonsense', prompt: 'x' })
    ).resolves.toBe(false)
    expect(useCloudStore.getState().jobsError).toBe('调度表达式无法解析')
    expect(useCloudStore.getState().jobCreatePending).toBe(false)
  })
})

const approval = (
  requestId: string,
  overrides: Partial<Extract<CloudTracePart, { type: 'approval' }>> = {}
): CloudTracePart => ({
  type: 'approval',
  id: `a:${requestId}`,
  requestId,
  command: 'rm -rf build',
  patternKeys: ['rm -rf'],
  choices: ['once', 'session', 'deny'],
  ...overrides,
})

describe('审批决定', () => {
  beforeEach(() => {
    useCloudStore.setState({
      parts: [approval('ap_1')],
      runId: 'run_1',
      activeSessionId: 's_1',
      approvalPending: null,
      approvalError: null,
    })
  })

  it('fills the decision in optimistically and keeps it when the server accepts', async () => {
    const sent: Array<Record<string, unknown>> = []
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudApprovalRespond: async (input: Record<string, unknown>) => {
        sent.push(input)
        return { success: true, choice: input.choice }
      },
    }

    const done = useCloudStore.getState().respondApproval('ap_1', 'session')
    // 乐观更新：点下去卡片立刻收折，不用等网络
    expect(
      (useCloudStore.getState().parts[0] as Extract<CloudTracePart, { type: 'approval' }>).decision
    ).toBe('session')
    await expect(done).resolves.toBe(true)

    expect(sent[0]).toMatchObject({
      runId: 'run_1',
      requestId: 'ap_1',
      choice: 'session',
      sessionId: 's_1',
    })
    expect(useCloudStore.getState().approvalPending).toBeNull()
  })

  it('rolls the decision back when the call fails', async () => {
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudApprovalRespond: async () => ({ success: false, error: '网络断了' }),
    }
    await expect(useCloudStore.getState().respondApproval('ap_1', 'once')).resolves.toBe(false)
    const part = useCloudStore.getState().parts[0] as Extract<CloudTracePart, { type: 'approval' }>
    expect(part.decision).toBeUndefined()
    expect(useCloudStore.getState().approvalError).toBe('网络断了')
  })

  it('marks the card settled instead of clickable when someone else resolved it', async () => {
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudApprovalRespond: async () => ({ success: false, error: '这条审批已经被结算了' }),
    }
    await useCloudStore.getState().respondApproval('ap_1', 'once')
    const part = useCloudStore.getState().parts[0] as Extract<CloudTracePart, { type: 'approval' }>
    expect(part.decision).toBeUndefined()
    expect(part.settled).toBe(true)
  })

  it('ignores a second click while one is in flight', async () => {
    let release: (value: unknown) => void = () => {}
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudApprovalRespond: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    }
    const first = useCloudStore.getState().respondApproval('ap_1', 'once')
    await expect(useCloudStore.getState().respondApproval('ap_1', 'deny')).resolves.toBe(false)
    release({ success: true })
    await expect(first).resolves.toBe(true)
  })

  it('will not answer an expired or already-decided card', async () => {
    useCloudStore.setState({ parts: [approval('ap_2', { expiredAt: Date.now() })] })
    await expect(useCloudStore.getState().respondApproval('ap_2', 'once')).resolves.toBe(false)

    useCloudStore.setState({ parts: [approval('ap_3', { decision: 'deny' })] })
    await expect(useCloudStore.getState().respondApproval('ap_3', 'once')).resolves.toBe(false)
  })

  it('expires the card locally when the countdown runs out', () => {
    useCloudStore.getState().expireApproval('ap_1')
    const part = useCloudStore.getState().parts[0] as Extract<CloudTracePart, { type: 'approval' }>
    expect(part.expiredAt).toBeTypeOf('number')
  })
})

describe('审批档位', () => {
  it('shows what the server reports after a successful switch', async () => {
    const modes: string[] = []
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudPolicyGet: async () => ({
        success: true,
        policy: {
          mode: 'manual',
          timeoutSeconds: 120,
          denyCount: 0,
          disabledToolsets: ['code_execution'],
          terminalBackend: 'local',
        },
      }),
      cloudPolicySet: async (input: { mode: string }) => {
        modes.push(input.mode)
        return {
          success: true,
          policy: {
            mode: input.mode,
            timeoutSeconds: 120,
            denyCount: 0,
            disabledToolsets: ['code_execution'],
            terminalBackend: 'local',
          },
        }
      },
    }

    await useCloudStore.getState().loadPolicy()
    expect(useCloudStore.getState().policy?.mode).toBe('manual')

    await expect(useCloudStore.getState().setMode('off')).resolves.toBe(true)
    expect(modes).toEqual(['off'])
    expect(useCloudStore.getState().policy?.mode).toBe('off')
    expect(useCloudStore.getState().policyPending).toBeNull()
  })

  it('keeps the old mode when the switch fails', async () => {
    useCloudStore.setState({
      policy: {
        mode: 'manual',
        timeoutSeconds: 120,
        denyCount: 0,
        disabledToolsets: [],
        terminalBackend: 'local',
      },
    })
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudPolicySet: async () => ({ success: false, error: '控制台拒绝了保存请求（403）' }),
    }
    await expect(useCloudStore.getState().setMode('off')).resolves.toBe(false)
    expect(useCloudStore.getState().policy?.mode).toBe('manual')
    expect(useCloudStore.getState().policyError).toContain('403')
  })

  it('shares one request between two mount points', async () => {
    // 连接页 + 会话页（多个常驻工作区各一份）会在 connected 翻转时各读一次；
    // 实测 502 期间 231ms 内出现 4 次请求，而单次超时是 30s。
    let calls = 0
    // 用对象装着 resolve：赋值在 Promise executor 里，TS 会把裸 let 缩成 null
    const gate: { release?: (value: unknown) => void } = {}
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudPolicyGet: () => {
        calls += 1
        return new Promise((resolve) => {
          gate.release = resolve
        })
      },
    }

    const first = useCloudStore.getState().loadPolicy()
    const second = useCloudStore.getState().loadPolicy()
    expect(calls).toBe(1)
    gate.release?.({
      success: true,
      policy: {
        mode: 'manual',
        timeoutSeconds: 120,
        denyCount: 0,
        disabledToolsets: [],
        terminalBackend: 'local',
      },
    })
    await Promise.all([first, second])
    expect(useCloudStore.getState().policy?.mode).toBe('manual')
    expect(useCloudStore.getState().policyLoading).toBe(false)
  })

  it('backs off after a failed read until forced', async () => {
    let calls = 0
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudPolicyGet: async () => {
        calls += 1
        return { success: false, error: '云端网关读取配置失败（502）' }
      },
    }

    await useCloudStore.getState().loadPolicy()
    expect(calls).toBe(1)
    expect(useCloudStore.getState().policyError).toContain('502')

    // 静默期内再挂载一次：不再打网关，但错误留着
    await useCloudStore.getState().loadPolicy()
    expect(calls).toBe(1)
    expect(useCloudStore.getState().policyError).toContain('502')

    // 用户点「重试」：force 跳过静默期
    await useCloudStore.getState().loadPolicy({ force: true })
    expect(calls).toBe(2)
  })
})

describe('attachRun（重启后接回在跑的一轮）', () => {
  interface AttachCall {
    sessionId?: string
  }

  function bridgeFor(
    attach: (input: AttachCall) => Promise<{
      success: boolean
      attached: boolean
      runId?: string
      sessionId?: string
      state?: string
    }>,
    calls: AttachCall[]
  ) {
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudConfigGet: async () => ({ success: true }),
      cloudConnect: async () => ({ success: true, state: 'connected', capabilities: {} }),
      cloudSessionsList: async () => ({ success: true, sessions: [], hasMore: false }),
      cloudMessagesList: async () => ({ success: true, parts: [], hasMore: false }),
      cloudRunAttach: (input: AttachCall) => {
        calls.push(input)
        return attach(input)
      },
    }
  }

  beforeEach(() => {
    useCloudStore.setState({ activeSessionId: null, runId: null, runState: null, runError: null })
  })

  it('adopts the run state reported by the main process', async () => {
    const calls: AttachCall[] = []
    bridgeFor(
      async () => ({ success: true, attached: true, runId: 'run_1', sessionId: 's1', state: 'running' }),
      calls
    )

    const attached = await useCloudStore.getState().attachRun()
    expect(attached).toBe(true)
    expect(calls).toEqual([{}])
    // 没有打开的会话时只记在 sessionRuns 里（重启后靠它给会话行标「在跑」）
    expect(useCloudStore.getState().sessionRuns.s1).toMatchObject({
      runId: 'run_1',
      state: 'running',
    })
  })

  it('stays idle when there is nothing to attach to', async () => {
    const calls: AttachCall[] = []
    bridgeFor(async () => ({ success: true, attached: false }), calls)

    const attached = await useCloudStore.getState().attachRun('s1')
    expect(attached).toBe(false)
    expect(useCloudStore.getState().runState).toBeNull()
  })

  it('asks about the session that was just opened', async () => {
    const calls: AttachCall[] = []
    bridgeFor(async () => ({ success: true, attached: false }), calls)

    await useCloudStore.getState().openSession('s2')
    await Promise.resolve()
    expect(calls).toEqual([{ sessionId: 's2' }])
  })

  it('tries to attach right after connecting', async () => {
    const calls: AttachCall[] = []
    bridgeFor(async () => ({ success: true, attached: false }), calls)

    await useCloudStore.getState().connect()
    await Promise.resolve()
    expect(calls).toHaveLength(1)
  })
})

describe('设备身份', () => {
  const DEVICE = { id: 'dev-1', name: '本机', defaultName: '本机' }

  // 前面的用例会把 window.electronAPI 留着，这里先清干净再各测各的
  beforeEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    useCloudStore.setState({ device: null, deviceError: null, deviceBusy: false })
  })

  it('falls back to a stable preview identity when there is no bridge', async () => {
    await useCloudStore.getState().loadDevice()
    expect(useCloudStore.getState().device).toMatchObject({ name: '浏览器预览（无主进程）' })
    expect(useCloudStore.getState().deviceError).toBeNull()
  })

  it('refuses to fake an identity when the preload is older than the main process', async () => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      cloudConfigGet: async () => ({ success: false }),
    }
    await useCloudStore.getState().loadDevice()
    expect(useCloudStore.getState().device).toBeNull()
    expect(useCloudStore.getState().deviceError).toMatch(/重启应用/)
  })

  it('reads and renames through the bridge', async () => {
    const setDevice = vi.fn(async (input: { name: string }) => ({
      success: true,
      device: { ...DEVICE, name: input.name || DEVICE.defaultName },
    }))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      cloudConfigGet: async () => ({ success: false }),
      cloudDeviceGet: async () => ({ success: true, device: DEVICE }),
      cloudDeviceSet: setDevice,
    }

    await useCloudStore.getState().loadDevice()
    expect(useCloudStore.getState().device).toEqual(DEVICE)

    await expect(useCloudStore.getState().setDeviceName('客厅那台')).resolves.toBe(true)
    expect(setDevice).toHaveBeenCalledWith({ name: '客厅那台' })
    expect(useCloudStore.getState().device?.name).toBe('客厅那台')
    expect(useCloudStore.getState().deviceBusy).toBe(false)
  })

  it('re-reads the system name through the bridge', async () => {
    const reprobe = vi.fn(async () => ({
      success: true,
      device: { ...DEVICE, defaultName: 'TChen-Legion', name: 'TChen-Legion' },
    }))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      cloudConfigGet: async () => ({ success: false }),
      cloudDeviceGet: async () => ({ success: true, device: DEVICE }),
      cloudDeviceReprobe: reprobe,
    }

    await useCloudStore.getState().loadDevice()
    await expect(useCloudStore.getState().reprobeDeviceName()).resolves.toBe(true)
    expect(reprobe).toHaveBeenCalledTimes(1)
    expect(useCloudStore.getState().device).toMatchObject({ name: 'TChen-Legion' })
    expect(useCloudStore.getState().deviceBusy).toBe(false)
  })

  it('keeps the previous name and surfaces the error when saving fails', async () => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      cloudConfigGet: async () => ({ success: false }),
      cloudDeviceGet: async () => ({ success: true, device: DEVICE }),
      cloudDeviceSet: async () => ({ success: false, error: '保存设备名失败' }),
    }

    await useCloudStore.getState().loadDevice()
    await expect(useCloudStore.getState().setDeviceName('坏名字')).resolves.toBe(false)
    expect(useCloudStore.getState().device?.name).toBe('本机')
    expect(useCloudStore.getState().deviceError).toBe('保存设备名失败')
  })
})

describe('pairGateway', () => {
  const config = {
    gatewayUrl: 'https://hub.example.com',
    dashboardUrl: 'https://dash.example.com',
    hasDeviceToken: true,
    deviceScopes: ['chat', 'dispatch'],
    deviceId: 'dev-local',
  }

  it('stores the returned config, connects and refreshes the gateway view', async () => {
    const { cloudApi } = await import('../src/api/cloud')
    const pair = vi.spyOn(cloudApi, 'gatewayPair').mockResolvedValue({
      success: true,
      config,
      name: 'TChen-Legion',
    })
    const connect = vi.spyOn(cloudApi, 'connect').mockResolvedValue({
      success: true,
      state: 'connected',
      capabilities: null,
    })
    vi.spyOn(cloudApi, 'listSessions').mockResolvedValue({
      success: true,
      sessions: [],
      hasMore: false,
    })
    vi.spyOn(cloudApi, 'attachRun').mockResolvedValue({ success: true, attached: false })
    vi.spyOn(cloudApi, 'gatewayStatus').mockResolvedValue({
      success: true,
      registered: true,
      gatewayUrl: config.gatewayUrl,
    })

    useCloudStore.setState({ config: {} as never, connection: 'unconfigured' })
    const ok = await useCloudStore.getState().pairGateway({
      code: 'ABCDE-FGHIJ',
      gatewayUrl: 'https://hub.example.com',
    })

    expect(ok).toBe(true)
    expect(pair).toHaveBeenCalledWith({
      code: 'ABCDE-FGHIJ',
      gatewayUrl: 'https://hub.example.com',
    })
    expect(connect).toHaveBeenCalled()
    expect(useCloudStore.getState().config).toEqual(config)
    expect(useCloudStore.getState().connection).toBe('connected')
    expect(useCloudStore.getState().gatewayNotice).toContain('TChen-Legion')
    expect(useCloudStore.getState().pairBusy).toBe(false)
  })

  it('keeps the old config and exposes the reason when pairing fails', async () => {
    const { cloudApi } = await import('../src/api/cloud')
    vi.spyOn(cloudApi, 'gatewayPair').mockResolvedValue({
      success: false,
      error: '连接码已过期',
      code: 'pairing_expired',
    })
    const connect = vi.spyOn(cloudApi, 'connect')
    const before = { ...config, hasDeviceToken: false, deviceId: '' }
    useCloudStore.setState({ config: before, connection: 'unconfigured' })

    const ok = await useCloudStore.getState().pairGateway({ code: 'EXPIRED001' })

    expect(ok).toBe(false)
    expect(connect).not.toHaveBeenCalled()
    expect(useCloudStore.getState().config).toEqual(before)
    expect(useCloudStore.getState().pairError).toBe('连接码已过期')
    expect(useCloudStore.getState().pairErrorCode).toBe('pairing_expired')
  })
})

describe('网关状态驱动连接状态', () => {
  it('turns the connection red when the gateway cannot be reached', async () => {
    const { cloudApi } = await import('../src/api/cloud')
    vi.spyOn(cloudApi, 'gatewayStatus').mockResolvedValue({
      success: false,
      registered: false,
      gatewayUrl: 'https://hub.example.com',
      error: '连不上网关：连接被关闭（ERR_CONNECTION_CLOSED）',
    } as never)
    useCloudStore.setState({ connection: 'connected', error: null, gatewayError: null })

    await useCloudStore.getState().loadGateway()

    // 右上角的状态灯不能还挂着"已连接"
    expect(useCloudStore.getState().connection).toBe('error')
    expect(useCloudStore.getState().error).toContain('ERR_CONNECTION_CLOSED')
  })

  it('turns the connection red when the hub is up but Hermes is not', async () => {
    const { cloudApi } = await import('../src/api/cloud')
    vi.spyOn(cloudApi, 'gatewayStatus').mockResolvedValue({
      success: true,
      registered: true,
      gatewayUrl: 'https://hub.example.com',
      online: false,
    } as never)
    useCloudStore.setState({ connection: 'connected', error: null })

    await useCloudStore.getState().loadGateway()

    expect(useCloudStore.getState().connection).toBe('error')
    expect(useCloudStore.getState().error).toContain('Hermes 没响应')
  })

  it('clears the error once the gateway and upstream are both healthy again', async () => {
    const { cloudApi } = await import('../src/api/cloud')
    vi.spyOn(cloudApi, 'gatewayStatus').mockResolvedValue({
      success: true,
      registered: true,
      gatewayUrl: 'https://hub.example.com',
      online: true,
    } as never)
    useCloudStore.setState({ connection: 'error', error: '上一个错误' })

    await useCloudStore.getState().loadGateway()

    expect(useCloudStore.getState().connection).toBe('connected')
    expect(useCloudStore.getState().error).toBeNull()
  })
})
