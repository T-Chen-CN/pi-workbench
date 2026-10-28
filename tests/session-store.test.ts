import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_OPEN_SESSIONS, useSessionStore } from '../src/store/sessionStore'
import { conversationKey } from '../src/store/chatStore'
import type { SessionSummary } from '../src/types/electron'

const WS = '/ws'

function makeSession(id: string, title = id): SessionSummary {
  return { id, title, messageCount: 0, createdAt: 1, updatedAt: 2 }
}

beforeEach(() => {
  useSessionStore.getState().reset()
})

describe('sessionStore', () => {
  it('tracks sessions, open tabs and the active session', () => {
    const store = useSessionStore.getState()
    store.setSessions(WS, [makeSession('a'), makeSession('b')])
    store.setOpen(WS, ['a', 'b'], 'a')

    expect(useSessionStore.getState().byWorkspace[WS]).toMatchObject({
      open: ['a', 'b'],
      active: 'a',
    })
  })

  it('switches to an existing tab and caps the number of open tabs', () => {
    for (let index = 0; index < MAX_OPEN_SESSIONS + 1; index += 1) {
      const added = useSessionStore
        .getState()
        .addOpen(WS, `s${index}`, makeSession(`s${index}`))
      if (index < MAX_OPEN_SESSIONS) expect(added).toBe(true)
      else expect(added).toBe(false)
    }

    const state = useSessionStore.getState().byWorkspace[WS]
    expect(state.open).toHaveLength(MAX_OPEN_SESSIONS)
    expect(state.active).toBe(`s${MAX_OPEN_SESSIONS - 1}`)

    expect(useSessionStore.getState().addOpen(WS, 's0')).toBe(true)
    expect(useSessionStore.getState().byWorkspace[WS].active).toBe('s0')
  })

  it('activates the neighbour when the active tab closes', () => {
    const store = useSessionStore.getState()
    store.setOpen(WS, ['a', 'b', 'c'], 'b')

    expect(useSessionStore.getState().closeOpen(WS, 'b')).toBe('c')
    expect(useSessionStore.getState().byWorkspace[WS]).toMatchObject({
      open: ['a', 'c'],
      active: 'c',
    })
  })

  it('removes a deleted session from tabs and metadata', () => {
    const store = useSessionStore.getState()
    store.setSessions(WS, [makeSession('a'), makeSession('b')])
    store.setOpen(WS, ['a', 'b'], 'b')

    expect(useSessionStore.getState().removeSession(WS, 'b')).toBe('a')
    expect(useSessionStore.getState().byWorkspace[WS].sessions).toHaveLength(1)
    expect(useSessionStore.getState().byWorkspace[WS].open).toEqual(['a'])
  })

  it('tracks streaming and unread state per conversation', () => {
    useSessionStore.getState().markStreaming(WS, 'a', true)
    useSessionStore.getState().markUnread(WS, 'a', true)

    const key = conversationKey(WS, 'a')
    expect(useSessionStore.getState().streaming[key]).toBe(true)
    expect(useSessionStore.getState().unread[key]).toBe(true)

    useSessionStore.getState().markStreaming(WS, 'a', false)
    useSessionStore.getState().markUnread(WS, 'a', false)
    expect(useSessionStore.getState().streaming[key]).toBeUndefined()
    expect(useSessionStore.getState().unread[key]).toBeUndefined()
  })

  it('stores errors and clears them', () => {
    useSessionStore.getState().markError(WS, 'a', 'provider down')
    const key = conversationKey(WS, 'a')
    expect(useSessionStore.getState().errors[key]).toBe('provider down')

    useSessionStore.getState().markError(WS, 'a', null)
    expect(useSessionStore.getState().errors[key]).toBeUndefined()
  })

  it('stores a placeholder needs-action reason and clears it', () => {
    useSessionStore.getState().markNeedsAction(WS, 'a', 'review')
    const key = conversationKey(WS, 'a')
    expect(useSessionStore.getState().needsAction[key]).toBe('review')

    useSessionStore.getState().markNeedsAction(WS, 'a', null)
    expect(useSessionStore.getState().needsAction[key]).toBeUndefined()
  })

  it('clears one workspace without touching others', () => {
    useSessionStore.getState().setOpen(WS, ['a'], 'a')
    useSessionStore.getState().setOpen('/other', ['b'], 'b')
    useSessionStore.getState().markStreaming(WS, 'a', true)
    useSessionStore.getState().markStreaming('/other', 'b', true)

    useSessionStore.getState().resetWorkspace(WS)

    expect(useSessionStore.getState().byWorkspace[WS]).toBeUndefined()
    expect(useSessionStore.getState().byWorkspace['/other']).toBeTruthy()
    expect(
      useSessionStore.getState().streaming[conversationKey(WS, 'a')]
    ).toBeUndefined()
    expect(
      useSessionStore.getState().streaming[conversationKey('/other', 'b')]
    ).toBe(true)
  })

  it('keeps a pinned title when a stale list refresh reports the fallback title', () => {
    const store = useSessionStore.getState()
    store.setSessions(WS, [makeSession('a', 'Fix the login redirect loop')])
    // 模型生成的标题到达（agent:session-title），渲染层钉住它
    store.pinTitle(WS, 'a', '登录重定向修复')
    expect(useSessionStore.getState().byWorkspace[WS].sessions[0].title).toBe('登录重定向修复')

    // 之前发起的 sessions:list 晚到，带着首条消息的回退标题
    store.setSessions(WS, [makeSession('a', 'Fix the login redirect loop')])
    expect(useSessionStore.getState().byWorkspace[WS].sessions[0].title).toBe('登录重定向修复')

    // 其他字段仍以最新列表为准
    store.setSessions(WS, [{ ...makeSession('a', 'Fix the login redirect loop'), messageCount: 7 }])
    expect(useSessionStore.getState().byWorkspace[WS].sessions[0]).toMatchObject({
      title: '登录重定向修复',
      messageCount: 7,
    })
  })

  it('never blanks a title that is already displayed', () => {
    const store = useSessionStore.getState()
    store.setSessions(WS, [makeSession('a', 'Existing title')])
    store.setSessions(WS, [makeSession('a', '')])
    expect(useSessionStore.getState().byWorkspace[WS].sessions[0].title).toBe('Existing title')

    store.updateSession(WS, 'a', { title: '', messageCount: 3 })
    expect(useSessionStore.getState().byWorkspace[WS].sessions[0]).toMatchObject({
      title: 'Existing title',
      messageCount: 3,
    })
  })

  it('drops pinned titles with the session or the workspace', () => {
    const store = useSessionStore.getState()
    store.setSessions(WS, [makeSession('a'), makeSession('b')])
    store.setOpen(WS, ['a', 'b'], 'a')
    store.pinTitle(WS, 'a', 'Pinned A')
    store.pinTitle(WS, 'b', 'Pinned B')

    store.removeSession(WS, 'a')
    expect(useSessionStore.getState().pinnedTitles[`${WS}\u0000a`]).toBeUndefined()
    expect(useSessionStore.getState().pinnedTitles[`${WS}\u0000b`]).toBe('Pinned B')

    store.resetWorkspace(WS)
    expect(useSessionStore.getState().pinnedTitles).toEqual({})
  })
})
