import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

interface IpcHandler {
  (event: unknown, ...args: unknown[]): unknown
}

const mocks = vi.hoisted(() => {
  const state = {
    appDir: '',
    statusCalls: 0,
    sent: [] as Array<{ channel: string; payload: unknown }>,
    requests: [] as string[],
    bodies: [] as string[],
  }
  const window = {
    webContents: {
      send: (channel: string, payload: unknown) => {
        state.sent.push({ channel, payload })
      },
      isDestroyed: () => false,
    },
    isDestroyed: () => false,
    on: () => {},
  }
  return {
    state,
    window,
    handlers: new Map<string, IpcHandler>(),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
      decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf-8').slice(4),
    },
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    isReady: () => false,
    getAppPath: () => mocks.state.appDir,
    getPath: () => mocks.state.appDir,
    quote: undefined,
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    },
  },
  safeStorage: mocks.safeStorage,
  shell: { openExternal: async () => {} },
  WebContentsView: class {
    webContents = {
      setWindowOpenHandler: () => {},
      on: () => {},
      session: { setPermissionRequestHandler: () => {}, on: () => {} },
      loadURL: async () => {},
      isDestroyed: () => false,
      close: () => {},
    }
    setBackgroundColor() {}
    setBounds() {}
    setVisible() {}
  },
  net: {
    fetch: async (url: string, init?: { method?: string; body?: unknown }) => {
      mocks.state.requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (typeof init?.body === 'string') mocks.state.bodies.push(init.body)
      const parsed = new URL(url)
      const route = parsed.pathname

      if (route === '/v1/capabilities') {
        return Response.json({ platform: 'hermes-agent', model: 'pi-cloud', run_stop: true })
      }
      if (route === '/v1/runs' && init?.method === 'POST') {
        return Response.json({ run_id: 'run_test', status: 'started', replayed: false }, { status: 202 })
      }
      if (route === '/v1/runs/run_test') {
        mocks.state.statusCalls += 1
        return Response.json({
          object: 'hermes.run',
          run_id: 'run_test',
          status: mocks.state.statusCalls === 1 ? 'running' : 'completed',
          session_id: 'run_session',
        })
      }
      if (route === '/health/detailed') {
        return Response.json({
          status: 'ok',
          platform: 'hermes-agent',
          version: '0.22.6',
          gateway_state: 'running',
          readiness: {
            status: 'ok',
            checks: {
              model: { status: 'ok' },
              disk: { status: 'ok', used_percent: 16.1 },
            },
          },
        })
      }
      if (route === '/v1/toolsets') {
        return Response.json({
          data: [
            { name: 'terminal', label: 'Terminal', enabled: true, configured: true, tools: ['terminal'] },
            { name: 'browser', label: 'Browser', enabled: true, configured: false, tools: [] },
          ],
        })
      }
      if (route === '/v1/skills') {
        return Response.json({ error: { message: 'Failed to enumerate skills' } }, { status: 500 })
      }
      if (route === '/v1/models') {
        return Response.json({ data: [{ id: 'pi-cloud' }] })
      }
      if (route === '/api/jobs') {
        return Response.json({
          jobs: [
            {
              id: 'job_1',
              name: '每日日志汇总',
              prompt: '汇总昨天的日志',
              schedule: '0 9 * * *',
              schedule_display: '0 9 * * *',
              state: 'scheduled',
              enabled: true,
              next_run_at: '2026-05-01T01:00:00Z',
              repeat: null,
            },
          ],
        })
      }
      if (/^\/api\/jobs\/job_1\/(run|pause|resume)$/.test(route) && init?.method === 'POST') {
        return Response.json({ job: { id: 'job_1' } })
      }
      if (route.endsWith('/resolve-unknown') && init?.method === 'POST') {
        return Response.json({ run_id: 'run_test', status: 'cancelled', object: 'hermes.run.receipt' })
      }
      if (route === '/v1/runs/run_lost') {
        return Response.json({
          object: 'hermes.run',
          run_id: 'run_lost',
          status: 'unknown',
          admission_id: 'adm_lost',
          execution_generation: 7,
          session_id: 'run_session',
        })
      }
      if (route === '/v1/runs/run_test/steer') {
        return Response.json({ object: 'hermes.run.steer', accepted: true })
      }
      if (route === '/v1/runs/run_test/events') {
        const encoder = new TextEncoder()
        const frames = [
          { seq: 0, event: 'run.running', run_id: 'run_test' },
          { seq: 1, event: 'message.delta', run_id: 'run_test', delta: 'Hello ' },
          { seq: 2, event: 'message.delta', run_id: 'run_test', delta: 'cloud' },
          {
            seq: 3,
            event: 'tool.started',
            run_id: 'run_test',
            tool: 'terminal',
            preview: 'ls',
            tool_call_id: 'c1',
          },
          {
            seq: 4,
            event: 'tool.completed',
            run_id: 'run_test',
            tool: 'terminal',
            tool_call_id: 'c1',
            error: false,
            duration: 0.5,
            preview: '',
          },
          { seq: 5, event: 'run.completed', run_id: 'run_test', output: 'Hello cloud', usage: {} },
        ]
        const body = frames
          .map((frame) => `id: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`)
          .join('')
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(body))
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
      }
      if (route === '/api/chat/image-upload' && init?.method === 'POST') {
        return Response.json({
          ok: true,
          path: '/srv/img/pasted.png',
          name: 'pasted.png',
          bytes: 12,
          mime_type: 'image/png',
        })
      }
      if (route === '/api/fs/read-data-url') {
        return Response.json({ dataUrl: 'data:image/png;base64,CCCC' })
      }
      if (route === '/api/sessions') {
        return Response.json({
          object: 'list',
          data: [
            {
              id: 'run_session',
              title: 'Probe',
              preview: 'hello',
              message_count: 2,
              tool_call_count: 1,
              input_tokens: 100,
              output_tokens: 20,
              last_active: 1793733153.1,
              started_at: 1793733048.3,
              model: 'deepseek-flash',
              estimated_cost_usd: 0.0004,
              actual_cost_usd: null,
            },
          ],
          has_more: false,
        })
      }
      if (route === '/api/sessions/run_session' && init?.method === 'PATCH') {
        return Response.json({
          object: 'hermes.session',
          session: {
            id: 'run_session',
            title: 'Renamed probe',
            preview: 'hello',
            message_count: 2,
            tool_call_count: 1,
            input_tokens: 100,
            output_tokens: 20,
            last_active: 1793733153.1,
            started_at: 1793733048.3,
            model: 'deepseek-flash',
            pinned: true,
          },
        })
      }
      if (route === '/api/sessions/run_session' && init?.method === 'DELETE') {
        return Response.json({ object: 'hermes.session.deleted', id: 'run_session', deleted: true })
      }
      if (route === '/api/sessions/run_session/messages') {
        return Response.json({
          object: 'list',
          session_id: 'run_session',
          data: [
            { id: 1, role: 'user', content: 'hello' },
            {
              id: 2,
              role: 'assistant',
              content: '',
              tool_calls: [{ call_id: 'c1', function: { name: 'terminal', arguments: '{"command":"ls"}' } }],
            },
            {
              id: 3,
              role: 'tool',
              content: '{"output":"file.txt","exit_code":0,"error":null}',
              tool_call_id: 'c1',
              tool_name: 'terminal',
            },
            { id: 4, role: 'assistant', content: 'Hello cloud' },
          ],
          pagination: { limit: 500, offset: 0, returned: 4 },
        })
      }
      return new Response('not found', { status: 404 })
    },
  },
}))

