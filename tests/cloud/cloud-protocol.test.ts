/**
 * 云端传输契约的回归用例（PR2）。
 *
 * 这些用例锁的是「两端共用同一份定义」这件事：版本拒绝、终态集合、
 * 事件唤醒载荷形状、连接错误分级。帧字段本身由后续实现消费，不在这一层做 schema 校验。
 */

import { CLOUD_PROTOCOL_VERSION as RENDERER_PROTOCOL_VERSION } from '../../src/types/cloud'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_TO_SERVER_TYPES,
  CLOUD_PROTOCOL_VERSION,
  CLOUD_TASK_EVENT_CUSTOM_TYPE,
  CLOUD_TASK_TERMINAL_STATUSES,
  DEVICE_TO_SERVER_TYPES,
  buildSnapshotRequest,
  buildTaskEventMessage,
  classifyConnectError,
  clientCursorQuery,
  decodeFrame,
  encodeFrame,
  isTerminalTaskStatus,
  normalizeResumeCursor,
} from '../../pi-bridge/src/cloud-protocol'

describe('版本号只有一处真相', () => {
  it('渲染层复制的协议版本与实际协议一致', () => {
    expect(RENDERER_PROTOCOL_VERSION).toBe(CLOUD_PROTOCOL_VERSION)
  })
})

describe('帧编解码', () => {
  it('编解码往返保持原样', () => {
    const frame = { v: CLOUD_PROTOCOL_VERSION, type: 'ping', at: 123 } as const
    const result = decodeFrame<typeof frame>(encodeFrame(frame))
    expect(result).toEqual({ ok: true, frame })
  })

  it('拒绝非文本、非 JSON、非对象', () => {
    expect(decodeFrame(42)).toMatchObject({ ok: false, code: 'invalid-frame' })
    expect(decodeFrame('{oops')).toMatchObject({ ok: false, code: 'invalid-frame' })
    expect(decodeFrame('"text"')).toMatchObject({ ok: false, code: 'invalid-frame' })
    expect(decodeFrame('[1,2]')).toMatchObject({ ok: false, code: 'invalid-frame' })
  })

  it('缺少 type 视为坏帧', () => {
    expect(decodeFrame(JSON.stringify({ v: CLOUD_PROTOCOL_VERSION }))).toMatchObject({
      ok: false,
      code: 'invalid-frame',
    })
  })

  it('版本不匹配一律拒绝（F-47 不维护旧客户端兼容）', () => {
    const result = decodeFrame(JSON.stringify({ v: CLOUD_PROTOCOL_VERSION + 1, type: 'snapshot' }))
    expect(result).toMatchObject({ ok: false, code: 'protocol-version' })
    if (!result.ok) expect(result.message).toContain(String(CLOUD_PROTOCOL_VERSION + 1))
  })

  it('缺省版本也拒绝', () => {
    expect(decodeFrame(JSON.stringify({ type: 'ping' }))).toMatchObject({
      ok: false,
      code: 'protocol-version',
    })
  })

  it('给了登记表就拒绝未登记的帧类型（否则被静默丢弃、对端干等）', () => {
    const unknown = JSON.stringify({ v: CLOUD_PROTOCOL_VERSION, type: 'nope' })
    expect(decodeFrame(unknown)).toMatchObject({ ok: true })
    expect(decodeFrame(unknown, CLIENT_TO_SERVER_TYPES)).toMatchObject({
      ok: false,
      code: 'invalid-frame',
    })
    expect(decodeFrame(unknown, DEVICE_TO_SERVER_TYPES)).toMatchObject({
      ok: false,
      code: 'invalid-frame',
    })
  })

  it('登记表覆盖两个方向的全部帧类型', () => {
    for (const type of ['say', 'confirm_plan', 'stop_reply', 'stop_task', 'ack', 'ping', 'resume']) {
      expect(CLIENT_TO_SERVER_TYPES.has(type)).toBe(true)
    }
    for (const type of [
      'hello',
      'workspaces',
      'heartbeat',
      'task_status',
      'task_worktree',
      'task_milestone',
      'task_question',
      'task_result',
      'task_failed',
      'task_interrupted',
    ]) {
      expect(DEVICE_TO_SERVER_TYPES.has(type)).toBe(true)
    }
  })
})

