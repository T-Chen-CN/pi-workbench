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
  type CloudUnitView,
  type DeviceToServerFrame,
} from 'pi-bridge'
import type { CloudStore, DeviceRecord, UnitRecord } from '../store/store.js'
import type { Hub } from '../ws/hub.js'
import type { CloudTaskSpec } from 'pi-bridge'
import { checkDispatch, consumeQuota } from './authorization.js'
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

/** 工作单元的对外视图（F-19a） */
export function toUnitView(unit: UnitRecord): CloudUnitView {
  return {
    unitId: unit.unitId,
    deviceId: unit.deviceId,
    workspacePath: unit.workspacePath,
    worktreePath: unit.worktreePath,
    branch: unit.branch,
    createdAt: unit.createdAt,
    closedAt: unit.closedAt,
    closeRequestedAt: unit.closeRequestedAt,
    dirtyAt: unit.dirtyAt,
  }
}

export class TaskDispatcher {
  /** 单设备在途已下发但尚未收到 assigned 的工单（防并发 tryDispatch 同时下发多条 queued） */
  private inFlightDispatches = new Map<string, string>()

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

    // 已结束 / 正在回收的单元不再接新工单：工作树马上要消失，派下去只会重建一棵新的
    const existingUnit = store.findUnit(request.workUnitId)
    if (existingUnit && (existingUnit.closedAt !== null || existingUnit.closeRequestedAt)) {
      return {
        ok: false,
        code: 'unit-closed',
        message: 'This work unit is closed or being reclaimed; open a new unit for follow-up work.',
      }
    }
    // 复用工作单元必须匹配同一设备与同一仓库，防跨目标借 sameUnit 绕过授权配额
    if (
      existingUnit &&
      (existingUnit.deviceId !== request.deviceId ||
        normalize(existingUnit.workspacePath) !== normalize(request.workspacePath))
    ) {
      return {
        ok: false,
        code: 'unit-target-mismatch',
        message: 'Work unit belongs to a different device or repository.',
      }
    }
    const sameUnit = Boolean(existingUnit && !existingUnit.closedAt)

    // 幂等：同一 idempotencyKey 只生成一张工单（先于配额扣减检查，避免重复扣减）
    const key = request.idempotencyKey ?? `key-${request.workUnitId}-${now}`
    const existing = store.listTasks().find((task) => task.idempotencyKey === key)
    if (existing) return { ok: true, task: existing }

