import { describe, expect, it, vi } from 'vitest'

// runner 会间接载入 client.ts（依赖 app-paths），测试里给个最小 electron 替身
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/tmp', getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf-8').slice(4),
  },
}))
import type { CloudClient } from '../electron/cloud/client'
import { CloudRunner, CONTROL_POLL_MS } from '../electron/cloud/runner'
import type { CloudFrame } from '../electron/cloud/types'

function sseStream(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function frame(event: string, payload: Record<string, unknown> = {}, id = 1): string {
  return `id: ${id}\ndata: ${JSON.stringify({ event, ...payload })}\n\n`
}

interface Behavior {
  /** 依次返回的状态：探测时看到 running 才会续订 */
  statuses: string[]
}

/** 用假的 CloudClient 驱动 runner：只关心「断流后能不能续上」 */
function makeRunner(streams: Response[], behavior: Behavior) {
  const frames: CloudFrame[] = []
  const opened: string[] = []
  let streamIndex = 0
  let statusIndex = 0

  const client: CloudClient = {
    baseUrl: 'https://api.example.com',
    rawBaseUrl: 'https://api.example.com',
    apiKey: 'key',
    request: async <T,>(path: string): Promise<T> => {
      if (path === '/v1/runs') return { run_id: 'run-1', status: 'queued' } as T
      if (path === '/api/sessions/s-1/messages') {
        return {
          data: [
            {
              id: 'm-1',
              role: 'assistant',
              content: 'done',
              timestamp: 1_700_000_000,
            },
          ],
          session_id: 's-1',
        } as T
      }
      const status =
        behavior.statuses[Math.min(statusIndex, behavior.statuses.length - 1)] ?? 'running'
      statusIndex += 1
      return { status, session_id: 's-1' } as T
    },
    openStream: async (path: string) => {
      opened.push(path)
      const response = streams[streamIndex] ?? sseStream([])
      streamIndex += 1
      return response
    },
  }

  const runner = new CloudRunner({ emit: (frame) => frames.push(frame) }, client)
  return { runner, frames, opened }
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('CloudRunner 断流续订', () => {
  it('resubscribes with last_seq when the stream dies mid-run', async () => {
    vi.useRealTimers()
    const { runner, frames, opened } = makeRunner(
      [
        // 第一次：只流了一个 delta 就断了（没有终态）
        sseStream([frame('message.delta', { delta: '半句话' }, 3)]),
        // 第二次：带 last_seq 续上，正常结束
        sseStream([frame('message.delta', { delta: '，接下来' }, 4), frame('run.completed', {}, 5)]),
      ],
      // start() 先探一次拿 session_id，之后每次断流续订再探
      { statuses: ['running', 'running', 'completed'] }
    )

    await runner.start({ input: 'hi', sessionId: 's-1', idempotencyKey: 'k1' })
    await waitFor(() => frames.some((item) => item.kind === 'parts'))

    expect(opened).toHaveLength(2)
    expect(opened[0]).toBe('/v1/runs/run-1/events')
    expect(opened[1]).toBe('/v1/runs/run-1/events?last_seq=3')
    expect(frames.some((item) => item.kind === 'error')).toBe(false)
    expect(frames.filter((item) => item.kind === 'part')).toHaveLength(2)
    expect(frames[frames.length - 1]?.kind).toBe('parts')
  })

  it('gives up with an error frame when every retry dies and the run is still active', async () => {
    // 断流后状态一直是 running：续订到上限就报错收尾，不能把界面永久卡在「执行中」
    const { runner, frames, opened } = makeRunner(
      [sseStream([]), sseStream([]), sseStream([]), sseStream([])],
      { statuses: ['running'] }
    )

    await runner.start({ input: 'hi', sessionId: 's-1', idempotencyKey: 'k2' })
    await waitFor(() => frames.some((item) => item.kind === 'error'))
    await waitFor(() => frames.some((item) => item.kind === 'parts'))

    expect(opened).toHaveLength(4)
    expect(opened.slice(1).every((path) => path.includes('last_seq') || opened.length === 4)).toBe(
      true
    )
    const error = frames.find((item) => item.kind === 'error')
    expect(error && 'error' in error ? error.error : '').toContain('事件流多次中断')
  }, 15_000)
})

describe('clarify 兜底轮询', () => {
  it('synthesises the prompt from pending_controls when the stream never carried it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const frames: CloudFrame[] = []
    const client: CloudClient = {
      baseUrl: 'https://api.example.com',
      rawBaseUrl: 'https://api.example.com',
      apiKey: 'key',
      request: async <T,>(path: string): Promise<T> => {
        if (path === '/v1/runs') return { run_id: 'run-1', status: 'queued' } as T
        if (path === '/api/sessions/s-1/messages') {
          return { data: [], session_id: 's-1' } as T
        }
        // 流里没推 clarify.request，但状态里挂着这条提问
        return {
          status: 'running',
          session_id: 's-1',
          pending_controls: [
            {
              kind: 'clarify',
              prompt_id: 'cl_9',
              execution_generation: 2,
              question: '要继续吗？',
              choices: ['继续', '停'],
              timeout_s: 300,
            },
          ],
        } as T
      },
      openStream: async () => {
        // 一直开着但不推任何事件
        const body = new ReadableStream<Uint8Array>({ start() {} })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      },
    }
    const runner = new CloudRunner({ emit: (frame) => frames.push(frame) }, client)
    await runner.start({ input: 'hi', sessionId: 's-1', idempotencyKey: 'k-clarify' })

    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS + 50)
    const clarify = frames.find(
      (frame) => frame.kind === 'part' && frame.part.type === 'clarify'
    ) as { kind: 'part'; part: Extract<CloudFrame, { kind: 'part' }>['part'] } | undefined
    expect(clarify?.part).toMatchObject({
      type: 'clarify',
      promptId: 'cl_9',
      generation: 2,
      question: '要继续吗？',
      choices: ['继续', '停'],
    })

    // 第二轮轮询不会重复推同一张卡
    const before = frames.filter((frame) => frame.kind === 'part').length
    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS + 50)
    expect(frames.filter((frame) => frame.kind === 'part').length).toBe(before)

    runner.dispose()
    vi.useRealTimers()
  })
})
