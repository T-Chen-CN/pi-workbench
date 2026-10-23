import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_NOTIFICATION_PREFS,
  NotificationRouter,
  normalizeNotificationPrefs,
} from '../electron/notifications'

const event = {
  kind: 'approval' as const,
  workspaceDir: 'F:/work',
  sessionId: 'session-1',
  title: '需要审批',
  body: 'write · a.ts',
}

describe('normalizeNotificationPrefs', () => {
  it('falls back to defaults for invalid input', () => {
    expect(normalizeNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS)
    expect(normalizeNotificationPrefs({ enabled: 'yes' })).toEqual(DEFAULT_NOTIFICATION_PREFS)
  })

  it('keeps boolean overrides', () => {
    expect(normalizeNotificationPrefs({ complete: false }).complete).toBe(false)
    expect(normalizeNotificationPrefs({ enabled: false }).enabled).toBe(false)
  })
})

describe('NotificationRouter', () => {
  it('delivers when unfocused and enabled', () => {
    const deliver = vi.fn()
    const router = new NotificationRouter(deliver, () => undefined, () => false)
    expect(router.notify(event)).toBe(true)
    expect(deliver).toHaveBeenCalledWith({
      title: event.title,
      body: event.body,
      workspaceDir: event.workspaceDir,
      sessionId: event.sessionId,
    })
  })

  it('stays quiet while the app is focused', () => {
    const deliver = vi.fn()
    const router = new NotificationRouter(deliver, () => undefined, () => true)
    expect(router.notify(event)).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('respects per-kind switches and the master switch', () => {
    const deliver = vi.fn()
    const disabledKind = new NotificationRouter(
      deliver,
      () => ({ approval: false }),
      () => false
    )
    expect(disabledKind.notify(event)).toBe(false)

    const disabledAll = new NotificationRouter(deliver, () => ({ enabled: false }), () => false)
    expect(disabledAll.notify(event)).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('swallows delivery errors', () => {
    const router = new NotificationRouter(
      () => {
        throw new Error('no notification support')
      },
      () => undefined,
      () => false
    )
    expect(router.notify(event)).toBe(false)
  })
})

describe('NotificationRouter logging', () => {
  it('logs skip reasons and delivered notifications', () => {
    const info = vi.fn()
    const deliver = vi.fn()
    const log = { info, warn: vi.fn() }

    new NotificationRouter(deliver, () => undefined, () => true, log).notify(event)
    expect(info).toHaveBeenCalledWith(expect.stringContaining('app is focused'))

    const unfocused = new NotificationRouter(deliver, () => ({ enabled: false }), () => false, log)
    unfocused.notify(event)
    expect(info).toHaveBeenCalledWith(expect.stringContaining('notifications disabled'))

    const delivered = new NotificationRouter(deliver, () => undefined, () => false, log)
    expect(delivered.notify(event)).toBe(true)
    expect(info).toHaveBeenCalledWith(expect.stringContaining('delivered "approval"'))
  })
})
