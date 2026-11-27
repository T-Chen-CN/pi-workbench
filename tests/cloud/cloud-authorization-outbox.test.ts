/** 授权强制点与 outbox（G9 / F-44） */

import { describe, expect, it } from 'vitest'
import {
  checkDispatch,
  consumeQuota,
  type AuthorizationRecord,
} from '../../apps/cloud/src/tasks/authorization'
import { BoundedLog } from '../../apps/cloud/src/ws/hub'

function scope(overrides: Partial<AuthorizationRecord> = {}): AuthorizationRecord {
  return {
    id: 'auth-1',
    items: [{ deviceId: 'dev-1', workspacePath: 'E:\\Projects\\repo' }],
    quota: 2,
    used: 0,
    confirmedAt: 1000,
    confirmedSummary: 'plan',
    expiresAt: 1_000_000,
    revokedAt: null,
    ...overrides,
  }
}

describe('checkDispatch', () => {
  it('范围内的设备 × 仓库放行', () => {
    expect(
      checkDispatch(scope(), { deviceId: 'dev-1', workspacePath: 'E:\\Projects\\repo' }, 2000)
    ).toEqual({ ok: true })
  })

  it('路径分隔符与大小写差异不算越界（Windows / Linux 混用）', () => {
    expect(
      checkDispatch(scope(), { deviceId: 'dev-1', workspacePath: 'e:/projects/repo/' }, 2000)
    ).toEqual({ ok: true })
  })

  it('换设备必须重新确认（A-07）', () => {
    expect(
      checkDispatch(scope(), { deviceId: 'dev-2', workspacePath: 'E:\\Projects\\repo' }, 2000)
    ).toEqual({ ok: false, code: 'out-of-scope' })
  })

  it('换仓库必须重新确认', () => {
    expect(
      checkDispatch(scope(), { deviceId: 'dev-1', workspacePath: 'E:\\Projects\\other' }, 2000)
    ).toEqual({ ok: false, code: 'out-of-scope' })
  })

  it('没有授权 / 已撤销 / 已过期都拒绝', () => {
    expect(checkDispatch(undefined, { deviceId: 'dev-1', workspacePath: 'E:\\Projects\\repo' })).toEqual(
      { ok: false, code: 'unknown-authorization' }
    )
    expect(
      checkDispatch(scope({ revokedAt: 1500 }), {
        deviceId: 'dev-1',
        workspacePath: 'E:\\Projects\\repo',
      })
    ).toEqual({ ok: false, code: 'revoked' })
    expect(
      checkDispatch(scope({ expiresAt: 1500 }), { deviceId: 'dev-1', workspacePath: 'E:\\Projects\\repo' }, 2000)
    ).toEqual({ ok: false, code: 'expired' })
  })

  it('额度用尽后拒绝，但同一工作单元追加的工单放行（O-06 例外）', () => {
    const used = scope({ used: 2 })
    expect(
      checkDispatch(used, { deviceId: 'dev-1', workspacePath: 'E:\\Projects\\repo' }, 2000)
    ).toEqual({ ok: false, code: 'quota' })
    expect(
      checkDispatch(used, {
        deviceId: 'dev-1',
        workspacePath: 'E:\\Projects\\repo',
        sameUnit: true,
      }, 2000)
    ).toEqual({ ok: true })
  })

  it('消费额度：普通派活 +1，同单元追加不扣', () => {
    expect(consumeQuota(scope({ used: 1 })).used).toBe(2)
    expect(consumeQuota(scope({ used: 1 }), true).used).toBe(1)
  })
})

describe('BoundedLog（outbox）', () => {
  it('按 seq 续读增量', () => {
    const log = new BoundedLog(10, 60_000, () => 0)
    log.append({ n: 1 })
    log.append({ n: 2 })
    log.append({ n: 3 })
    const { frames, overflow } = log.since(1)
    expect(overflow).toBe(false)
    expect(frames.map((frame) => frame.seq)).toEqual([2, 3])
  })

  it('超过上限丢旧增量并标记 overflow（要求重拉快照）', () => {
    const log = new BoundedLog(3, 60_000, () => 0)
    for (let index = 0; index < 6; index += 1) log.append({ n: index })
    expect(log.size()).toBe(3)
    const { overflow } = log.since(1)
    expect(overflow).toBe(true)
  })

  it('超过时效的条目被丢弃', () => {
    let now = 0
    const log = new BoundedLog(10, 1000, () => now)
    log.append({ n: 1 })
    now = 2000
    log.append({ n: 2 })
    expect(log.size()).toBe(1)
    expect(log.since(0).frames).toHaveLength(1)
  })

  it('ack 裁掉已确认的帧，但不影响更晚的帧', () => {
    const log = new BoundedLog(10, 60_000, () => 0)
    log.append({ n: 1 })
    log.append({ n: 2 })
    log.append({ n: 3 })
    log.ackUpTo(2)
    expect(log.since(0).frames.map((frame) => frame.seq)).toEqual([3])
  })

  it('工单进终态时清掉该工单的待投递项（不会被重放）', () => {
    const log = new BoundedLog(10, 60_000, () => 0)
    log.append({ type: 'task' }, 'T-1')
    log.append({ type: 'task_cancel' }, 'T-1')
    log.append({ type: 'task' }, 'T-2')
    log.dropTask('T-1')
    expect(log.since(0).frames).toHaveLength(1)
  })

  it('dropTask 造成 seq 空洞不会误判 overflow（Bug 6）', () => {
    const log = new BoundedLog(10, 60_000, () => 0)
    const seq1 = log.append({ type: 'task' }, 'T-1')
    log.append({ type: 'task_message' }, 'T-2')
    const seq3 = log.append({ type: 'task' }, 'T-3')
    // T-2 结单被 dropTask 删掉 seq=2；seq=1 已 ack，设备带 lastAckSeq=1 续读不应误报 overflow
    log.dropTask('T-1')
    log.dropTask('T-2')
    const res = log.since(seq1)
    expect(res.overflow).toBe(false)
    expect(res.frames.map((frame) => frame.seq)).toEqual([seq3])
  })

  it('appendWith 让帧自带 seq（设备通道重放时不能再包一层）', () => {
    const log = new BoundedLog(10, 60_000, () => 0)
    const { seq, frame } = log.appendWith((next) => ({ type: 'task', seq: next }), 'T-1')
    expect(seq).toBe(1)
    expect(frame).toEqual({ type: 'task', seq: 1 })
    expect(log.since(0).frames[0].frame).toEqual({ type: 'task', seq: 1 })
  })
})
