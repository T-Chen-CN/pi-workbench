/**
 * 桌面端客户端通道的连接 URL。
 *
 * 事故：首连带了 `?lastAckSeq=0`，服务端把这当成「续传游标」，只重放事件日志、
 * 不发整份快照 —— 云端页于是历史空白。没有游标时（0）必须不带这个参数。
 */

// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

const urls: string[] = []

vi.mock('ws', () => {
  class FakeSocket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 0
    constructor(public url: string) {
      urls.push(url)
    }
    on() {}
    close() {}
    send() {}
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
})
