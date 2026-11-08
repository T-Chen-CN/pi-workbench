import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_NOTIFICATION_PREFS,
  NotificationRouter,
  normalizeNotificationPrefs,
  notificationCopy,
  notificationSummary,
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

describe('NotificationRouter 云端会话', () => {
  it('把云端标记与锚点透传出去，工作区为 null', () => {
    const deliver = vi.fn()
    const router = new NotificationRouter(deliver, () => undefined, () => false)
    expect(
      router.notify({
        kind: 'approval',
        workspaceDir: null,
        sessionId: 'run_session',
        cloud: true,
        requestId: 'ap_1',
        title: '云端需要审批',
        body: 'rm -rf build'
      })
    ).toBe(true)
    expect(deliver).toHaveBeenCalledWith({
      title: '云端需要审批',
      body: 'rm -rf build',
      workspaceDir: null,
      sessionId: 'run_session',
      cloud: true,
      requestId: 'ap_1'
    })
  })

  it('本地事件不带云端字段', () => {
    const deliver = vi.fn()
    new NotificationRouter(deliver, () => undefined, () => false).notify(event)
    expect(deliver.mock.calls[0][0]).toMatchObject({ cloud: undefined, requestId: undefined })
  })
})

describe('notificationCopy', () => {
  it('云端与本地各有一套措辞，中文为默认', () => {
    const zh = notificationCopy(undefined)
    expect(zh.approval).toBe('需要审批')
    expect(zh.cloudApproval).toBe('云端需要审批')
    expect(zh.cloudComplete).toBe('云端会话已完成')

    const en = notificationCopy('en')
    expect(en.cloudApproval).toBe('Cloud approval required')
    expect(en.complete).toBe('Session finished')
  })
})

describe('notificationSummary', () => {
  it('压成一行并截断到 120 字，避免锁屏上出现长命令', () => {
    expect(notificationSummary('  rm\n -rf  build ')).toBe('rm -rf build')
    const long = notificationSummary('a'.repeat(400))
    expect(long.endsWith('…')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(120)
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

describe('NotificationRouter 退出中静默', () => {
  it('退出中不投递任何类型，且日志写明原因', () => {
    const deliver = vi.fn()
    const info = vi.fn()
    let quitting = true
    const router = new NotificationRouter(
      deliver,
      () => undefined,
      () => false,
      { info, warn: vi.fn() },
      () => quitting
    )

    for (const kind of ['approval', 'complete', 'error'] as const) {
      expect(router.notify({ ...event, kind })).toBe(false)
    }
    expect(deliver).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(expect.stringContaining('app is quitting'))

    // 退出被取消（未保存确认里点「取消」）后必须恢复正常投递
    quitting = false
    expect(router.notify(event)).toBe(true)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('未注入退出探测时行为不变', () => {
    const deliver = vi.fn()
    const router = new NotificationRouter(deliver, () => undefined, () => false)
    expect(router.notify(event)).toBe(true)
  })
})
