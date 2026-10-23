/**
 * 工具审批代理（AF-01）
 *
 * 主进程持有待审批请求：Agent 的 tool_call 钩子挂起后，broker 把请求发给渲染层，
 * 等待用户选择或超时。超时与通道缺失都按拒绝处理（fail-closed）。
 */

export type ToolCategory = 'read' | 'write' | 'command' | 'other'

export interface ApprovalRequestPayload {
  requestId: string
  workspaceDir: string
  sessionId: string
  toolCallId: string
  toolName: string
  category: ToolCategory
  summary: string
  details: {
    path?: string
    command?: string
    preview?: string
    editCount?: number
  }
  createdAt: number
  expiresAt: number
}

export type ApprovalDecision =
  | { action: 'allow-once' }
  | { action: 'allow-always' }
  | { action: 'deny'; reason?: string }

const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_REASON_LENGTH = 500

interface PendingApproval {
  request: ApprovalRequestPayload
  resolve: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

/** 校验来自渲染层的决策，非法值返回 null */
export function sanitizeApprovalDecision(input: unknown): ApprovalDecision | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Record<string, unknown>
  switch (value.action) {
    case 'allow-once':
    case 'allow-always':
      return { action: value.action }
    case 'deny': {
      const reason =
        typeof value.reason === 'string' ? value.reason.slice(0, MAX_REASON_LENGTH) : undefined
      return { action: 'deny', reason }
    }
    default:
      return null
  }
}

export interface ApprovalResolution {
  requestId: string
  workspaceDir: string
  sessionId: string
  decision: ApprovalDecision
}

export class ApprovalBroker {
  private pending = new Map<string, PendingApproval>()

  constructor(
    private readonly send: (payload: ApprovalRequestPayload) => void,
    /** 请求在用户操作之外结束时（超时 / 取消 / 中止）通知渲染层移除卡片 */
    private readonly onResolved?: (resolution: ApprovalResolution) => void
  ) {}

  private finish(requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(decision)
    try {
      this.onResolved?.({
        requestId,
        workspaceDir: pending.request.workspaceDir,
        sessionId: pending.request.sessionId,
        decision,
      })
    } catch (error) {
      console.warn('[Approval] Failed to notify resolution:', error)
    }
    return true
  }

  /** 发起审批；返回的 Promise 只会以 allow-* 或 deny 收尾 */
  request(request: ApprovalRequestPayload): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(MIN_TIMEOUT_MS, request.expiresAt - Date.now())
      )
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId)
        resolve({ action: 'deny', reason: 'The approval request timed out.' })
        try {
          this.onResolved?.({
            requestId: request.requestId,
            workspaceDir: request.workspaceDir,
            sessionId: request.sessionId,
            decision: { action: 'deny', reason: 'The approval request timed out.' },
          })
        } catch (error) {
          console.warn('[Approval] Failed to notify timeout:', error)
        }
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(request.requestId, { request, resolve, timer })
      try {
        this.send(request)
      } catch (error) {
        // 发送失败按拒绝处理，避免请求永远悬挂
        this.pending.delete(request.requestId)
        clearTimeout(timer)
        console.warn('[Approval] Failed to deliver approval request:', error)
        resolve({ action: 'deny', reason: 'The approval request could not be delivered.' })
      }
    })
  }

  /** 用户响应；找不到请求（已超时或已取消）返回 false */
  respond(requestId: string, decision: ApprovalDecision): boolean {
    return this.finish(requestId, decision)
  }

  /** 工作区关闭 / Agent 释放时，取消该工作区所有待审批请求 */
  cancelForWorkspace(workspaceDir: string, reason = 'The workspace was closed.'): void {
    this.cancelWhere((request) => request.workspaceDir === workspaceDir, reason)
  }

  /** 会话关闭时取消该会话的待审批请求 */
  cancelForSession(sessionId: string, reason = 'The session was closed.'): void {
    this.cancelWhere((request) => request.sessionId === sessionId, reason)
  }

  private cancelWhere(predicate: (request: ApprovalRequestPayload) => boolean, reason: string): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.pending.get(requestId)
      if (!pending || !predicate(pending.request)) continue
      this.finish(requestId, { action: 'deny', reason })
    }
  }

  dispose(reason = 'The application is shutting down.'): void {
    for (const requestId of [...this.pending.keys()]) {
      this.finish(requestId, { action: 'deny', reason })
    }
  }

  get pendingCount(): number {
    return this.pending.size
  }
}
