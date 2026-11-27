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
  CLOUD_MAX_CONCURRENT_SESSIONS,
  CLOUD_MAX_DIFF_LIMIT_BYTES,
  CLOUD_OFFLINE_TIMEOUT_MS,
  CLOUD_QUEUED_ACK_WINDOW_MS,
  CLOUD_TASK_SILENCE_CHECK_MS,
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

/** 同一工作单元内通过 sameUnit 派发的工单上限，防止 quota=1 时无限循环派单绕过额度 */
const MAX_TASKS_PER_UNIT = 20
/** 干净工作树自动回收的默认空闲延迟（10 分钟），为 2s 节流唤醒后的 sameUnit 跟单留足窗口 */
export const DEFAULT_WORKTREE_RECLAIM_DELAY_MS = 10 * 60 * 1000

export class TaskDispatcher {
  /** 单设备在途已下发但尚未收到 assigned 的工单（防并发 tryDispatch 同时下发多条 queued） */
  private inFlightDispatches = new Map<string, string>()
  /** 同一幂等键并发派单合并，避免重复创建工单 */
  private inFlightIdempotency = new Map<string, Promise<DispatchOutcome>>()
  private drainingQueue = false
  private drainQueuePending = false
  /** 同一工具停滞只报一次（收到新里程碑/终态后清除，C-02） */
  private reportedToolStalls = new Set<string>()
  /** 同一静默窗口只唤醒一次：记录已告警时的 lastEventAt（C-02） */
  private reportedSilenceAt = new Map<string, number>()
  /** 干净工作树延迟回收定时器（按 unitId 管理，同单元新派活 / 手动关闭 / dispose 时取消） */
  private reclaimTimers = new Map<string, NodeJS.Timeout>()
  private disposed = false
  /** 启动时间戳：用于服务重启宽限期后收敛离线设备的僵尸活跃工单 */
  private readonly bootAt: number

  constructor(
    private readonly deps: {
      store: CloudStore
      hub: Hub
      /** 把工单事件投进云端会话（事件唤醒）；由 agent 层实现 */
      wake: (payload: CloudTaskEventPayload) => Promise<void> | void
      logger: DispatcherLogger
      /** 全局活跃工单并发上限（D-15 / A-21，默认 8） */
      maxConcurrentTasks?: number
      /** 云端静默巡检阈值（C-02，默认 20 分钟） */
      silenceCheckMs?: number
      /** 服务重启后对未重连设备的僵尸运行中工单宽限时长（默认 60s） */
      offlineRecoveryGraceMs?: number
      /** 干净工作树空闲自动回收延迟（毫秒，默认 10 分钟；测试可注入短延迟） */
      reclaimDelayMs?: number
      now?: () => number
    }
  ) {
    this.bootAt = deps.now?.() ?? Date.now()
  }

  private reclaimDelayMs(): number {
    const raw = this.deps.reclaimDelayMs
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
    return DEFAULT_WORKTREE_RECLAIM_DELAY_MS
  }

  private cancelReclaimTimer(unitId: string): void {
    const timer = this.reclaimTimers.get(unitId)
    if (!timer) return
    clearTimeout(timer)
    this.reclaimTimers.delete(unitId)
  }

  /** 停机清理：取消所有待执行的延迟回收定时器，避免进程退出或关服后误触发 */
  dispose(): void {
    this.disposed = true
    for (const timer of this.reclaimTimers.values()) {
      clearTimeout(timer)
    }
    this.reclaimTimers.clear()
  }

  private maxConcurrent(): number {
    return Math.max(1, this.deps.maxConcurrentTasks ?? CLOUD_MAX_CONCURRENT_SESSIONS)
  }

  private silenceCheckMs(): number {
    return Math.max(1_000, this.deps.silenceCheckMs ?? CLOUD_TASK_SILENCE_CHECK_MS)
  }

  private offlineRecoveryGraceMs(): number {
    return Math.max(1_000, this.deps.offlineRecoveryGraceMs ?? CLOUD_OFFLINE_TIMEOUT_MS)
  }

  /** 全站当前活跃或已下发待 ACK 的工单总数（D-15 / A-21） */
  private activeGlobalCount(excludingTaskId?: string): number {
    const ids = new Set<string>()
    for (const task of this.deps.store.listTasks()) {
      if (task.id === excludingTaskId) continue
      if (['assigned', 'running', 'waiting_human'].includes(task.status)) {
        ids.add(task.id)
      }
    }
    for (const inFlightId of this.inFlightDispatches.values()) {
      if (inFlightId !== excludingTaskId) ids.add(inFlightId)
    }
    return ids.size
  }

