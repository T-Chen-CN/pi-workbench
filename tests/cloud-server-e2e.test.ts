/**
 * 云端服务端到端（C2 的核心证据）：
 * 建账号 → 登录 → 生成配对码 → 配对 → 设备通道 + 客户端通道 → 确认方案授权 →
 * 派活 → 终端回流 → 完成；以及设备离线 → 工单 cancelled(device-offline)。
 *
 * 这里**不碰模型**：云端会话没有推配置，`ensureAgent()` 不启动。派活路径本身
 * 不依赖模型，所以工单状态机与两条通道可以在无 Key 的环境里验收。
 */

// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WebSocket } from 'ws'
import { CLOUD_PROTOCOL_VERSION } from 'pi-bridge'
import { createCloudServer, type CloudServer } from '../apps/cloud/src/main'

const WORKSPACE = 'E:/tmp/cloud-e2e-repo'

let tmpRoot: string
let server: CloudServer
let base: string
let cookie: string
let deviceId: string
let token: string
let clientToken: string

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', cookie, ...extra }
}

async function waitFor<T>(probe: () => T | Promise<T>, timeoutMs = 3000, label = 'condition'): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function openSocket(url: string, headers: Record<string, string>, sink: any[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    socket.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString()
      sink.push(JSON.parse(text))
    })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-e2e-'))
  server = await createCloudServer({
    dataDir: tmpRoot,
    workspaceDir: path.join(tmpRoot, 'workspace'),
    agentDir: path.join(tmpRoot, 'agent'),
    port: 0,
    encryptionKey: Buffer.alloc(32, 3),
    cookieSecret: 'e2e-cookie-secret',
    secureCookies: false,
    version: 'e2e',
  })
  const port = await server.listen()
  base = `http://127.0.0.1:${port}`

  // 建账号（F-01）→ 登录（F-02）
  const setup = await fetch(`${base}/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'password-1234' }),
  })
  expect(setup.status).toBe(200)
  const again = await fetch(`${base}/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'password-1234' }),
  })
  expect(again.status).toBe(409)

  const login = await fetch(`${base}/v1/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'password-1234' }),
  })
  expect(login.status).toBe(200)
  const setCookie = login.headers.getSetCookie?.() ?? []
  cookie = setCookie[0].split(';')[0]

  // 配对码（F-04）→ 配对（F-05）
  const codeResponse = await fetch(`${base}/v1/pair/code`, {
    method: 'POST',
    headers: jsonHeaders(),
  })
  const { code } = (await codeResponse.json()) as { code: string }
  expect(code).toMatch(/^\d{6}$/)

  const pair = await fetch(`${base}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      deviceName: 'e2e-device',
      platform: 'win32',
      workspaces: [{ path: WORKSPACE, name: 'cloud-e2e-repo', isGit: true }],
    }),
  })
  expect(pair.status).toBe(200)
  const paired = (await pair.json()) as { deviceId: string; token: string; clientToken: string }
  deviceId = paired.deviceId
  token = paired.token
  clientToken = paired.clientToken

  // 同一码二次使用失败（A-02 / A-03），且不透露细节
  const reuse = await fetch(`${base}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'x', platform: 'x', workspaces: [] }),
  })
  expect(reuse.status).toBe(401)
  expect(await reuse.json()).toMatchObject({ code: 'invalid-credential' })
}, 30_000)

afterAll(async () => {
  await server?.close().catch(() => undefined)
  // 关闭后仍有 in-flight 的帧回调；等一拍再删目录，否则原子写会撞上被删的目录
  await new Promise((resolve) => setTimeout(resolve, 150))
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe('控制面', () => {
  it('健康检查与登录态互相独立', async () => {
    const health = await (await fetch(`${base}/v1/health`)).json()
    expect(health).toMatchObject({ ok: true, version: 'e2e', hasAccount: true })
    const me = await (await fetch(`${base}/v1/me`, { headers: { cookie } })).json()
    expect(me).toMatchObject({ authenticated: true, hasAccount: true })
    const anonymous = await (await fetch(`${base}/v1/me`)).json()
    expect(anonymous).toMatchObject({ authenticated: false })
  })

  it('未登录访问设备清单被拒', async () => {
    const response = await fetch(`${base}/v1/devices`)
    expect(response.status).toBe(401)
  })

  it('云端配置只收预设供应商，白名单外的端点被拒（D1 / D20）', async () => {
    const legacy = await fetch(`${base}/v1/cloud-config`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({
        provider: 'openai',
        apiUrl: 'https://api.example.com/v1',
        model: 'gpt-x',
        apiKey: 'sk-live-abcd1234',
      }),
    })
    expect(legacy.status).toBe(400)

    // 白名单内但模型不在 catalog 里：同样拒绝
    const badModel = await fetch(`${base}/v1/cloud-config`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ providerId: 'deepseek', model: 'gpt-x', apiKey: 'sk-live-abcd1234' }),
    })
    expect(badModel.status).toBe(400)
  })

  it('匹配错误时统一错误码，不区分「码不存在 / 已用过」', async () => {
    const wrong = await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000', deviceName: 'x', platform: 'x', workspaces: [] }),
    })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toMatchObject({ code: 'invalid-credential' })
  })
})

describe('派活闭环', () => {
  let deviceFrames: any[] = []
  let clientFrames: any[] = []
  let device: WebSocket
  let client: WebSocket

  beforeAll(async () => {
    deviceFrames = []
    clientFrames = []
    device = await openSocket(
      `ws://127.0.0.1:${new URL(base).port}/device/ws`,
      { authorization: `Bearer ${token}` },
      deviceFrames
    )
    device.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'hello',
        deviceId,
        workspaces: [{ path: WORKSPACE, name: 'cloud-e2e-repo', isGit: true }],
      })
    )
    client = await openSocket(
      `ws://127.0.0.1:${new URL(base).port}/client/ws`,
      { authorization: `Bearer ${clientToken}` },
      clientFrames
    )
    await waitFor(() => clientFrames.some((frame) => frame.type === 'snapshot'), 3000, 'snapshot')
  })

  afterAll(() => {
    client?.close()
    device?.close()
  })

  it('确认方案 → 派活 → 终端回流 → 完成（A-06 / A-08 / A-35）', async () => {
    const auth = await fetch(`${base}/v1/authorizations`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        planText: '在 cloud-e2e-repo 里加一个脚本',
        items: [{ deviceId, workspacePath: WORKSPACE }],
        quota: 2,
      }),
    })
    const { authorization } = (await auth.json()) as { authorization: { id: string } }
    expect(authorization.id).toMatch(/^auth-/)

    const outcome = await server.dispatcher.dispatch({
      authorizationId: authorization.id,
      workUnitId: 'unit-e2e',
      deviceId,
      workspacePath: WORKSPACE,
      title: 'add script',
      background: 'because',
      goal: 'add script',
      acceptance: 'script runs',
      commit: false,
    })
    expect(outcome.ok).toBe(true)
    const taskId = outcome.ok ? outcome.task.id : ''

    // 终端收到 task 帧
    const taskFrame = await waitFor(
      () => deviceFrames.find((frame) => frame.type === 'task' && frame.task?.id === taskId),
      3000,
      'task frame'
    )
    expect(taskFrame.task.spec.workUnitId).toBe('unit-e2e')

    // 接单 → 执行 → 完成
    for (const status of ['assigned', 'running'] as const) {
      device.send(
        JSON.stringify({
          v: CLOUD_PROTOCOL_VERSION,
          type: 'task_status',
          taskId,
          status,
          at: Date.now(),
        })
      )
      await waitFor(
        () => server.store.findTask(taskId)?.status === status,
        3000,
        `status ${status}`
      )
    }

    device.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'task_result',
        taskId,
        at: Date.now(),
        result: {
          summary: 'added script',
          changedFiles: [{ path: 'run.sh', kind: 'added' }],
          tests: { command: 'bash run.sh', passed: true },
          branch: 'pi/cloud-unit-e2e',
          commit: 'abc1234',
        },
      })
    )

    const done = (await waitFor(
      () => (server.store.findTask(taskId)?.status === 'done' ? server.store.findTask(taskId) : null),
      3000,
      'task done'
    ))!
    expect(done.terminalReason).toBe('completed')
    expect(done.progress.changedFiles).toEqual([{ path: 'run.sh', kind: 'added' }])

    // 客户端通过事件流看到这条工单终态
    const events = await waitFor(
      () =>
        clientFrames.find(
          (frame) => frame.type === 'event' && frame.event?.type === 'task' && frame.event.task?.id === taskId && frame.event.task.status === 'done'
        ),
      3000,
      'client task event'
    )
    expect(events.seq).toBeGreaterThan(0)

    // 授权额度被扣掉一次
    const snapshot = await (await fetch(`${base}/v1/snapshot`, { headers: { cookie } })).json()
    const used = snapshot.authorizations.find((item: any) => item.id === authorization.id)
    expect(used.used).toBe(1)
  })

  it('设备离线 → 未完成工单直接 cancelled(device-offline)，不排队（A-41）', async () => {
    const auth = await fetch(`${base}/v1/authorizations`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        planText: 'second plan',
        items: [{ deviceId, workspacePath: WORKSPACE }],
        quota: 2,
      }),
    })
    const { authorization } = (await auth.json()) as { authorization: { id: string } }
    const outcome = await server.dispatcher.dispatch({
      authorizationId: authorization.id,
      workUnitId: 'unit-offline',
      deviceId,
      workspacePath: WORKSPACE,
      title: 'will be cancelled',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      commit: false,
    })
    expect(outcome.ok).toBe(true)
    const taskId = outcome.ok ? outcome.task.id : ''

    device.close()
    const cancelled = (await waitFor(
      () => {
        const task = server.store.findTask(taskId)
        return task?.status === 'cancelled' ? task : null
      },
      5000,
      'cancelled task'
    ))!
    expect(cancelled.terminalReason).toBe('device-offline')
  })

  it('离线设备不接受新工单（F-15）', async () => {
    const auth = await fetch(`${base}/v1/authorizations`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        planText: 'third plan',
        items: [{ deviceId, workspacePath: WORKSPACE }],
        quota: 2,
      }),
    })
    const { authorization } = (await auth.json()) as { authorization: { id: string } }
    await waitFor(() => !server.hub.isDeviceOnline(deviceId), 3000, 'device offline')
    const outcome = await server.dispatcher.dispatch({
      authorizationId: authorization.id,
      workUnitId: 'unit-offline-2',
      deviceId,
      workspacePath: WORKSPACE,
      title: 'rejected',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      commit: false,
    })
    expect(outcome).toMatchObject({ ok: false, code: 'device-offline' })
  })

  it('非 git 工作区与越界授权都被拒绝（G10 / A-07）', async () => {
    // 上一个用例把设备断开了；派活前的在线校验先于仓库校验，所以这里重新连上
    const revived: any[] = []
    const reconnected = await openSocket(
      `ws://127.0.0.1:${new URL(base).port}/device/ws`,
      { authorization: `Bearer ${token}` },
      revived
    )
    reconnected.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'hello',
        deviceId,
        workspaces: [{ path: WORKSPACE, name: 'cloud-e2e-repo', isGit: true }],
      })
    )
    await waitFor(() => server.hub.isDeviceOnline(deviceId), 3000, 'device back online')

    const auth = await fetch(`${base}/v1/authorizations`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        planText: 'fourth plan',
        items: [{ deviceId, workspacePath: WORKSPACE }],
        quota: 1,
      }),
    })
    const { authorization } = (await auth.json()) as { authorization: { id: string } }

    const otherRepo = await server.dispatcher.dispatch({
      authorizationId: authorization.id,
      workUnitId: 'unit-other',
      deviceId,
      workspacePath: 'E:/tmp/another-repo',
      title: 'out of scope',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      commit: false,
    })
    expect(otherRepo).toMatchObject({ ok: false, code: 'unknown-workspace' })
    reconnected.close()
  })
})

