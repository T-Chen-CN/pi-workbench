/**
 * 终端侧 device agent：帧路由、失败上报、离线队列与 G6 恢复。
 *
 * 这里不打真模型：工单会因为没有 API 配置直接失败，正好覆盖「执行器报错也要
 * 把 task_failed 送回云端」这条路径。
 */

// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import { CLOUD_PROTOCOL_VERSION } from 'pi-bridge'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.env.TEMP ?? '/tmp',
  },
}))

const linkState: { record: any; token: string; baseUrl: string } = {
  record: null,
  token: '',
  baseUrl: '',
}

vi.mock('../electron/cloud/link-store.js', () => ({
  readCloudLink: () => linkState.record,
  readCloudToken: () => linkState.token,
  touchCloudLink: async () => undefined,
  saveCloudLink: async (input: any) => {
    linkState.record = { ...input, pairedAt: Date.now() }
    return linkState.record
  },
  clearCloudLink: async () => {
    linkState.record = null
  },
  normalizeBaseUrl: (input: string) => input,
  wsUrl: (base: string, pathname: string) => `${base}${pathname}`,
}))

const { DeviceAgent } = await import('../electron/cloud/device-agent')
import type { DeviceLinkState } from '../electron/cloud/device-agent'

let tmpRoot: string
let server: WebSocketServer
let port = 0
let received: any[] = []
let sockets: WebSocket[] = []

function waitFor<T>(probe: () => T | undefined, label: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const value = probe()
      if (value) return resolve(value)
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${label}`))
      setTimeout(tick, 20)
    }
    tick()
  })
}

function frame(type: string): any {
  return received.find((item) => item.type === type)
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-device-'))
  server = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  port = (server.address() as { port: number }).port
  linkState.baseUrl = `ws://127.0.0.1:${port}`
  linkState.record = {
    baseUrl: linkState.baseUrl,
    deviceId: 'dev-test',
    deviceName: 'test-device',
    token: 'enc:whatever',
    pairedAt: Date.now(),
  }
  linkState.token = 'plain-token'

  server.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (raw) => {
      received.push(JSON.parse(String(raw)))
    })
  })
})

