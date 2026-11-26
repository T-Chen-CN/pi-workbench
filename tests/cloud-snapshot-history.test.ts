/**
 * 快照必须带历史消息 —— 即使这次进程重启后还没人说过话。
 *
 * 事故：云端会话是懒初始化的（`ensureAgent()` 只在 say / 派活时跑），而快照里的历史要经
 * AgentManager 投影。于是「重启 → 直接打开 Web/桌面端 → 历史空白」，可会话 JSONL 一直
 * 躺在 `agentDir/sessions/` 里。修法：buildSnapshot 先 ensureAgent()。
 */

// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WebSocket } from 'ws'
import { createCloudServer, type CloudServer } from '../apps/cloud/src/main'

let tmpRoot: string
let workspaceDir: string
let server: CloudServer
let base: string
let cookie = ''

const SESSION_ID = '11111111-2222-3333-4444-555555555555'

function sessionRecord(cwd: string): string {
  const now = new Date('2026-11-20T09:00:00.000Z')
  const lines = [
    { type: 'session', version: 3, id: SESSION_ID, timestamp: now.toISOString(), cwd },
    {
      type: 'message',
      id: 'r1',
      parentId: null,
      timestamp: now.toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: '重启前的问候' }], timestamp: 1 },
    },
    {
      type: 'message',
      id: 'r2',
      parentId: 'r1',
      timestamp: new Date(now.getTime() + 1000).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '重启前的回复' }],
        api: 'openai-completions',
        provider: 'pi-workbench',
        model: 'probe',
      },
    },
  ]
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-history-'))
  workspaceDir = path.join(tmpRoot, 'workspace')
  const agentDir = path.join(tmpRoot, 'agent')
  await fs.mkdir(path.join(agentDir, 'sessions'), { recursive: true })
  await fs.mkdir(workspaceDir, { recursive: true })
  await fs.writeFile(
    path.join(agentDir, 'sessions', `2026-11-20T09-00-00-000Z_${SESSION_ID}.jsonl`),
    sessionRecord(workspaceDir),
    'utf-8'
  )

  server = await createCloudServer(
    {
      dataDir: tmpRoot,
      workspaceDir,
      agentDir,
      port: 0,
      encryptionKey: Buffer.alloc(32, 7),
      cookieSecret: 'history-cookie-secret',
      secureCookies: false,
      version: 'test',
    },
    // 配置保存会做一次 Key 探测：测试不打外网
    { probeConfig: async () => ({ ok: true }) }
  )
  const port = await server.listen()
  base = `http://127.0.0.1:${port}`

  await fetch(`${base}/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'password-1234' }),
  })
  const login = await fetch(`${base}/v1/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'password-1234' }),
  })
  cookie = String(login.headers.get('set-cookie') ?? '').split(';')[0]

  // 推一份模型配置（不必真能连通，初始化只建 SDK 实例，不发请求）
  const saved = await fetch(`${base}/v1/cloud-config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      providerId: 'deepseek',
      model: 'deepseek-flash',
      apiKey: 'sk-probe',
    }),
  })
  expect(saved.status).toBe(200)
}, 60_000)

afterAll(async () => {
  await server?.close()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

function openClient(path: string): Promise<{ first: any; socket: WebSocket }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}${path}`, {
      headers: { cookie, origin: base },
    })
    const timer = setTimeout(() => reject(new Error('ws timeout')), 5000)
    socket.on('message', (raw) => {
      clearTimeout(timer)
      resolve({ first: JSON.parse(String(raw)), socket })
    })
    socket.on('error', reject)
  })
}

describe('快照带历史', () => {
  it('进程刚起、还没人说话时，快照也应该拿到落盘的历史', async () => {
    const response = await fetch(`${base}/v1/snapshot`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as any
    const texts = (snapshot.messages ?? []).map((message: any) => `${message.role}:${message.text}`)
    expect(texts).toContain('user:重启前的问候')
    expect(texts).toContain('assistant:重启前的回复')
  }, 60_000)

  it('首次连接（lastAckSeq=0）也发快照，不能退化成只重放日志', async () => {
    const { first, socket } = await openClient('/client/ws?lastAckSeq=0')
    socket.close()
    expect(first.type).toBe('snapshot')
    expect((first.snapshot?.messages ?? []).length).toBeGreaterThan(0)
  }, 30_000)

  it('没有游标时同样发快照', async () => {
    const { first, socket } = await openClient('/client/ws')
    socket.close()
    expect(first.type).toBe('snapshot')
  }, 30_000)
})

describe('resume 帧带 0 游标', () => {
  it('客户端主动发 resume(0) 也要回快照，不能只重放日志', async () => {
    const { first, socket } = await openClient('/client/ws')
    expect(first.type).toBe('snapshot')
    const next = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), 5000)
      socket.on('message', (raw) => {
        clearTimeout(timer)
        resolve(JSON.parse(String(raw)))
      })
    })
    socket.send(JSON.stringify({ v: 1, type: 'resume', lastAckSeq: 0 }))
    const frame = await next
    socket.close()
    expect(frame.type).toBe('snapshot')
  }, 30_000)
})