    // 原子校验并扣减授权配额，防止并发 dispatch TOCTOU 超额派活
    let checkCode: string | null = null
    const consumed = await store.updateAuthorization(request.authorizationId, (current) => {
      const check = checkDispatch(
        current,
        { deviceId: request.deviceId, workspacePath: request.workspacePath, sameUnit },
        now
      )
      if (!check.ok) {
        checkCode = check.code
        return undefined
      }
      return consumeQuota(current!, sameUnit)
    })
    if (!consumed) {
      return {
        ok: false,
        code: checkCode ?? 'unknown-authorization',
        message: authorizationError(checkCode ?? 'unknown-authorization'),
      }
    }

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
      dispatchedAt: null,
      updatedAt: now,
      progress: { step: 0, lastEventAt: now },
    }
    await store.saveTask(task)

    // 工作单元台账：一个单元只对应一个 worktree，后续工单沿用
    if (!existingUnit) {
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

  /** 设备空下来时派队首（FIFO）；同一设备同时只能有一张在跑或在途待 ACK */
  async tryDispatch(task: CloudTaskSnapshot): Promise<void> {
    const store = this.deps.store
    const deviceId = task.spec.deviceId
    const inFlight = this.inFlightDispatches.get(deviceId)
    if (inFlight && inFlight !== task.id) {
      this.deps.logger.info(`[cloud] task ${task.id} queued behind in-flight ${inFlight}`)
      return
    }
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
    // 同步占位，防止并发 dispatch 在 await saveTask 期间同时发第二张工单
    this.inFlightDispatches.set(deviceId, task.id)
    const dispatched: CloudTaskSnapshot = { ...task, dispatchedAt: this.now() }
    const delivered = this.deps.hub.sendToDevice(
      deviceId,
      {
        v: 1,
        type: 'task',
        seq: 0,
        task: dispatched,
      },
      task.id
    )
    if (!delivered) {
      if (this.inFlightDispatches.get(deviceId) === task.id) {
        this.inFlightDispatches.delete(deviceId)
      }
      return
    }
    await store.saveTask(dispatched)
    // 投递成功不等于被接收：等终端 ack（`task_status: assigned`）才离开 queued
  }

  // ------------------------------ 设备回流 ------------------------------

  private clearInFlight(deviceId: string, taskId: string): void {
    if (this.inFlightDispatches.get(deviceId) === taskId) {
      this.inFlightDispatches.delete(deviceId)
    }
  }

  /** 向处于 waiting_human 的工单下发回答并恢复为 running */
  async answerTask(taskId: string, text: string, questionId?: string): Promise<boolean> {
    const task = this.deps.store.findTask(taskId)
    if (!task || task.status !== 'waiting_human') return false
    if (!this.deps.hub.isDeviceOnline(task.spec.deviceId)) return false
    const now = this.now()
    const moved = transition(task, 'running', { now })
    if (!moved.changed) return false
    const updated: CloudTaskSnapshot = { ...moved.task, question: undefined }
    await this.deps.store.saveTask(updated)
    this.publishTask(updated)
    this.deps.hub.sendToDevice(
      task.spec.deviceId,
      {
        v: 1,
        type: 'task_answer',
        taskId: task.id,
        questionId: questionId ?? task.question?.id ?? `q-${now}`,
        text,
        at: now,
      },
      task.id
    )
    return true
  }

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
        await this.onTaskWorktree(deviceId, frame)
        return
      case 'task_milestone': {
        if (!frame.milestone || typeof frame.milestone.text !== 'string') return
        const task = this.deps.store.findTask(frame.taskId)
        if (!task || task.spec.deviceId !== deviceId || isTerminalTaskStatus(task.status)) return
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
        if (typeof frame.text !== 'string') return
        const task = this.deps.store.findTask(frame.taskId)
        if (!task || task.spec.deviceId !== deviceId) return
        const now = this.now()
        const moved = transition(task, 'waiting_human', { now })
        if (moved.changed) {
          const withQuestion: CloudTaskSnapshot = {
            ...moved.task,
            question: {
              id: typeof frame.questionId === 'string' && frame.questionId ? frame.questionId : `q-${now}`,
              text: frame.text,
              at: typeof frame.at === 'number' ? frame.at : now,
            },
          }
          await this.deps.store.saveTask(withQuestion)
          this.publishTask(withQuestion)
          await this.wake(withQuestion, 'question', frame.text)
          return
        }
        await this.wake(moved.task, 'question', frame.text)
        return
      }
      case 'task_result': {
        if (!frame.result || typeof frame.result.summary !== 'string') return
        const task = this.deps.store.findTask(frame.taskId)
        if (!task || task.spec.deviceId !== deviceId) return
        this.clearInFlight(deviceId, task.id)
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
          // FIFO：同一设备的下一张工单在终态后接力（A-35）；顺序不能反：
          // 先补投下一张，`reclaimIfClean` 才看得出该单元还有后续工单（A-46）
          await this.dispatchNextFor(moved.task.spec.deviceId)
          await this.reclaimIfClean(moved.task, frame.result.worktreeClean, 'converged')
        }
        return
      }
      case 'task_failed': {
        if (typeof frame.error !== 'string') return
        const task = this.deps.store.findTask(frame.taskId)
        if (!task || task.spec.deviceId !== deviceId) return
        this.clearInFlight(deviceId, task.id)
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
          await this.dispatchNextFor(moved.task.spec.deviceId)
          await this.reclaimIfClean(moved.task, frame.worktreeClean, 'converged')
        }
        return
      }
      case 'task_interrupted': {
        if (typeof frame.reason !== 'string') return
        const task = this.deps.store.findTask(frame.taskId)
        if (!task || task.spec.deviceId !== deviceId) return
        this.clearInFlight(deviceId, task.id)
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
          await this.dispatchNextFor(moved.task.spec.deviceId)
          await this.reclaimIfClean(moved.task, frame.worktreeClean, 'converged')
        } else if (moved.ignored) {
          this.deps.logger.info(
            `[cloud] task ${task.id} already terminal (${task.status}); interrupted is an annotation only`
          )
        }
        return
      }
      case 'unit_closed': {
        await this.onUnitClosed(deviceId, frame)
        return
      }
      case 'unit_state': {
        await this.onUnitState(deviceId, frame)
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
    if (status !== 'queued') this.clearInFlight(deviceId, taskId)
    const moved = transition(task, status, { now: at || this.now() })
    if (!moved.changed) return
    await this.deps.store.saveTask(moved.task)
    this.publishTask(moved.task)
    if (moved.task.status === 'assigned') {
      await this.wake(moved.task, 'accepted', `终端已接单：${moved.task.spec.title}`)
    }
  }

  private async onTaskWorktree(
    deviceId: string,
    frame: {
      taskId: string
      unitId: string
      path: string
      branch?: string
    }
  ): Promise<void> {
    const existing = this.deps.store.findUnit(frame.unitId)
    if (!existing || existing.deviceId !== deviceId) return
    const updated = await this.deps.store.patchUnit(frame.unitId, (unit) => ({
      ...unit,
      worktreePath: frame.path,
      branch: frame.branch ?? unit.branch,
    }))
    if (updated) this.publishUnit(updated)
  }

  // ------------------------------ 工作树回收（F-19a / A-43 / A-46） ------------------------------

  /**
   * 快照里的工作单元：未结束的全给，已结束的只给最近 20 条。
   * 每派一个单元就多一条记录，不封顶的话快照会随时日无上限变大（F-19a / F-44）。
   */
  unitViews(): CloudUnitView[] {
    const all = this.deps.store.listUnits().map(toUnitView)
    const open = all.filter((unit) => unit.closedAt === null)
    const closed = all
      .filter((unit): unit is CloudUnitView & { closedAt: number } => unit.closedAt !== null)
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, 20)
    return [...open, ...closed]
  }

  /**
   * 人工入口：结束一个工作单元（F-19a 要求保留人工入口）。
   * 单元里还有非终态工单时直接拒绍，不去 auto-abort：先停工单再结束单元，
   * 否则 aborted 的那一下还没落盘的文件会被当成脏树留下。
   */
  async requestUnitClose(
    unitId: string,
    reason: 'converged' | 'user-close' | 'sweep' = 'user-close'
  ): Promise<{ ok: boolean; code?: string }> {
    const unit = this.deps.store.findUnit(unitId)
    if (!unit) return { ok: false, code: 'unknown-unit' }
    if (unit.closedAt !== null) return { ok: false, code: 'already-closed' }
    if (this.hasOpenTaskInUnit(unitId)) return { ok: false, code: 'task-running' }
    const updated: UnitRecord = { ...unit, closeRequestedAt: this.now() }
    await this.deps.store.saveUnit(updated)
    this.publishUnit(updated)
    // 设备离线时帧进有界队列，重连补发（F-44）：不需要另写一套排队
    this.deps.hub.sendToDevice(unit.deviceId, {
      v: 1,
      type: 'close_unit',
      seq: 0,
      unitId,
      reason,
    })
    return { ok: true }
  }

  /**
   * A-43：**干净就自动回收**。
   *
   * 判定放在云端是因为只有它知道该单元还有没有后续工单：干净但还有后续就不动，
   * 否则下一张工单会从 base 重开一棵树、丢掉上一张的 commit（A-46）。
   */
  private async reclaimIfClean(
    task: CloudTaskSnapshot,
    worktreeClean: boolean | undefined,
    reason: 'converged' | 'sweep'
  ): Promise<void> {
    if (worktreeClean !== true) return
    const unit = this.deps.store.findUnit(task.spec.workUnitId)
    if (!unit || unit.closedAt !== null || unit.closeRequestedAt) return
    if (this.hasOpenTaskInUnit(task.spec.workUnitId)) return
    await this.requestUnitClose(unit.unitId, reason)
  }

  private hasOpenTaskInUnit(unitId: string): boolean {
    return this.deps.store
      .listTasks()
      .some((task) => task.spec.workUnitId === unitId && !isTerminalTaskStatus(task.status))
  }

  /** 设备回执：只有这里才写 `closedAt`，避免“云端说回收了、磁盘还在” */
  private async onUnitClosed(
    deviceId: string,
    frame: {
      unitId: string
      removed: boolean
      dirty: boolean
      worktreePath?: string
      branch?: string
      error?: string
    }
  ): Promise<void> {
    const unit = this.deps.store.findUnit(frame.unitId)
    if (!unit || unit.deviceId !== deviceId) return
    await this.deps.store.settleUnitClose(frame.unitId, {
      removed: frame.removed,
      dirty: frame.dirty,
      worktreePath: frame.worktreePath,
      branch: frame.branch,
      error: frame.error,
    })
    const updated = this.deps.store.findUnit(frame.unitId)
    if (updated) this.publishUnit(updated)
    const where = frame.worktreePath ?? unit.worktreePath ?? unit.workspacePath
    if (frame.error) {
      // 删树失败：单元保持未结束，用户可以重试（下一张工单也能接着用这棵树）
      this.deps.hub.publish({
        type: 'notice',
        level: 'error',
        text: `回收工作树失败：${where}（${frame.error}）；单元仍是未结束状态，可重试`,
        at: this.now(),
        key: `unit-close-failed-${frame.unitId}-${this.now()}`,
      })
      return
    }
    this.deps.hub.publish({
      type: 'notice',
      level: frame.dirty ? 'warn' : 'info',
      text: frame.dirty
        ? `工作树有未提交改动，已保留：${where}（清理后可再次结束这个工作单元）`
        : `工作树已回收${frame.branch ? `，分支 ${frame.branch} 保留` : ''}`,
      at: this.now(),
      key: `unit-closed-${frame.unitId}-${this.now()}`,
    })
  }

  /** 兜底：设备启动/重连上报工作树状态，帮云端对齐“已收敛但树还留着”的单元 */
  private async onUnitState(
    deviceId: string,
    frame: {
      unitId: string
      clean: boolean
      worktreePath?: string
    }
  ): Promise<void> {
    const unit = this.deps.store.findUnit(frame.unitId)
    if (!unit || unit.deviceId !== deviceId) return
    if (frame.worktreePath && unit.worktreePath !== frame.worktreePath) {
      const updated = await this.deps.store.patchUnit(frame.unitId, (current) => ({
        ...current,
        worktreePath: frame.worktreePath,
      }))
      if (updated) this.publishUnit(updated)
    }
    if (!frame.clean) return
    const latest = this.deps.store.findUnit(frame.unitId) ?? unit
    if (latest.closedAt !== null) return
    if (this.hasOpenTaskInUnit(frame.unitId)) return
    // 已经请求过但设备一直没回执（旧终端不认 `close_unit`、或进程被杀）：
    // 超过 60 s 就重发一次，否则会永远卡在“回收中”
    if (latest.closeRequestedAt !== undefined && this.now() - latest.closeRequestedAt < 60_000) return
    await this.requestUnitClose(frame.unitId, 'sweep')
  }

  private publishUnit(unit: UnitRecord): void {
    this.deps.hub.publish({ type: 'unit', unit: toUnitView(unit) })
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
    this.clearInFlight(task.spec.deviceId, taskId)
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
    this.inFlightDispatches.delete(deviceId)
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
        this.clearInFlight(task.spec.deviceId, task.id)
        await this.deps.store.saveTask(moved.task)
        this.finish(moved.task)
        await this.wake(moved.task, 'expired', '工单超时未被终端接收（ack 窗口 60 s）')
        await this.dispatchNextFor(moved.task.spec.deviceId)
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
        await this.dispatchNextFor(moved.task.spec.deviceId)
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
    // 已结束 / 正在回收的单元不再补投：工作树马上要消失
    const next = this.deps.store.queuedTasksFor(deviceId).find((task) => {
      const unit = this.deps.store.findUnit(task.spec.workUnitId)
      return !unit || (unit.closedAt === null && !unit.closeRequestedAt)
    })
    if (!next) return
    await this.tryDispatch(next)
  }

  private taskSeq = 0

  private nextTaskId(): string {
    if (this.taskSeq === 0) {
      let max = 0
      for (const task of this.deps.store.listTasks()) {
        const match = /^T-(\d+)$/.exec(task.id)
        if (match) {
          const num = Number.parseInt(match[1], 10)
          if (num > max) max = num
        }
      }
      this.taskSeq = max
    }
    this.taskSeq += 1
    return `T-${String(this.taskSeq).padStart(3, '0')}`
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