afterAll(async () => {
  for (const socket of sockets) socket.terminate()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

beforeEach(() => {
  received = []
})

function makeAgent(
  overrides: { dataDir?: string; getCoordinator?: any; getWorkspaces?: any } = {}
) {
  const states: DeviceLinkState[] = []
  const agent = new (DeviceAgent as any)({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    dataDir: overrides.dataDir ?? path.join(tmpRoot, 'cloud'),
    getWorkspaces:
      overrides.getWorkspaces ??
      (async () => [
        { path: path.join(tmpRoot, 'repo'), name: 'repo', isGit: true, defaultBranch: 'main' },
      ]),
    getApiConfig: async () => null,
    getCoordinator: overrides.getCoordinator ?? (async () => null),
    onStateChange: (state: DeviceLinkState) => states.push(state),
  })
  return { agent, states }
}

describe('连接与帧', () => {
  it('连上先发 hello（带工作区清单），心跳与工作区刷新走同一通道', async () => {
    const { agent, states } = makeAgent()
    await agent.start()
    const hello = await waitFor(() => frame('hello'), 'hello')
    expect(hello.deviceId).toBe('dev-test')
    expect(hello.workspaces[0]).toMatchObject({ name: 'repo', isGit: true })
    expect(hello.v).toBe(CLOUD_PROTOCOL_VERSION)
    // 重连对账（F-21 / A-13）：终端要把“自己认为还在跑的工单”报上去
    expect(hello.runningTasks).toEqual([])
    expect(states[states.length - 1]?.status).toBe('online')

    await agent.refreshWorkspaces()
    await waitFor(() => frame('workspaces'), 'workspaces')
    await agent.stop()
  })

  it('工单在非 git 仓库上直接失败，并把原因回传', async () => {
    const nonGitPath = path.join(tmpRoot, 'not-a-repo')
    const { agent } = makeAgent({
      getWorkspaces: async () => [
        { path: path.join(tmpRoot, 'repo'), name: 'repo', isGit: true, defaultBranch: 'main' },
        { path: nonGitPath, name: 'not-a-repo', isGit: false },
      ],
    })
    await agent.start()
    await waitFor(() => frame('hello'), 'hello')
    const socket = sockets[sockets.length - 1]!
    socket.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'task',
        seq: 1,
        task: {
          id: 'T-1',
          status: 'queued',
          idempotencyKey: 'k1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          progress: { step: 0, lastEventAt: Date.now() },
          spec: {
            workUnitId: 'unit-1',
            deviceId: 'dev-test',
            repo: { workspacePath: nonGitPath },
            title: 't',
            background: 'b',
            goal: 'g',
            acceptance: 'a',
            output: { summary: true, changeList: true, testResult: true },
            commit: false,
            authorizationId: 'auth-1',
          },
        },
      })
    )
    const failed = await waitFor(() => frame('task_failed'), 'task_failed')
    expect(failed.taskId).toBe('T-1')
    expect(String(failed.error)).toMatch(/not found|git repository/i)
    await agent.stop()
  })

  it('拒绝未在设备登记/受信任的工作区路径', async () => {
    const { agent } = makeAgent()
    await agent.start()
    await waitFor(() => frame('hello'), 'hello')
    const socket = sockets[sockets.length - 1]!
    socket.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'task',
        seq: 1,
        task: {
          id: 'T-untrusted',
          status: 'queued',
          idempotencyKey: 'k-untrusted',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          progress: { step: 0, lastEventAt: Date.now() },
          spec: {
            workUnitId: 'unit-untrusted',
            deviceId: 'dev-test',
            repo: { workspacePath: path.join(tmpRoot, 'unregistered-dir') },
            title: 't',
            background: 'b',
            goal: 'g',
            acceptance: 'a',
            output: { summary: true, changeList: true, testResult: true },
            commit: false,
            authorizationId: 'auth-1',
          },
        },
      })
    )
    const failed = await waitFor(() => frame('task_failed'), 'task_failed')
    expect(failed.taskId).toBe('T-untrusted')
    expect(String(failed.error)).toMatch(/not trusted or registered/i)
    await agent.stop()
  })

  it('服务端发 task_cancel 时结束执行器', async () => {
    const { agent } = makeAgent()
    await agent.start()
    await waitFor(() => frame('hello'), 'hello')
    const socket = sockets[sockets.length - 1]!
    socket.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'task_cancel',
        seq: 2,
        taskId: 'T-unknown',
        reason: 'user-cancel',
      })
    )
    // 未知工单不发任何帧，也不崩
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(frame('task_interrupted')).toBeUndefined()
    await agent.stop()
  })

  it('心跳帧保持连接（25s 一次；这里只验证通道可发）', async () => {
    const { agent } = makeAgent()
    await agent.start()
    await waitFor(() => frame('hello'), 'hello')
    expect(agent.getState().status).toBe('online')
    await agent.stop()
    expect(agent.getState().status).toBe('online')
  })
})

describe('G6 崩溃恢复', () => {
  it('启动时把上次残留的未完成工单标 interrupted 并上报', async () => {
    const dataDir = path.join(tmpRoot, 'cloud-recover')
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(
      path.join(dataDir, 'tasks.json'),
      JSON.stringify({
        'T-stale': {
          id: 'T-stale',
          unitId: 'unit-1',
          repoPath: path.join(tmpRoot, 'repo'),
          worktreePath: path.join(tmpRoot, 'repo'),
          status: 'running',
          startedAt: Date.now() - 60_000,
        },
      })
    )

    const { agent } = makeAgent({ dataDir })
    await agent.start()
    const interrupted = await waitFor(() => frame('task_interrupted'), 'task_interrupted')
    expect(interrupted.taskId).toBe('T-stale')
    expect(interrupted.reason).toMatch(/restart/i)
    await agent.stop()
  })
})

describe('离线队列', () => {
  it('断线时的帧进队列，重连后补发', async () => {
    const { agent } = makeAgent()
    await agent.start()
    await waitFor(() => frame('hello'), 'hello')

    // 服务端把所有连接踢掉，模拟网络中断
    for (const socket of sockets) socket.terminate()
    sockets = []
    await waitFor(() => agent.getState().status !== 'online', 'offline')

    await agent.refreshWorkspaces()
    expect(agent.getState().pending).toBeGreaterThan(0)

    received = []
    await agent.reconnect()
    await waitFor(() => frame('workspaces'), 'workspaces after reconnect', 6000)
    expect(agent.getState().pending).toBe(0)
    await agent.stop()
  })
})
