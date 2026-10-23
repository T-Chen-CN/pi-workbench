import { beforeEach, describe, expect, it } from 'vitest'
import { useApprovalStore } from '../src/store/approvalStore'
import type { ApprovalRequestPayload } from '../src/types/electron'

function makeRequest(overrides: Partial<ApprovalRequestPayload> = {}): ApprovalRequestPayload {
  return {
    requestId: 'req-1',
    workspaceDir: 'F:/work',
    sessionId: 'session-1',
    toolCallId: 'call-1',
    toolName: 'write',
    category: 'write',
    summary: 'src/a.ts',
    details: { path: 'src/a.ts' },
    createdAt: 1,
    expiresAt: 2,
    ...overrides,
  }
}

describe('approvalStore', () => {
  beforeEach(() => {
    useApprovalStore.getState().reset()
  })

  it('adds requests in order and ignores duplicates', () => {
    const store = useApprovalStore.getState()
    store.add(makeRequest({ requestId: 'a' }))
    store.add(makeRequest({ requestId: 'b' }))
    store.add(makeRequest({ requestId: 'a' }))
    expect(useApprovalStore.getState().requests.map((item) => item.requestId)).toEqual(['a', 'b'])
  })

  it('removes a single request', () => {
    const store = useApprovalStore.getState()
    store.add(makeRequest({ requestId: 'a' }))
    store.add(makeRequest({ requestId: 'b' }))
    store.remove('a')
    expect(useApprovalStore.getState().requests.map((item) => item.requestId)).toEqual(['b'])
  })

  it('clears by workspace and by session', () => {
    const store = useApprovalStore.getState()
    store.add(makeRequest({ requestId: 'a' }))
    store.add(makeRequest({ requestId: 'b', sessionId: 'session-2' }))
    store.add(makeRequest({ requestId: 'c', workspaceDir: 'F:/other' }))

    store.clearSession('F:/work', 'session-1')
    expect(useApprovalStore.getState().requests.map((item) => item.requestId)).toEqual(['b', 'c'])

    store.clearWorkspace('F:/work')
    expect(useApprovalStore.getState().requests.map((item) => item.requestId)).toEqual(['c'])
  })
})
