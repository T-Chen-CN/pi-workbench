/** 工单状态机与超时收敛（F-20 / F-21 / F-25） */

import { describe, expect, it } from 'vitest'
import type { CloudTaskSnapshot } from 'pi-bridge'
import {
  canTransition,
  isAckExpired,
  isWaitingHumanExpired,
  tasksToCancelOnOffline,
  transition,
} from '../apps/cloud/src/tasks/state-machine'

function makeTask(overrides: Partial<CloudTaskSnapshot> = {}): CloudTaskSnapshot {
  return {
    id: 'T-001',
    spec: {
      workUnitId: 'unit-1',
      deviceId: 'dev-1',
      repo: { workspacePath: '/repo' },
      title: 'title',
      background: 'bg',
      goal: 'goal',
      acceptance: 'acceptance',
      output: { summary: true, changeList: true, testResult: true },
      commit: false,
      authorizationId: 'auth-1',
    },
    status: 'queued',
    idempotencyKey: 'key-1',
    createdAt: 1000,
    updatedAt: 1000,
    progress: { step: 0, lastEventAt: 1000 },
    ...overrides,
  }
}

describe('canTransition', () => {
  it('允许正常推进路径', () => {
    expect(canTransition('queued', 'assigned')).toBe(true)
    expect(canTransition('assigned', 'running')).toBe(true)
    expect(canTransition('running', 'waiting_human')).toBe(true)
    expect(canTransition('waiting_human', 'running')).toBe(true)
    expect(canTransition('running', 'done')).toBe(true)
    expect(canTransition('running', 'failed')).toBe(true)
    expect(canTransition('running', 'cancelled')).toBe(true)
  })

  it('禁止跳过接单直接完成，也禁止从终态复活', () => {
    expect(canTransition('queued', 'done')).toBe(false)
    expect(canTransition('assigned', 'done')).toBe(false)
    expect(canTransition('done', 'running')).toBe(false)
    expect(canTransition('cancelled', 'running')).toBe(false)
  })

  it('同状态不算变化', () => {
    expect(canTransition('running', 'running')).toBe(false)
  })
})

describe('transition', () => {
  it('推进到 running 时补 startedAt 并刷新进度时间', () => {
    const result = transition(makeTask({ status: 'assigned' }), 'running', { now: 2000 })
    expect(result.changed).toBe(true)
    expect(result.task.status).toBe('running')
    expect(result.task.startedAt).toBe(2000)
    expect(result.task.progress.lastEventAt).toBe(2000)
  })

  it('终态写入 finishedAt 与原因', () => {
    const result = transition(makeTask({ status: 'running' }), 'cancelled', {
      now: 3000,
      reason: 'device-offline',
    })
    expect(result.task.status).toBe('cancelled')
    expect(result.task.finishedAt).toBe(3000)
    expect(result.task.terminalReason).toBe('device-offline')
  })

  it('先落终态者胜：后到的终态只作附注，不覆盖', () => {
    const cancelled = makeTask({
      status: 'cancelled',
      terminalReason: 'device-offline',
      finishedAt: 2000,
    })
    const result = transition(cancelled, 'interrupted', { now: 3000, reason: 'app-quit' })
    expect(result.changed).toBe(false)
    expect(result.task).toBe(cancelled)
    expect(result.task.terminalReason).toBe('device-offline')
    expect(result.ignored).toEqual({ status: 'interrupted', reason: 'app-quit' })
  })

  it('非法迁移被忽略（不静默改成奇怪状态）', () => {
    const result = transition(makeTask({ status: 'queued' }), 'done', { now: 2000 })
    expect(result.changed).toBe(false)
    expect(result.task.status).toBe('queued')
  })
})

describe('离线取消与超时', () => {
  const tasks = [
    makeTask({ id: 'T-1', status: 'running' }),
    makeTask({ id: 'T-2', status: 'queued' }),
    makeTask({ id: 'T-3', status: 'waiting_human' }),
    makeTask({ id: 'T-4', status: 'done' }),
    makeTask({ id: 'T-5', status: 'running', spec: { ...makeTask().spec, deviceId: 'dev-2' } }),
  ]

  it('只终止该设备上未完成的工单', () => {
    const ids = tasksToCancelOnOffline(tasks, 'dev-1').map((task) => task.id)
    expect(ids.sort()).toEqual(['T-1', 'T-2', 'T-3'])
  })

  it('queued 超过 ack 窗口算过期', () => {
    const queued = makeTask({ status: 'queued', createdAt: 1000 })
    expect(isAckExpired(queued, 1000 + 59_000, 60_000)).toBe(false)
    expect(isAckExpired(queued, 1000 + 61_000, 60_000)).toBe(true)
    // 已经离开 queued 就不再按 ack 窗口判
    expect(isAckExpired(makeTask({ status: 'running', createdAt: 1000 }), 999_999, 60_000)).toBe(false)
  })

  it('waiting_human 超 2 小时算超时', () => {
    const waiting = makeTask({ status: 'waiting_human', updatedAt: 1000 })
    expect(isWaitingHumanExpired(waiting, 1000 + 60_000, 2 * 60 * 60 * 1000)).toBe(false)
    expect(isWaitingHumanExpired(waiting, 1000 + 2 * 60 * 60 * 1000 + 1, 2 * 60 * 60 * 1000)).toBe(
      true
    )
  })
})
