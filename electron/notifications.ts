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

export interface NotificationCopy {
  approval: string
  complete: string
  error: string
  /** 云端：命令要人点一下 */
  cloudApproval: string
  /** 云端：clarify 在等人回答（同样是“这轮卡住了”） */
  cloudClarify: string
  cloudComplete: string
  cloudError: string
}

/**
 * 通知文案的唯一来源。主进程里本地 Agent 与云端 Agent 都用它，
 * 否则同一个应用会出现两套措辞（本地“会话已完成”/ 云端“任务结束”）。
 */
export function notificationCopy(language: string | undefined): NotificationCopy {
  const zh = (language ?? 'zh') !== 'en'
  return zh
    ? {
        approval: '需要审批',
        complete: '会话已完成',
        error: '会话运行失败',
        cloudApproval: '云端需要审批',
        cloudClarify: '云端在等你回答',
        cloudComplete: '云端会话已完成',
        cloudError: '云端会话运行失败'
      }
    : {
        approval: 'Approval required',
        complete: 'Session finished',
        error: 'Session failed',
        cloudApproval: 'Cloud approval required',
        cloudClarify: 'Cloud agent has a question',
        cloudComplete: 'Cloud session finished',
        cloudError: 'Cloud session failed'
      }
}

/**
 * 通知里只放一行短摘要：完整命令可能带密钥，锁屏上不该出现全文。
 * 本地与云端共用，保证两边的截断长度一致。
 */
export function notificationSummary(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > 120 ? `${single.slice(0, 117)}…` : single
}

export interface SessionNotification {
  kind: NotificationKind
  /** 本地工作区会话的目录；云端会话没有工作区，传 null */
  workspaceDir: string | null
  sessionId: string
  title: string
  body: string
  /** 云端会话：点击后切到云端页，不去找同名工作区 */
  cloud?: boolean
  /** 云端审批 / 澄清卡：点击后定位到那张卡 */
  requestId?: string
}

export class NotificationRouter {
  constructor(
    private readonly deliver: (payload: {
      title: string
      body: string
      workspaceDir: string | null
      sessionId: string
      cloud?: boolean
      requestId?: string
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
        cloud: event.cloud,
        requestId: event.requestId
      })
      this.log?.info(`[Notifications] delivered "${event.kind}"`)
      return true
    } catch (error) {
      this.log?.warn(`[Notifications] failed to show "${event.kind}": ${String(error)}`)
      return false
    }
  }
}
