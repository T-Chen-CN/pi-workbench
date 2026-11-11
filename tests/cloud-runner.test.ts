import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// runner 会间接载入 client.ts（依赖 app-paths），测试里给个最小 electron 替身
const dirs = vi.hoisted(() => ({
  appDir: '',
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => dirs.appDir,
    getPath: () => dirs.appDir,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf-8').slice(4),
  },
}))
dirs.appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cloud-runner-'))

afterAll(() => {
  fs.rmSync(dirs.appDir, { recursive: true, force: true })
})

import { CloudApiError, type CloudClient } from '../electron/cloud/client'
import { CloudRunner, controlKindOf, CONTROL_POLL_MS } from '../electron/cloud/runner'
import { auditFile, recordApprovalDecision, resetAuditForTests } from '../electron/cloud/audit'
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
function makeRunner(streams: Array<Response | Error>, behavior: Behavior) {
  const frames: CloudFrame[] = []
  const opened: string[] = []
  let streamIndex = 0
  let statusIndex = 0

  const client: CloudClient = {
    baseUrl: 'https://api.example.com',
    rawBaseUrl: 'https://api.example.com',
    credential: 'key',
    request: async <T,>(path: string): Promise<T> => {
      // 会话详情：取尾部要靠 message_count（0 = 按旧行为取第一页）
      if (path === '/api/sessions/s-1') return { id: 's-1', message_count: 0 } as T
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
      if (response instanceof Error) throw response
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

  it('stops following when the gateway says the run already ended', async () => {
    // 实测故障（2026-11-09 10:34）：服务端回 `这一轮已经结束了`，客户端却按退避
    // 又试了三次，8 秒后才推一条「事件流多次中断」的假故障。
    const ended = new CloudApiError('not_found', '这一轮已经结束了', { status: 404 })
    const { runner, frames, opened } = makeRunner([ended], { statuses: ['completed'] })

    await runner.start({ input: 'hi', sessionId: 's-1', idempotencyKey: 'k-ended' })
    await waitFor(() => frames.some((item) => item.kind === 'parts'))

    // 只开了一次流：没有退避重试
    expect(opened).toHaveLength(1)
    // 也没有假故障：收尾用的是状态接口给的终态
    expect(frames.some((item) => item.kind === 'error')).toBe(false)
    const run = frames.filter((item) => item.kind === 'run').pop()
    expect(run && 'state' in run ? run.state : '').toBe('completed')
  }, 15_000)

  it('says the stream was closed when the status still claims it is running', async () => {
    // 服务端自相矛盾（事件流说结束、状态接口说 running）：不能留一个永远转圈的界面，
    // 也不该谎称「多次中断」。
    const ended = new CloudApiError('conflict', '这一轮已经结束了', { status: 409 })
    const { runner, frames, opened } = makeRunner([ended], { statuses: ['running'] })

    await runner.start({ input: 'hi', sessionId: 's-1', idempotencyKey: 'k-lie' })
    await waitFor(() => frames.some((item) => item.kind === 'error'))

    expect(opened).toHaveLength(1)
    const error = frames.find((item) => item.kind === 'error')
    const message = error && 'error' in error ? error.error : ''
    expect(message).toContain('事件流已被服务端关闭')
    expect(message).not.toContain('多次中断')
  }, 15_000)

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

describe('帧的会话归属', () => {
  it('tags every frame with the session it belongs to', async () => {
    // A 在跑的时候用户可能切到 B：渲染层只靠这个字段判断帧该不该写进当前时间线
    const { runner, frames } = makeRunner(
      [sseStream([frame('message.delta', { delta: 'hello' }, 1), frame('run.completed', {}, 2)])],
      { statuses: ['running', 'completed'] }
    )

    await runner.start({ input: 'hi', sessionId: 's-1', idempotencyKey: 'k-tag' })
    await waitFor(() => frames.some((item) => item.kind === 'run' && item.state === 'completed'))

    const tagged = frames.filter((item) => item.kind !== 'session')
    expect(tagged.length).toBeGreaterThan(0)
    for (const item of tagged) expect(item.sessionId).toBe('s-1')
    // `session` 帧自己就是会话 id 的来源
    expect(frames.find((item) => item.kind === 'session')).toMatchObject({ sessionId: 's-1' })
    // 这一轮流得很干净：收尾**不**推整段历史，否则会把刚上屏的消息替换掉
    expect(frames.some((item) => item.kind === 'parts')).toBe(false)
  })
})

describe('并行跑两轮', () => {
  /** 永不结束的事件流：两轮同时挂着，才能验「同时跟随」 */
  function hangingStream(): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start() {
          // 故意不 close：reader 会一直 await
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  }

  function makeConcurrentRunner() {
    const frames: CloudFrame[] = []
    const opened: string[] = []
    let created = 0
    const client: CloudClient = {
      baseUrl: 'https://api.example.com',
      rawBaseUrl: 'https://api.example.com',
      credential: 'key',
      request: async <T,>(requestPath: string): Promise<T> => {
        // 会话详情：取尾部要靠 message_count（0 = 按旧行为取第一页）
        if (requestPath === '/api/sessions/s-1') return { id: 's-1', message_count: 0 } as T
        if (requestPath === '/v1/runs') {
          created += 1
          return { run_id: `run-${created}`, status: 'queued' } as T
        }
        // 状态探测：保持 running，谁都不许自动收尾；不给 session_id，
        // 让 start() 用调用方传进来的那个（真实后端也只对新建的 run 才回填）
        return { status: 'running' } as T
      },
      openStream: async (requestPath: string) => {
        opened.push(requestPath)
        return hangingStream()
      },
    }
    const runner = new CloudRunner({ emit: (frame) => frames.push(frame) }, client)
    return { runner, frames, opened }
  }

  it('follows two runs at once and keeps their sessions apart', async () => {
    const { runner, frames, opened } = makeConcurrentRunner()
    try {
      const first = await runner.start({ input: 'a', sessionId: 's-a', idempotencyKey: 'k-a' })
      const second = await runner.start({ input: 'b', sessionId: 's-b', idempotencyKey: 'k-b' })

      await waitFor(() => opened.length === 2)
      // 第二条不许把第一条掐掉：这正是「切到 B 就把 A 掐死」的根因
      expect(runner.liveStreamCount).toBe(2)
      expect(runner.activeRunIdFor('s-a')).toBe(first.runId)
      expect(runner.activeRunIdFor('s-b')).toBe(second.runId)
      expect(opened).toEqual(['/v1/runs/run-1/events', '/v1/runs/run-2/events'])
      expect(frames.some((item) => item.kind === 'session' && item.sessionId === 's-b')).toBe(true)
    } finally {
      runner.dispose()
    }
  })

  it('refuses a third run instead of waiting for a 429 from the gateway', async () => {
    const { runner } = makeConcurrentRunner()
    try {
      await runner.start({ input: 'a', sessionId: 's-a', idempotencyKey: 'k-a' })
      await runner.start({ input: 'b', sessionId: 's-b', idempotencyKey: 'k-b' })
      await expect(
        runner.start({ input: 'c', sessionId: 's-c', idempotencyKey: 'k-c' })
      ).rejects.toThrow(/同时最多跟随 2 轮/)
      expect(runner.liveStreamCount).toBe(2)
    } finally {
      runner.dispose()
    }
  })

  it('steers the run the caller names, not the most recent one', async () => {
    const { runner } = makeConcurrentRunner()
    const steered: string[] = []
    const remote = runner.remoteApi as unknown as {
      steerRun: (runId: string, text: string) => Promise<unknown>
    }
    remote.steerRun = async (runId: string) => {
      steered.push(runId)
    }
    try {
      const first = await runner.start({ input: 'a', sessionId: 's-a', idempotencyKey: 'k-a' })
      await runner.start({ input: 'b', sessionId: 's-b', idempotencyKey: 'k-b' })

      await runner.steer(first.runId, '改一下')
      expect(steered).toEqual([first.runId])
    } finally {
      runner.dispose()
    }
  })
})

describe('clarify 兜底轮询', () => {
  it('synthesises the prompt from pending_controls when the stream never carried it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const frames: CloudFrame[] = []
    const client: CloudClient = {
      baseUrl: 'https://api.example.com',
      rawBaseUrl: 'https://api.example.com',
      credential: 'key',
      request: async <T,>(path: string): Promise<T> => {
        // 会话详情：取尾部要靠 message_count（0 = 按旧行为取第一页）
        if (path === '/api/sessions/s-1') return { id: 's-1', message_count: 0 } as T
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

describe('审批兜底轮询', () => {
  it('synthesises the approval card from pending_controls', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const frames: CloudFrame[] = []
    const client: CloudClient = {
      baseUrl: 'https://api.example.com',
      rawBaseUrl: 'https://api.example.com',
      credential: 'key',
      request: async <T,>(path: string): Promise<T> => {
        // 会话详情：取尾部要靠 message_count（0 = 按旧行为取第一页）
        if (path === '/api/sessions/s-1') return { id: 's-1', message_count: 0 } as T
        if (path === '/v1/runs') return { run_id: 'run-1', status: 'queued' } as T
        if (path === '/api/sessions/s-1/messages') {
          return { data: [], session_id: 's-1' } as T
        }
        // SSE 里错过了 approval.request，但状态里挂着待审批
        return {
          status: 'waiting_for_approval',
          session_id: 's-1',
          pending_controls: [
            {
              kind: 'approval',
              prompt_id: 'ap_3',
              execution_generation: 8,
              command: 'systemctl restart caddy',
              pattern_keys: ['systemctl restart'],
              choices: ['once', 'session', 'deny', 'always'],
              timeout_s: 120,
            },
          ],
        } as T
      },
      openStream: async () => {
        const body = new ReadableStream<Uint8Array>({ start() {} })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      },
    }
    const runner = new CloudRunner({ emit: (frame) => frames.push(frame) }, client)
    await runner.start({ input: 'hi', sessionId: 's-1', idempotencyKey: 'k-approval' })

    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS + 50)
    const part = frames.find(
      (frame) => frame.kind === 'part' && frame.part.type === 'approval'
    ) as { kind: 'part'; part: Extract<CloudFrame, { kind: 'part' }>['part'] } | undefined
    expect(part?.part).toMatchObject({
      type: 'approval',
      requestId: 'ap_3',
      command: 'systemctl restart caddy',
      patternKeys: ['systemctl restart'],
      generation: 8,
      timeoutSeconds: 120,
    })
    // always 不进我们的可选项
    expect(
      (part?.part as Extract<CloudFrame, { kind: 'part' }>['part'] & { choices: string[] }).choices
    ).not.toContain('always')

    // 第二轮不会重复推同一张卡
    const before = frames.filter((frame) => frame.kind === 'part').length
    await vi.advanceTimersByTimeAsync(CONTROL_POLL_MS + 50)
    expect(frames.filter((frame) => frame.kind === 'part').length).toBe(before)

    runner.dispose()
    vi.useRealTimers()
  })
})

describe('控制项识别', () => {
  it('tells approvals from clarifies by kind or by shape', () => {
    expect(controlKindOf({ kind: 'approval' })).toBe('approval')
    expect(controlKindOf({ kind: 'clarify' })).toBe('clarify')
    // 服务端版本差异：只看字段形状也能认出来
    expect(controlKindOf({ command: 'rm -rf /tmp/x' })).toBe('approval')
    expect(controlKindOf({ pattern_keys: ['rm -rf'] })).toBe('approval')
    expect(controlKindOf({ question: '继续吗？' })).toBe('clarify')
    expect(controlKindOf({})).toBeNull()
  })
})

/** 手控的 SSE 流：可以按真实时序注入事件（审批挂起时流是敞着的） */
function liveStream(): { response: Response; push: (chunk: string) => void; close: () => void } {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    push: (chunk) => controller?.enqueue(encoder.encode(chunk)),
    close: () => controller?.close(),
  }
}

function auditLines(): Array<Record<string, unknown>> {
  if (!fs.existsSync(auditFile())) return []
  return fs
    .readFileSync(auditFile(), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('审批结果对号', () => {
  beforeEach(() => {
    resetAuditForTests()
  })

  it('pairs the guarded tool call and ignores unrelated tool results', async () => {
    const stream = liveStream()
    const client: CloudClient = {
      baseUrl: 'https://api.example.com',
      rawBaseUrl: 'https://api.example.com',
      credential: 'key',
      request: async <T,>(p: string): Promise<T> => {
        // 会话详情：取尾部要靠 message_count（0 = 按旧行为取第一页）
        if (p === '/api/sessions/s-1') return { id: 's-1', message_count: 0 } as T
        if (p === '/v1/runs') return { run_id: 'run-1', status: 'queued' } as T
        if (p === '/api/sessions/s-1/messages') return { data: [], session_id: 's-1' } as T
        return { status: 'running', session_id: 's-1' } as T
      },
      openStream: async () => stream.response,
    }
    const runner = new CloudRunner({ emit: () => {} }, client)
    void runner.start({ input: 'hi', sessionId: 's-1', idempotencyKey: 'k' })

    await waitFor(() => true)
    stream.push(frame('tool.started', { tool: 'terminal', preview: 'rm -rf /tmp/x', tool_call_id: 'c1' }, 0))
    stream.push(
      frame(
        'approval.request',
        { prompt_id: 'ap_1', command: 'rm -rf /tmp/x', description: 'delete in root path' },
        1
      )
    )
    await waitFor(() => runner.approvalToolCallId('ap_1') === 'c1')

    // 用户点「本次允许」：主进程写审计（带 toolCallId），服务端随后才执行工具
    recordApprovalDecision({
      runId: 'run-1',
      command: 'rm -rf /tmp/x',
      patternKeys: ['delete in root path'],
      choice: 'once',
      mode: 'manual',
      toolCallId: runner.approvalToolCallId('ap_1'),
    })

    // 另一个无关工具的终态：不该拿去充数
    stream.push(frame('tool.completed', { tool: 'read_file', tool_call_id: 'c2', error: false }, 2))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(auditLines().some((line) => line.kind === 'approval_result')).toBe(false)

    stream.push(frame('tool.completed', { tool: 'terminal', tool_call_id: 'c1', error: false, preview: '已删除' }, 3))
    await waitFor(() => auditLines().some((line) => line.kind === 'approval_result'))
    const result = auditLines().find((line) => line.kind === 'approval_result')
    expect(result).toMatchObject({ error: false })
    stream.push(frame('run.completed', {}, 4))
    runner.dispose()
  })

  it('still pairs the outcome when the result only arrives through history', async () => {
    // 断流：审批之后没有任何实时事件，结果只能靠 reconcile 拉历史回来
    const stream = liveStream()
    const client: CloudClient = {
      baseUrl: 'https://api.example.com',
      rawBaseUrl: 'https://api.example.com',
      credential: 'key',
      request: async <T,>(p: string): Promise<T> => {
        // 会话详情：取尾部要靠 message_count（0 = 按旧行为取第一页）
        if (p === '/api/sessions/s-1') return { id: 's-1', message_count: 0 } as T
        if (p === '/v1/runs') return { run_id: 'run-1', status: 'queued' } as T
        if (p.startsWith('/api/sessions/s-1/messages')) {
          return {
            data: [
              {
                id: 'm1',
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'c9',
                    call_id: 'c9',
                    type: 'function',
                    function: { name: 'terminal', arguments: '{"command":"rm -rf /tmp/x"}' },
                  },
                ],
              },
              {
                id: 'm2',
                role: 'tool',
                tool_call_id: 'c9',
                tool_name: 'terminal',
                content: '{"output":"已删除","exit_code":0,"error":null}',
              },
            ],
            session_id: 's-1',
          } as T
        }
        return { status: 'completed', session_id: 's-1' } as T
      },
      openStream: async () => stream.response,
    }
    const runner = new CloudRunner({ emit: () => {} }, client)
    void runner.start({ input: 'hi', sessionId: 's-1', idempotencyKey: 'k' })

    await waitFor(() => true)
    stream.push(frame('tool.started', { tool: 'terminal', tool_call_id: 'c9' }, 0))
    stream.push(frame('approval.request', { prompt_id: 'ap_9', command: 'rm -rf /tmp/x' }, 1))
    await waitFor(() => runner.approvalToolCallId('ap_9') === 'c9')
    recordApprovalDecision({
      runId: 'run-1',
      command: 'rm -rf /tmp/x',
      choice: 'once',
      mode: 'manual',
      toolCallId: 'c9',
    })
    // 流结束（服务端没再推 tool.completed）
    stream.close()

    await waitFor(() => auditLines().some((line) => line.kind === 'approval_result'))
    const result = auditLines().find((line) => line.kind === 'approval_result')
    expect(result).toMatchObject({ error: false })
    expect(String(result?.preview)).toContain('已删除')
    runner.dispose()
  })

  it('waits for the real preview instead of logging an empty result', async () => {
    // 实时 tool.completed 的 preview 就是空的；历史里才有真结果 → 用历史那份
    const stream = liveStream()
    const client: CloudClient = {
      baseUrl: 'https://api.example.com',
      rawBaseUrl: 'https://api.example.com',
      credential: 'key',
      request: async <T,>(p: string): Promise<T> => {
        // 会话详情：取尾部要靠 message_count（0 = 按旧行为取第一页）
        if (p === '/api/sessions/s-1') return { id: 's-1', message_count: 0 } as T
        if (p === '/v1/runs') return { run_id: 'run-1', status: 'queued' } as T
        if (p.startsWith('/api/sessions/s-1/messages')) {
          return {
            data: [
              {
                id: 'm1',
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'c1',
                    call_id: 'c1',
                    type: 'function',
                    function: { name: 'terminal', arguments: '{"command":"rm -rf /tmp/x"}' },
                  },
                ],
              },
              {
                id: 'm2',
                role: 'tool',
                tool_call_id: 'c1',
                tool_name: 'terminal',
                content: '{"output":"BLOCKED: 用户拒绝","exit_code":-1,"error":"blocked"}',
              },
            ],
            session_id: 's-1',
          } as T
        }
        return { status: 'completed', session_id: 's-1' } as T
      },
      openStream: async () => stream.response,
    }
    const runner = new CloudRunner({ emit: () => {} }, client)
    void runner.start({ input: 'hi', sessionId: 's-1', idempotencyKey: 'k' })

    stream.push(frame('tool.started', { tool: 'terminal', tool_call_id: 'c1' }, 0))
    stream.push(frame('approval.request', { prompt_id: 'ap_2', command: 'rm -rf /tmp/x' }, 1))
    await waitFor(() => runner.approvalToolCallId('ap_2') === 'c1')
    recordApprovalDecision({
      runId: 'run-1',
      command: 'rm -rf /tmp/x',
      choice: 'deny',
      mode: 'manual',
      toolCallId: 'c1',
    })
    stream.push(frame('tool.completed', { tool: 'terminal', tool_call_id: 'c1', error: true, preview: '' }, 2))
    await new Promise((resolve) => setTimeout(resolve, 30))
    // 空预览不落盘：宁缺毋滥
    expect(auditLines().some((line) => line.kind === 'approval_result')).toBe(false)

    stream.push(frame('run.completed', {}, 3))
    stream.close()
    await waitFor(() => auditLines().some((line) => line.kind === 'approval_result'))
    const result = auditLines().find((line) => line.kind === 'approval_result')
    expect(result).toMatchObject({ error: true, exitCode: -1 })
    expect(String(result?.preview)).toContain('BLOCKED')
    runner.dispose()
  })
})

describe('接回在跑的一轮（重启后 attach）', () => {
  interface AttachBehavior {
    /** 状态依次返回：接上时一次，收尾校正一次 */
    status: string | string[]
    /** 状态接口抛错时的错误（模拟 404 之类） */
    statusError?: Error
    streams?: Response[]
    /** 历史请求前先等等（模拟「run 比历史先结束」） */
    beforeMessages?: () => Promise<void>
  }

  function makeAttachRunner(behavior: AttachBehavior) {
    const frames: CloudFrame[] = []
    const opened: string[] = []
    let streamIndex = 0
    let statusIndex = 0
    const statuses = Array.isArray(behavior.status) ? behavior.status : [behavior.status]
    const client: CloudClient = {
      baseUrl: 'https://api.example.com',
      rawBaseUrl: 'https://api.example.com',
      credential: 'key',
      request: async <T,>(path: string): Promise<T> => {
        // 会话详情：取尾部要靠 message_count（0 = 按旧行为取第一页）
        if (path === '/api/sessions/s-1') return { id: 's-1', message_count: 0 } as T
        if (path.startsWith('/api/sessions/s-1/messages')) {
          if (behavior.beforeMessages) await behavior.beforeMessages()
          return {
            data: [
              { id: 'm-1', role: 'user', content: 'hi' },
              { id: 'm-2', role: 'assistant', content: '历史里的半句话' },
            ],
            session_id: 's-1',
          } as T
        }
        if (behavior.statusError) throw behavior.statusError
        const status = statuses[Math.min(statusIndex, statuses.length - 1)]
        statusIndex += 1
        return { status, session_id: 's-1' } as T
      },
      openStream: async (path: string) => {
        opened.push(path)
        const streams = behavior.streams ?? []
        return streams[streamIndex++] ?? sseStream([])
      },
    }
    const runner = new CloudRunner({ emit: (frame) => frames.push(frame) }, client)
    return { runner, frames, opened }
  }

  it('subscribes live-only and puts history before the buffered delta', async () => {
    const { runner, frames, opened } = makeAttachRunner({
      status: 'running',
      streams: [
        sseStream([
          frame('message.delta', { delta: '接上之后的半句' }, 42),
          frame('run.completed', {}, 43),
        ]),
      ],
    })

    const result = await runner.attach({ runId: 'run-9', sessionId: 's-1' })
    expect(result).toMatchObject({ attached: true, runId: 'run-9', sessionId: 's-1' })
    await waitFor(() => frames.some((item) => item.kind === 'parts'))

    // 关键：不带 last_seq 会从 seq 0 回放整轮，重启后时间线会重复一遍
    expect(opened[0]).toBe(`/v1/runs/run-9/events?last_seq=2147483647`)

    const partsIndex = frames.findIndex((item) => item.kind === 'parts')
    const dividerIndex = frames.findIndex(
      (item) => item.kind === 'part' && item.part.type === 'divider'
    )
    const deltaIndex = frames.findIndex(
      (item) => item.kind === 'part' && item.part.type === 'text' && item.part.id.startsWith('s:')
    )
    // 历史先铺，分隔线其次，增量最后 —— 否则全量替换会把刚推来的卡片冲掉
    expect(partsIndex).toBeGreaterThanOrEqual(0)
    expect(dividerIndex).toBeGreaterThan(partsIndex)
    expect(deltaIndex).toBeGreaterThan(dividerIndex)
    const divider = frames.find((item) => item.kind === 'part' && item.part.type === 'divider')
    expect(divider).toMatchObject({ kind: 'part', part: { kind: 'reattach' } })
    runner.dispose()
  })

  it('does not subscribe again when the same run is already being followed', async () => {
    const { runner, opened } = makeAttachRunner({
      status: 'running',
      streams: [sseStream([])],
    })
    await runner.attach({ runId: 'run-9', sessionId: 's-1' })
    const again = await runner.attach({ runId: 'run-9' })
    expect(again.attached).toBe(true)
    expect(opened).toHaveLength(1)
    runner.dispose()
  })

  it('only reconciles a finished run instead of subscribing', async () => {
    const { runner, frames, opened } = makeAttachRunner({ status: 'completed' })
    const result = await runner.attach({ runId: 'run-9', sessionId: 's-1' })
    expect(result).toMatchObject({ attached: false, state: 'completed' })
    expect(opened).toHaveLength(0)
    await waitFor(() => frames.some((item) => item.kind === 'run'))
    expect(frames.some((item) => item.kind === 'parts')).toBe(true)
    expect(frames.find((item) => item.kind === 'run')).toMatchObject({ state: 'completed' })
    runner.dispose()
  })

  it('surfaces a lost run as unknown so the resolve action can be offered', async () => {
    const { runner, frames, opened } = makeAttachRunner({ status: 'unknown' })
    const result = await runner.attach({ runId: 'run-9', sessionId: 's-1' })
    expect(result).toMatchObject({ attached: false, state: 'unknown' })
    expect(opened).toHaveLength(0)
    await waitFor(() => frames.some((item) => item.kind === 'run'))
    expect(frames.find((item) => item.kind === 'run')).toMatchObject({ state: 'unknown' })
    runner.dispose()
  })

  it('still reports the terminal state when the run ends before history lands', async () => {
    // 这条路径下终态增量落在缓冲里被丢弃：必须有收尾校正补一次终态帧，
    // 否则界面会永远停在「运行中」
    let open: (() => void) | null = null
    const held = new Promise<void>((resolve) => {
      open = resolve
    })
    const { runner, frames } = makeAttachRunner({
      status: ['running', 'completed'],
      streams: [sseStream([frame('message.delta', { delta: '说完就结束' }, 9), frame('run.completed', {}, 10)])],
      beforeMessages: () => held,
    })

    const result = await runner.attach({ runId: 'run-9', sessionId: 's-1' })
    expect(result.attached).toBe(true)
    await waitFor(() => frames.some((item) => item.kind === 'run' && item.state === 'completed'))

    open!()
    await waitFor(() => frames.some((item) => item.kind === 'parts'))
    // 被丢弃的增量不该再露头（历史已经是权威）
    expect(frames.some((item) => item.kind === 'part' && item.part.id.startsWith('s:text'))).toBe(
      false
    )
    expect(frames.filter((item) => item.kind === 'run' && item.state === 'completed')).toHaveLength(1)
    runner.dispose()
  })

  it('propagates not_found so the caller can drop a stale record', async () => {
    const { runner } = makeAttachRunner({
      status: 'running',
      statusError: new CloudApiError('not_found', 'run 不存在'),
    })
    await expect(runner.attach({ runId: 'run-gone' })).rejects.toBeInstanceOf(CloudApiError)
    runner.dispose()
  })
})
