/**
 * 派活中继：帧解析、relay.reconnect 不落地、断线重连、上行报文形状。
 *
 * 用假的 CloudClient（openStream 返回手造 SSE）验证真实解析路径 —— 不碰网络。
 */

import { describe, expect, it } from 'vitest'
import type { CloudClient } from '../electron/cloud/client'
import { DispatchRelay, publishWorkspaces, reportTask } from '../electron/dispatch/relay'

const encoder = new TextEncoder()

/** 造一条立刻结束的 SSE 响应体 */
function sseBody(frames: Array<Record<string, unknown> | string>): ReadableStream<Uint8Array> {
  const text = frames
    .map((frame) =>
      typeof frame === 'string' ? frame : `data: ${JSON.stringify(frame)}\n\n`
    )
    .join('')
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

function fakeClient(body: () => ReadableStream<Uint8Array> | null): {
  client: CloudClient
  calls: Array<{ url: string; body?: unknown }>
} {
  const calls: Array<{ url: string; body?: unknown }> = []
  const client = {
    openStream: async (url: string) => {
      calls.push({ url })
      const stream = body()
      return { ok: true, status: 200, body: stream } as unknown as Response
    },
    request: async (url: string, init?: { body?: unknown }) => {
      calls.push({ url, body: init?.body })
      return {}
    },
  } as unknown as CloudClient
  return { client, calls }
}

describe('dispatch relay', () => {
  it('passes task frames through and swallows relay.reconnect', async () => {
    const frames: unknown[] = []
    const { client, calls } = fakeClient(() =>
      sseBody([
        { type: 'relay.hello', deviceId: 'dev-1' },
        { type: 'relay.reconnect', reason: 'age' },
        { type: 'task.assigned', taskId: 't-1', workspaceId: 'ws-1', prompt: 'hi' },
        ': ping\n\n'
      ])
    )
    const relay = new DispatchRelay({
      getClient: () => client,
      onFrame: (frame) => frames.push(frame),
      onState: () => {},
      delay: async () => {
        relay.stop()
      }
    })
    relay.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await relay.stop()

    expect(calls[0].url).toBe('/v1/hub/relay/stream')
    expect(frames).toEqual([
      { type: 'relay.hello', deviceId: 'dev-1' },
      { type: 'task.assigned', taskId: 't-1', workspaceId: 'ws-1', prompt: 'hi' }
    ])
  })

  it('drops malformed frames instead of throwing', async () => {
    const frames: unknown[] = []
    const { client } = fakeClient(() => sseBody(['data: not-json\n\n', { type: 'task.cancel', taskId: 't-9' }]))
    const relay = new DispatchRelay({
      getClient: () => client,
      onFrame: (frame) => frames.push(frame),
      onState: () => {},
      delay: async () => {
        relay.stop()
      }
    })
    relay.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await relay.stop()
    expect(frames).toEqual([{ type: 'task.cancel', taskId: 't-9' }])
  })

  it('reports connected / disconnected and retries after a failed stream', async () => {
    const states: boolean[] = []
    let attempt = 0
    const client = {
      openStream: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('boom')
        return { ok: true, status: 200, body: sseBody([{ type: 'relay.hello' }]) } as unknown as Response
      },
      request: async () => ({})
    } as unknown as CloudClient
    const delays: number[] = []
    const relay = new DispatchRelay({
      getClient: () => client,
      onFrame: () => {},
      onState: (state) => states.push(state.connected),
      delay: async (ms) => {
        delays.push(ms)
        if (delays.length >= 3) relay.stop()
      }
    })
    relay.start()
    await new Promise((resolve) => setTimeout(resolve, 120))
    await relay.stop()

    expect(attempt).toBeGreaterThanOrEqual(2)
    // 第一次失败后按 1s 起退避重连，失败不会死循环空转
    expect(delays[0]).toBe(1000)
    expect(states).toContain(true)
    expect(states[states.length - 1]).toBe(false)
  })

  it('sends the workspace catalog and reports with the expected bodies', async () => {
    const { client, calls } = fakeClient(() => null)
    await publishWorkspaces(client, {
      enabled: true,
      workspaces: [{ id: 'ws-1', label: 'repo', description: '前端' }]
    })
    await reportTask(client, {
      taskId: 't-1',
      kind: 'done',
      summary: 'ok',
      files: ['src/a.ts'],
      localSessionId: 's-1'
    })

    expect(calls[0]).toEqual({
      url: '/v1/hub/workspaces',
      body: { dispatchable: true, workspaces: [{ id: 'ws-1', label: 'repo', description: '前端' }] }
    })
    expect(calls[1]).toEqual({
      url: '/v1/hub/relay/report',
      body: {
        taskId: 't-1',
        kind: 'done',
        summary: 'ok',
        files: ['src/a.ts'],
        localSessionId: 's-1'
      }
    })
  })

  it('idles instead of spinning when there is no credential', async () => {
    const states: boolean[] = []
    const delays: number[] = []
    const relay = new DispatchRelay({
      getClient: () => null,
      onFrame: () => {},
      onState: (state) => states.push(state.connected),
      delay: async (ms) => {
        delays.push(ms)
        await relay.stop()
      }
    })
    relay.start()
    await new Promise((resolve) => setTimeout(resolve, 40))
    await relay.stop()
    expect(delays[0]).toBe(30_000)
    expect(states.every((value) => value === false)).toBe(true)
  })
})