  private clearStallMarkers(taskId: string): void {
    this.reportedSilenceAt.delete(taskId)
    for (const key of [...this.reportedToolStalls]) {
      if (key.startsWith(`${taskId}:`)) this.reportedToolStalls.delete(key)
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // ------------------------------ 派活 ------------------------------

  async dispatch(request: DispatchRequest): Promise<DispatchOutcome> {
    const key = request.idempotencyKey
    if (key) {
      const inflight = this.inFlightIdempotency.get(key)
      if (inflight) return inflight
      const promise = this.runDispatch(request, key).finally(() => {
        if (this.inFlightIdempotency.get(key) === promise) {
          this.inFlightIdempotency.delete(key)
        }
      })
      this.inFlightIdempotency.set(key, promise)
      return promise
    }
    return this.runDispatch(request, `key-${request.workUnitId}-${this.now()}-${Math.random().toString(36).slice(2, 8)}`)
  }

  private async runDispatch(request: DispatchRequest, key: string): Promise<DispatchOutcome> {
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
    // 复用已有单元时禁止跨授权蹭额度，且限制同单元最多跟单数防无限循环
    if (
      existingUnit &&
      existingUnit.authorizationId &&
      existingUnit.authorizationId !== request.authorizationId
    ) {
      return {
        ok: false,
        code: 'unit-authorization-mismatch',
        message: 'Work unit was created under a different authorization; open a new unit or reuse the original authorization.',
      }
    }
    const sameUnit = Boolean(existingUnit && !existingUnit.closedAt)

    // 幂等：同一 idempotencyKey 只生成一张工单（先于配额扣减检查，避免重复扣减）
    const existing =
      typeof store.findTaskByIdempotencyKey === 'function'
        ? store.findTaskByIdempotencyKey(key)
        : store.listTasks().find((task) => task.idempotencyKey === key)
    if (existing) return { ok: true, task: existing }

    if (sameUnit) {
      const tasksInUnit = store
        .listTasks()
        .filter((task) => task.spec.workUnitId === request.workUnitId).length
      if (tasksInUnit >= MAX_TASKS_PER_UNIT) {
        return {
          ok: false,
          code: 'unit-task-limit',
          message: `Work unit reached the maximum of ${MAX_TASKS_PER_UNIT} tasks; ask the user to confirm a new plan.`,
        }
      }
    }

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
    // 新工单落入该单元前必须取消挂起的空闲回收定时器，避免工作树被中途销毁
    this.cancelReclaimTimer(request.workUnitId)
    await store.saveTask(task)

    // 工作单元台账：一个单元只对应一个 worktree，后续工单沿用
    if (!existingUnit) {
      await store.saveUnit({
        unitId: request.workUnitId,
        deviceId: request.deviceId,
        workspacePath: request.workspacePath,
        authorizationId: request.authorizationId,
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
    const fresh = store.findTask(task.id)
    if (!fresh || fresh.status !== 'queued' || fresh.dispatchedAt !== null) return
    const deviceId = fresh.spec.deviceId
    const inFlight = this.inFlightDispatches.get(deviceId)
    if (inFlight && inFlight !== fresh.id) {
      this.deps.logger.info(`[cloud] task ${fresh.id} queued behind in-flight ${inFlight}`)
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
        `[cloud] task ${fresh.id} queued behind ${running.map((item) => item.id).join(',')}`
      )
      return
    }
    // D-15 / A-21：全站并发上限保护——超出上限保持 queued（dispatchedAt 仍为 null，不计 ACK 超时）并提示
    const limit = this.maxConcurrent()
    if (this.activeGlobalCount(fresh.id) >= limit) {
      this.deps.logger.info(
        `[cloud] task ${fresh.id} queued: global concurrency limit (${limit}) reached`
      )
      this.deps.hub.publish({
        type: 'notice',
        level: 'info',
        text: `已达并发上限（${limit} 个工单执行中），${fresh.id}（${fresh.spec.title}）已进入排队等待`,
        at: this.now(),
        key: `concurrency-limit-${fresh.id}`,
      })
      return
    }
    if (!this.deps.hub.isDeviceOnline(deviceId)) return
    // 同步占位，防止并发 dispatch 在 await saveTask 期间同时发第二张工单或绕过全站上限
    this.inFlightDispatches.set(deviceId, fresh.id)
    const dispatched: CloudTaskSnapshot = { ...fresh, dispatchedAt: this.now() }
    // 必须先落盘 dispatchedAt 再发往设备，否则极快回包的 `task_status: assigned/running`
    // 会被后完成的 `saveTask(dispatched)` 覆盖回 `queued`，导致全站并发计数失真
    await store.saveTask(dispatched)
    // await 期间工单可能已被取消或设备已下线，必须复检状态避免把已取消工单发往设备
    const afterSave = store.findTask(fresh.id)
    if (!afterSave || afterSave.status !== 'queued') {
      this.clearInFlight(deviceId, fresh.id)
      return
    }
    const delivered = this.deps.hub.sendToDevice(
      deviceId,
      {
        v: 1,
        type: 'task',
        seq: 0,
        task: dispatched,
      },
      fresh.id
    )
    if (!delivered) {
      // 发送失败时必须立刻清除写入 deviceLog 的 task 帧，否则重连重放会与 dispatchNextFor 触发双派单
      this.deps.hub.dropDeviceTask(deviceId, fresh.id)
      this.clearInFlight(deviceId, fresh.id)
      const current = store.findTask(fresh.id)
      if (current && current.status === 'queued') {
        await store.saveTask({ ...current, dispatchedAt: null })
      }
      return
    }
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
      case 'task_heartbeat':
        // 工单运行期 60s 心跳：只更新设备在线活跃时间，不改 task.progress.lastEventAt（防止洗白 20 分钟静默巡检，C-02）
        await this.deps.store.updateDevice(deviceId, { lastSeenAt: frame.at || this.now() })
        return
      case 'task_stalled': {
        const task = this.deps.store.findTask(frame.taskId)
        if (!task || task.spec.deviceId !== deviceId || isTerminalTaskStatus(task.status)) return
        const toolName = typeof frame.toolName === 'string' && frame.toolName ? frame.toolName : undefined
        const stallKey = `${task.id}:${toolName ?? ''}`
        if (this.reportedToolStalls.has(stallKey)) return
        this.reportedToolStalls.add(stallKey)
        const minutes = Math.max(1, Math.round((Number(frame.idleMs) || 0) / 60_000))
        const label = toolName ? `工具 ${toolName}` : '当前操作'
        const summary = `工单 ${task.id} 的${label}已 ${minutes} 分钟无输出增量，可能已停滞；请用 get_task 查看并告知用户是否需要停止。`
        this.deps.hub.publish({
          type: 'notice',
          level: 'warn',
          text: `工单 ${task.id} 可能停滞：${label}已 ${minutes} 分钟无输出`,
          at: this.now(),
          key: `task-stalled-${stallKey}`,
        })
        await this.wake(task, 'stalled', summary)
        return
      }
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
        this.clearStallMarkers(task.id)
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
        const sanitizedDiff = sanitizeIncomingDiff(frame.result.diff)
        // 脱敏 diff 单独落盘到 task-diffs/<taskId>.json，不进 tasks.json 与前端广播快照（get_task 按需加载）
        if (sanitizedDiff && typeof this.deps.store.saveTaskDiff === 'function') {
          await this.deps.store.saveTaskDiff(task.id, sanitizedDiff)
        }
        const moved = transition(task, 'done', {
          now: this.now(),
          reason: 'completed',
          progress: {
            summary: frame.result.summary,
            branch: frame.result.branch,
            commit: frame.result.commit,
            changedFiles: frame.result.changedFiles,
            secretHits: frame.result.secretHits,
          },
        })
        if (moved.changed) {
          await this.deps.store.saveTask(moved.task)
          this.finish(moved.task)
          await this.wake(moved.task, 'done', frame.result.summary, {
            changedFiles: frame.result.changedFiles,
            secretHits: frame.result.secretHits,
          })
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
        const mergedChanges = mergeChangedFiles(task.progress.changedFiles, frame.changedFiles)
        const moved = transition(task, 'failed', {
          now: this.now(),
          reason: 'failed',
          error: frame.error,
          progress: {
            changedFiles: mergedChanges,
            ...(frame.secretHits?.length ? { secretHits: frame.secretHits } : {}),
          },
        })
        if (moved.changed) {
          await this.deps.store.saveTask(moved.task)
          this.finish(moved.task)
          await this.wake(moved.task, 'failed', frame.error, {
            changedFiles: mergedChanges,
            secretHits: frame.secretHits,
          })
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
    this.cancelReclaimTimer(unitId)
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
   * A-43：**干净就延迟自动回收**（默认空闲 10 分钟后回收）。
   *
   * 判定放在云端是因为只有它知道该单元还有没有后续工单；采用空闲延迟而非同步立即销毁，
   * 是为了给 2s 节流唤醒的云端 Agent 留出审查结果并向同一单元派 `sameUnit` 跟单的窗口，
   * 否则跟单会被 `unit-closed` 拒绝或丢失前序工作树（A-46）。
   */
  private async reclaimIfClean(
    task: CloudTaskSnapshot,
    worktreeClean: boolean | undefined,
    reason: 'converged' | 'sweep'
  ): Promise<void> {
    const unitId = task.spec.workUnitId
    if (this.disposed || worktreeClean !== true) {
      this.cancelReclaimTimer(unitId)
      return
    }
    const unit = this.deps.store.findUnit(unitId)
    if (!unit || unit.closedAt !== null || unit.closeRequestedAt) return
    if (this.hasOpenTaskInUnit(unitId)) return
    this.cancelReclaimTimer(unitId)
    const timer = setTimeout(() => {
      if (this.reclaimTimers.get(unitId) === timer) {
        this.reclaimTimers.delete(unitId)
      }
      if (this.disposed) return
      const latest = this.deps.store.findUnit(unitId)
      if (!latest || latest.closedAt !== null || latest.closeRequestedAt) return
      if (this.hasOpenTaskInUnit(unitId)) return
      void this.requestUnitClose(unitId, reason).catch((error) => {
        this.deps.logger.warn(`[cloud] delayed worktree reclaim failed for ${unitId}:`, error)
      })
    }, this.reclaimDelayMs())
    timer.unref?.()
    this.reclaimTimers.set(unitId, timer)
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
    this.cancelReclaimTimer(frame.unitId)
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

    // 在线才下发 cancel；this.finish() 已先清理旧的 task 帧，这里绝不能在发完 cancel 后再 dropDeviceTask 把刚入队的取消帧抹掉
    if (this.deps.hub.isDeviceOnline(task.spec.deviceId)) {
      this.deps.hub.sendToDevice(
        task.spec.deviceId,
        { v: 1, type: 'task_cancel', seq: 0, taskId, reason },
        taskId
      )
    }
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

  /** 超时收敛：`queued` 未 ack → expired；`waiting_human` 超 2 h → failed；服务重启后离线设备的僵尸活跃工单宽限期后取消（F-21 / F-25） */
  async sweepTimeouts(): Promise<void> {
    const now = this.now()
    const offlineGraceMs = this.offlineRecoveryGraceMs()
    const pastBootGrace = now - this.bootAt >= offlineGraceMs
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
        continue
      }
      // 服务端重启后若原执行设备未在宽限期内重连，必须取消残留活跃工单，防止永久占死单设备锁与全站 8 并发上限
      if (
        pastBootGrace &&
        (task.status === 'assigned' || task.status === 'running' || task.status === 'waiting_human') &&
        !this.deps.hub.isDeviceOnline(task.spec.deviceId) &&
        now - task.updatedAt >= offlineGraceMs
      ) {
        await this.cancelTask(task.id, 'device-offline')
        continue
      }
      // C-02：running 工单 20 分钟无进度事件 → 主动唤醒一轮检查（同一静默只报一次）
      if (task.status === 'running') {
        const lastEventAt = task.progress.lastEventAt || task.startedAt || task.createdAt
        const silentMs = now - lastEventAt
        if (silentMs >= this.silenceCheckMs() && this.reportedSilenceAt.get(task.id) !== lastEventAt) {
          this.reportedSilenceAt.set(task.id, lastEventAt)
          const minutes = Math.max(1, Math.round(silentMs / 60_000))
          await this.wake(
            task,
            'stalled',
            `工单 ${task.id} 已超过 ${minutes} 分钟无进度事件，请调用 get_task 主动检查状态并向用户汇报。`
          )
        }
      }
    }
  }

  // ------------------------------ 快照 ------------------------------

  deviceSnapshots(): CloudDeviceSnapshot[] {
    return this.deps.store
      .listDevices()
      .filter((device) => device.revokedAt === null)
      .map((device) => this.deviceSnapshot(device))
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
    this.clearStallMarkers(task.id)
    this.deps.hub.dropDeviceTask(task.spec.deviceId, task.id)
    this.publishTask(task)
  }

  private publishTask(task: CloudTaskSnapshot): void {
    // 防御纵深：广播给客户端的工单快照绝不附带大体积 diff 正文
    const sanitized: CloudTaskSnapshot = task.progress.diff
      ? { ...task, progress: { ...task.progress, diff: undefined } }
      : task
    const event: CloudEvent = { type: 'task', task: sanitized }
    this.deps.hub.publish(event)
  }

  private async wake(
    task: CloudTaskSnapshot,
    kind: CloudTaskEventKind,
    summary: string,
    extra?: {
      changedFiles?: CloudChangedFile[]
      secretHits?: import('pi-bridge').CloudSecretHit[]
    }
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
      ...(extra?.changedFiles?.length ? { changedFiles: extra.changedFiles } : {}),
      ...(extra?.secretHits?.length ? { secretHits: extra.secretHits } : {}),
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
    if (next) await this.tryDispatch(next)
    // 全站并发槽位空出后，顺手按 FIFO 补投其他在线设备的排队工单（A-21）
    await this.dispatchNextQueued()
  }

  private async dispatchNextQueued(): Promise<void> {
    if (this.drainingQueue) {
      this.drainQueuePending = true
      return
    }
    this.drainingQueue = true
    try {
      do {
        this.drainQueuePending = false
        if (this.activeGlobalCount() >= this.maxConcurrent()) break
        const queued = this.deps.store
          .listTasks()
          .filter((task) => task.status === 'queued' && task.dispatchedAt === null)
          .sort((a, b) => a.createdAt - b.createdAt)
        for (const task of queued) {
          if (this.activeGlobalCount() >= this.maxConcurrent()) break
          const unit = this.deps.store.findUnit(task.spec.workUnitId)
          if (unit && (unit.closedAt !== null || unit.closeRequestedAt)) continue
          if (!this.deps.hub.isDeviceOnline(task.spec.deviceId)) continue
          await this.tryDispatch(task)
        }
      } while (this.drainQueuePending)
    } finally {
      this.drainingQueue = false
    }
  }

  private taskSeq = 0

  private nextTaskId(): string {
    if (typeof this.deps.store.nextTaskSeq === 'function') {
      const seq = this.deps.store.nextTaskSeq()
      this.taskSeq = seq
      return `T-${String(seq).padStart(3, '0')}`
    }
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

/** UTF-8 安全按字节上限截断，避免切在多字节字符中间产生 \uFFFD 乱码 */
function sliceUtf8ByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1
  }
  return buf.subarray(0, end).toString('utf8')
}

/** 服务端二次夹取 diff 大小，避免异常终端帧把 tasks.json 撑爆（C-03b） */
function sanitizeIncomingDiff(
  raw: { bytes: number; excerpt: string; truncated?: boolean } | undefined
): { bytes: number; excerpt: string; truncated?: boolean } | undefined {
  if (!raw || typeof raw.excerpt !== 'string') return undefined
  const excerpt = raw.excerpt.trim()
  if (!excerpt) return undefined
  const bytes =
    typeof raw.bytes === 'number' && Number.isFinite(raw.bytes) && raw.bytes >= 0
      ? Math.floor(raw.bytes)
      : Buffer.byteLength(excerpt, 'utf8')
  if (Buffer.byteLength(excerpt, 'utf8') <= CLOUD_MAX_DIFF_LIMIT_BYTES) {
    return { bytes, excerpt, ...(raw.truncated ? { truncated: true } : {}) }
  }
  const suffix = '\n... [clipped by server]'
  const budget = Math.max(0, CLOUD_MAX_DIFF_LIMIT_BYTES - Buffer.byteLength(suffix, 'utf8'))
  const clipped = sliceUtf8ByBytes(excerpt, budget)
  return { bytes, excerpt: `${clipped}${suffix}`, truncated: true }
}

function authorizationError(code: string): string {
  switch (code) {
    case 'unknown-authorization':
      return 'No confirmed plan authorizes this dispatch. Plain-text replies cannot create an authorization; ask the user to click "确认方案并授权" (Desktop) or "确认方案…" (Web) in the UI to generate a real authorizationId (auth-...).'
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
