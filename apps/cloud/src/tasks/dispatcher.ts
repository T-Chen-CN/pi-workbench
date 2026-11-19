/**
 * 派活与工单生命周期（F-19 ~ F-22 / F-30 / F-31 / A-41）。
 *
 * 这里持有全部「工单相关的业务状态」：状态迁移、FIFO、离线取消、超时收敛，
 * 以及向云端会话投事件。连接层（Hub）只管收发，不决定状态。
 *
 * 三条硬约束：
 * - 单设备并发 1，`queued` 按入队顺序派（F-21 / A-35）。
 * - 设备离线 → 在跑工单立即 `cancelled(device-offline)`，**不排队、不续跑**（A-41）。
 * - 工单进终态就清掉设备 outbox 里的待投递项，重连不会重放（F-44）。
 */

import {
  CLOUD_QUEUED_ACK_WINDOW_MS,
  CLOUD_WAITING_HUMAN_TIMEOUT_MS,
  isTerminalTaskStatus,
  type CloudChangedFile,
  type CloudDeviceSnapshot,
  type CloudEvent,
  type CloudTaskEventKind,
  type CloudTaskEventPayload,
  type CloudTaskSnapshot,
  type DeviceToServerFrame,
} from 'pi-bridge'
import type { CloudStore, DeviceRecord } from '../store/store.js'
import type { Hub } from '../ws/hub.js'
import type { CloudTaskSpec } from 'pi-bridge'
import { checkDispatch, consumeQuota, type AuthorizationRecord } from './authorization.js'
import {
  isAckExpired,
  isWaitingHumanExpired,
  tasksToCancelOnOffline,
  transition,
} from './state-machine.js'

export interface DispatcherLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

export interface DispatchRequest {
  authorizationId: string
  workUnitId: string
  deviceId: string
  workspacePath: string
  title: string
  background: string
  goal: string
  acceptance: string
  expectedChanges?: string
  forbidden?: string[]
  commit: boolean
  diffLimitBytes?: number
  idempotencyKey?: string
}

export type DispatchOutcome =
  | { ok: true; task: CloudTaskSnapshot }
  | { ok: false; code: string; message: string }

