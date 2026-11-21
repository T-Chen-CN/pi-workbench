/**
 * 工单状态机（F-20 / F-21，纯函数）。
 *
 * 两条容易写错的规则：
 * - **服务端先落终态者胜**：已经是终态时，后到的终态（例如 `interrupted` 撞上
 *   `cancelled(device-offline)`）只能作附注，不能覆盖、不能触发二次汇报。
 * - `queued` 只覆盖「服务端已生成工单、终端尚未 ack」的短暂窗口；超时变 `expired`。
 */

import type { CloudTaskSnapshot, CloudTaskStatus, CloudTaskTerminalReason } from 'pi-bridge'
import { isTerminalTaskStatus } from 'pi-bridge'

const TRANSITIONS: Record<CloudTaskStatus, readonly CloudTaskStatus[]> = {
  // `queued → failed/interrupted`：终端在“备好工作树、建会话”这一步就可能失败（没配 API Key 最常见）。
  // 它此时还没发过 `assigned`，但已经真的收到并处理过了——不允许就会永远挂在 queued，
  // 用户看到“执行中”且 FIFO 堵死（后续工单不会补投）。
  queued: ['assigned', 'rejected', 'expired', 'cancelled', 'failed', 'interrupted'],
  assigned: ['running', 'rejected', 'cancelled', 'interrupted', 'failed'],
  running: ['waiting_human', 'done', 'failed', 'cancelled', 'interrupted'],
  waiting_human: ['running', 'failed', 'cancelled', 'interrupted'],
  done: [],
  failed: [],
  cancelled: [],
  expired: [],
  rejected: [],
  interrupted: [],
}

export interface TransitionResult {
  task: CloudTaskSnapshot
  changed: boolean
  /** 被忽略的后到终态（F-21 附注语义） */
  ignored?: { status: CloudTaskStatus; reason?: CloudTaskTerminalReason }
}

export function canTransition(from: CloudTaskStatus, to: CloudTaskStatus): boolean {
  if (from === to) return false
  return TRANSITIONS[from].includes(to)
}

export function transition(
  task: CloudTaskSnapshot,
  to: CloudTaskStatus,
  patch: {
    now: number
    reason?: CloudTaskTerminalReason
    error?: string
    progress?: Partial<CloudTaskSnapshot['progress']>
  }
): TransitionResult {
  // 已经终态：后到的任何状态都只是附注，不改状态、不覆盖终态原因
  if (isTerminalTaskStatus(task.status)) {
    if (to === task.status) return { task, changed: false }
    return { task, changed: false, ignored: { status: to, reason: patch.reason } }
  }
  if (!canTransition(task.status, to)) return { task, changed: false }

  const next: CloudTaskSnapshot = {
    ...task,
    status: to,
    updatedAt: patch.now,
    progress: { ...task.progress, ...patch.progress, lastEventAt: patch.now },
  }
  if (to === 'running' && !next.startedAt) next.startedAt = patch.now
  if (isTerminalTaskStatus(to)) {
    next.finishedAt = patch.now
    if (patch.reason) next.terminalReason = patch.reason
  }
  if (patch.error) next.error = patch.error
  return { task: next, changed: true }
}

/**
 * 设备离线时应该被终止的工单（F-21 / A-41）。
 * 只有 `queued` 与执行中的需要终止；`waiting_human` 同样终止——终端已经停手等答复，
 * 没人能回答它，留着只会变成僵尸。
 */
export function tasksToCancelOnOffline(tasks: CloudTaskSnapshot[], deviceId: string): CloudTaskSnapshot[] {
  return tasks.filter(
    (task) =>
      task.spec.deviceId === deviceId &&
      ['queued', 'assigned', 'running', 'waiting_human'].includes(task.status)
  )
}

/** `queued` 超时未 ack（F-21：窗口 60 s） */
export function isAckExpired(task: CloudTaskSnapshot, now: number, windowMs: number): boolean {
  return task.status === 'queued' && now - task.createdAt > windowMs
}

/** `waiting_human` 超时（F-25：2 小时 → failed） */
export function isWaitingHumanExpired(
  task: CloudTaskSnapshot,
  now: number,
  timeoutMs: number
): boolean {
  return task.status === 'waiting_human' && now - task.updatedAt > timeoutMs
}
