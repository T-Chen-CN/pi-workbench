/**
 * C-07（全站并发上限 A-21 / D-15 + ask_cloud 非阻塞对齐 F-23）
 * 与 C-02（工单停滞看门狗：终端工具静默 10m、云端 20m 无事件巡检、60s 工单心跳、同一停滞只报一次）。
 */

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CLOUD_PROTOCOL_VERSION, type CloudEvent, type CloudTaskEventPayload } from 'pi-bridge'
import { CloudStore } from '../../apps/cloud/src/store/store'
import { TaskDispatcher } from '../../apps/cloud/src/tasks/dispatcher'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => os.tmpdir(),
  },
}))

const { CloudTaskRunner } = await import('../../electron/cloud/task-runner')

let tmpDir = ''
const openStores: CloudStore[] = []

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-c02-c07-'))
})

afterEach(async () => {
  while (openStores.length > 0) openStores.pop()?.close()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
})

async function setupDispatcher(options: {
  maxConcurrentTasks?: number
  silenceCheckMs?: number
  nowRef: { value: number }
}) {
  const store = await CloudStore.open(path.join(tmpDir, 'cloud'))
  openStores.push(store)
  const onlineDevices = new Set<string>(['dev-1', 'dev-2', 'dev-3'])
  const sentFrames: Array<{ deviceId: string; frame: any }> = []
  const publishedEvents: CloudEvent[] = []
  const wakes: CloudTaskEventPayload[] = []

  for (const id of onlineDevices) {
    await store.addDevice({
      id,
      name: id,
      platform: 'win32',
      token: { hash: 'h', salt: 's' },
      createdAt: options.nowRef.value,
      lastSeenAt: options.nowRef.value,
      workspaces: [{ path: '/repo', name: 'repo', isGit: true, defaultBranch: 'main' }],
      revokedAt: null,
    })
  }
  await store.saveAuthorization({
    id: 'auth-1',
    items: [
      { deviceId: 'dev-1', workspacePath: '/repo' },
      { deviceId: 'dev-2', workspacePath: '/repo' },
      { deviceId: 'dev-3', workspacePath: '/repo' },
    ],
    quota: 10,
    used: 0,
    confirmedAt: options.nowRef.value,
    expiresAt: options.nowRef.value + 3_600_000,
    confirmedSummary: 'plan',
    revokedAt: null,
  })

  const hub = {
    isDeviceOnline: (id: string) => onlineDevices.has(id),
    sendToDevice: (deviceId: string, frame: any) => {
      if (!onlineDevices.has(deviceId)) return false
      sentFrames.push({ deviceId, frame })
      return true
    },
    dropDeviceTask: () => undefined,
    publish: (event: CloudEvent) => {
      publishedEvents.push(event)
    },
  } as any

  const dispatcher = new TaskDispatcher({
    store,
    hub,
    wake: (payload) => {
      wakes.push(payload)
    },
    logger: { info: () => undefined, warn: () => undefined },
    maxConcurrentTasks: options.maxConcurrentTasks,
    silenceCheckMs: options.silenceCheckMs,
    now: () => options.nowRef.value,
  })

  return { store, dispatcher, sentFrames, publishedEvents, wakes }
}

