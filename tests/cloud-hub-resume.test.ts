/**
 * 客户端通道的「快照 vs 续传」策略（F-44）。
 *
 * 事故背景：游标 0 被当成合法续传点，新连上的客户端只收到一堆旧事件、拿不到快照里的
 * 历史消息。反向的坑同样要防：有效游标时必须只补增量，不能每次都给整份快照
 * （否则续传设计形同废纸）。两种方向都钉在这里。
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import { Hub } from '../apps/cloud/src/ws/hub'
import { CLOUD_OUTBOX_MAX_ENTRIES, CLOUD_PROTOCOL_VERSION } from '../pi-bridge/src/cloud-protocol'

type Frame = Record<string, any>

function fakeSocket() {
  const sent: Frame[] = []
  const socket = {
    sent,
    readyState: 1,
    send(payload: string) {
      sent.push(JSON.parse(payload) as Frame)
    },
    on() {},
    close() {},
    terminate() {},
    ping() {},
  }
  return socket
}

function makeHub(snapshotMessages = 2) {
  let snapshots = 0
  const hub = new Hub(
    {
      onClientFrame: () => undefined,
      onDeviceFrame: () => undefined,
      onDeviceOnline: () => undefined,
      onDeviceOffline: () => undefined,
      onClientHello: () => undefined,
      buildSnapshot: async () => {
        snapshots += 1
        return {
          serverVersion: 'test',
          protocol: CLOUD_PROTOCOL_VERSION,
          lastSeq: 0,
          cloud: { status: 'idle', canStopReply: false },
          messages: Array.from({ length: snapshotMessages }, (_v, index) => ({
            id: `h-${index}`,
            role: 'user',
            text: `m${index}`,
            at: index,
          })),
          tasks: [],
          devices: [],
          authorizations: [],
        } as any
      },
      logger: { warn: () => undefined, info: () => undefined },
    },
    () => 1_000
  )
  return { hub, snapshotCount: () => snapshots }
}

function publish(hub: Hub, text: string) {
  hub.publish({ type: 'notice', level: 'info', text, at: 1 })
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

describe('客户端通道：快照 vs 续传', () => {
  it('没有游标 → 整份快照', async () => {
    const { hub, snapshotCount } = makeHub()
    publish(hub, 'a')
    const socket = fakeSocket()
    hub.addClient(socket as unknown as WebSocket, null)
    await flush()
    expect(snapshotCount()).toBe(1)
    expect(socket.sent[0].type).toBe('snapshot')
    expect(socket.sent[0].snapshot.messages).toHaveLength(2)
  })

  it('游标 0 也按「没有游标」处理 → 快照（不是重放日志）', async () => {
    const { hub, snapshotCount } = makeHub()
    publish(hub, 'a')
    publish(hub, 'b')
    const socket = fakeSocket()
    hub.addClient(socket as unknown as WebSocket, 0)
    await flush()
    expect(snapshotCount()).toBe(1)
    expect(socket.sent[0].type).toBe('snapshot')
  })

  it('有效游标 → 只补增量，不发快照', async () => {
    const { hub, snapshotCount } = makeHub()
    publish(hub, 'a')
    publish(hub, 'b')
    publish(hub, 'c')
    const socket = fakeSocket()
    hub.addClient(socket as unknown as WebSocket, 1)
    await flush()
    expect(snapshotCount()).toBe(0)
    expect(socket.sent.map((frame) => frame.type)).toEqual(['event', 'event'])
    expect(socket.sent.map((frame) => frame.seq)).toEqual([2, 3])
  })

  it('中间有丢失（overflow）→ 回快照而不是给残缺增量', async () => {
    const { hub, snapshotCount } = makeHub()
    // 超出日志上限后旧的被裁掉：客户端停在 1，中间那截已不可得
    for (let index = 0; index < CLOUD_OUTBOX_MAX_ENTRIES + 5; index += 1) publish(hub, `m${index}`)
    const socket = fakeSocket()
    hub.addClient(socket as unknown as WebSocket, 1)
    await flush()
    expect(snapshotCount()).toBe(1)
    expect(socket.sent[0].type).toBe('snapshot')
  })

  it('resume(0) 帧 = 主动要快照（渲染层重载复用连接）', async () => {
    const { hub, snapshotCount } = makeHub()
    for (const text of ['a', 'b', 'c', 'd']) publish(hub, text)
    const socket = fakeSocket()
    hub.addClient(socket as unknown as WebSocket, 3)
    await flush()
    expect(socket.sent.map((frame) => frame.type)).toEqual(['event'])
    socket.sent.length = 0

    const peer = { id: 'p', role: 'client' as const, socket, alive: true, lastSeenAt: 0, resumeFrom: 3 }
    await hub.resumeClient(peer as any, 0)
    expect(snapshotCount()).toBe(1)
    expect(socket.sent[0].type).toBe('snapshot')
  })

  it('resume(有效游标) 仍然只补增量', async () => {
    const { hub, snapshotCount } = makeHub()
    publish(hub, 'a')
    publish(hub, 'b')
    const socket = fakeSocket()
    const peer = { id: 'p', role: 'client' as const, socket, alive: true, lastSeenAt: 0, resumeFrom: null }
    await hub.resumeClient(peer as any, 1)
    expect(snapshotCount()).toBe(0)
    expect(socket.sent.map((frame) => frame.type)).toEqual(['event'])
  })
})

describe('首包顺序：快照不能被事件抢在前面', () => {
  it('快照构建期间产生的事件排在快照之后补发（客户端的第一帧必须是快照）', async () => {
    let releaseSnapshot: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    const hub = new Hub(
      {
        onClientFrame: () => undefined,
        onDeviceFrame: () => undefined,
        onDeviceOnline: () => undefined,
        onDeviceOffline: () => undefined,
        onClientHello: () => undefined,
        buildSnapshot: async () => {
          // 模拟“建快照要等一下”，这期间 publish 会被触发
          await gate
          return {
            serverVersion: 'test',
            protocol: CLOUD_PROTOCOL_VERSION,
            lastSeq: 0,
            cloud: { status: 'idle', canStopReply: false },
            messages: [],
            tasks: [],
            devices: [],
            units: [],
            authorizations: [],
          } as any
        },
        logger: { warn: () => undefined, info: () => undefined },
      },
      () => 1_000
    )

    const socket = fakeSocket()
    hub.addClient(socket as unknown as WebSocket, null)
    // 快照还没建好就广播一条事件
    publish(hub, 'config-applied')
    await flush()
    expect(socket.sent).toHaveLength(0)
    releaseSnapshot()
    await flush()

    expect(socket.sent[0]?.type).toBe('snapshot')
    expect(socket.sent.slice(1).map((frame) => frame.type)).toEqual(['event'])
    expect(socket.sent[1]?.event?.text).toBe('config-applied')
  })
})