describe('工作树回收（A-43 / A-46）', () => {
  let deviceFrames: any[] = []
  let clientFrames: any[] = []
  let device: WebSocket
  let client: WebSocket

  const send = (frame: Record<string, unknown>) =>
    device.send(JSON.stringify({ v: CLOUD_PROTOCOL_VERSION, ...frame }))

  async function authorize(quota = 3): Promise<string> {
    const response = await fetch(`${base}/v1/authorizations`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        planText: 'reclaim plan',
        items: [{ deviceId, workspacePath: WORKSPACE }],
        quota,
      }),
    })
    const { authorization } = (await response.json()) as { authorization: { id: string } }
    return authorization.id
  }

  async function dispatchTask(authorizationId: string, unitId: string, title: string) {
    const outcome = await server.dispatcher.dispatch({
      authorizationId,
      workUnitId: unitId,
      deviceId,
      workspacePath: WORKSPACE,
      title,
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      commit: false,
    })
    expect(outcome.ok).toBe(true)
    return outcome.ok ? outcome.task.id : ''
  }

  async function acceptAndRun(taskId: string): Promise<void> {
    await waitFor(
      () => deviceFrames.find((frame) => frame.type === 'task' && frame.task?.id === taskId),
      3000,
      `task frame ${taskId}`
    )
    for (const status of ['assigned', 'running'] as const) {
      send({ type: 'task_status', taskId, status, at: Date.now() })
      await waitFor(
        () => server.store.findTask(taskId)?.status === status,
        3000,
        `${taskId} ${status}`
      )
    }
  }

  async function finish(
    taskId: string,
    worktreeClean: boolean | undefined,
    unitId: string
  ): Promise<void> {
    send({
      type: 'task_result',
      taskId,
      at: Date.now(),
      result: {
        summary: 'done',
        changedFiles: worktreeClean ? [] : [{ path: 'run.sh', kind: 'modified' }],
        branch: `pi/${unitId}`,
        worktreeClean,
      },
    })
    await waitFor(() => server.store.findTask(taskId)?.status === 'done', 3000, `${taskId} done`)
  }

  const closeFrames = (unitId: string) =>
    deviceFrames.filter((frame) => frame.type === 'close_unit' && frame.unitId === unitId)

  beforeAll(async () => {
    deviceFrames = []
    clientFrames = []
    device = await openSocket(
      `ws://127.0.0.1:${new URL(base).port}/device/ws`,
      { authorization: `Bearer ${token}` },
      deviceFrames
    )
    device.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'hello',
        deviceId,
        workspaces: [{ path: WORKSPACE, name: 'cloud-e2e-repo', isGit: true }],
      })
    )
    await waitFor(() => server.hub.isDeviceOnline(deviceId), 3000, 'device online for reclaim')
    clientFrames = []
    client = await openSocket(
      `ws://127.0.0.1:${new URL(base).port}/client/ws`,
      { authorization: `Bearer ${clientToken}` },
      clientFrames
    )
    await waitFor(() => clientFrames.some((frame) => frame.type === 'snapshot'), 3000, 'snapshot')
  })

  afterAll(() => {
    client?.close()
    device?.close()
  })

  it('干净树：工单结束就自动回收，回执后才算结束（A-43）', async () => {
    const authorizationId = await authorize()
    const taskId = await dispatchTask(authorizationId, 'unit-auto', 'clean task')
    await acceptAndRun(taskId)
    await finish(taskId, true, 'unit-auto')

    // 云端自动下发 close_unit，不需要用户点
    const request = await waitFor(
      () => closeFrames('unit-auto')[0],
      3000,
      'auto close_unit frame'
    )
    expect(request.reason).toBe('converged')
    // 回执前不写 closedAt：避免“云端说回收了、磁盘还在”
    expect(server.store.findUnit('unit-auto')?.closeRequestedAt).toBeTypeOf('number')
    expect(server.store.findUnit('unit-auto')?.closedAt).toBeNull()

    send({
      type: 'unit_closed',
      unitId: 'unit-auto',
      removed: true,
      dirty: false,
      worktreePath: 'E:/tmp/wt-unit-auto',
      branch: 'pi/unit-auto',
      at: Date.now(),
    })

    const closed = await waitFor(
      () => (server.store.findUnit('unit-auto')?.closedAt ? server.store.findUnit('unit-auto') : null),
      3000,
      'unit closed'
    )
    expect(closed!.closeRequestedAt).toBeUndefined()
    // 客户端收到 unit 事件（多端一致）
    await waitFor(
      () =>
        clientFrames.find(
          (frame) =>
            frame.type === 'event' &&
            frame.event?.type === 'unit' &&
            frame.event.unit?.unitId === 'unit-auto' &&
            typeof frame.event.unit.closedAt === 'number'
        ),
      3000,
      'client unit event'
    )

    // 已结束的单元不再接新工单（否则会重建一棵已回收的树）
    const again = await server.dispatcher.dispatch({
      authorizationId,
      workUnitId: 'unit-auto',
      deviceId,
      workspacePath: WORKSPACE,
      title: 'too late',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      commit: false,
    })
    expect(again).toMatchObject({ ok: false, code: 'unit-closed' })
  })

  it('同一单元连派：前一张结束不回收，最后一张结束才回收（A-46）', async () => {
    const authorizationId = await authorize(5)
    const first = await dispatchTask(authorizationId, 'unit-serial', 'first')
    await acceptAndRun(first)
    const second = await dispatchTask(authorizationId, 'unit-serial', 'second')
    expect(server.store.findTask(second)?.status).toBe('queued')

    await finish(first, true, 'unit-serial')
    // 还有后续工单：不回收，工作树留给下一张复用
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(closeFrames('unit-serial')).toHaveLength(0)

    // FIFO：下一张自动接力
    await acceptAndRun(second)
    await finish(second, true, 'unit-serial')
    await waitFor(() => closeFrames('unit-serial')[0], 3000, 'close after last task')
    expect(closeFrames('unit-serial')).toHaveLength(1)
  })

  it('脏树：不自动回收；用户手动结束后按回执标「待处理」（A-43）', async () => {
    const authorizationId = await authorize(3)
    const taskId = await dispatchTask(authorizationId, 'unit-dirty', 'dirty task')
    await acceptAndRun(taskId)
    await finish(taskId, false, 'unit-dirty')

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(closeFrames('unit-dirty')).toHaveLength(0)

    // 人工入口：客户端帧（Web 走同样的 REST 端点）
    client.send(JSON.stringify({ v: CLOUD_PROTOCOL_VERSION, type: 'close_unit', unitId: 'unit-dirty' }))
    const request = await waitFor(() => closeFrames('unit-dirty')[0], 3000, 'manual close_unit frame')
    expect(request.reason).toBe('user-close')

    send({
      type: 'unit_closed',
      unitId: 'unit-dirty',
      removed: false,
      dirty: true,
      worktreePath: 'E:/tmp/wt-unit-dirty',
      at: Date.now(),
    })

    const unit = await waitFor(
      () => (server.store.findUnit('unit-dirty')?.dirtyAt ? server.store.findUnit('unit-dirty') : null),
      3000,
      'unit dirty recorded'
    )
    // 脏树保留：closedAt 仍是 null，用户清理后还能再结束一次
    expect(unit!.closedAt).toBeNull()
    expect(unit!.worktreePath).toBe('E:/tmp/wt-unit-dirty')
  })

  it('REST 结束单元：未知 404 / 有工单在跑 409 / 空闲 200；unit_state 能兑底回收（F-19a）', async () => {
    // 未知单元
    const missing = await fetch(`${base}/v1/units/nope/close`, {
      method: 'POST',
      headers: jsonHeaders(),
    })
    expect(missing.status).toBe(404)

    const authorizationId = await authorize(5)
    const taskId = await dispatchTask(authorizationId, 'unit-rest', 'rest task')
    await acceptAndRun(taskId)

    // 还有工单在跑：拒绍，并要求先停工单（不能把正在写的文件当脏树）
    const busy = await fetch(`${base}/v1/units/unit-rest/close`, {
      method: 'POST',
      headers: jsonHeaders(),
    })
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ code: 'task-running' })

    // 不报 worktreeClean（模拟旧终端 / 离线）：不会自动回收
    send({
      type: 'task_result',
      taskId,
      at: Date.now(),
      result: { summary: 'done without cleanliness', changedFiles: [] },
    })
    await waitFor(() => server.store.findTask(taskId)?.status === 'done', 3000, 'rest task done')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(closeFrames('unit-rest')).toHaveLength(0)

    // 空闲后 REST 回收
    const ok = await fetch(`${base}/v1/units/unit-rest/close`, {
      method: 'POST',
      headers: jsonHeaders(),
    })
    expect(ok.status).toBe(200)
    await waitFor(() => closeFrames('unit-rest')[0], 3000, 'rest close frame')

    // 设备重连/启动时的兑底上报：干净且已收敛 → 自动回收（A-43）
    const sweepTask = await dispatchTask(authorizationId, 'unit-sweep', 'sweep task')
    await acceptAndRun(sweepTask)
    send({
      type: 'task_result',
      taskId: sweepTask,
      at: Date.now(),
      result: { summary: 'done', changedFiles: [] },
    })
    await waitFor(
      () => server.store.findTask(sweepTask)?.status === 'done',
      3000,
      'sweep task done'
    )
    expect(closeFrames('unit-sweep')).toHaveLength(0)

    send({
      type: 'unit_state',
      unitId: 'unit-sweep',
      clean: true,
      worktreePath: 'E:/tmp/wt-unit-sweep',
      at: Date.now(),
    })
    const sweepFrame = await waitFor(() => closeFrames('unit-sweep')[0], 3000, 'sweep close frame')
    expect(sweepFrame.reason).toBe('sweep')
  })

  it('回收失败的设备回执不能写成「已结束」（否则磁盘还在云端却说没了）', async () => {
    const authorizationId = await authorize(3)
    const taskId = await dispatchTask(authorizationId, 'unit-broken', 'broken task')
    await acceptAndRun(taskId)
    await finish(taskId, true, 'unit-broken')
    await waitFor(() => closeFrames('unit-broken')[0], 3000, 'close frame for unit-broken')

    send({
      type: 'unit_closed',
      unitId: 'unit-broken',
      removed: false,
      dirty: false,
      worktreePath: 'E:/tmp/wt-unit-broken',
      error: 'git worktree remove failed',
      at: Date.now(),
    })

    // 等一轮事件循环：回执处理完才能断言
    await clientFrameFor('unit-broken')
    const unit = server.store.findUnit('unit-broken')!
    expect(unit.closedAt).toBeNull()
    // 回收请求已消耗，用户可以重试（不会被当成又一轮待处理）
    expect(unit.closeRequestedAt).toBeUndefined()
  })

  /** 等到 unit 事件里该单元被 publish 过（回执处理完成） */
  async function clientFrameFor(unitId: string): Promise<void> {
    await waitFor(
      () =>
        clientFrames.filter(
          (frame) => frame.type === 'event' && frame.event?.type === 'unit' && frame.event.unit?.unitId === unitId
        ).length >= 2,
      3000,
      `unit event ${unitId}`
    )
  }

  it('设备重启时对「已请求回收但没回执」的单元重发一次（避免卡在回收中）', async () => {
    const now = Date.now()
    // 已请求回收、但设备一直没回执的单元
    await server.store.saveUnit({
      unitId: 'unit-stale',
      deviceId,
      workspacePath: WORKSPACE,
      createdAt: now - 600_000,
      closedAt: null,
      closeRequestedAt: now - 300_000,
    })
    // 刚请求过（< 60 s）的不重发：避免设备每次重连都收一堆同一条请求
    await server.store.saveUnit({
      unitId: 'unit-fresh',
      deviceId,
      workspacePath: WORKSPACE,
      createdAt: now,
      closedAt: null,
      closeRequestedAt: now - 1_000,
    })
    await server.store.saveUnit({
      unitId: 'unit-sweep-dirty',
      deviceId,
      workspacePath: WORKSPACE,
      createdAt: now,
      closedAt: null,
    })

    send({ type: 'unit_state', unitId: 'unit-fresh', clean: true, at: now })
    send({ type: 'unit_state', unitId: 'unit-sweep-dirty', clean: false, at: now })
    send({
      type: 'unit_state',
      unitId: 'unit-stale',
      clean: true,
      worktreePath: 'E:/tmp/wt-stale',
      at: now,
    })

    const resent = await waitFor(() => closeFrames('unit-stale')[0], 3000, 'stale close re-sent')
    expect(resent.reason).toBe('sweep')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(closeFrames('unit-fresh')).toHaveLength(0)
    expect(closeFrames('unit-sweep-dirty')).toHaveLength(0)
  })

  it('快照里的已结束单元会封顶（否则快照随工单数量无上限变大）', async () => {
    const base = Date.now()
    for (let index = 0; index < 25; index += 1) {
      await server.store.saveUnit({
        unitId: `unit-hist-${index}`,
        deviceId,
        workspacePath: WORKSPACE,
        createdAt: base + index,
        closedAt: base + index,
      })
    }
    await server.store.saveUnit({
      unitId: 'unit-hist-open',
      deviceId,
      workspacePath: WORKSPACE,
      createdAt: base,
      closedAt: null,
    })

    const views = server.dispatcher.unitViews()
    expect(views.filter((unit) => unit.closedAt === null)).toContainEqual(
      expect.objectContaining({ unitId: 'unit-hist-open' })
    )
    // 未结束的全量保留，已结束的只留最近 20 条（其他用例造的已结束单元也会被挤掉）
    expect(views.filter((unit) => unit.closedAt !== null).length).toBe(20)
    expect(views.filter((unit) => unit.closedAt !== null).map((unit) => unit.unitId)).toContain(
      'unit-hist-24'
    )
  })
})

