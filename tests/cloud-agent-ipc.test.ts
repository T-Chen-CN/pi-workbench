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
    liveStatusCalls: 0,
    sent: [] as Array<{ channel: string; payload: unknown }>,
    /** 云端通知：主进程发出的每一条（路由侧的前台/开关判断不在本层） */
    notifies: [] as Array<{
      kind: string
      title: string
      body: string
      workspaceDir: string | null
      sessionId: string
      cloud?: boolean
      requestId?: string
    }>,
    requests: [] as string[],
    bodies: [] as string[],
    /** 控制台配置里 approvals.mode 的当前值（模拟 PUT 之后读回） */
    configMode: 'manual' as string,
    /** 导出时保存对话框的落点（空 = 用户取消） */
    savePath: '' as string,
    /** 每次导出请求的 defaultPath，用来断言文件名 */
    saveDialogs: [] as string[],
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
    whenReady: async () => {},
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
  dialog: {
    showSaveDialog: async (_win: unknown, options?: { defaultPath?: string }) => {
      const target = mocks.state.savePath
      mocks.state.saveDialogs.push(options?.defaultPath ?? '')
      return target ? { canceled: false, filePath: target } : { canceled: true }
    },
  },
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
    fetch: async (
      url: string,
      init?: { method?: string; body?: unknown; headers?: Record<string, string> }
    ) => {
      mocks.state.requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (typeof init?.body === 'string') mocks.state.bodies.push(init.body)
      const parsed = new URL(url)
      const route = parsed.pathname

      // 网关（单入口）三个接口：设备自己、健康检查、配对与撤销
      if (route === '/v1/hub/health') {
        return Response.json({
          status: 'ok',
          hub: '0.1.0',
          upstream: 'http://127.0.0.1:8642',
          upstreamOk: true,
          upstreamVersion: '0.22.6',
          dashboard: 'http://127.0.0.1:9119',
          devices: { total: 1, active: 1, revoked: 0 },
          adminKeyConfigured: true,
          uptimeSeconds: 12,
        })
      }
      if (route === '/v1/hub/status') {
        const auth = String(init?.headers?.Authorization ?? '')
        if (!auth.startsWith('Bearer pi_hub_')) {
          return Response.json({ error: { code: 'unauthorized' } }, { status: 401 })
        }
        return Response.json({
          status: 'ok',
          hub: '0.1.0',
          contractVersion: 1,
          features: ['pairing'],
          upstream: 'http://127.0.0.1:8642',
          upstreamOk: true,
          upstreamVersion: '0.22.6-full',
          dashboard: 'https://dash.example.com',
          devices: { total: 3, active: 2, revoked: 1 },
          adminKeyConfigured: true,
          uptimeSeconds: 99
        })
      }
      if (route === '/v1/devices/me') {
        const auth = String(init?.headers?.Authorization ?? '')
        if (!auth.startsWith('Bearer pi_hub_')) {
          return Response.json({ error: { code: 'unauthorized' } }, { status: 401 })
        }
        return Response.json({
          deviceId: 'dev_from_gateway',
          name: 'TChen-Legion',
          scopes: ['chat', 'dispatch'],
          hub: '0.1.0',
        })
      }
      if (route === '/v1/devices/pair' && init?.method === 'POST') {
        const headers = init?.headers ?? {}
        const body = JSON.parse(String(init.body)) as { code: string; deviceId: string; name: string }
        // 配对请求绝不能携带管理凭据；带上就说明客户端走错了路
        if (headers['X-Pi-Admin-Key'] || headers.Authorization) {
          return Response.json({ error: { code: 'invalid_params' } }, { status: 400 })
        }
        if (body.code === 'PAIREXPIRED') {
          return Response.json({ error: { code: 'pairing_expired' } }, { status: 410 })
        }
        if (body.code === 'OLDPLUGIN') {
          return new Response('', { status: 404 })
        }
        if (body.code !== 'ABCDEFGHIJ') {
          return Response.json({ error: { code: 'pairing_not_found' } }, { status: 404 })
        }
        return Response.json(
          {
            deviceId: body.deviceId,
            name: body.name,
            scopes: ['chat', 'dispatch'],
            token: 'pi_hub_token_paired',
            tokenPrefix: 'pi_hub_paired',
            dashboardUrl: 'https://dash.example.com',
          },
          { status: 201 }
        )
      }
      if (route.startsWith('/v1/devices/') && route.endsWith('/revoke')) {
        return Response.json({ success: true })
      }
      if (route === '/v1/capabilities') {
        return Response.json({ platform: 'hermes-agent', model: 'pi-cloud', run_stop: true })
      }
      if (route === '/v1/runs' && init?.method === 'POST') {
        const body = String(init.body ?? '')
        const runId = body.includes('hang')
          ? 'run_hang'
          : body.includes('notify')
            ? 'run_notify'
            : body.includes('cancel')
              ? 'run_cancel'
              : 'run_test'
        return Response.json({ run_id: runId, status: 'started', replayed: false }, { status: 202 })
      }
      if (route === '/v1/runs/run_notify' || route === '/v1/runs/run_cancel') {
        const isNotify = route.endsWith('notify')
        return Response.json({
          object: 'hermes.run',
          run_id: isNotify ? 'run_notify' : 'run_cancel',
          status: isNotify ? 'running' : 'cancelled',
          session_id: isNotify ? 'notify_session' : 'cancel_session',
          execution_generation: 2,
        })
      }
      if (route === '/v1/runs/run_notify/events' || route === '/v1/runs/run_cancel/events') {
        const encoder = new TextEncoder()
        const isNotify = route.includes('run_notify')
        const runId = isNotify ? 'run_notify' : 'run_cancel'
        const frames: Array<Record<string, unknown>> = [
          { seq: 0, event: 'run.running', run_id: runId },
          { seq: 1, event: 'message.delta', run_id: runId, delta: 'Hello notify' }
        ]
        if (isNotify) {
          frames.push(
            {
              seq: 2,
              event: 'approval.request',
              run_id: runId,
              prompt_id: 'ap_1',
              execution_generation: 2,
              command: 'rm -rf /tmp/build',
              choices: ['once', 'session', 'deny'],
              timeout_s: 300
            },
            // 同一条审批重放：只该弹一条通知
            {
              seq: 3,
              event: 'approval.request',
              run_id: runId,
              prompt_id: 'ap_1',
              execution_generation: 2,
              command: 'rm -rf /tmp/build',
              choices: ['once', 'session', 'deny'],
              timeout_s: 300
            },
            {
              seq: 4,
              event: 'clarify.request',
              run_id: runId,
              prompt_id: 'cl_1',
              execution_generation: 2,
              question: '要清空哪个目录？',
              choices: ['/tmp/a', '/tmp/b']
            },
            { seq: 5, event: 'run.completed', run_id: runId, output: 'Hello notify', usage: {} }
          )
        } else {
          frames.push({ seq: 2, event: 'run.cancelled', run_id: runId })
        }
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
      if (route === '/v1/runs/run_hang') {
        return Response.json({
          object: 'hermes.run',
          run_id: 'run_hang',
          status: 'running',
          session_id: 'hang_session',
        })
      }
      if (route === '/v1/runs/run_hang/events') {
        // 一直开着、不收尾：验证「记录会一直留着」的那条用例
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      if (route === '/v1/runs/run_live') {
        // 接上时还在跑，收尾校正时已经结束（真实服务端就是这个顺序）
        mocks.state.liveStatusCalls += 1
        return Response.json({
          object: 'hermes.run',
          run_id: 'run_live',
          status: mocks.state.liveStatusCalls === 1 ? 'running' : 'completed',
          session_id: 'run_session',
        })
      }
      if (route === '/v1/runs/run_live/events') {
        const encoder = new TextEncoder()
        const frames = [
          { seq: 7, event: 'message.delta', run_id: 'run_live', delta: '接上之后' },
          { seq: 8, event: 'run.completed', run_id: 'run_live', output: '接上之后' },
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
      if (route === '/v1/runs/run_test') {
        mocks.state.statusCalls += 1
        return Response.json({
          object: 'hermes.run',
          run_id: 'run_test',
          status: mocks.state.statusCalls === 1 ? 'running' : 'completed',
          session_id: 'run_session',
          // 真实服务端会给这个：审批回执缺它会被 400 invalid_params
          execution_generation: 3,
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
      if (route === '/api/jobs' && init?.method !== 'POST' && !parsed.search.includes('include_disabled=true')) {
        return Response.json({ jobs: [] })
      }
      if (route === '/api/jobs' && init?.method !== 'POST') {
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
      if (route === '/api/jobs/job_1' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
        return Response.json({
          job: {
            id: 'job_1',
            name: body.name ?? '每日日志汇总',
            prompt: body.prompt ?? '汇总昨天的日志',
            schedule: body.schedule ?? '0 9 * * *',
            schedule_display: body.schedule ?? '0 9 * * *',
            state: 'scheduled',
            enabled: true,
            next_run_at: '2026-05-01T01:00:00Z',
            repeat: null,
          },
        })
      }
      if (route === '/api/jobs/job_1' && init?.method === 'DELETE') {
        return Response.json({ ok: true })
      }
      if (route === '/api/jobs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
        return Response.json({
          job: {
            id: 'job_new',
            name: body.name,
            prompt: body.prompt,
            schedule: body.schedule,
            schedule_display: body.schedule,
            state: 'scheduled',
            enabled: true,
            next_run_at: '2026-05-02T01:00:00Z',
            repeat: body.repeat ?? null,
          },
        })
      }
      if (/^\/api\/jobs\/job_1\/(run|pause|resume)$/.test(route) && init?.method === 'POST') {
        return Response.json({ job: { id: 'job_1' } })
      }
      if (route.endsWith('/clarify') && init?.method === 'POST') {
        return Response.json({ status: 'resolved', prompt_id: 'cl_1' })
      }
      if (route === '/api/config') {
        if (init?.method === 'PUT') {
          const patch = JSON.parse(String(init.body ?? '{}')) as {
            config?: { approvals?: { mode?: string } }
          }
          if (patch.config?.approvals?.mode) mocks.state.configMode = patch.config.approvals.mode
          return Response.json({ ok: true })
        }
        // 真实接口会把密钥解析成明文一起返回；策略层只允许取白名单子集
        return Response.json({
          approvals: {
            mode: mocks.state.configMode,
            timeout: 120,
            deny: ['rm -rf /', 'mkfs.*'],
          },
          agent: { disabled_toolsets: ['code_execution'] },
          terminal: { backend: 'local' },
          providers: { openai: { api_key: 'sk-should-never-leak' } },
        })
      }
      if (/\/v1\/runs\/[^/]+\/approval$/.test(route) && init?.method === 'POST') {
        return Response.json({ status: 'resolved', resolved: 1 })
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

import {
  clearActiveRun,
  readActiveRun,
  writeActiveRun,
} from '../electron/cloud/active-run'

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

/**
 * 把本地置成「已配对」状态：单入口之后没有 API 密钥这条路，
 * 所有需要凭据的用例都从这里起步（等价于连接页配对成功之后）。
 */
async function seedPairedDevice(): Promise<void> {
  const config = await import('../electron/cloud/config')
  config.writeCloudConfig({
    gatewayUrl: 'https://hub.example.com',
    deviceToken: 'pi_hub_token_paired',
    deviceScopes: ['chat', 'dispatch'],
    deviceId: 'dev-local',
  })
}

beforeAll(async () => {
  mocks.state.appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cloud-ipc-'))
  module = await import('../electron/ipc/cloud-agent')
  const registered = module.registerCloudAgentIpc({
    getMainWindow: () => mocks.window as never,
    getLanguage: () => 'zh',
    notify: (event) => {
      mocks.state.notifies.push(event)
      return true
    }
  })
  dispose = registered.dispose
})

afterAll(() => {
  dispose?.()
  fs.rmSync(mocks.state.appDir, { recursive: true, force: true })
})

describe('cloud IPC', () => {
  it('starts unregistered and never leaks a credential', async () => {
    const result = await call<{
      success: boolean
      config: { gatewayUrl: string; hasDeviceToken: boolean }
    }>('cloud:config:get')
    expect(result.success).toBe(true)
    expect(result.config.hasDeviceToken).toBe(false)
    // 单入口：连「API 密钥」这个概念都不该出现在公开配置里
    expect(result.config).not.toHaveProperty('apiKey')
    expect(result.config).not.toHaveProperty('deviceToken')
    // 网关地址没有内置默认值：未配置时就是空串（不会偷偷指向某个域名）
    expect(result.config.gatewayUrl).toBe('')
  })

  it('rejects cloud calls before a key is saved', async () => {
    const result = await call<{ success: boolean; error?: string }>('cloud:sessions:list', {})
    expect(result.success).toBe(false)
    // 单缝之后「没配置」= 这台设备还没配对
    expect(result.error).toMatch(/配对/)
  })

  it('connects and lists sessions after registration', async () => {
    await seedPairedDevice()

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

    expect(mocks.state.requests).toContain('POST https://hub.example.com/v1/runs')
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

describe('cloud notifications', () => {
  it('notifies the approval, the clarify and the finish of a run, once each', async () => {
    await seedPairedDevice()
    mocks.state.notifies.length = 0
    const started = await call<{ success: boolean }>('cloud:run:start', {
      input: 'notify me',
      idempotencyKey: 'notify-1'
    })
    expect(started.success).toBe(true)
    await waitFor(() => mocks.state.notifies.some((notice) => notice.kind === 'complete'))

    // 审批 → 澄清 → 收尾；重放的同一条审批不进第二条
    expect(mocks.state.notifies.map((notice) => notice.kind)).toEqual([
      'approval',
      'approval',
      'complete'
    ])

    const [approval, clarify, complete] = mocks.state.notifies
    // 云端会话没有工作区：点击后只能切云端页，不能去开同名目录
    expect(approval).toMatchObject({
      cloud: true,
      workspaceDir: null,
      sessionId: 'notify_session',
      requestId: 'ap_1',
      title: '云端需要审批'
    })
    expect(approval.body).toContain('rm -rf /tmp/build')
    // clarify 不是一类新通知：对用户来说一样是“这轮卡在等你”
    expect(clarify).toMatchObject({ kind: 'approval', requestId: 'cl_1', title: '云端在等你回答' })
    expect(clarify.body).toContain('要清空哪个目录')
    expect(complete).toMatchObject({
      kind: 'complete',
      sessionId: 'notify_session',
      title: '云端会话已完成'
    })
    // 正文取最近一段助手输出，方便不解手机就知道发生了什么
    expect(complete.body).toContain('Hello notify')
  })

  it('stays silent when the run is cancelled on purpose', async () => {
    await seedPairedDevice()
    mocks.state.notifies.length = 0
    await call('cloud:run:start', { input: 'cancel it', idempotencyKey: 'notify-2' })
    await waitFor(() =>
      mocks.state.sent.some((message) => {
        const payload = message.payload as { kind?: string; state?: string }
        return message.channel === 'cloud:event' && payload.state === 'cancelled'
      })
    )
    expect(mocks.state.notifies).toHaveLength(0)
  })
})

describe('cloud device identity', () => {
  interface DeviceResult {
    success: boolean
    device?: { id: string; name: string; defaultName: string }
  }

  it('creates an identity on first read and keeps the id across renames', async () => {
    const first = await call<DeviceResult>('cloud:device:get')
    expect(first.success).toBe(true)
    expect(first.device?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.device?.name.length).toBeGreaterThan(0)

    const renamed = await call<DeviceResult>('cloud:device:set', { name: '  客厅那台  ' })
    expect(renamed.success).toBe(true)
    expect(renamed.device?.name).toBe('客厅那台')
    expect(renamed.device?.id).toBe(first.device?.id)

    // 再读一次：友好名探测不能把用户起的名字盖掉
    const reread = await call<DeviceResult>('cloud:device:get')
    expect(reread.device?.name).toBe('客厅那台')
  })

  it('sends author with every run and records which device started the session', async () => {
    const current = await call<DeviceResult>('cloud:device:set', { name: '客厅那台' })
    const before = mocks.state.bodies.length
    await call('cloud:run:start', { input: 'device probe', idempotencyKey: 'key-device' })

    const body = JSON.parse(mocks.state.bodies[before])
    expect(body.input).toBe('device probe')
    expect(body.author).toMatchObject({ name: '客厅那台', is_bot: false })
    expect(String(body.author.id)).toMatch(/^pi-workbench\//)
    // 不注入 prompt：上游 instructions 是另一条路，我们刻意不用
    expect(body).not.toHaveProperty('instructions')

    // 会话归属是「首次写入即固定」（run_session 在前面已由 hostname 名字记过），
    // 改名不该把历史归属改写成新名字 —— 但设备 id 必须一致。
    const index = JSON.parse(
      fs.readFileSync(
        path.join(mocks.state.appDir, 'data', 'cloud-agent', 'device-sessions.json'),
        'utf-8'
      )
    ) as Record<string, { deviceId: string; deviceName: string }>
    expect(index.run_session).toMatchObject({
      deviceId: current.device?.id,
      deviceName: expect.any(String),
    })
  })

  it('re-reads the system name on demand without touching a name the user typed', async () => {
    await call('cloud:device:set', { name: '手工名' })
    const before = await call<DeviceResult>('cloud:device:get')
    const reprobed = await call<DeviceResult>('cloud:device:reprobe')
    expect(reprobed.success).toBe(true)
    expect(reprobed.device?.name).toBe('手工名')
    expect(reprobed.device?.id).toBe(before.device?.id)
  })

  it('restores the system default name when the input is cleared', async () => {
    const before = await call<DeviceResult>('cloud:device:get')
    const cleared = await call<DeviceResult>('cloud:device:set', { name: '   ' })
    expect(cleared.device?.name).toBe(before.device?.defaultName)
    expect(cleared.device?.id).toBe(before.device?.id)
  })
})

describe('cloud session actions', () => {
  it('renames and pins through PATCH, and deletes hard', async () => {
    await seedPairedDevice()
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
    expect(mocks.state.requests.some((line) => line === 'PATCH https://hub.example.com/api/sessions/run_session')).toBe(true)

    const removed = await call<{ success: boolean; deleted?: boolean }>('cloud:sessions:delete', {
      sessionId: 'run_session',
    })
    expect(removed).toMatchObject({ success: true, deleted: true })
    expect(mocks.state.requests.some((line) => line === 'DELETE https://hub.example.com/api/sessions/run_session')).toBe(true)
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
  it('uploads with the device token, no console token needed', async () => {
    await seedPairedDevice()
    const uploaded = await call<{ success: boolean; image?: { path: string } }>(
      'cloud:media:upload',
      { dataUrl: 'data:image/png;base64,AAAA', filename: 'pasted.png' }
    )
    // 单入口：图片上传也走网关，凭据是设备 token
    expect(uploaded.success).toBe(true)
    expect(mocks.state.requests.some((line) => line.startsWith('POST https://hub.example.com/api/chat/image-upload'))).toBe(true)
  })

  it('refuses to upload before the device is registered', async () => {
    // 没配对 = 没有凭据，连上传都不该发出去
    const config = await import('../electron/cloud/config')
    config.clearDeviceCredentials()
    const before = mocks.state.requests.length
    const result = await call<{ success: boolean; error?: string }>('cloud:media:upload', {
      dataUrl: 'data:image/png;base64,AAAA',
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/配对/)
    expect(mocks.state.requests.length).toBe(before)
  })

  it('rejects a non-whitelisted type locally', async () => {
    await seedPairedDevice()
    const result = await call<{ success: boolean; error?: string }>('cloud:media:upload', {
      dataUrl: 'data:image/svg+xml;base64,AAAA',
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('不支持')
  })

  it('uploads and reads back through the console', async () => {
    await seedPairedDevice()
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
    await seedPairedDevice()
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
    await seedPairedDevice()
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

describe('cloud session export', () => {
  beforeAll(async () => {
    await seedPairedDevice()
  })

  it('renders the session and writes it to the picked path', async () => {
    const target = path.join(mocks.state.appDir, 'export.md')
    mocks.state.savePath = target
    mocks.state.saveDialogs = []

    const result = await call<{ success: boolean; path?: string }>('cloud:session:export', {
      sessionId: 'run_session',
      title: '部署排查',
      format: 'md',
      language: 'zh',
    })

    expect(result.success).toBe(true)
    expect(result.path).toBe(target)
    const written = fs.readFileSync(target, 'utf-8')
    expect(written).toContain('# 部署排查')
    expect(written).toContain('hello')
    expect(written).toContain('Hello cloud')
    // 默认文件名取自标题，落在下载目录
    expect(mocks.state.saveDialogs[0]).toContain('部署排查.md')
  })

  it('reports a cancelled dialog as success so the UI stays quiet', async () => {
    mocks.state.savePath = ''
    const result = await call<{ success: boolean; canceled?: boolean }>('cloud:session:export', {
      sessionId: 'run_session',
      title: 'x',
      format: 'html',
    })
    expect(result).toMatchObject({ success: true, canceled: true })
  })

  it('refuses to export without a session id', async () => {
    const result = await call<{ success: boolean; error?: string }>('cloud:session:export', {
      format: 'md',
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('sessionId')
  })
})

describe('cloud jobs', () => {
  it('asks for disabled jobs too, otherwise a paused job can never be resumed', async () => {
    await call('cloud:jobs:list', {})
    const urls = mocks.state.requests.filter((line) => line.includes('/api/jobs'))
    expect(urls[urls.length - 1]).toContain('include_disabled=true')
  })

  beforeAll(async () => {
    await seedPairedDevice()
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

  it('edits a job through PATCH and only sends the fields it was given', async () => {
    const before = mocks.state.bodies.length
    const result = await call<{ success: boolean; job?: Record<string, unknown> }>(
      'cloud:jobs:update',
      { jobId: 'job_1', name: '  改名后的任务  ' }
    )
    expect(result.success).toBe(true)
    expect(result.job).toMatchObject({ id: 'job_1', name: '改名后的任务' })
    const body = JSON.parse(mocks.state.bodies[before]) as Record<string, unknown>
    expect(body).toEqual({ name: '改名后的任务' })
  })

  it('refuses an empty edit instead of turning it into a 400 upstream', async () => {
    const result = await call<{ success: boolean; error?: string }>('cloud:jobs:update', {
      jobId: 'job_1',
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('没有要修改的字段')
  })

  it('deletes a job by id', async () => {
    const result = await call<{ success: boolean }>('cloud:jobs:delete', { jobId: 'job_1' })
    expect(result.success).toBe(true)
    expect(mocks.state.requests.some((line) => line === 'DELETE https://hub.example.com/api/jobs/job_1')).toBe(true)
  })

  it('creates a job with the schedule the form collected', async () => {
    const before = mocks.state.bodies.length
    const result = await call<{ success: boolean; job?: Record<string, unknown> }>(
      'cloud:jobs:create',
      { name: '  每日日志汇总  ', schedule: '0 9 * * *', prompt: '汇总昨天的日志' }
    )
    expect(result.success).toBe(true)
    expect(result.job).toMatchObject({
      id: 'job_new',
      name: '每日日志汇总',
      schedule: '0 9 * * *',
      state: 'scheduled',
    })
    // 名字要去空白后再发，repeat 没填就不带（服务端把 0/负数当 400）
    const body = JSON.parse(mocks.state.bodies[before]) as Record<string, unknown>
    expect(body).toMatchObject({ name: '每日日志汇总', schedule: '0 9 * * *' })
    expect('repeat' in body).toBe(false)
  })

  it('passes repeat through only when it is a positive integer', async () => {
    const before = mocks.state.bodies.length
    await call('cloud:jobs:create', {
      name: '一次性',
      schedule: 'in 30m',
      prompt: '跑一次',
      repeat: 2,
    })
    expect(JSON.parse(mocks.state.bodies[before]).repeat).toBe(2)

    const rejected = await call<{ success: boolean; error?: string }>('cloud:jobs:create', {
      name: 'x',
      schedule: '30m',
      prompt: 'y',
      repeat: 0,
    })
    expect(rejected.success).toBe(false)
    expect(rejected.error).toContain('正整数')
  })

  it('refuses blank fields without hitting the network', async () => {
    const before = mocks.state.requests.length
    for (const input of [
      { name: '  ', schedule: '30m', prompt: 'p' },
      { name: 'n', schedule: '  ', prompt: 'p' },
      { name: 'n', schedule: '30m', prompt: '  ' },
    ]) {
      const result = await call<{ success: boolean; error?: string }>('cloud:jobs:create', input)
      expect(result.success).toBe(false)
    }
    expect(mocks.state.requests.length).toBe(before)
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
    await seedPairedDevice()
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

describe('cloud console layer', () => {
  it('only lets the main window report the native layer bounds', async () => {
    const handler = mocks.handlers.get('cloud:dashboard:bounds')
    expect(handler).toBeTruthy()
    const rect = { x: 0, y: 34, width: 800, height: 600, visible: true }

    // 拆出去的面板窗口：坐标系与主窗口无关，推上来的矩形会把控制台摆错位置
    const rejected = (await handler?.({ sender: { id: 999 } }, rect)) as {
      success: boolean
      error?: string
    }
    expect(rejected.success).toBe(false)
    expect(rejected.error).toContain('主窗口')

    const accepted = (await handler?.({ sender: mocks.window.webContents }, rect)) as {
      success: boolean
    }
    expect(accepted.success).toBe(true)
  })
})

describe('cloud clarify', () => {
  beforeAll(async () => {
    await seedPairedDevice()
  })

  it('sends exactly the three fields the backend accepts', async () => {
    await call('cloud:run:start', { input: 'ask me', idempotencyKey: 'key-clarify' })
    const before = mocks.state.bodies.length
    const result = await call<{ success: boolean; error?: string }>('cloud:clarify:respond', {
      requestId: 'cl_1',
      generation: 4,
      answer: 'production',
    })
    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
    const body = JSON.parse(mocks.state.bodies[before])
    expect(Object.keys(body).sort()).toEqual(['answer', 'execution_generation', 'request_id'])
    expect(body).toEqual({ request_id: 'cl_1', execution_generation: 4, answer: 'production' })
  })

  it('refuses an empty answer, a missing id or a missing generation', async () => {
    for (const input of [
      { requestId: 'cl_1', generation: 4, answer: '   ' },
      { generation: 4, answer: 'x' },
      { requestId: 'cl_1', answer: 'x' },
    ]) {
      const result = await call<{ success: boolean; error?: string }>(
        'cloud:clarify:respond',
        input
      )
      expect(result.success).toBe(false)
    }
  })

  it('refuses when there is no active run to answer into', async () => {
    await call('cloud:run:stop', { runId: 'run_test' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const result = await call<{ success: boolean; error?: string }>('cloud:clarify:respond', {
      requestId: 'cl_1',
      generation: 4,
      answer: 'x',
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('正在执行')
  })
})

describe('cloud approval', () => {
  const auditLines = (): Array<Record<string, unknown>> => {
    const file = path.join(mocks.state.appDir, 'data', 'cloud-agent', 'audit.jsonl')
    if (!fs.existsSync(file)) return []
    return fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  beforeAll(async () => {
    await seedPairedDevice()
    await call('cloud:run:start', { input: 'run a command', idempotencyKey: 'key-approval' })
  })

  it('sends request_id + generation + choice when it has them', async () => {
    const before = mocks.state.bodies.length
    const result = await call<{ success: boolean; error?: string }>('cloud:approval:respond', {
      runId: 'run_test',
      requestId: 'ap_7',
      generation: 3,
      choice: 'once',
      command: 'rm -rf build',
      patternKeys: ['rm -rf'],
    })
    expect(result.error).toBeUndefined()
    const body = JSON.parse(mocks.state.bodies[before])
    expect(body).toEqual({ choice: 'once', request_id: 'ap_7', execution_generation: 3 })
  })

  it('fills the generation from the run status when the card has none', async () => {
    // 实测：{choice} 与 {request_id, choice} 都是 400 invalid_params，三个字段必须齐全
    const before = mocks.state.bodies.length
    const result = await call<{ success: boolean; error?: string }>('cloud:approval:respond', {
      runId: 'run_test',
      requestId: 'ap_9',
      choice: 'deny',
    })
    expect(result.error).toBeUndefined()
    const body = JSON.parse(mocks.state.bodies[before])
    expect(body.request_id).toBe('ap_9')
    expect(body.execution_generation).toBeTypeOf('number')
  })

  it('refuses when there is no request id at all', async () => {
    const before = mocks.state.bodies.length
    const result = await call<{ success: boolean; error?: string }>('cloud:approval:respond', {
      runId: 'run_test',
      choice: 'deny',
    })
    expect(result.success).toBe(false)
    expect(mocks.state.bodies.length).toBe(before)
  })

  it('refuses always and unknown choices without touching the network', async () => {
    for (const choice of ['always', 'allow', '']) {
      const before = mocks.state.bodies.length
      const result = await call<{ success: boolean; error?: string }>('cloud:approval:respond', {
        runId: 'run_test',
        requestId: 'ap_7',
        choice,
      })
      expect(result.success).toBe(false)
      expect(mocks.state.bodies.length).toBe(before)
    }
  })

  it('writes one audit line with a truncated command and the matched patterns', async () => {
    // 界面挂载时会读一次策略；决定行用那次读回的值（不再在回执里现读）
    await call('cloud:policy:get')
    await call('cloud:approval:respond', {
      runId: 'run_test',
      requestId: 'ap_8',
      generation: 1,
      choice: 'once',
      command: 'rm -rf build\nrm -rf dist',
      patternKeys: ['rm -rf'],
    })
    const lines = auditLines().filter((line) => line.kind === 'approval')
    const line = lines.find((row) => row.requestId === 'ap_8') ?? lines[lines.length - 1]
    expect(line).toBeTruthy()
    expect(line?.patternKeys).toEqual(['rm -rf'])
    expect(String(line?.command).length).toBeLessThanOrEqual(200)
    expect(line?.mode).toBe('manual')
    // 审计只存摘要：换行被压平
    expect(String(line?.command)).not.toContain('\n')
    // 哪台设备批的：多设备时日志会合并查看，这条必须留
    expect(line?.device).toMatchObject({ id: expect.any(String), name: expect.any(String) })
  })

  it('records the decision before the outcome can arrive', async () => {
    // 回归：决定行曾经写在一次策略 GET 之后，服务端的 tool.completed 会先到，
    // 结果行就永远配不上。现在回执一返回就落盘。
    const { recordApprovalOutcome } = await import('../electron/cloud/audit')
    await call('cloud:approval:respond', {
      runId: 'run_test',
      requestId: 'ap_10',
      generation: 1,
      choice: 'deny',
    })
    expect(recordApprovalOutcome('run_test', { error: true, preview: 'BLOCKED' })).toBe(true)
    expect(auditLines().filter((line) => line.kind === 'approval_result').length).toBeGreaterThan(0)
  })

  it('returns only the whitelisted policy subset', async () => {
    const result = await call<{
      success: boolean
      policy?: {
        mode: string | null
        timeoutSeconds: number | null
        denyCount: number
        disabledToolsets: string[]
        terminalBackend: string
      }
    }>('cloud:policy:get')
    expect(result.success).toBe(true)
    expect(result.policy).toEqual({
      mode: 'manual',
      timeoutSeconds: 120,
      denyCount: 2,
      disabledToolsets: ['code_execution'],
      terminalBackend: 'local',
    })
    // 整份配置里有明文密钥：绝不能随手透出
    expect(JSON.stringify(result)).not.toContain('sk-should-never-leak')
  })

  it('switches mode with a minimal patch and verifies by reading back', async () => {
    const before = mocks.state.bodies.length
    const result = await call<{ success: boolean; policy?: { mode: string } }>(
      'cloud:policy:set',
      { mode: 'off' }
    )
    expect(result.success).toBe(true)
    expect(result.policy?.mode).toBe('off')
    const patch = JSON.parse(mocks.state.bodies[before])
    expect(patch).toEqual({ config: { approvals: { mode: 'off' } } })

    const modeLine = auditLines().filter((line) => line.kind === 'mode')
    expect(modeLine[modeLine.length - 1]).toMatchObject({ from: 'manual', to: 'off' })
  })

  it('rejects a mode the server does not have', async () => {
    for (const mode of ['readonly', 'full', '']) {
      const result = await call<{ success: boolean }>('cloud:policy:set', { mode })
      expect(result.success).toBe(false)
    }
  })

  it('exposes pending controls on run status without leaking anything else', async () => {
    const result = await call<{
      success: boolean
      pendingControls?: Array<Record<string, unknown>>
    }>('cloud:run:status', { runId: 'run_test' })
    expect(result.success).toBe(true)
    expect(Array.isArray(result.pendingControls)).toBe(true)
  })
})

describe('cloud run attach（重启后接回在跑的一轮）', () => {
  beforeAll(async () => {
    // 前面的用例可能清掉凭据；这里恢复一个可用配置
    await seedPairedDevice()
    await call('cloud:connect')
  })

  it('remembers the run it just started', async () => {
    clearActiveRun()
    const started = await call<{ success: boolean; runId?: string }>('cloud:run:start', {
      input: 'hang 住别结束',
      idempotencyKey: 'key-hang',
    })
    expect(started).toMatchObject({ success: true, runId: 'run_hang' })
    expect(readActiveRun()).toMatchObject({ runId: 'run_hang', sessionId: 'hang_session' })
  })

  it('does nothing when the record belongs to another session', async () => {
    const before = mocks.state.requests.filter((line) => line.includes('/v1/runs/run_hang')).length
    const result = await call<{ success: boolean; attached: boolean }>('cloud:run:attach', {
      sessionId: 'run_session',
    })
    expect(result).toMatchObject({ success: true, attached: false })
    // 不该为了一个不相关的会话去问服务端
    const after = mocks.state.requests.filter((line) => line.includes('/v1/runs/run_hang')).length
    expect(after).toBe(before)
  })

  it('drops a record the backend no longer knows about', async () => {
    writeActiveRun({ runId: 'run_gone', sessionId: 'run_session', startedAt: 1 })
    const result = await call<{ success: boolean; attached: boolean }>('cloud:run:attach', {
      sessionId: 'run_session',
    })
    // 404 不是错误：记录作废，页面照常打开
    expect(result).toMatchObject({ success: true, attached: false })
    expect(readActiveRun()).toBeNull()
  })

  it('reattaches a live run, streams it and clears the record at the end', async () => {
    writeActiveRun({ runId: 'run_live', sessionId: 'run_session', startedAt: 1 })
    mocks.state.sent.length = 0
    const result = await call<{
      success: boolean
      attached: boolean
      runId?: string
      sessionId?: string
      state?: string
    }>('cloud:run:attach', { sessionId: 'run_session' })
    expect(result).toMatchObject({
      success: true,
      attached: true,
      runId: 'run_live',
      sessionId: 'run_session',
      state: 'running',
    })
    // 只订阅新事件：带 last_seq 上限，避免把整轮回放一遍
    expect(
      mocks.state.requests.some((line) => line.includes('/v1/runs/run_live/events?last_seq=2147483647'))
    ).toBe(true)

    await waitFor(() => readActiveRun() === null)
    const frames = mocks.state.sent
      .filter((message) => message.channel === 'cloud:event')
      .map((message) => message.payload as { kind: string; state?: string })
    // 历史先铺，然后才是增量与「已接上」分隔线
    expect(frames.some((frame) => frame.kind === 'parts')).toBe(true)
    expect(frames.some((frame) => frame.kind === 'run' && frame.state === 'completed')).toBe(true)
  })

  it('returns attached: false when there is nothing to attach to', async () => {
    clearActiveRun()
    const result = await call<{ success: boolean; attached: boolean }>('cloud:run:attach', {})
    expect(result).toMatchObject({ success: true, attached: false })
  })

  it('keeps the record when the address stays the same, drops it when it changes', async () => {
    writeActiveRun({ runId: 'run_hang', sessionId: 'hang_session', startedAt: 1 })
    // 原地保存同一个地址不该把能接回的记录清掉
    await seedPairedDevice()
    expect(readActiveRun()?.runId).toBe('run_hang')

    // 换了服务器（网关地址变了）= 上一台的轮次接不回来
    await call('cloud:gateway:pair', {
      code: 'ABCDE-FGHIJ',
      gatewayUrl: 'https://other.example.com',
    })
    expect(readActiveRun()).toBeNull()

    // 复原配置，别影响同文件里排在前面的用例假设
    await seedPairedDevice()
  })
})

describe('cloud gateway (single entry)', () => {
  interface StatusResult {
    success: boolean
    registered: boolean
    gatewayUrl: string
    deviceId?: string
    scopes?: string[]
    online?: boolean | null
    upstreamVersion?: string
    devices?: { total: number; active: number; revoked: number } | null
    error?: string
  }

  it('starts unpaired and reports the gateway url without touching the network', async () => {
    const config = await import('../electron/cloud/config')
    config.clearDeviceCredentials()
    const before = mocks.state.requests.length
    const status = await call<StatusResult>('cloud:gateway:status')
    expect(status.success).toBe(true)
    expect(status.registered).toBe(false)
    expect(status.gatewayUrl).toMatch(/^https?:\/\//)
    expect(mocks.state.requests.length).toBe(before)
  })

  it('switches every business call to the gateway once paired', async () => {
    await seedPairedDevice()
    await call('cloud:connect')
    const last = mocks.state.requests[mocks.state.requests.length - 1]
    // 单缝：配对之后不再打 api. 直连，一律走 hub
    expect(last).toMatch(/^(GET|POST) https:\/\/hub\./)
  })

  it('reports the device identity and upstream health from the gateway', async () => {
    await seedPairedDevice()
    const status = await call<StatusResult>('cloud:gateway:status')
    expect(status.registered).toBe(true)
    expect(status.deviceId).toBe('dev_from_gateway')
    expect(status.scopes).toEqual(['chat', 'dispatch'])
    expect(status.online).toBe(true)
    // 新版插件：诊断优先取带凭据的 /v1/hub/status（health 已瘦身，只回存活）
    expect(status.upstreamVersion).toBe('0.22.6-full')
  })

  it('prefers the authenticated status endpoint for diagnostics', async () => {
    await seedPairedDevice()
    const status = await call<StatusResult>('cloud:gateway:status')
    expect(status.devices).toEqual({ total: 3, active: 2, revoked: 1 })
    // 完整诊断来自 /v1/hub/status，而不是匿名的 /v1/hub/health
    expect(status.upstreamVersion).toBe('0.22.6-full')
    expect(mocks.state.requests.some((r: string) => r.includes('/v1/hub/status'))).toBe(true)
  })

  it('revokes the device and drops the local token immediately', async () => {
    await seedPairedDevice()
    const revoked = await call<{ success: boolean; error?: string }>('cloud:gateway:revoke')
    expect(revoked).toMatchObject({ success: true })

    const after = await call<StatusResult>('cloud:gateway:status')
    expect(after.registered).toBe(false)

    // 注销之后这台设备对云端就是关门的：既不能打网关，也不能悄悄用 apiKey 走直连
    const before = mocks.state.requests.length
    const listed = await call<{ success: boolean; error?: string }>('cloud:sessions:list', {
      limit: 1,
    })
    expect(listed.success).toBe(false)
    expect(listed.error).toMatch(/配对|注销/)
    const after2 = mocks.state.requests.slice(before)
    expect(after2).toHaveLength(0)
  })
})

describe('cloud gateway pairing', () => {
  it('pairs with a code, writes config and uses the response dashboard url', async () => {
    const config = await import('../electron/cloud/config')
    config.writeCloudConfig({ gatewayUrl: 'https://hub.example.com' })
    const device = await call<{ device?: { id: string } }>('cloud:device:get')

    const paired = await call<{
      success: boolean
      config?: { hasDeviceToken: boolean; deviceId: string; dashboardUrl: string }
      error?: string
    }>('cloud:gateway:pair', {
      code: 'abcde-fghij',
      gatewayUrl: 'https://hub.example.com',
    })

    expect(paired.success).toBe(true)
    expect(paired.config).toMatchObject({
      hasDeviceToken: true,
      deviceId: device.device?.id,
      dashboardUrl: 'https://dash.example.com',
    })
    const raw = JSON.parse(
      fs.readFileSync(path.join(mocks.state.appDir, 'data', 'cloud-agent', 'connection.json'), 'utf-8')
    ) as { deviceToken?: string; deviceScopes?: string[] }
    expect(raw.deviceToken).toMatch(/^enc:/)
    expect(raw.deviceToken).not.toContain('pi_hub_token_paired')
    expect(raw.deviceScopes).toEqual(['chat', 'dispatch'])
  })

  it('does not overwrite an existing token when pairing fails', async () => {
    await seedPairedDevice()
    const config = await import('../electron/cloud/config')
    const before = config.readCloudConfig().deviceToken

    const failed = await call<{ success: boolean; code?: string; error?: string }>(
      'cloud:gateway:pair',
      { code: 'PAIREXPIRED', gatewayUrl: 'https://hub.example.com' }
    )
    expect(failed.success).toBe(false)
    expect(failed.code).toBe('pairing_expired')
    expect(config.readCloudConfig().deviceToken).toBe(before)
  })

  it('reports an old plugin separately from a bad code', async () => {
    const failed = await call<{ success: boolean; code?: string }>('cloud:gateway:pair', {
      code: 'OLDPLUGIN',
      gatewayUrl: 'https://hub.example.com',
    })
    expect(failed.success).toBe(false)
    expect(failed.code).toBe('pairing_unsupported')
  })

  it('drops the previous active run when the gateway changes', async () => {
    const config = await import('../electron/cloud/config')
    config.writeCloudConfig({
      gatewayUrl: 'https://old.example.com',
      deviceToken: 'old-token',
      deviceId: 'old-device',
    })
    writeActiveRun({ runId: 'run_old', sessionId: 'old_session', startedAt: 1 })

    const paired = await call<{ success: boolean }>('cloud:gateway:pair', {
      code: 'ABCDE-FGHIJ',
      gatewayUrl: 'https://new.example.com',
    })
    expect(paired.success).toBe(true)
    expect(readActiveRun()).toBeNull()
  })
})