describe('C-07：全站并发上限（A-21 / D-15）', () => {
  it('超出全站并发上限的新工单排队并给出可读提示，前序终态后自动按 FIFO 补投', async () => {
    const nowRef = { value: 10_000 }
    const { store, dispatcher, sentFrames, publishedEvents } = await setupDispatcher({
      maxConcurrentTasks: 2,
      nowRef,
    })

    const d1 = await dispatcher.dispatch({
      authorizationId: 'auth-1',
      workUnitId: 'u1',
      deviceId: 'dev-1',
      workspacePath: '/repo',
      title: 'task 1',
      background: 'b',
      goal: 'g1',
      acceptance: 'a',
      commit: false,
    })
    nowRef.value += 10
    const d2 = await dispatcher.dispatch({
      authorizationId: 'auth-1',
      workUnitId: 'u2',
      deviceId: 'dev-2',
      workspacePath: '/repo',
      title: 'task 2',
      background: 'b',
      goal: 'g2',
      acceptance: 'a',
      commit: false,
    })
    nowRef.value += 10
    const d3 = await dispatcher.dispatch({
      authorizationId: 'auth-1',
      workUnitId: 'u3',
      deviceId: 'dev-3',
      workspacePath: '/repo',
      title: 'task 3',
      background: 'b',
      goal: 'g3',
      acceptance: 'a',
      commit: false,
    })

    expect(d1.ok && d2.ok && d3.ok).toBe(true)
    if (!d1.ok || !d2.ok || !d3.ok) return

    // 前两张下发，第三张因触及全站并发上限 2 留在 queued 且不计 ACK 超时
    expect(sentFrames.filter((entry) => entry.frame.type === 'task').map((e) => e.frame.task.id)).toEqual([
      d1.task.id,
      d2.task.id,
    ])
    expect(store.findTask(d3.task.id)?.dispatchedAt).toBeNull()
    expect(
      publishedEvents.some(
        (event) =>
          event.type === 'notice' &&
          event.text.includes('已达并发上限') &&
          event.text.includes(d3.task.id)
      )
    ).toBe(true)

    // 确认 d1/d2 先 assigned 再 running，避免 60s ACK 超时，并验证 d3 不会因等待并发槽位而 expired
    for (const [dev, id] of [
      ['dev-1', d1.task.id],
      ['dev-2', d2.task.id],
    ] as const) {
      await dispatcher.handleDeviceFrame(dev, {
        v: CLOUD_PROTOCOL_VERSION,
        type: 'task_status',
        taskId: id,
        status: 'assigned',
        at: nowRef.value,
      })
      await dispatcher.handleDeviceFrame(dev, {
        v: CLOUD_PROTOCOL_VERSION,
        type: 'task_status',
        taskId: id,
        status: 'running',
        at: nowRef.value,
      })
    }
    nowRef.value += 90_000
    await dispatcher.sweepTimeouts()
    expect(store.findTask(d3.task.id)?.status).toBe('queued')

    // d1 完成后，空出的全局槽位立刻把排队在 dev-3 的 d3 派出去
    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_result',
      taskId: d1.task.id,
      result: { summary: 'ok', changedFiles: [] },
      at: nowRef.value,
    })
    expect(sentFrames.filter((entry) => entry.frame.type === 'task').map((e) => e.frame.task.id)).toEqual([
      d1.task.id,
      d2.task.id,
      d3.task.id,
    ])
    expect(store.findTask(d3.task.id)?.dispatchedAt).not.toBeNull()
  })
})

describe('C-02：云端停滞看门狗（task_stalled / 20 分钟静默巡检 / task_heartbeat）', () => {
  it('task_stalled 同一次停滞只唤醒一次；task_heartbeat 不洗白 20 分钟静默巡检', async () => {
    const nowRef = { value: 1_000_000 }
    const { store, dispatcher, wakes } = await setupDispatcher({
      silenceCheckMs: 20 * 60 * 1000,
      nowRef,
    })

    const dispatched = await dispatcher.dispatch({
      authorizationId: 'auth-1',
      workUnitId: 'u-stall',
      deviceId: 'dev-1',
      workspacePath: '/repo',
      title: 'long build',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      commit: false,
    })
    if (!dispatched.ok) throw new Error('dispatch failed')
    const taskId = dispatched.task.id

    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_status',
      taskId,
      status: 'assigned',
      at: nowRef.value,
    })
    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_status',
      taskId,
      status: 'running',
      at: nowRef.value,
    })
    wakes.length = 0

    // 1. 终端上报 task_stalled 两次 → 只唤醒一次
    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_stalled',
      taskId,
      toolName: 'bash',
      idleMs: 10 * 60 * 1000,
      at: nowRef.value + 10 * 60 * 1000,
    })
    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_stalled',
      taskId,
      toolName: 'bash',
      idleMs: 12 * 60 * 1000,
      at: nowRef.value + 12 * 60 * 1000,
    })
    expect(wakes.filter((item) => item.kind === 'stalled')).toHaveLength(1)
    expect(wakes[0].summary).toContain('bash')

    // 2. 60s task_heartbeat 刷新设备 lastSeenAt，但不重置工单 lastEventAt
    nowRef.value += 15 * 60 * 1000
    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_heartbeat',
      taskId,
      at: nowRef.value,
    })
    expect(store.findDevice('dev-1')?.lastSeenAt).toBe(nowRef.value)

    // 3. 满 20 分钟无进度事件 → sweepTimeouts 唤醒一次；再扫一次不重复唤醒
    nowRef.value += 6 * 60 * 1000
    wakes.length = 0
    await dispatcher.sweepTimeouts()
    await dispatcher.sweepTimeouts()
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toMatchObject({ kind: 'stalled', taskId })
    expect(wakes[0].summary).toContain('get_task')

    // 4. 新里程碑到达后重置标记，下一次再静默 20 分钟可再次唤醒
    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_milestone',
      taskId,
      milestone: { kind: 'progress', text: 'still working', at: nowRef.value },
    })
    wakes.length = 0
    nowRef.value += 21 * 60 * 1000
    await dispatcher.sweepTimeouts()
    expect(wakes.filter((item) => item.kind === 'stalled')).toHaveLength(1)
  })
})