describe('工单终态', () => {
  it('终态集合包含 done/failed/cancelled/expired/rejected/interrupted', () => {
    expect([...CLOUD_TASK_TERMINAL_STATUSES].sort()).toEqual(
      ['cancelled', 'done', 'expired', 'failed', 'interrupted', 'rejected'].sort()
    )
  })

  it('运行中的状态不是终态', () => {
    for (const status of ['queued', 'assigned', 'running', 'waiting_human'] as const) {
      expect(isTerminalTaskStatus(status)).toBe(false)
    }
    for (const status of CLOUD_TASK_TERMINAL_STATUSES) {
      expect(isTerminalTaskStatus(status)).toBe(true)
    }
  })
})

describe('事件唤醒载荷', () => {
  it('落成 custom message，display 为 false 且 details 保留结构化载荷', () => {
    const payload = {
      eventId: 'evt-1',
      kind: 'done' as const,
      taskId: 'T-1',
      deviceId: 'dev-1',
      at: 1_700_000_000_000,
      summary: '测试通过，已提交',
      status: 'done' as const,
      terminalReason: 'completed' as const,
    }
    const message = buildTaskEventMessage(payload)

    expect(message.customType).toBe(CLOUD_TASK_EVENT_CUSTOM_TYPE)
    expect(message.display).toBe(false)
    expect(message.details).toEqual(payload)
    // 正文要能被人读懂，但不能冒充一句用户发言
    expect(message.content).toContain('task-event')
    expect(message.content).toContain('T-1')
    expect(message.content).toContain('测试通过')
  })

  it('设备离线取消也走同一条通道（F-21 / A-41）', () => {
    const message = buildTaskEventMessage({
      eventId: 'evt-2',
      kind: 'device-offline',
      taskId: 'T-2',
      deviceId: 'dev-1',
      at: 1,
      summary: '设备离线，工单已取消',
      status: 'cancelled',
      terminalReason: 'device-offline',
    })
    expect(message.details.kind).toBe('device-offline')
    expect(message.content).toContain('device-offline')
  })
})

describe('连接错误分级（F-43）', () => {
  it('按状态码分级', () => {
    expect(classifyConnectError({ stage: 'http', status: 401 })).toBe('auth')
    expect(classifyConnectError({ stage: 'http', status: 403 })).toBe('auth')
    expect(classifyConnectError({ stage: 'ws', status: 426 })).toBe('protocol')
    expect(classifyConnectError({ stage: 'http', status: 502 })).toBe('server')
  })

  it('按系统错误码分级', () => {
    expect(classifyConnectError({ stage: 'resolve', code: 'ENOTFOUND' })).toBe('dns')
    expect(classifyConnectError({ stage: 'connect', code: 'ECONNREFUSED' })).toBe('offline')
    expect(classifyConnectError({ stage: 'connect', code: 'ENETUNREACH' })).toBe('offline')
    expect(classifyConnectError({ stage: 'connect', code: 'ETIMEDOUT' })).toBe('timeout')
  })

  it('静默超时（被墙）归到 timeout 而不是 offline', () => {
    expect(
      classifyConnectError({ stage: 'connect', code: 'UND_ERR_CONNECT_TIMEOUT' })
    ).toBe('timeout')
  })

  it('无信息的失败至少能区分“域名没解析”和“连不上”', () => {
    expect(classifyConnectError({ stage: 'resolve' })).toBe('dns')
    expect(classifyConnectError({ stage: 'connect' })).toBe('offline')
    expect(classifyConnectError({ stage: 'ws', code: 'protocol-version' })).toBe('protocol')
  })
})

describe('连接游标只有一处真相', () => {
  it('0 / 负数 / 非数字 / 空串都等于「没有游标」', () => {
    for (const raw of [0, -1, '0', 'abc', '', null, undefined, NaN, '  ']) {
      expect(normalizeResumeCursor(raw)).toBeNull()
    }
  })

  it('正整数才算游标，字符串形式也认', () => {
    expect(normalizeResumeCursor(3)).toBe(3)
    expect(normalizeResumeCursor('7')).toBe(7)
    expect(normalizeResumeCursor(2.9)).toBe(2)
  })

  it('没有游标时不拼 lastAckSeq 参数（拼 0 会让服务端只重放日志）', () => {
    expect(clientCursorQuery(0)).toBe('')
    expect(clientCursorQuery(-5)).toBe('')
    expect(clientCursorQuery(Number.NaN)).toBe('')
    expect(clientCursorQuery(4)).toBe('?lastAckSeq=4')
  })

  it('「给我快照」就是游标为空的 resume 帧', () => {
    expect(buildSnapshotRequest()).toEqual({ type: 'resume', lastAckSeq: 0 })
    expect(normalizeResumeCursor(buildSnapshotRequest().lastAckSeq)).toBeNull()
  })
})