describe('重连对账（A-13 / F-21）', () => {
  /**
   * 事故：只要设备掉线超过 60 s，服务端就把在跑工单判 `cancelled(device-offline)`；
   * 但终端在本地还在跑，重连后不拉服务端状态就会把已经取消的活干完 ——
   * 用户看到“已取消”，文件却被继续改。对账必须由服务端判定。
   */
  const frames: any[] = []
  let device: WebSocket

  beforeAll(async () => {
    device = await openSocket(
      `ws://127.0.0.1:${new URL(base).port}/device/ws`,
      { authorization: `Bearer ${token}` },
      frames
    )
    device.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'hello',
        deviceId,
        workspaces: [{ path: WORKSPACE, name: 'cloud-e2e-repo', isGit: true }],
      })
    )
    await waitFor(() => server.hub.isDeviceOnline(deviceId), 3000, 'device online')
  })

  afterAll(() => {
    device?.close()
  })

  async function dispatchRunning(unitId: string): Promise<string> {
    const authorized = await fetch(`${base}/v1/authorizations`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        planText: 'reconcile plan',
        items: [{ deviceId, workspacePath: WORKSPACE }],
        quota: 3,
      }),
    })
    const { authorization } = (await authorized.json()) as { authorization: { id: string } }
    const outcome = await server.dispatcher.dispatch({
      authorizationId: authorization.id,
      workUnitId: unitId,
      deviceId,
      workspacePath: WORKSPACE,
      title: 'reconcile',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      commit: false,
    })
    expect(outcome.ok).toBe(true)
    const taskId = outcome.ok ? outcome.task.id : ''
    // 状态机不允许 queued → running：终端总是先回 assigned 再回 running
    for (const status of ['assigned', 'running'] as const) {
      device.send(
        JSON.stringify({
          v: CLOUD_PROTOCOL_VERSION,
          type: 'task_status',
          taskId,
          status,
          at: Date.now(),
        })
      )
      await waitFor(() => server.store.findTask(taskId)?.status === status, 3000, `task ${status}`)
    }
    return taskId
  }

  it('服务端已判终态的工单：重连 hello 时要求终端停手', async () => {
    const taskId = await dispatchRunning('unit-reconcile-1')
    // 掉线期间的终态（离线判定 / 用户停止 / 超时都是这条路径）
    await server.dispatcher.cancelTask(taskId, 'device-offline')
    frames.length = 0

    device.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'hello',
        deviceId,
        workspaces: [{ path: WORKSPACE, name: 'cloud-e2e-repo', isGit: true }],
        runningTasks: [taskId],
      })
    )
    const cancel = await waitFor(
      () => frames.find((frame) => frame.type === 'task_cancel' && frame.taskId === taskId),
      3000,
      'reconcile cancel'
    )
    expect(cancel.reason).toBe('device-offline')
  })

  it('服务端没有记录的孤儿工单：也要求终端停手（否则会堵住单设备 FIFO）', async () => {
    frames.length = 0
    device.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'hello',
        deviceId,
        workspaces: [{ path: WORKSPACE, name: 'cloud-e2e-repo', isGit: true }],
        runningTasks: ['T-does-not-exist'],
      })
    )
    const cancel = await waitFor(
      () => frames.find((frame) => frame.type === 'task_cancel' && frame.taskId === 'T-does-not-exist'),
      3000,
      'orphan cancel'
    )
    expect(cancel.reason).toBe('unknown-task')
  })

  it('还在跑的工单不被打扰', async () => {
    const taskId = await dispatchRunning('unit-reconcile-2')
    frames.length = 0
    device.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'hello',
        deviceId,
        workspaces: [{ path: WORKSPACE, name: 'cloud-e2e-repo', isGit: true }],
        runningTasks: [taskId],
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(frames.some((frame) => frame.type === 'task_cancel' && frame.taskId === taskId)).toBe(false)
    // 收尾：让后面的用例不受这张工单影响
    await server.dispatcher.cancelTask(taskId, 'user-cancel')
  })
})
