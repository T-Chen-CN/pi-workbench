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
    // 真实执行器 abort 后 run 会立刻返回（带失败报告），这里同样放行，
    // 否则「取消后 drain 收尾」的路径在测试里永远不会发生
    cancel: async (taskId: string) => {
      cancels.push(taskId)
      self.release()
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
    traceDir: path.join(tmp, 'cache', 'dispatch-traces'),
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

  it('keeps a long report intact in the ledger and flags the truncated ones', async () => {
    const { client } = makeClient()
    // 旧行为是裸 slice(0,500)：实测 20 条里 15 条正好卡在 500，断在句子中间，
    // 而界面上只有一行 caption —— 全文在本机没有可读位置。
    const long = `${'报告开始。'.repeat(120)}结尾在这`
    expect(long.length).toBeGreaterThan(500)
    const executor = makeExecutor(async () => ({
      report: { kind: 'done' as const, summary: long },
      sessionId: 'session-long'
    }))
    const { worker } = createWorker(executor, client)
    await worker.refresh()

    await worker.handleFrame({ type: 'task.assigned', taskId: 't-long', workspaceId: wsId(), prompt: 'a' })
    await vi.waitFor(() => expect(readLedger(ledgerPath(tmp))[0]?.state).toBe('completed'))

    const entry = readLedger(ledgerPath(tmp))[0]
    expect(entry?.summary).toBe(long)
    expect(entry?.summary.endsWith('结尾在这')).toBe(true)
    expect(entry?.truncated).toBeUndefined()
    await worker.stop()
  })

  it('flags a report that hits the 4k local cap instead of dropping it silently', async () => {
    const { client } = makeClient()
    const huge = 'x'.repeat(5_000)
    const executor = makeExecutor(async () => ({
      report: { kind: 'done' as const, summary: huge },
      sessionId: 'session-huge'
    }))
    const { worker } = createWorker(executor, client)
    await worker.refresh()

    await worker.handleFrame({ type: 'task.assigned', taskId: 't-huge', workspaceId: wsId(), prompt: 'a' })
    await vi.waitFor(() => expect(readLedger(ledgerPath(tmp))[0]?.state).toBe('completed'))

    const entry = readLedger(ledgerPath(tmp))[0]
    expect(entry?.summary).toHaveLength(4_000)
    expect(entry?.truncated).toBe(true)
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
    // 急停与「关派活开关」要能分辨：账本里得是「本机急停」
    await vi.waitFor(() =>
      expect(readLedger(ledgerPath(tmp))[0]?.summary).toBe('本机急停')
    )
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

  it('cancels the running task when the switch is turned off', async () => {
    const { client, reports } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()
    await worker.handleFrame({ type: 'task.assigned', taskId: 't-off', workspaceId: wsId(), prompt: 'a' })
    await vi.waitFor(() => expect(executor.runs).toHaveLength(1))

    // 关开关走的是 refresh() → stop()：必须同样 abort，不能只断开中继把任务留在后台写文件
    await writeDispatchConfig({
      enabled: false,
      workspaces: [{ id: '', path: workspace, label: 'Repo', description: '' }]
    })
    await worker.refresh()

    expect(executor.cancels).toEqual(['t-off'])
    await vi.waitFor(() =>
      expect(readLedger(ledgerPath(tmp))[0]).toMatchObject({
        taskId: 't-off',
        state: 'canceled',
        summary: '派活已关闭'
      })
    )
    expect(
      reports.some(
        (call) =>
          (call.body as { taskId?: string }).taskId === 't-off' &&
          (call.body as { kind?: string }).kind === 'canceled'
      )
    ).toBe(true)
    expect(worker.getState().runningTaskId).toBe(null)
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

describe('dispatch worker · input_required 与断线补发', () => {
  it('reports the question, then resumes the same run with the cloud answer', async () => {
    const { client, reports } = makeClient()
    let askFn: ((question: string) => Promise<string>) | undefined
    const executor = makeExecutor()
    executor.run = async (task: any) => {
      askFn = task.ask
      const answer = await task.ask!('删哪个分支？')
      return {
        report: { kind: 'done' as const, summary: `按「${answer}」处理完毕` },
        sessionId: 'session-ask'
      }
    }
    const { worker } = createWorker(executor, client)
    await worker.refresh()

    await worker.handleFrame({
      type: 'task.assigned',
      taskId: 't-ask',
      workspaceId: wsId(),
      prompt: '把那个删了'
    })
    await vi.waitFor(() => expect(askFn).toBeTypeOf('function'))
    await vi.waitFor(() =>
      expect(worker.getState().question).toBe('删哪个分支？')
    )
    expect(reports[reports.length - 1]?.body).toMatchObject({
      taskId: 't-ask',
      kind: 'question',
      question: '删哪个分支？'
    })

    await worker.handleFrame({ type: 'task.answered', taskId: 't-ask', answer: '删 feature/x' })
    await vi.waitFor(() => expect(worker.getState().runningTaskId).toBeNull())
    expect(reports[reports.length - 1]?.body).toMatchObject({
      taskId: 't-ask',
      kind: 'done',
      summary: '按「删 feature/x」处理完毕'
    })
    expect(worker.getState().question).toBeNull()
  })

  it('rejects the pending question when the task is canceled', async () => {
    const { client } = makeClient()
    const executor = makeExecutor()
    let failure = ''
    executor.run = async (task: any) => {
      try {
        await task.ask!('要哪个？')
        return { report: { kind: 'done' as const, summary: 'ok' }, sessionId: null }
      } catch (error) {
        failure = (error as Error).message
        throw error
      }
    }
    const { worker } = createWorker(executor, client)
    await worker.refresh()
    await worker.handleFrame({
      type: 'task.assigned',
      taskId: 't-cancel',
      workspaceId: wsId(),
      prompt: 'x'
    })
    await vi.waitFor(() => expect(worker.getState().question).toBe('要哪个？'))

    await worker.handleFrame({ type: 'task.cancel', taskId: 't-cancel', reason: '云端取消' })
    await vi.waitFor(() => expect(failure).toContain('云端取消'))
    await vi.waitFor(() =>
      expect(readLedger(ledgerPath(tmp))[0]).toMatchObject({ state: 'canceled' })
    )
  })

  it('keeps a failed terminal report and replays it after reconnect', async () => {
    const reports: Array<{ url: string; body: unknown }> = []
    let online = true
    const client = {
      request: async (url: string, init?: { body?: unknown }) => {
        reports.push({ url, body: init?.body })
        if (online && url === '/v1/hub/relay/report') throw new Error('network down')
        return {}
      },
      openStream: async () => ({ ok: true, status: 200, body: null }) as unknown as Response
    } as unknown as CloudClient
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()

    await worker.handleFrame({
      type: 'task.assigned',
      taskId: 't-offline',
      workspaceId: wsId(),
      prompt: 'x'
    })
    await vi.waitFor(() => expect(executor.runs).toEqual(['t-offline@repo']))
    executor.release()
    await vi.waitFor(() => expect(worker.getState().runningTaskId).toBeNull())

    // 网络恢复后重连：补发那条没送到的终态
    online = false
    const internals = worker as unknown as { flushPendingReports: () => Promise<void> }
    await internals.flushPendingReports()
    const done = reports.filter(
      (call) =>
        (call.body as { taskId?: string; kind?: string })?.taskId === 't-offline' &&
        (call.body as { kind?: string }).kind === 'done'
    )
    // 第一次发失败 + 重连后补发成功
    expect(done.length).toBeGreaterThanOrEqual(2)
  })
})

describe('dispatch worker · 重发不重跑', () => {
  it('re-reports a task it already finished instead of running it twice', async () => {
    const { client, reports } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()

    await worker.handleFrame({
      type: 'task.assigned',
      taskId: 't-once',
      workspaceId: wsId(),
      prompt: '只该跑一次'
    })
    await vi.waitFor(() => expect(executor.runs).toEqual(['t-once@repo']))
    executor.release()
    await vi.waitFor(() => expect(worker.getState().runningTaskId).toBeNull())
    const before = reports.length

    // 网关重连后补发同一任务（它还以为在跑）：不能再执行一遍
    await worker.handleFrame({
      type: 'task.assigned',
      taskId: 't-once',
      workspaceId: wsId(),
      prompt: '只该跑一次',
      attempt: 2
    })
    expect(executor.runs).toEqual(['t-once@repo'])
    await vi.waitFor(() => expect(reports.length).toBe(before + 1))
    expect(reports[reports.length - 1].body).toMatchObject({
      taskId: 't-once',
      kind: 'done',
      summary: '已处理 t-once'
    })
  })

  it('uses the ledger to answer a replay after a restart', async () => {
    const { client, reports } = makeClient()
    const executor = makeExecutor()
    const { worker } = createWorker(executor, client)
    await worker.refresh()

    await worker.handleFrame({
      type: 'task.assigned',
      taskId: 't-ledger',
      workspaceId: wsId(),
      prompt: 'x'
    })
    await vi.waitFor(() => expect(executor.runs).toEqual(['t-ledger@repo']))
    executor.release()
    await vi.waitFor(() => expect(worker.getState().runningTaskId).toBeNull())

    // 新进程：内存里没有记录，只能靠账本
    const restarted = createWorker(makeExecutor(), client).worker
    await restarted.refresh()
    await restarted.handleFrame({
      type: 'task.assigned',
      taskId: 't-ledger',
      workspaceId: wsId(),
      prompt: 'x',
      attempt: 2
    })
    await vi.waitFor(() =>
      expect(reports[reports.length - 1].body).toMatchObject({ taskId: 't-ledger', kind: 'done' })
    )
  })
})

describe('dispatch worker · 取消原因透传', () => {
  it('uses the reason from the task.cancel frame (gateway expiry vs cloud cancel)', async () => {
    const { client } = makeClient()
    const runs: string[] = []
    let rejectRun: ((error: Error) => void) | undefined
    const executor: DispatchExecutorLike = {
      run: async (task) => {
        runs.push(task.taskId)
        await new Promise<never>((_resolve, reject) => {
          rejectRun = reject
        })
        return { report: { kind: 'done' }, sessionId: null }
      },
      cancel: async () => {
        rejectRun?.(new Error('aborted'))
        return true
      }
    }
    const { worker } = createWorker(executor, client)
    await worker.refresh()
    await worker.handleFrame({
      type: 'task.assigned',
      taskId: 't-expire',
      workspaceId: wsId(),
      prompt: 'x'
    })
    await vi.waitFor(() => expect(runs).toEqual(['t-expire']))

    await worker.handleFrame({
      type: 'task.cancel',
      taskId: 't-expire',
      reason: '超过截止时间仍未完成（网关收尾）。',
      by: 'gateway'
    })
    await vi.waitFor(() =>
      expect(readLedger(ledgerPath(tmp))[0]).toMatchObject({
        state: 'canceled',
        summary: '超过截止时间仍未完成（网关收尾）。'
      })
    )
  })
})

describe('dispatch worker · 轨迹只随终态回报运一趟', () => {
  /** 会回报几个工具的假执行器：模拟真实 chat 的 onTrace 序列 */
  function makeTracingExecutor() {
    const runs: string[] = []
    const executor = {
      runs,
      run: async (task: {
        taskId: string
        onTrace?: (event: {
          type: string
          toolCallId?: string
          toolName?: string
          argsSummary?: string
          status?: 'success' | 'error'
          durationMs?: number
        }) => void
      }) => {
        runs.push(task.taskId)
        task.onTrace?.({ type: 'tool_start', toolCallId: 'c1', toolName: 'bash', argsSummary: 'npm test' })
        task.onTrace?.({
          type: 'tool_end',
          toolCallId: 'c1',
          toolName: 'bash',
          status: 'success',
          durationMs: 900
        })
        return {
          report: { kind: 'done' as const, summary: '跑完了' },
          sessionId: `session-${task.taskId}`
        }
      },
      cancel: async () => true
    }
    return executor
  }

  it('attaches the trace to the terminal report and caches it on disk', async () => {
    const { client, reports } = makeClient()
    const executor = makeTracingExecutor()
    const { worker } = createWorker(executor as never, client)
    await worker.refresh()
    await worker.handleFrame({ type: 'task.assigned', taskId: 't-trace', workspaceId: wsId(), prompt: 'x' })

    await vi.waitFor(() => {
      const done = reports.find(
        (call) => (call.body as { kind?: string }).kind === 'done'
      )
      expect(done).toBeTruthy()
    })
    const done = reports.find((call) => (call.body as { kind?: string }).kind === 'done')
    const trace = (done?.body as { trace?: { steps: Array<{ tool: string; ok: boolean }>; total: number } })
      .trace
    expect(trace?.total).toBe(1)
    expect(trace?.steps[0]).toMatchObject({ tool: 'bash', ok: true })
    expect(fs.existsSync(path.join(tmp, 'cache', 'dispatch-traces', 't-trace.json'))).toBe(true)
  })

  it('never puts the trace on progress or claimed reports', async () => {
    const { client, reports } = makeClient()
    const executor = makeTracingExecutor()
    const { worker } = createWorker(executor as never, client)
    await worker.refresh()
    await worker.handleFrame({ type: 'task.assigned', taskId: 't-lean', workspaceId: wsId(), prompt: 'x' })
    await vi.waitFor(() => expect(executor.runs).toEqual(['t-lean']))

    for (const call of reports) {
      const kind = (call.body as { kind?: string }).kind
      if (kind && kind !== 'done' && kind !== 'failed' && kind !== 'canceled') {
        expect((call.body as { trace?: unknown }).trace).toBeUndefined()
      }
    }
  })

  it('replays a cached trace when the report is re-sent after a restart', async () => {
    const { client: firstClient } = makeClient()
    const first = createWorker(makeTracingExecutor() as never, firstClient)
    await first.worker.refresh()
    await first.worker.handleFrame({ type: 'task.assigned', taskId: 't-replay-trace', workspaceId: wsId(), prompt: 'x' })
    await vi.waitFor(() =>
      expect(fs.existsSync(path.join(tmp, 'cache', 'dispatch-traces', 't-replay-trace.json'))).toBe(true)
    )

    // 重启：新的 worker 没有内存记录，账本里也没有这条（模拟账本已滚掉）
    const { client, reports } = makeClient()
    const second = createWorker(makeTracingExecutor() as never, client)
    await second.worker.refresh()
    // 内存里没有 → 走账本；账本里没有 → 照常入队
    await second.worker.handleFrame({
      type: 'task.assigned',
      taskId: 't-replay-trace',
      workspaceId: wsId(),
      prompt: 'x'
    })
    await vi.waitFor(() =>
      expect(reports.some((call) => (call.body as { kind?: string }).kind === 'done')).toBe(true)
    )
  })
})
