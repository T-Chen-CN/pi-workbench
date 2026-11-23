/**
 * 桌面端客户端通道的连接 URL。
 *
 * 事故：首连带了 `?lastAckSeq=0`，服务端把这当成「续传游标」，只重放事件日志、
 * 不发整份快照 —— 云端页于是历史空白。没有游标时（0）必须不带这个参数。
 */

// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

const urls: string[] = []
const sent: Array<Record<string, unknown>> = []
const sockets = vi.hoisted(() => [] as Array<{
  emit: (event: string, ...args: unknown[]) => void
  handlers: Record<string, Array<(...args: any[]) => void>>
}>)

vi.mock('ws', () => {
  class FakeSocket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 0
    handlers: Record<string, Array<(...args: any[]) => void>> = {}
    constructor(public url: string) {
      urls.push(url)
      sockets.push(this as unknown as (typeof sockets)[number])
    }
    on(event: string, callback: (...args: any[]) => void) {
      this.handlers[event] = [...(this.handlers[event] ?? []), callback]
      return this
    }
    emit(event: string, ...args: unknown[]) {
      for (const callback of this.handlers[event] ?? []) callback(...args)
    }
    close() {
      this.readyState = 3
    }
    send(payload: string) {
      sent.push(JSON.parse(payload) as Record<string, unknown>)
    }
    terminate() {}
  }
  return { WebSocket: FakeSocket }
})

vi.mock('../electron/cloud/link-store.js', () => ({
  readCloudLink: () => ({ baseUrl: 'https://cloud.example', deviceId: 'dev-1', linked: true }),
  readCloudToken: () => 'token-1',
  wsUrl: (baseUrl: string, path: string) =>
    `${baseUrl.replace('https', 'wss')}${path}`,
}))

import { CloudClientBridge } from '../electron/cloud/client-link'
import type { CloudClientState } from '../electron/cloud/client-link'

function makeBridge() {
  return new CloudClientBridge({
    logger: { info: () => undefined, warn: () => undefined },
    onFrame: () => undefined,
    onState: () => undefined,
  })
}

describe('CloudClientBridge 连接 URL', () => {
  beforeEach(() => {
    urls.length = 0
    sent.length = 0
    sockets.length = 0
  })

  it('首连不带 lastAckSeq（否则服务端只重放日志、不发快照）', () => {
    makeBridge().open()
    expect(urls[0]).toBe('wss://cloud.example/client/ws')
  })

  it('已有游标时带上 lastAckSeq 走续传', () => {
    const bridge = makeBridge()
    bridge.open()
    // 模拟收到一帧带 seq 的事件后重连
    ;(bridge as unknown as { lastAckSeq: number }).lastAckSeq = 42
    bridge.close()
    bridge.open()
    expect(urls[urls.length - 1]).toBe('wss://cloud.example/client/ws?lastAckSeq=42')
  })

  it('连接已活着时再 open 会主动要快照（渲染层重载后 store 是空的）', () => {
    const bridge = makeBridge()
    bridge.open()
    // 模拟握手成功
    const socket = (bridge as unknown as { socket: { readyState: number } }).socket
    socket.readyState = 1
    const before = urls.length

    bridge.open()
    expect(urls.length).toBe(before)
    expect(sent[0]).toEqual({ v: 1, type: 'resume', lastAckSeq: 0 })
  })

  it('连接没起来时 requestSnapshot 不发送、也不抛', () => {
    const bridge = makeBridge()
    expect(bridge.requestSnapshot()).toBe(false)
    expect(sent).toHaveLength(0)
  })
})

describe('致命拒绝（F-47 / A-27）', () => {
  it('收到 fatal 错误帧后停手：不再退避重连，文案留在状态里', async () => {
    const states: CloudClientState[] = []
    const frames: unknown[] = []
    const bridge = new CloudClientBridge({
      logger: { info: () => undefined, warn: () => undefined },
      onFrame: (frame) => frames.push(frame),
      onState: (state) => states.push(state),
    })
    try {
      bridge.open()
      const socket = sockets[sockets.length - 1]
      socket.emit(
        'message',
        JSON.stringify({
          v: 1,
          type: 'error',
          code: 'protocol-version',
          message: 'Client must be updated',
          fatal: true,
        })
      )
      expect(states[states.length - 1]).toMatchObject({
        status: 'error',
        fatal: true,
        error: 'Client must be updated',
      })
      // 渲染层也要拿到这一帧，否则气泡里什么都看不到
      expect(frames).toHaveLength(1)
      // 服务端随后关连接：不能再起一次退避重连（原本会无限重试）
      socket.emit('close')
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(urls).toHaveLength(1)
      expect(bridge.getState()).toMatchObject({ status: 'error', fatal: true })
    } finally {
      bridge.close()
    }
  })

  it('非 fatal 的错误帧不影响连接（只是普通提示）', () => {
    const states: CloudClientState[] = []
    const bridge = new CloudClientBridge({
      logger: { info: () => undefined, warn: () => undefined },
      onFrame: () => undefined,
      onState: (state) => states.push(state),
    })
    bridge.open()
    sockets[sockets.length - 1].emit(
      'message',
      JSON.stringify({ v: 1, type: 'error', code: 'bad-frame', message: 'nope', fatal: false })
    )
    expect(states.some((state) => state.status === 'error')).toBe(false)
    expect(bridge.getState().status).not.toBe('error')
  })
})