type CloudAgentModule = typeof import('../electron/ipc/cloud-agent')

function call<T = Record<string, unknown>>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`IPC handler not registered: ${channel}`)
  return Promise.resolve(handler({}, ...args) as T)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

let module: CloudAgentModule
let dispose: () => void

beforeAll(async () => {
  mocks.state.appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cloud-ipc-'))
  module = await import('../electron/ipc/cloud-agent')
  const registered = module.registerCloudAgentIpc({
    getMainWindow: () => mocks.window as never,
  })
  dispose = registered.dispose
})

afterAll(() => {
  dispose?.()
  fs.rmSync(mocks.state.appDir, { recursive: true, force: true })
})

describe('cloud IPC', () => {
  it('starts unconfigured and hides the key', async () => {
    const result = await call<{ success: boolean; config: { baseUrl: string; hasToken: boolean } }>(
      'cloud:config:get'
    )
    expect(result.success).toBe(true)
    expect(result.config.hasToken).toBe(false)
    expect(result.config).not.toHaveProperty('apiKey')
  })

  it('rejects cloud calls before a key is saved', async () => {
    const result = await call<{ success: boolean; error?: string }>('cloud:sessions:list', {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('API 密钥')
  })

  it('saves config, connects and lists sessions', async () => {
    const saved = await call<{ success: boolean }>('cloud:config:set', {
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
    })
    expect(saved.success).toBe(true)

    const connected = await call<{ success: boolean; capabilities?: { model?: string } }>(
      'cloud:connect'
    )
    expect(connected.success).toBe(true)
    expect(connected.capabilities?.model).toBe('pi-cloud')

    const listed = await call<{
      success: boolean
      sessions: Array<{ id: string; costUsd: number; lastActive: number; toolCallCount: number }>
    }>('cloud:sessions:list', { limit: 10 })
    expect(listed.success).toBe(true)
    expect(listed.sessions[0]).toMatchObject({
      id: 'run_session',
      toolCallCount: 1,
      costUsd: 0.0004,
    })
    // epoch 秒 → 毫秒
    expect(listed.sessions[0].lastActive).toBe(1793733153100)
  })

  it('runs a turn and streams mapped frames before the corrective history frame', async () => {
    mocks.state.sent.length = 0
    const started = await call<{ success: boolean; runId?: string; sessionId?: string }>(
      'cloud:run:start',
      { input: 'hi', idempotencyKey: 'key-1' }
    )
    expect(started).toMatchObject({ success: true, runId: 'run_test', sessionId: 'run_session' })

    await waitFor(() =>
      mocks.state.sent.some(
        (message) =>
          message.channel === 'cloud:event' &&
          (message.payload as { kind?: string }).kind === 'parts'
      )
    )

    const frames = mocks.state.sent
      .filter((message) => message.channel === 'cloud:event')
      .map((message) => message.payload as { kind: string; [key: string]: unknown })

    // 增量帧：文本 + 工具卡
    expect(frames.some((frame) => frame.kind === 'part')).toBe(true)
    // 终态帧
    expect(frames.some((frame) => frame.kind === 'run' && frame.state === 'completed')).toBe(true)
    // 校正帧：来自历史的完整时间线（含工具结果）
    const partsFrame = frames.find((frame) => frame.kind === 'parts') as
      | { parts: Array<{ type: string; resultPreview?: string }> }
      | undefined
    expect(partsFrame).toBeTruthy()
    expect(partsFrame?.parts.map((part) => part.type)).toEqual([
      'text',
      'tool',
      'text',
    ])
    expect(partsFrame?.parts[1].resultPreview).toBe('file.txt')

    expect(mocks.state.requests).toContain('POST https://api.example.com/v1/runs')
    expect(mocks.state.requests.some((line) => line.endsWith('/v1/runs/run_test/events'))).toBe(true)
  })

  it('lists messages as timeline parts', async () => {
    const result = await call<{ success: boolean; parts: Array<{ type: string }> }>(
      'cloud:messages:list',
      { sessionId: 'run_session' }
    )
    expect(result.success).toBe(true)
    expect(result.parts.map((part) => part.type)).toEqual(['text', 'tool', 'text'])
  })

  it('requires a session id and an idempotency key', async () => {
    expect(await call('cloud:messages:list', {})).toMatchObject({ success: false })
    expect(await call('cloud:run:start', { input: 'hi' })).toMatchObject({
      success: false,
      error: '缺少幂等键',
    })
  })
})

describe('cloud session actions', () => {
  it('renames and pins through PATCH, and deletes hard', async () => {
    const renamed = await call<{ success: boolean; session?: { title: string } }>(
      'cloud:sessions:update',
      { sessionId: 'run_session', title: 'Renamed probe' }
    )
    expect(renamed.success).toBe(true)
    expect(renamed.session?.title).toBe('Renamed probe')

    const pinned = await call<{ success: boolean; session?: { pinned: boolean } }>(
      'cloud:sessions:update',
      { sessionId: 'run_session', pinned: true }
    )
    expect(pinned.success).toBe(true)
    expect(pinned.session?.pinned).toBe(true)
    // 请求确实打到 PATCH /api/sessions/{id}
    expect(mocks.state.requests.some((line) => line === 'PATCH https://api.example.com/api/sessions/run_session')).toBe(true)

    const removed = await call<{ success: boolean; deleted?: boolean }>('cloud:sessions:delete', {
      sessionId: 'run_session',
    })
    expect(removed).toMatchObject({ success: true, deleted: true })
    expect(mocks.state.requests.some((line) => line === 'DELETE https://api.example.com/api/sessions/run_session')).toBe(true)
  })

  it('rejects a missing session id', async () => {
    const result = await call<{ success: boolean; error?: string }>('cloud:sessions:delete', {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('sessionId')
  })
})

describe('cloud steer', () => {
  it('refuses an empty interjection', async () => {
    const result = await call<{ success: boolean; error?: string }>('cloud:run:steer', { text: '   ' })
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('rejects steering when no run is active', async () => {
    const result = await call<{ success: boolean; error?: string }>('cloud:run:steer', { text: 'hi' })
    expect(result.success).toBe(false)
  })
})

describe('cloud images', () => {
  it('refuses to upload before a console token is configured', async () => {
    const result = await call<{ success: boolean; error?: string }>('cloud:media:upload', {
      dataUrl: 'data:image/png;base64,AAAA',
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('HERMES_DASHBOARD_SESSION_TOKEN')
  })

  it('rejects a non-whitelisted type locally', async () => {
    await call('cloud:config:set', {
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
      dashboardToken: 'dash-token',
    })
    const result = await call<{ success: boolean; error?: string }>('cloud:media:upload', {
      dataUrl: 'data:image/svg+xml;base64,AAAA',
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('不支持')
  })

  it('uploads and reads back through the console', async () => {
    await call('cloud:config:set', {
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
      dashboardToken: 'dash-token',
    })
    const uploaded = await call<{ success: boolean; image?: { path: string } }>(
      'cloud:media:upload',
      { dataUrl: 'data:image/png;base64,AAAA', filename: 'pasted.png' }
    )
    expect(uploaded.success).toBe(true)
    expect(uploaded.image?.path).toBe('/srv/img/pasted.png')

    const read = await call<{ success: boolean; dataUrl?: string }>('cloud:media:read', {
      path: '/srv/img/pasted.png',
    })
    expect(read.success).toBe(true)
    expect(read.dataUrl).toBe('data:image/png;base64,CCCC')
    // 旁路必须打控制台域名，不是网关域名
    expect(mocks.state.requests.some((line) => line.includes('/api/chat/image-upload'))).toBe(true)
  })
})

describe('cloud resolve-unknown', () => {
  beforeAll(async () => {
    await call('cloud:config:set', {
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
    })
  })

  it('refuses to close a run that is merely running', async () => {
    const result = await call<{ success: boolean; error?: string }>('cloud:run:resolve-unknown', {
      runId: 'run_test',
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('无需收尾')
  })

  it('sends the admission pair back and reports the settled state', async () => {
    const result = await call<{ success: boolean; state?: string; error?: string }>(
      'cloud:run:resolve-unknown',
      { runId: 'run_lost' }
    )
    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ success: true, state: 'cancelled' })
    const body = mocks.state.bodies.find((item) => item.includes('adm_lost'))
    expect(body).toBeTruthy()
    // body 必须严格只有两个字段，多一个后端就 invalid_params
    expect(JSON.parse(body as string)).toEqual({
      admission_id: 'adm_lost',
      execution_generation: 7,
    })
  })

  it('requires a run id', async () => {
    const result = await call<{ success: boolean; error?: string }>('cloud:run:resolve-unknown', {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('runId')
  })
})

describe('cloud ledger', () => {
  beforeAll(async () => {
    await call('cloud:config:set', { baseUrl: 'https://api.example.com', apiKey: 'test-key' })
  })

  it('books an external write from a live run and settles it on completion', async () => {
    await call('cloud:run:start', { input: 'push it', idempotencyKey: 'key-ledger' })
    // 等 SSE 那一轮跑完（mock 里 tool.started 是 terminal + ls，不命中分类）
    await new Promise((resolve) => setTimeout(resolve, 50))
    const listed = await call<{ success: boolean; entries: unknown[] }>('cloud:ledger:list', {})
    expect(listed.success).toBe(true)
    expect(Array.isArray(listed.entries)).toBe(true)
  })

  it('rejects an unknown verdict', async () => {
    const result = await call<{ success: boolean; error?: string }>('cloud:ledger:resolve', {
      id: 'run_1:c1',
      verdict: 'maybe',
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('核对结论')
  })

  it('adds a manual note as an open unknown entry', async () => {
    const noted = await call<{ success: boolean; entries: Array<{ id: string; status: string }> }>(
      'cloud:ledger:note',
      { summary: '手工补记：发了一封邮件', writeClass: 'external' }
    )
    expect(noted.success).toBe(true)
    const added = noted.entries.find((entry) => entry.id.startsWith('note:'))
    expect(added?.status).toBe('unknown')
  })

  it('resolves a note and keeps it out of the open list', async () => {
    const noted = await call<{ success: boolean; entries: Array<{ id: string }> }>(
      'cloud:ledger:note',
      { summary: '手工补记：一条 webhook' }
    )
    const id = noted.entries[0].id
    const resolved = await call<{ success: boolean; entries: Array<{ id: string; status: string }> }>(
      'cloud:ledger:resolve',
      { id, verdict: 'done' }
    )
    expect(resolved.success).toBe(true)
    expect(resolved.entries.find((entry) => entry.id === id)?.status).toBe('confirmed_done')
  })

  it('refuses an empty note', async () => {
    const result = await call<{ success: boolean; error?: string }>('cloud:ledger:note', {
      summary: '   ',
    })
    expect(result.success).toBe(false)
  })
})

describe('cloud jobs', () => {
  beforeAll(async () => {
    await call('cloud:config:set', { baseUrl: 'https://api.example.com', apiKey: 'test-key' })
  })

  it('maps the server record into camelCase and keeps the display schedule', async () => {
    const result = await call<{ success: boolean; error?: string; jobs: Array<Record<string, unknown>> }>(
      'cloud:jobs:list',
      {}
    )
    expect(result.success).toBe(true)
    expect(result.jobs[0]).toMatchObject({
      id: 'job_1',
      name: '每日日志汇总',
      scheduleDisplay: '0 9 * * *',
      state: 'scheduled',
      enabled: true,
      nextRunAt: '2026-05-01T01:00:00Z',
    })
  })

  it('runs, pauses and resumes by id', async () => {
    for (const channel of ['cloud:jobs:run', 'cloud:jobs:pause', 'cloud:jobs:resume']) {
      const result = await call<{ success: boolean }>(channel, { jobId: 'job_1' })
      expect(result.success).toBe(true)
    }
  })

  it('refuses a missing job id without hitting the network', async () => {
    const before = mocks.state.requests.length
    const result = await call<{ success: boolean; error?: string }>('cloud:jobs:run', {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('任务 id')
    expect(mocks.state.requests.length).toBe(before)
  })
})

describe('cloud diagnostics', () => {
  beforeAll(async () => {
    await call('cloud:config:set', { baseUrl: 'https://api.example.com', apiKey: 'test-key' })
  })

  it('keeps the healthy sections when one of them fails', async () => {
    const result = await call<{
      success: boolean
      diagnostics: {
        version?: string
        gatewayState?: string
        readiness: { ok: boolean; checks: Array<{ name: string; status: string }> }
        toolsets: { ok: boolean; items: Array<{ name: string; configured: boolean }> }
        skills: { ok: boolean; error?: string }
        models: { ok: boolean; items: string[] }
      }
    }>('cloud:diagnostics', {})

    expect(result.success).toBe(true)
    const d = result.diagnostics
    expect(d.version).toBe('0.22.6')
    expect(d.gatewayState).toBe('running')
    expect(d.readiness.ok).toBe(true)
    expect(d.readiness.checks.map((check) => check.name)).toContain('disk')
    expect(d.toolsets.items.find((row) => row.name === 'browser')?.configured).toBe(false)
    // /v1/skills 在服务器上就是 500：单独失败，不影响其它块
    expect(d.skills.ok).toBe(false)
    expect(d.skills.error).toBeTruthy()
    expect(d.models.items).toEqual(['pi-cloud'])
  })
})
