/** 离线期汇报（F-51 / A-23）：客户端断开期间工单结束 → 重连快照带「你离开期间…」 */

// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import WebSocket from 'ws'
import { CLOUD_PROTOCOL_VERSION, CLOUD_WS_PATHS, type CloudSnapshot } from 'pi-bridge'
import { buildAwaySummary, createCloudServer, type CloudServer } from '../apps/cloud/src/main'

let tmpRoot = ''
let server: CloudServer
let base = ''
let cookie = ''
let deviceId = ''

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', cookie, ...extra }
}

function connectClient(wsBase: string): Promise<{ ws: WebSocket; snapshot: CloudSnapshot }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${CLOUD_WS_PATHS.client}`, {
      headers: { cookie, origin: base },
    })
    ws.once('error', reject)
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw))
      if (frame.type === 'snapshot') {
        resolve({ ws, snapshot: frame.snapshot as CloudSnapshot })
      }
    })
  })
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    ws.once('close', () => resolve())
    ws.close()
  })
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-away-'))
  server = await createCloudServer(
    {
      dataDir: path.join(tmpRoot, 'cloud'),
      workspaceDir: path.join(tmpRoot, 'workspace'),
      agentDir: path.join(tmpRoot, 'agent'),
      port: 0,
      encryptionKey: Buffer.alloc(32, 7),
      cookieSecret: 'away-summary-secret',
      secureCookies: false,
      version: 'test',
    },
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
  cookie = (login.headers.getSetCookie?.() ?? [])[0].split(';')[0]

  const pairCodeRes = await fetch(`${base}/v1/pair/code`, { method: 'POST', headers: headers() })
  const { code } = (await pairCodeRes.json()) as { code: string }
  const pairRes = await fetch(`${base}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      deviceName: 'desk',
      platform: 'win32',
      workspaces: [{ path: '/repo', name: 'repo', isGit: true }],
    }),
  })
  deviceId = ((await pairRes.json()) as { deviceId: string }).deviceId
})

afterAll(async () => {
  await server?.close().catch(() => undefined)
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe('离线期汇报（F-51 / A-23）', () => {
  it('buildAwaySummary 只纳入离开之后落终态或进入 waiting_human 的工单', () => {
    const baseSpec = {
      workUnitId: 'u1',
      deviceId: 'd1',
      repo: { workspacePath: '/repo' },
      title: 't',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      output: { summary: true, changeList: true, testResult: false },
      commit: false,
      authorizationId: 'a1',
    }
    const summary = buildAwaySummary(
      [
        {
          id: 'T-001',
          spec: { ...baseSpec, title: '旧工单' },
          status: 'done',
          idempotencyKey: 'k1',
          createdAt: 100,
          updatedAt: 500,
          finishedAt: 500,
          progress: { step: 1, lastEventAt: 500 },
        },
        {
          id: 'T-002',
          spec: { ...baseSpec, title: '修单测' },
          status: 'done',
          idempotencyKey: 'k2',
          createdAt: 900,
          updatedAt: 1200,
          finishedAt: 1200,
          progress: { step: 1, lastEventAt: 1200 },
        },
        {
          id: 'T-003',
          spec: { ...baseSpec, title: '等拍板' },
          status: 'waiting_human',
          idempotencyKey: 'k3',
          createdAt: 1000,
          updatedAt: 1500,
          progress: { step: 1, lastEventAt: 1500 },
        },
      ],
      1000,
      2000
    )

    expect(summary).toBeDefined()
    expect(summary!.items.map((item) => item.taskId)).toEqual(['T-002', 'T-003'])
    expect(summary!.text).toContain('你离开期间：')
    expect(summary!.text).toContain('T-002（修单测）已完成')
    expect(summary!.text).toContain('T-003（等拍板）等待决定')
  })

  it('客户端断开期间工单结束 → 重连后快照带 awaySummary，发消息后清掉', async () => {
    const wsBase = base.replace(/^http/, 'ws')
    const first = await connectClient(wsBase)
    expect(first.snapshot.awaySummary).toBeUndefined()
    await closeSocket(first.ws)

    // 模拟离开期间落了一张已完成工单
    const authRes = await fetch(`${base}/v1/authorizations`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        planText: 'away plan',
        items: [{ deviceId, workspacePath: '/repo' }],
        quota: 2,
      }),
    })
    const { authorization } = (await authRes.json()) as { authorization: { id: string } }
    const now = Date.now() + 10
    await server.store.saveTask({
      id: 'T-009',
      spec: {
        workUnitId: 'unit-away',
        deviceId,
        repo: { workspacePath: '/repo' },
        title: '夜间跑测试',
        background: 'b',
        goal: 'g',
        acceptance: 'a',
        output: { summary: true, changeList: true, testResult: false },
        commit: false,
        authorizationId: authorization.id,
      },
      status: 'done',
      idempotencyKey: 'away-1',
      createdAt: now - 5,
      updatedAt: now,
      finishedAt: now,
      terminalReason: 'completed',
      progress: { step: 1, summary: 'all green', lastEventAt: now },
    })

    // 客户端重连：快照带「你离开期间…」
    const second = await connectClient(wsBase)
    expect(second.snapshot.awaySummary?.text).toContain('你离开期间：T-009（夜间跑测试）已完成')

    // 用户回到会话发言后清空汇总
    second.ws.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'say',
        text: '收到',
        clientMessageId: 'm-1',
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    const snapRes = await fetch(`${base}/v1/snapshot`, { headers: headers() })
    const snap = (await snapRes.json()) as CloudSnapshot
    expect(snap.awaySummary).toBeUndefined()

    await closeSocket(second.ws)
  })
})