export class TaskDispatcher {
  constructor(
    private readonly deps: {
      store: CloudStore
      hub: Hub
      /** 把工单事件投进云端会话（事件唤醒）；由 agent 层实现 */
      wake: (payload: CloudTaskEventPayload) => Promise<void> | void
      logger: DispatcherLogger
      now?: () => number
    }
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // ------------------------------ 派活 ------------------------------

  async dispatch(request: DispatchRequest): Promise<DispatchOutcome> {
    const store = this.deps.store
    const now = this.now()

    const device = store.findDevice(request.deviceId)
    if (!device || device.revokedAt) {
      return { ok: false, code: 'unknown-device', message: 'Unknown or revoked device.' }
    }
    if (!this.deps.hub.isDeviceOnline(request.deviceId)) {
      // F-15：新工单只给在线设备；离线设备直接拒绝，不排队
      return { ok: false, code: 'device-offline', message: 'Device is offline.' }
    }
    const workspace = device.workspaces.find(
      (item) => normalize(item.path) === normalize(request.workspacePath)
    )
    if (!workspace) {
      return { ok: false, code: 'unknown-workspace', message: 'Workspace is not registered on that device.' }
    }
    if (!workspace.isGit) {
      // G10：非 git 目录没有 worktree，就没有隔离，不接受派活
      return { ok: false, code: 'not-a-repo', message: 'Workspace is not a git repository.' }
    }

    const authorization = store.findAuthorization(request.authorizationId)
    const sameUnit = Boolean(store.findUnit(request.workUnitId) && !store.findUnit(request.workUnitId)?.closedAt)
    const check = checkDispatch(
      authorization,
      { deviceId: request.deviceId, workspacePath: request.workspacePath, sameUnit },
      now
    )
    if (!check.ok) {
      return { ok: false, code: check.code, message: authorizationError(check.code) }
    }

    // 幂等：同一 idempotencyKey 只生成一张工单
    const key = request.idempotencyKey ?? `key-${request.workUnitId}-${now}`
    const existing = store.listTasks().find((task) => task.idempotencyKey === key)
    if (existing) return { ok: true, task: existing }

    const spec: CloudTaskSpec = {
      workUnitId: request.workUnitId,
      deviceId: request.deviceId,
      repo: {
        workspacePath: request.workspacePath,
        remote: workspace.remote,
        baseBranch: workspace.defaultBranch,
      },
      title: request.title,
      background: request.background,
      goal: request.goal,
      acceptance: request.acceptance,
      expectedChanges: request.expectedChanges,
      forbidden: request.forbidden,
      output: {
        summary: true,
        changeList: true,
        testResult: true,
        diffLimitBytes: request.diffLimitBytes,
      },
      commit: request.commit,
      authorizationId: request.authorizationId,
    }

    const task: CloudTaskSnapshot = {
      id: this.nextTaskId(),
      spec,
      status: 'queued',
      idempotencyKey: key,
      createdAt: now,
      updatedAt: now,
      progress: { step: 0, lastEventAt: now },
    }
    await store.saveTask(task)
    await this.consumeAuthorization(authorization!, sameUnit)

    // 工作单元台账：一个单元只对应一个 worktree，后续工单沿用
    const unit = store.findUnit(request.workUnitId)
    if (!unit) {
      await store.saveUnit({
        unitId: request.workUnitId,
        deviceId: request.deviceId,
        workspacePath: request.workspacePath,
        createdAt: now,
        closedAt: null,
      })
    }

    this.publishTask(task)
    await this.tryDispatch(task)
    const latest = store.findTask(task.id) ?? task
    return { ok: true, task: latest }
  }

  /** 设备空下来时派队首（FIFO）；同一设备同时只能有一张在跑 */
  async tryDispatch(task: CloudTaskSnapshot): Promise<void> {
    const store = this.deps.store
    const deviceId = task.spec.deviceId
    const running = store
      .listTasks()
      .filter(
        (item) =>
          item.spec.deviceId === deviceId &&
          ['assigned', 'running', 'waiting_human'].includes(item.status)
      )
    if (running.length > 0) {
      this.deps.logger.info(
        `[cloud] task ${task.id} queued behind ${running.map((item) => item.id).join(',')}`
      )
      return
    }
    if (!this.deps.hub.isDeviceOnline(deviceId)) return
    const delivered = this.deps.hub.sendToDevice(deviceId, {
      v: 1,
      type: 'task',
      seq: 0,
      task,
    }, task.id)
    if (!delivered) return
    // 投递成功不等于被接收：等终端 ack（`task_status: assigned`）才离开 queued
  }

  // ------------------------------ 设备回流 ------------------------------

  async handleDeviceFrame(deviceId: string, frame: DeviceToServerFrame): Promise<void> {
    switch (frame.type) {
      case 'heartbeat':
        await this.deps.store.updateDevice(deviceId, { lastSeenAt: frame.at })
        return
      case 'workspaces':
        await this.deps.store.updateDevice(deviceId, {
          workspaces: frame.workspaces,
          lastSeenAt: this.now(),
        })
        return
      case 'task_status':
        await this.onTaskStatus(deviceId, frame.taskId, frame.status, frame.at)
        return
      case 'task_worktree':
        await this.onTaskWorktree(frame)
        return
      case 'task_milestone': {
        const task = this.deps.store.findTask(frame.taskId)
        if (!task || isTerminalTaskStatus(task.status)) return
        const changes = frame.milestone.changedFiles
        const updated: CloudTaskSnapshot = {
          ...task,
          updatedAt: this.now(),
          progress: {
            ...task.progress,
            summary: frame.milestone.text,
            changedFiles: mergeChangedFiles(task.progress.changedFiles, changes),
            lastEventAt: this.now(),
          },
        }
        await this.deps.store.saveTask(updated)
        this.publishTask(updated)
        await this.wake(updated, 'milestone', frame.milestone.text)
        return
      }
      case 'task_question': {
        const task = this.deps.store.findTask(frame.taskId)
        if (!task) return
        const moved = transition(task, 'waiting_human', { now: this.now() })
        if (moved.changed) {
          await this.deps.store.saveTask(moved.task)
          this.publishTask(moved.task)
        }
        await this.wake(moved.task, 'question', frame.text)
        return
      }
      case 'task_result': {
        const task = this.deps.store.findTask(frame.taskId)
        if (!task) return
        const moved = transition(task, 'done', {
          now: this.now(),
          reason: 'completed',
          progress: {
            summary: frame.result.summary,
            branch: frame.result.branch,
            commit: frame.result.commit,
            changedFiles: frame.result.changedFiles,
          },
        })
        if (moved.changed) {
          await this.deps.store.saveTask(moved.task)
          this.finish(moved.task)
          await this.wake(moved.task, 'done', frame.result.summary)
        }
        return
      }
      case 'task_failed': {
        const task = this.deps.store.findTask(frame.taskId)
        if (!task) return
        const moved = transition(task, 'failed', {
          now: this.now(),
          reason: 'failed',
          error: frame.error,
          progress: { changedFiles: mergeChangedFiles(task.progress.changedFiles, frame.changedFiles) },
        })
        if (moved.changed) {
          await this.deps.store.saveTask(moved.task)
          this.finish(moved.task)
          await this.wake(moved.task, 'failed', frame.error)
        }
        return
      }
      case 'task_interrupted': {
        const task = this.deps.store.findTask(frame.taskId)
        if (!task) return
        // 服务端已先落终态时，后到的 interrupted 只是附注（F-21 终态优先级）
        const moved = transition(task, 'interrupted', {
          now: this.now(),
          reason: 'app-quit',
          error: frame.reason,
        })
        if (moved.changed) {
          await this.deps.store.saveTask(moved.task)
          this.finish(moved.task)
          await this.wake(moved.task, 'interrupted', frame.reason)
        } else if (moved.ignored) {
          this.deps.logger.info(
            `[cloud] task ${task.id} already terminal (${task.status}); interrupted is an annotation only`
          )
        }
        return
      }
      default:
        return
    }
  }

  private async onTaskStatus(
    deviceId: string,
    taskId: string,
    status: CloudTaskSnapshot['status'],
    at: number
  ): Promise<void> {
    const task = this.deps.store.findTask(taskId)
    if (!task || task.spec.deviceId !== deviceId) return
    const moved = transition(task, status, { now: at || this.now() })
    if (!moved.changed) return
    await this.deps.store.saveTask(moved.task)
    this.publishTask(moved.task)
    if (moved.task.status === 'assigned') {
      await this.wake(moved.task, 'accepted', `终端已接单：${moved.task.spec.title}`)
    }
  }

  private async onTaskWorktree(frame: {
    taskId: string
    unitId: string
    path: string
    branch?: string
  }): Promise<void> {
    const unit = this.deps.store.findUnit(frame.unitId)
    if (!unit) return
    await this.deps.store.saveUnit({
      ...unit,
      worktreePath: frame.path,
      branch: frame.branch ?? unit.branch,
    })
  }

  // ------------------------------ 取消与离线 ------------------------------

  async cancelTask(
    taskId: string,
    reason: 'user-cancel' | 'device-offline'
  ): Promise<boolean> {
    const task = this.deps.store.findTask(taskId)
    if (!task || isTerminalTaskStatus(task.status)) return false
    const moved = transition(task, 'cancelled', { now: this.now(), reason })
    if (!moved.changed) return false
    await this.deps.store.saveTask(moved.task)
    this.finish(moved.task)

    // 在线才下发 cancel；离线时终端本来就不再执行（F-30）
    if (this.deps.hub.isDeviceOnline(task.spec.deviceId)) {
      this.deps.hub.sendToDevice(
        task.spec.deviceId,
        { v: 1, type: 'task_cancel', seq: 0, taskId, reason },
        taskId
      )
    }
    this.deps.hub.dropDeviceTask(task.spec.deviceId, taskId)
    await this.wake(
      moved.task,
      reason === 'device-offline' ? 'device-offline' : 'cancelled',
      reason === 'device-offline'
        ? '设备离线，工单已取消（改动保留在工作树里）'
        : '用户停止了工单（改动保留在工作树里）'
    )
    await this.dispatchNextFor(task.spec.deviceId)
    return true
  }

  async onDeviceOffline(deviceId: string): Promise<void> {
    const pending = tasksToCancelOnOffline(this.deps.store.listTasks(), deviceId)
    for (const task of pending) {
      await this.cancelTask(task.id, 'device-offline')
    }
  }

  async onDeviceOnline(deviceId: string): Promise<void> {
    await this.deps.store.updateDevice(deviceId, { lastSeenAt: this.now() })
    await this.dispatchNextFor(deviceId)
  }

  /** 超时收敛：`queued` 未 ack → expired；`waiting_human` 超 2 h → failed（F-21 / F-25） */
  async sweepTimeouts(): Promise<void> {
    const now = this.now()
    for (const task of this.deps.store.listTasks()) {
      if (isAckExpired(task, now, CLOUD_QUEUED_ACK_WINDOW_MS)) {
        const moved = transition(task, 'expired', { now, reason: 'ack-timeout' })
        if (!moved.changed) continue
        await this.deps.store.saveTask(moved.task)
        this.finish(moved.task)
        await this.wake(moved.task, 'expired', '工单超时未被终端接收（ack 窗口 60 s）')
        continue
      }
      if (isWaitingHumanExpired(task, now, CLOUD_WAITING_HUMAN_TIMEOUT_MS)) {
        const moved = transition(task, 'failed', {
          now,
          reason: 'waiting-human-timeout',
          error: '等待用户决定超时',
        })
        if (!moved.changed) continue
        await this.deps.store.saveTask(moved.task)
        this.finish(moved.task)
        await this.wake(moved.task, 'failed', '等待用户决定超时，工单已失败')
      }
    }
  }

  // ------------------------------ 快照 ------------------------------

  deviceSnapshots(): CloudDeviceSnapshot[] {
    return this.deps.store.listDevices().map((device) => this.deviceSnapshot(device))
  }

  deviceSnapshot(device: DeviceRecord): CloudDeviceSnapshot {
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      online: this.deps.hub.isDeviceOnline(device.id),
      lastSeenAt: device.lastSeenAt,
      workspaces: device.workspaces,
      runningTaskIds: this.deps.store
        .listTasks()
        .filter(
          (task) =>
            task.spec.deviceId === device.id &&
            ['assigned', 'running', 'waiting_human'].includes(task.status)
        )
        .map((task) => task.id),
    }
  }

