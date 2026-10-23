import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApprovalBroker,
  sanitizeApprovalDecision,
  type ApprovalRequestPayload,
} from '../electron/approval-broker'

function makeRequest(overrides: Partial<ApprovalRequestPayload> = {}): ApprovalRequestPayload {
  return {
    requestId: 'req-1',
    workspaceDir: 'F:/work',
    sessionId: 'session-1',
    toolCallId: 'call-1',
    toolName: 'write',
    category: 'write',
    summary: 'src/a.ts · 10 字符',
    details: { path: 'src/a.ts' },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  }
}

describe('ApprovalBroker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers the request and resolves with the user decision', async () => {
    const send = vi.fn()
    const broker = new ApprovalBroker(send)
    const request = makeRequest()
    const pending = broker.request(request)

    expect(send).toHaveBeenCalledWith(request)
    expect(broker.respond('req-1', { action: 'allow-once' })).toBe(true)
    await expect(pending).resolves.toEqual({ action: 'allow-once' })
    expect(broker.pendingCount).toBe(0)
  })

  it('denies on timeout (fail-closed)', async () => {
    const broker = new ApprovalBroker(() => {})
    const pending = broker.request(makeRequest({ expiresAt: Date.now() + 5_000 }))

    await vi.advanceTimersByTimeAsync(5_001)
    await expect(pending).resolves.toEqual({
      action: 'deny',
      reason: 'The approval request timed out.',
    })
  })

  it('ignores responses for unknown or already resolved requests', async () => {
    const broker = new ApprovalBroker(() => {})
    const pending = broker.request(makeRequest())
    expect(broker.respond('req-1', { action: 'deny' })).toBe(true)
    expect(broker.respond('req-1', { action: 'allow-once' })).toBe(false)
    await expect(pending).resolves.toEqual({ action: 'deny' })
  })

  it('cancels pending requests by session and workspace', async () => {
    const broker = new ApprovalBroker(() => {})
    const first = broker.request(makeRequest({ requestId: 'a' }))
    const second = broker.request(makeRequest({ requestId: 'b', sessionId: 'session-2' }))
    const third = broker.request(
      makeRequest({ requestId: 'c', workspaceDir: 'F:/other', sessionId: 'session-3' })
    )

    broker.cancelForSession('session-1')
    await expect(first).resolves.toEqual({ action: 'deny', reason: 'The session was closed.' })

    broker.cancelForWorkspace('F:/work')
    await expect(second).resolves.toEqual({ action: 'deny', reason: 'The workspace was closed.' })

    broker.cancelForWorkspace('F:/other')
    await expect(third).resolves.toEqual({ action: 'deny', reason: 'The workspace was closed.' })
  })

  it('denies when the request cannot be delivered', async () => {
    const broker = new ApprovalBroker(() => {
      throw new Error('no window')
    })
    await expect(broker.request(makeRequest())).resolves.toEqual({
      action: 'deny',
      reason: 'The approval request could not be delivered.',
    })
  })
})

describe('sanitizeApprovalDecision', () => {
  it('accepts known actions and trims deny reasons', () => {
    expect(sanitizeApprovalDecision({ action: 'allow-always' })).toEqual({ action: 'allow-always' })
    expect(sanitizeApprovalDecision({ action: 'deny', reason: 'too risky' })).toEqual({
      action: 'deny',
      reason: 'too risky',
    })
  })

  it('rejects unknown shapes', () => {
    expect(sanitizeApprovalDecision(null)).toBeNull()
    expect(sanitizeApprovalDecision({ action: 'yolo' })).toBeNull()
    expect(sanitizeApprovalDecision('allow-once')).toBeNull()
  })
})
