/**
 * 派活 worker：帧分发、串行执行、取消、上报顺序、账本。
 *
 * 执行器与云端客户端都注入替身，测的是 worker 自己的状态机（真实会话执行另测）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const state = vi.hoisted(() => ({ appDir: '', cloud: null as unknown }))

// worker → executor → ipc/agent 会顺带加载 IPC 注册表，这里要把 electron 挡住
vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  app: { getAppPath: () => '', getPath: () => '', isPackaged: false, isReady: () => false },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => {} },
  net: { fetch: async () => new Response('{}') },
  WebContentsView: class {},
  BrowserWindow: class {}
}))

vi.mock('../electron/app-paths.js', () => ({
  getAppDir: () => state.appDir,
}))

vi.mock('../electron/cloud/config.js', () => ({
  readCloudConfig: () =>
    state.cloud ?? {
      gatewayUrl: 'https://hub.example.com',
      dashboardUrl: '',
      hasDeviceToken: true,
      deviceToken: 'pi_hub_test',
      deviceScopes: ['chat', 'dispatch'],
      deviceId: 'dev-1',
    },
}))

import { readDispatchConfig, writeDispatchConfig, workspaceIdFor } from '../electron/dispatch/config'
import { DispatchWorker, type DispatchExecutorLike } from '../electron/dispatch/worker'
import { readLedger, ledgerPath } from '../electron/dispatch/ledger'
import type { CloudClient } from '../electron/cloud/client'

let tmp = ''
let workspace = ''

interface ReportCall {
  url: string
  body: unknown
}

function makeClient(): { client: CloudClient; reports: ReportCall[] } {
  const reports: ReportCall[] = []
  const client = {
    request: async (url: string, init?: { body?: unknown }) => {
      reports.push({ url, body: init?.body })
      return {}
    },
    openStream: async () => ({ ok: true, status: 200, body: null }) as unknown as Response,
  } as unknown as CloudClient
  return { client, reports }
}

function makeExecutor(outcome?: () => Promise<{
  report: { kind: 'done' | 'failed' | 'canceled'; summary?: string; error?: string }
  sessionId: string | null
}>): DispatchExecutorLike & {
  runs: string[]
  cancels: string[]
  release: () => void
  waiters: Array<() => void>
} {
  const runs: string[] = []
  const cancels: string[] = []
  let gates: Array<() => void> = []
  const self = {
    runs,
    cancels,
    waiters: gates,
    release: () => {
      const pending = gates
      gates = []
      for (const resolve of pending) resolve()
    },
    run: async (task: { taskId: string; workspacePath: string }) => {
      runs.push(`${task.taskId}@${path.basename(task.workspacePath)}`)
      if (outcome) return outcome()
      await new Promise<void>((resolve) => {
        gates.push(resolve)
      })
      return {
        report: { kind: 'done' as const, summary: `已处理 ${task.taskId}` },
        sessionId: `session-${task.taskId}`
      }
    },
    cancel: async (taskId: string) => {
      cancels.push(taskId)
      return true
    }
  }
  return self
}

function createWorker(
  executor: DispatchExecutorLike,
  client: CloudClient,
  overrides: Partial<ConstructorParameters<typeof DispatchWorker>[0]> = {}
): { worker: DispatchWorker; states: unknown[] } {
  const states: unknown[] = []
  const worker = new DispatchWorker({
    context: {} as never,
    readApiConfig: async () => null,
    logger: { warn: () => {} },
    ledgerPath: ledgerPath(tmp),
    onState: (snapshot) => states.push(snapshot),
    createClient: () => client,
    executor,
    now: () => 1_700_000_000_000,
    // 中继重连不真等：测试只关心分发逻辑
    relayDelay: async () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    ...overrides
  })
  return { worker, states }
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dispatch-worker-'))
  state.appDir = tmp
  workspace = path.join(tmp, 'repo')
  fs.mkdirSync(workspace, { recursive: true })
  await writeDispatchConfig({
    enabled: true,
    workspaces: [{ id: '', path: workspace, label: 'Repo', description: '' }]
  })
})

afterEach(async () => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const wsId = () => workspaceIdFor(workspace)

describe('dispatch worker', () => {
  it('runs a dispatched task and reports claimed → done', async () => {
    const { client, reports } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()

    await worker.handleFrame({
      type: 'task.assigned',
      taskId: 't-1',
      workspaceId: wsId(),
      prompt: '跑测试'
    })
    await vi.waitFor(() => expect(executor.runs).toEqual(['t-1@repo']))
    expect(worker.getState().runningTaskId).toBe('t-1')
    expect(worker.getState().runningWorkspace).toBe('Repo')

    executor.release()
    await vi.waitFor(() => expect(worker.getState().runningTaskId).toBeNull())

    expect(reports.map((call) => call.url)).toEqual([
      '/v1/hub/workspaces',
      '/v1/hub/relay/report',
      '/v1/hub/relay/report'
    ])
    expect(reports[1].body).toMatchObject({ taskId: 't-1', kind: 'claimed' })
    expect(reports[2].body).toMatchObject({
      taskId: 't-1',
      kind: 'done',
      summary: '已处理 t-1',
      localSessionId: 'session-t-1'
    })

    const ledger = readLedger(ledgerPath(tmp))
    expect(ledger[0]).toMatchObject({
      taskId: 't-1',
      workspaceLabel: 'Repo',
      state: 'completed',
      sessionId: 'session-t-1'
    })
    await worker.stop()
  })

  it('runs one task at a time and keeps the rest queued', async () => {
    const { client } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()

    await worker.handleFrame({ type: 'task.assigned', taskId: 't-1', workspaceId: wsId(), prompt: 'a' })
    await worker.handleFrame({ type: 'task.assigned', taskId: 't-2', workspaceId: wsId(), prompt: 'b' })
    await vi.waitFor(() => expect(executor.runs).toHaveLength(1))
    expect(worker.getState().queued).toBe(1)

    executor.release()
    await vi.waitFor(() => expect(executor.runs).toHaveLength(2))
    expect(executor.runs).toEqual(['t-1@repo', 't-2@repo'])
    executor.release()
    await vi.waitFor(() => expect(worker.getState().queued).toBe(0))
    await worker.stop()
  })

  it('ignores a duplicated assignment for the same task', async () => {
    const { client } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()

    await worker.handleFrame({ type: 'task.assigned', taskId: 't-1', workspaceId: wsId(), prompt: 'a' })
    await worker.handleFrame({ type: 'task.assigned', taskId: 't-1', workspaceId: wsId(), prompt: 'a' })
    await vi.waitFor(() => expect(executor.runs).toHaveLength(1))
    expect(worker.getState().queued).toBe(0)
    executor.release()
    await vi.waitFor(() => expect(worker.getState().runningTaskId).toBeNull())
    await worker.stop()
  })

  it('fails a task whose workspace is no longer whitelisted', async () => {
    const { client, reports } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()

    await worker.handleFrame({ type: 'task.assigned', taskId: 't-9', workspaceId: 'ws-ghost', prompt: 'x' })
    await vi.waitFor(() =>
      expect(reports.some((call) => (call.body as { kind?: string }).kind === 'failed')).toBe(true)
    )
    const failed = reports.find((call) => (call.body as { kind?: string }).kind === 'failed')
    expect((failed?.body as { error: string }).error).toContain('白名单')
    expect(executor.runs).toEqual([])
    await vi.waitFor(() =>
      expect(readLedger(ledgerPath(tmp))[0]).toMatchObject({ state: 'failed', sessionId: null })
    )
    await worker.stop()
  })

  it('fails a task whose directory disappeared', async () => {
    const { client, reports } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()
    fs.rmSync(workspace, { recursive: true, force: true })

    await worker.handleFrame({ type: 'task.assigned', taskId: 't-3', workspaceId: wsId(), prompt: 'x' })
    await vi.waitFor(() =>
      expect(reports.some((call) => (call.body as { kind?: string }).kind === 'failed')).toBe(true)
    )
    expect(executor.runs).toEqual([])
    await worker.stop()
  })

  it('cancels a queued task without running it, and aborts a running one', async () => {
    const { client, reports } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()

    await worker.handleFrame({ type: 'task.assigned', taskId: 't-1', workspaceId: wsId(), prompt: 'a' })
    await vi.waitFor(() => expect(executor.runs).toHaveLength(1))
    await worker.handleFrame({ type: 'task.assigned', taskId: 't-2', workspaceId: wsId(), prompt: 'b' })
    expect(worker.getState().queued).toBe(1)

    // t-2 还在队列里：直接回报 canceled，不执行
    await worker.handleFrame({ type: 'task.cancel', taskId: 't-2' })
    expect(reports.some((call) => (call.body as { taskId?: string; kind?: string }).taskId === 't-2' &&
      (call.body as { kind?: string }).kind === 'canceled')).toBe(true)
    expect(worker.getState().queued).toBe(0)

    // t-1 正在跑：交给执行器 abort
    await worker.handleFrame({ type: 'task.cancel', taskId: 't-1' })
    expect(executor.cancels).toEqual(['t-1'])

    executor.release()
    await vi.waitFor(() => expect(worker.getState().runningTaskId).toBeNull())
    await worker.stop()
  })

  it('records a failed run honestly', async () => {
    const { client } = makeClient()
    const executor = makeExecutor(async () => ({
      report: { kind: 'failed' as const, error: '模型报错' },
      sessionId: 'session-x'
    }))
    const { worker } = createWorker(executor, client)
    await worker.refresh()
    await worker.handleFrame({ type: 'task.assigned', taskId: 't-5', workspaceId: wsId(), prompt: 'a' })
    await vi.waitFor(() => expect(worker.getState().runningTaskId).toBeNull())
    expect(readLedger(ledgerPath(tmp))[0]).toMatchObject({
      taskId: 't-5',
      state: 'failed',
      summary: '模型报错'
    })
    await worker.stop()
  })

  it('stops publishing and refuses work when dispatch is off', async () => {
    const { client, reports } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()
    expect(reports).toHaveLength(1)

    await writeDispatchConfig({ enabled: false, workspaces: [] })
    await worker.refresh()
    expect(worker.getState().enabled).toBe(false)
    expect(worker.getState().connected).toBe(false)
    // 关掉派活要先把清单标成不可派活，云端才立刻停派
    expect(reports[reports.length - 1]?.body).toEqual({ dispatchable: false, workspaces: [] })

    // 关掉之后即使收到帧也不执行（网关侧同样会拒绝，这里是本机兜底）
    await worker.handleFrame({ type: 'task.assigned', taskId: 't-7', workspaceId: wsId(), prompt: 'a' })
    expect(executor.runs).toEqual([])
    await worker.stop()
  })

  it('does nothing without a paired device token', async () => {
    state.cloud = {
      gatewayUrl: 'https://hub.example.com',
      dashboardUrl: '',
      hasDeviceToken: false,
      deviceToken: '',
      deviceScopes: [],
      deviceId: 'dev-1'
    }
    const { client, reports } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()
    expect(reports).toEqual([])
    expect(worker.getState().connected).toBe(false)
    state.cloud = null
    await worker.stop()
  })

  it('stops the running task on emergency stop and records it as canceled', async () => {
    const { client, reports } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()
    await worker.handleFrame({ type: 'task.assigned', taskId: 't-1', workspaceId: wsId(), prompt: 'a' })
    await vi.waitFor(() => expect(executor.runs).toHaveLength(1))

    await worker.stopNow()
    expect(executor.cancels).toEqual(['t-1'])
    expect(worker.getState().enabled).toBe(false)
    // 急停要落盘 enabled:false，否则重启后中继又自己连上
    expect(readDispatchConfig().enabled).toBe(false)
    // 并且把清单标成不可派活，让云端立刻停派；工作区本身留着，模型能据此判断该请人打开开关
    expect(reports[reports.length - 1]?.body).toEqual({
      dispatchable: false,
      workspaces: [{ id: workspaceIdFor(workspace), label: 'Repo', description: '' }],
    })

    // abort 让执行器返回失败，但这条任务必须报 canceled（云端与账本都以取消为准）
    executor.release()
    await vi.waitFor(() => expect(readLedger(ledgerPath(tmp))[0]?.state).toBe('canceled'))
    expect(
      reports.some(
        (call) =>
          (call.body as { taskId?: string }).taskId === 't-1' &&
          (call.body as { kind?: string }).kind === 'canceled'
      )
    ).toBe(true)
    expect(
      reports.some(
        (call) =>
          (call.body as { taskId?: string }).taskId === 't-1' &&
          (call.body as { kind?: string }).kind === 'failed'
      )
    ).toBe(false)
  })

  it('cancels queued tasks on emergency stop instead of leaving them hanging', async () => {
    const { client, reports } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()
    await worker.handleFrame({ type: 'task.assigned', taskId: 't-1', workspaceId: wsId(), prompt: 'a' })
    await vi.waitFor(() => expect(executor.runs).toHaveLength(1))
    await worker.handleFrame({ type: 'task.assigned', taskId: 't-2', workspaceId: wsId(), prompt: 'b' })
    expect(worker.getState().queued).toBe(1)

    await worker.stopNow()
    expect(
      reports.some(
        (call) =>
          (call.body as { taskId?: string }).taskId === 't-2' &&
          (call.body as { kind?: string }).kind === 'canceled'
      )
    ).toBe(true)
    executor.release()
  })
})
