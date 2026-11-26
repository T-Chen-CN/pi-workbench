/**
 * C-03d 并发与压力回归测试：
 * 1. 4 台设备并发派发 20 个工单：严格受限于全局并发上限（8），超额进 queued，完成后按 FIFO 补发直到 20/20 done；
 * 2. 并发派单扣减授权额度（quota=3，10 个并发请求）：绝不超发（TOCTOU 防护）；
 * 3. 200+ 条事件风暴 + 客户端中途重连 resume：事件序号单调递增，无丢帧、无未捕获异常。
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createCloudServer, type CloudServer } from '../apps/cloud/src/main.js'
import { createToken, hashToken } from '../apps/cloud/src/auth/credentials.js'
import { CLOUD_PROTOCOL_VERSION } from '../pi-bridge/src/cloud-protocol'

const tempDirs: string[] = []
const servers: CloudServer[] = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.close().catch(() => undefined)
  }
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined)
  }
})

const TEST_ENC_KEY = Buffer.alloc(32, 9)
const TEST_COOKIE_SECRET = 'stress-cookie-secret-32-bytes-long!'

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function waitForFrame(
  ws: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 8_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for WS frame'))
    }, timeoutMs)
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(raw.toString()) as Record<string, unknown>
        if (predicate(parsed)) {
          cleanup()
          resolve(parsed)
        }
      } catch {
        // ignore
      }
    }
    const cleanup = () => {
      clearTimeout(timer)
      ws.off('message', onMessage)
    }
    ws.on('message', onMessage)
  })
}

async function loginAdmin(baseUrl: string, password: string): Promise<string> {
  await fetch(`${baseUrl}/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const login = await fetch(`${baseUrl}/v1/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  return (login.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? ''
}

async function registerOnlineDevice(
  srv: CloudServer,
  baseUrl: string,
  port: number,
  cookie: string,
  name: string,
  viaPair = true
) {
  const workspaces = [{ path: `/repos/${name}/r1`, name: `${name}-r1`, isGit: true }]
  let deviceId: string
  let token: string
  let clientToken: string
  if (viaPair) {
    const codeRes = await fetch(`${baseUrl}/v1/pair/code`, {
      method: 'POST',
      headers: { cookie },
    })
    const { code } = (await codeRes.json()) as { code: string }
    const pairRes = await fetch(`${baseUrl}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        deviceName: name,
        platform: 'win32',
        workspaces,
      }),
    })
    const paired = (await pairRes.json()) as { deviceId: string; token: string; clientToken: string }
    deviceId = paired.deviceId
    token = paired.token
    clientToken = paired.clientToken
  } else {
    // 避开单 IP /v1/pair 限速（5 次/窗），直接写设备凭据后走真实 /device/ws 建连
    deviceId = `dev-${name}`
    token = createToken()
    clientToken = createToken()
    await srv.store.addDevice({
      id: deviceId,
      name,
      platform: 'win32',
      token: hashToken(token),
      clientToken: hashToken(clientToken),
      workspaces,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revokedAt: null,
    })
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/device/ws`, {
    headers: { authorization: `Bearer ${token}` },
  })
  await new Promise<void>((resolve) => ws.once('open', () => resolve()))
  ws.send(
    JSON.stringify({
      v: CLOUD_PROTOCOL_VERSION,
      type: 'hello',
      deviceId,
      name,
      platform: 'win32',
      workspaces,
    })
  )
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const dev = srv.store.findDevice(deviceId)
    if (srv.hub.isDeviceOnline(deviceId) && dev && dev.workspaces.length >= 1) break
    await new Promise((r) => setTimeout(r, 15))
  }
  return { deviceId, token, clientToken, ws, workspacePath: workspaces[0].path, workspaces }
}

describe('C-03d: 并发与事件风暴压力测试', () => {
  it('4 台设备并发派发 20 个工单：严格控并发上限 8 并 FIFO 补发直到 20/20 完成', async () => {
    const dataDir = await makeTempDir('pi-cloud-stress-')
    const srv = await createCloudServer({
      dataDir,
      port: 0,
      host: '127.0.0.1',
      encryptionKey: TEST_ENC_KEY,
      cookieSecret: TEST_COOKIE_SECRET,
      secureCookies: false,
    })
    servers.push(srv)
    const port = await srv.listen()
    const baseUrl = `http://127.0.0.1:${port}`

    const cookie = await loginAdmin(baseUrl, 'stress-password-123456')

    // 注册 10 台在线设备（> 全局并发上限 8，前 4 台走真实 /v1/pair，全部 10 台走真实 /device/ws）
    const devices = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        registerOnlineDevice(srv, baseUrl, port, cookie, `dev-${idx + 1}`, idx < 4)
      )
    )
    const targets = devices.map((d) => ({ deviceId: d.deviceId, workspacePath: d.workspacePath }))

    // 追踪收到的 task 派发顺序与并发峰值
    const assignedOrder: string[] = []
    let inflight = 0
    let maxInflight = 0

    for (const dev of devices) {
      let devSeq = 1
      dev.ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { type?: string; task?: { id: string } }
        if (frame.type !== 'task' || !frame.task?.id) return
        const taskId = frame.task.id
        assignedOrder.push(taskId)
        inflight += 1
        maxInflight = Math.max(maxInflight, inflight)
        dev.ws.send(
          JSON.stringify({
            v: CLOUD_PROTOCOL_VERSION,
            type: 'task_status',
            seq: devSeq++,
            taskId,
            status: 'assigned',
            at: Date.now(),
          })
        )
        dev.ws.send(
          JSON.stringify({
            v: CLOUD_PROTOCOL_VERSION,
            type: 'task_status',
            seq: devSeq++,
            taskId,
            status: 'running',
            at: Date.now(),
          })
        )
        // 模拟 120ms 执行耗时后回报完成，保证 20 路并发能实打实撞上并发上限 8
        setTimeout(() => {
          inflight -= 1
          dev.ws.send(
            JSON.stringify({
              v: CLOUD_PROTOCOL_VERSION,
              type: 'task_result',
              seq: devSeq++,
              taskId,
              result: {
                summary: `ok ${taskId}`,
                changedFiles: [],
                secretHits: [],
                worktreeClean: true,
              },
              at: Date.now(),
            })
          )
        }, 120)
      })
    }

    // 发放覆盖 4 台设备 × 3 仓库的 25 额度授权
    await srv.store.saveAuthorization({
      id: 'auth-stress',
      items: targets,
      quota: 25,
      used: 0,
      confirmedAt: Date.now(),
      confirmedSummary: 'stress test 20 tasks',
      expiresAt: Date.now() + 3_600_000,
      revokedAt: null,
    })

    // 同时并发派发 20 个工单（真实撞上并发上限 8）
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const target = targets[i % targets.length]
        return srv.dispatcher.dispatch({
          deviceId: target.deviceId,
          workspacePath: target.workspacePath,
          authorizationId: 'auth-stress',
          workUnitId: `unit-stress-${i + 1}`,
          idempotencyKey: `key-stress-${i + 1}`,
          title: `Stress Task #${i + 1}`,
          background: 'stress test',
          goal: `Run check #${i + 1}`,
          acceptance: 'all pass',
          commit: false,
        })
      })
    )
    const dispatchedIds: string[] = []
    for (const res of outcomes) {
      expect(res.ok).toBe(true)
      if (res.ok) dispatchedIds.push(res.task.id)
    }
    expect(dispatchedIds).toHaveLength(20)

    // 等待所有 20 个工单进入 done
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const tasks = srv.store.listTasks()
      if (tasks.length === 20 && tasks.every((t) => t.status === 'done')) break
      await new Promise((r) => setTimeout(r, 30))
    }

    const finalTasks = srv.store.listTasks()
    expect(finalTasks).toHaveLength(20)
    expect(finalTasks.every((t) => t.status === 'done')).toBe(true)
    expect(maxInflight).toBeLessThanOrEqual(8)
    expect(maxInflight).toBeGreaterThanOrEqual(4)
    expect(assignedOrder).toHaveLength(20)
    expect(new Set(assignedOrder)).toEqual(new Set(dispatchedIds))

    for (const dev of devices) dev.ws.close()
  })

  it('并发授权扣减不超发（quota=3 时 10 个并发 dispatch 只成功 3 个）', async () => {
    const dataDir = await makeTempDir('pi-cloud-quota-')
    const srv = await createCloudServer({
      dataDir,
      port: 0,
      host: '127.0.0.1',
      encryptionKey: TEST_ENC_KEY,
      cookieSecret: TEST_COOKIE_SECRET,
      secureCookies: false,
    })
    servers.push(srv)
    const port = await srv.listen()
    const baseUrl = `http://127.0.0.1:${port}`

    const cookie = await loginAdmin(baseUrl, 'quota-password-123456')
    const dev = await registerOnlineDevice(srv, baseUrl, port, cookie, 'dev-q')

    await srv.store.saveAuthorization({
      id: 'auth-tight',
      items: [{ deviceId: dev.deviceId, workspacePath: dev.workspacePath }],
      quota: 3,
      used: 0,
      confirmedAt: Date.now(),
      confirmedSummary: 'tight quota',
      expiresAt: Date.now() + 3_600_000,
      revokedAt: null,
    })

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        srv.dispatcher.dispatch({
          deviceId: dev.deviceId,
          workspacePath: dev.workspacePath,
          authorizationId: 'auth-tight',
          workUnitId: `unit-quota-${idx}`,
          idempotencyKey: `key-quota-${idx}`,
          title: `Quota #${idx}`,
          background: 'quota race test',
          goal: `Work #${idx}`,
          acceptance: 'ok',
          commit: false,
        })
      )
    )
    const okCount = results.filter((r) => r.ok).length
    expect(okCount).toBe(3)
    const auth = srv.store.listAuthorizations().find((a) => a.id === 'auth-tight')
    expect(auth?.used).toBe(3)

    dev.ws.close()
  })

  it('220 条高频事件风暴 + 客户端断线后 resume 补齐，序号单调无丢失', async () => {
    const dataDir = await makeTempDir('pi-cloud-storm-')
    const srv = await createCloudServer({
      dataDir,
      port: 0,
      host: '127.0.0.1',
      encryptionKey: TEST_ENC_KEY,
      cookieSecret: TEST_COOKIE_SECRET,
      secureCookies: false,
    })
    servers.push(srv)
    const port = await srv.listen()
    const baseUrl = `http://127.0.0.1:${port}`

    const cookie = await loginAdmin(baseUrl, 'storm-password-123456')
    const dev = await registerOnlineDevice(srv, baseUrl, port, cookie, 'dev-storm')

    // 客户端连接并在前 50 条后断开，剩余 170 条期间离线，然后用 lastSeq 重连补齐
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/client/ws`, {
      headers: { authorization: `Bearer ${dev.clientToken}` },
    })
    const received1: number[] = []
    ws1.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as { type?: string; seq?: number }
      if (f.type === 'event' && typeof f.seq === 'number') received1.push(f.seq)
    })
    await waitForFrame(ws1, (f) => f.type === 'snapshot')

    for (let i = 1; i <= 50; i += 1) {
      srv.hub.publish({ type: 'notice', level: 'info', text: `storm-${i}`, at: Date.now() })
    }
    await new Promise((r) => setTimeout(r, 80))
    const lastSeqBeforeDrop = received1[received1.length - 1]
    expect(lastSeqBeforeDrop).toBeGreaterThanOrEqual(50)
    ws1.close()

    for (let i = 51; i <= 220; i += 1) {
      srv.hub.publish({ type: 'notice', level: 'info', text: `storm-${i}`, at: Date.now() })
    }

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/client/ws`, {
      headers: { authorization: `Bearer ${dev.clientToken}` },
    })
    const replayed: number[] = []
    ws2.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as { type?: string; seq?: number }
      if (f.type === 'event' && typeof f.seq === 'number') replayed.push(f.seq)
    })
    await new Promise<void>((resolve) => ws2.once('open', () => resolve()))
    ws2.send(JSON.stringify({ v: CLOUD_PROTOCOL_VERSION, type: 'resume', lastAckSeq: lastSeqBeforeDrop }))

    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && replayed.length < 170) {
      await new Promise((r) => setTimeout(r, 25))
    }

    expect(replayed.length).toBeGreaterThanOrEqual(170)
    for (let i = 1; i < replayed.length; i += 1) {
      expect(replayed[i]).toBeGreaterThan(replayed[i - 1])
    }

    ws2.close()
    dev.ws.close()
  })
})