describe('C-02 & C-07：终端工具静默检测、工单心跳与 ask_cloud 非阻塞收尾', () => {
  it('工具静默只报一次、tool_update 重置计时，且 60s 心跳不重置工具停滞', async () => {
    const stalled: Array<{ taskId: string; toolName?: string; idleMs: number }> = []
    const heartbeats: Array<{ taskId: string; at: number }> = []
    let traceListener: ((event: any) => void) | null = null
    let finishChat: ((outcome: any) => void) | null = null

    const worktreePath = path.join(tmpDir, 'wt')
    await fs.mkdir(worktreePath, { recursive: true })
    const dataDir = path.join(tmpDir, 'device')
    await fs.mkdir(dataDir, { recursive: true })

    const runner = new CloudTaskRunner({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      dataDir,
      getApiConfig: async () => null,
      getCoordinator: async () => ({
        bind: async () => ({ success: true, worktree: { path: worktreePath, branch: 'pi/wt' } }),
        getSessionBinding: () => ({ key: '', path: worktreePath, branch: 'pi/wt' }),
        hasBinding: () => true,
        release: async () => ({ success: true, removed: true, dirty: false, worktreePath }),
      }),
      onStatus: () => undefined,
      onWorktree: () => undefined,
      onMilestone: () => undefined,
      onQuestion: () => undefined,
      onStalled: (taskId, info) => stalled.push({ taskId, ...info }),
      onTaskHeartbeat: (taskId, at) => heartbeats.push({ taskId, at }),
      onResult: () => undefined,
      onFailed: () => undefined,
      onInterrupted: () => undefined,
      onUnitClosed: () => undefined,
      onUnitState: () => undefined,
      toolStallMs: 120,
      taskHeartbeatMs: 70,
    })

    // 注入最小假 AgentManager，避开真实 LLM 与网络
    const fakeManager = {
      createSession: async () => ({ success: true, session: { id: 'sess-1' } }),
      subscribeTrace: (_sid: string, listener: (event: any) => void) => {
        traceListener = listener
      },
      chat: () =>
        new Promise((resolve) => {
          finishChat = resolve
        }),
      abort: async () => undefined,
      dispose: async () => undefined,
    }
    ;(runner as any).manager = fakeManager
    ;(runner as any).ensureManager = async () => fakeManager

    const runPromise = runner.start('T-term', {
      workUnitId: 'u-term',
      deviceId: 'dev-1',
      repo: { workspacePath: worktreePath, baseBranch: 'main' },
      title: 'stall test',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      output: { summary: true, changeList: true, testResult: false },
      commit: false,
      authorizationId: 'auth-1',
    })

    const waitStarted = Date.now()
    while (!traceListener && Date.now() - waitStarted < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(traceListener).not.toBeNull()

    // 模拟工具卡住，超过 toolStallMs 且经过多次 heartbeat：只上报一次 task_stalled
    traceListener!({ type: 'tool_start', toolCallId: 'c1', toolName: 'bash', argsSummary: 'sleep 999' })
    await new Promise((resolve) => setTimeout(resolve, 260))

    expect(heartbeats.length).toBeGreaterThanOrEqual(2)
    expect(stalled).toHaveLength(1)
    expect(stalled[0]).toMatchObject({ taskId: 'T-term', toolName: 'bash' })

    // 有增量输出后重置，再静默超过阈值才报第二次
    traceListener!({ type: 'tool_update', toolCallId: 'c1', toolName: 'bash', chunk: 'progress' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(stalled).toHaveLength(2)

    // 工具结束后不再报错
    traceListener!({ type: 'tool_end', toolCallId: 'c1', toolName: 'bash', status: 'success' })
    finishChat!({ success: true, response: 'done' })
    await runPromise
    await runner.dispose()
  })

  it('ask_cloud 上报问题后非阻塞结束本轮进入 waiting_human，回答到达再起新轮完成（F-23 / A-10）', async () => {
    const statuses: string[] = []
    const questions: Array<{ taskId: string; questionId: string; text: string }> = []
    const results: Array<{ taskId: string; summary: string }> = []
    let askToolExecute: ((id: string, params: { question: string }) => Promise<any>) | null = null
    let chatCalls = 0

    const worktreePath = path.join(tmpDir, 'wt-ask')
    await fs.mkdir(worktreePath, { recursive: true })
    const dataDir = path.join(tmpDir, 'device-ask')
    await fs.mkdir(dataDir, { recursive: true })

    const runner = new CloudTaskRunner({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      dataDir,
      getApiConfig: async () => null,
      getCoordinator: async () => ({
        bind: async () => ({ success: true, worktree: { path: worktreePath, branch: 'pi/ask' } }),
        getSessionBinding: () => ({ key: '', path: worktreePath, branch: 'pi/ask' }),
        hasBinding: () => true,
        release: async () => ({ success: true, removed: true, dirty: false, worktreePath }),
      }),
      onStatus: (_id, status) => statuses.push(status),
      onWorktree: () => undefined,
      onMilestone: () => undefined,
      onQuestion: (taskId, questionId, text) => questions.push({ taskId, questionId, text }),
      onResult: (taskId, result) => results.push({ taskId, summary: result.summary }),
      onFailed: () => undefined,
      onInterrupted: () => undefined,
      onUnitClosed: () => undefined,
      onUnitState: () => undefined,
    })

    // 取出内部注册的 ask_cloud 工具，直接模拟第一轮提问、第二轮回答后完成
    const ext = (runner as any).createAskCloudExtension()
    ext({
      registerTool: (tool: any) => {
        if (tool.name === 'ask_cloud') askToolExecute = tool.execute
      },
    })
    const fakeAskManager = {
      createSession: async () => ({ success: true, session: { id: 'sess-ask' } }),
      subscribeTrace: () => undefined,
      chat: async () => {
        chatCalls += 1
        if (chatCalls === 1) {
          await askToolExecute!('tc-1', { question: '需要用方案 A 还是 B？' })
          return { success: true, response: '等待用户答复' }
        }
        return { success: true, response: '已按方案 A 完成' }
      },
      abort: async () => undefined,
      dispose: async () => undefined,
    }
    ;(runner as any).manager = fakeAskManager
    ;(runner as any).ensureManager = async () => fakeAskManager

    await runner.start('T-ask', {
      workUnitId: 'u-ask',
      deviceId: 'dev-1',
      repo: { workspacePath: worktreePath, baseBranch: 'main' },
      title: 'ask test',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      output: { summary: true, changeList: true, testResult: false },
      commit: false,
      authorizationId: 'auth-1',
    })

    // 第一轮结束时停在 waiting_human，绝不误结算 done
    expect(questions).toHaveLength(1)
    expect(questions[0].text).toBe('需要用方案 A 还是 B？')
    expect(statuses[statuses.length - 1]).toBe('waiting_human')
    expect(results).toHaveLength(0)

    // 回答到达后自动开启第二轮并完成
    const resumed = await runner.answer('T-ask', '选方案 A', questions[0].questionId)
    expect(resumed).toBe(true)
    expect(results).toEqual([{ taskId: 'T-ask', summary: '已按方案 A 完成' }])
    await runner.dispose()
  })
})