  // ------------------------------ 内部 ------------------------------

  private async consumeAuthorization(
    authorization: AuthorizationRecord,
    sameUnit: boolean
  ): Promise<void> {
    await this.deps.store.saveAuthorization(consumeQuota(authorization, sameUnit))
  }

  private finish(task: CloudTaskSnapshot): void {
    this.deps.hub.dropDeviceTask(task.spec.deviceId, task.id)
    this.publishTask(task)
  }

  private publishTask(task: CloudTaskSnapshot): void {
    const event: CloudEvent = { type: 'task', task }
    this.deps.hub.publish(event)
  }

  private async wake(
    task: CloudTaskSnapshot,
    kind: CloudTaskEventKind,
    summary: string
  ): Promise<void> {
    const payload: CloudTaskEventPayload = {
      eventId: `evt-${task.id}-${kind}-${this.now()}`,
      kind,
      taskId: task.id,
      deviceId: task.spec.deviceId,
      at: this.now(),
      summary,
      status: task.status,
      terminalReason: task.terminalReason,
    }
    // 事件载荷同时进 details：形状由 buildTaskEventMessage 定义，投递在 wake 实现里完成
    await this.deps.wake(payload)
  }

  private async dispatchNextFor(deviceId: string): Promise<void> {
    const next = this.deps.store.queuedTasksFor(deviceId)[0]
    if (!next) return
    await this.tryDispatch(next)
  }

  private nextTaskId(): string {
    const count = this.deps.store.listTasks().length + 1
    return `T-${String(count).padStart(3, '0')}`
  }
}

function mergeChangedFiles(
  current: CloudChangedFile[] | undefined,
  incoming: CloudChangedFile[] | undefined
): CloudChangedFile[] | undefined {
  if (!incoming?.length) return current
  const map = new Map<string, CloudChangedFile>()
  for (const file of current ?? []) map.set(file.path, file)
  for (const file of incoming) map.set(file.path, file)
  return [...map.values()]
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function authorizationError(code: string): string {
  switch (code) {
    case 'unknown-authorization':
      return 'No confirmed plan authorizes this dispatch.'
    case 'expired':
      return 'The confirmed plan has expired; ask the user to confirm again.'
    case 'revoked':
      return 'The confirmed plan was revoked.'
    case 'out-of-scope':
      return 'Dispatch is outside the confirmed plan (device or repository changed). Ask the user first.'
    case 'quota':
      return 'Task quota for this plan is used up; ask the user before dispatching more.'
    default:
      return 'Dispatch is not authorized.'
  }
}
