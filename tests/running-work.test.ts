import { beforeEach, describe, expect, it } from 'vitest'
import { useApprovalStore } from '../src/store/approvalStore'
import { useSessionStore } from '../src/store/sessionStore'
import type { ApprovalRequestPayload } from '../src/types/electron'
import { hasRunningWork, runningWorkFor } from '../src/utils/runningWork'

function request(
  requestId: string,
  workspaceDir: string,
  sessionId: string
): ApprovalRequestPayload {
  return {
    requestId,
    workspaceDir,
    sessionId,
    toolCallId: `call-${requestId}`,
    toolName: 'write',
    category: 'write',
    summary: 'write a.ts',
    details: { path: 'a.ts' },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  }
}

beforeEach(() => {
  useSessionStore.getState().reset()
  useApprovalStore.getState().reset()
})

describe('running work', () => {
  it('counts streaming sessions and pending approvals per workspace', () => {
    useSessionStore.getState().markStreaming('F:/a', 's1', true)
    useSessionStore.getState().markStreaming('F:/b', 's2', true)
    useApprovalStore.getState().add(request('r1', 'F:/a', 's1'))

    expect(runningWorkFor('F:/a')).toEqual({ sessions: 1, approvals: 1 })
    expect(runningWorkFor('F:/b')).toEqual({ sessions: 1, approvals: 0 })
    expect(runningWorkFor()).toEqual({ sessions: 2, approvals: 1 })
    expect(hasRunningWork('F:/a')).toBe(true)
    expect(hasRunningWork('F:/c')).toBe(false)
  })

  it('stops counting a session once it is no longer streaming', () => {
    useSessionStore.getState().markStreaming('F:/a', 's1', true)
    useSessionStore.getState().markStreaming('F:/a', 's1', false)

    expect(runningWorkFor('F:/a')).toEqual({ sessions: 0, approvals: 0 })
    expect(hasRunningWork()).toBe(false)
  })
})
