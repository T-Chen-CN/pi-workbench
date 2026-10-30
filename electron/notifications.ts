/**
 * 桌面通知路由（AF-06）
 *
 * 只在应用不在前台时通知；每个事件类型单独开关，缺省全部开启。
 * 退出过程一律不通知：退出时我们会主动 `abort()` 在跑的会话，那会走 ``error`` 分支 ——
 * 用户刚点了退出却收到一条「错误」系统通知属于自伤型误报，而且窗口已拆、点开无处可去。
 */

export type NotificationKind = 'approval' | 'complete' | 'error'

export interface NotificationPrefs {
  enabled: boolean
  approval: boolean
  complete: boolean
  error: boolean
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  approval: true,
  complete: true,
  error: true,
}

export function normalizeNotificationPrefs(input: unknown): NotificationPrefs {
  const source = (input ?? {}) as Record<string, unknown>
  const result = { ...DEFAULT_NOTIFICATION_PREFS }
  for (const key of ['enabled', 'approval', 'complete', 'error'] as const) {
    if (typeof source[key] === 'boolean') result[key] = source[key] as boolean
  }
  return result
}

export interface SessionNotification {
  kind: NotificationKind
  workspaceDir: string
  sessionId: string
  title: string
  body: string
}

export class NotificationRouter {
  constructor(
    private readonly deliver: (payload: {
      title: string
      body: string
      workspaceDir: string
      sessionId: string
    }) => void,
    private readonly getPrefs: () => unknown,
    private readonly isAppFocused: () => boolean,
    private readonly log?: {
      info: (message: string) => void
      warn: (message: string) => void
    },
    /** 退出中探测：关闭流程一启动就不再投递任何系统通知 */
    private readonly isQuitting?: () => boolean
  ) {}

  /** 前台不打扰；退出中不打扰；按事件类型开关过滤。返回是否真的发出了通知 */
  notify(event: SessionNotification): boolean {
    // 先判退出：退出时我们会 abort 在跑的会话，不拦就会把自伤 abort 弹成「错误」通知
    if (this.isQuitting?.()) {
      this.log?.info(`[Notifications] skipped "${event.kind}": app is quitting`)
      return false
    }
    if (this.isAppFocused()) {
      this.log?.info(`[Notifications] skipped "${event.kind}": app is focused`)
      return false
    }
    const prefs = normalizeNotificationPrefs(this.getPrefs())
    if (!prefs.enabled) {
      this.log?.info(`[Notifications] skipped "${event.kind}": notifications disabled`)
      return false
    }
    if (!prefs[event.kind]) {
      this.log?.info(`[Notifications] skipped "${event.kind}": event type disabled`)
      return false
    }
    try {
      this.deliver({
        title: event.title,
        body: event.body,
        workspaceDir: event.workspaceDir,
        sessionId: event.sessionId,
      })
      this.log?.info(`[Notifications] delivered "${event.kind}"`)
      return true
    } catch (error) {
      this.log?.warn(`[Notifications] failed to show "${event.kind}": ${String(error)}`)
      return false
    }
  }
}
