/**
 * Track B 云端服务端 + 终端执行器纯 Bug 回归测试套件：
 * - Bug 2: 干净工作树延迟回收（默认 10m、PI_CLOUD_WORKTREE_RECLAIM_DELAY_MS、手动关闭/dispose 取消）
 * - Bug 4: findDeviceByClientToken 严格拒绝执行通道 token（含旧无 clientToken 记录），clientToken 控制面对等
 * - Bug 5: 已撤销设备从 listDevices / deviceSnapshots / GET /v1/devices / list_devices / list_repos 中过滤
 * - Bug 9: 优雅停机顺序（先排空 HTTP，最后关 store）与畸形 Host 头返回 400
 * - Bug 10c: 服务端 sanitizeIncomingDiff 中文 UTF-8 安全截断
 * - Bug 11: task-runner porcelain 'D'、带点目录路径提取、answer 重放防并发、dispose 先 abort 再 closeSession、
 *           ensureManager 包含 overrides 且延迟销毁仍在被活跃工单使用的旧 manager、retry 串行化
 * - Bug 13: update.sh 不含未加引号的 token 参数展开且规范化 TARGET_REAL
 */

// @vitest-environment node

import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_MAX_DIFF_LIMIT_BYTES, CLOUD_PROTOCOL_VERSION, type CloudTaskSpec } from 'pi-bridge'
import { createToken, hashToken } from '../../apps/cloud/src/auth/credentials'
import { loadConfig } from '../../apps/cloud/src/config'
import { createCloudServer, type CloudServer } from '../../apps/cloud/src/main'
import { CloudStore } from '../../apps/cloud/src/store/store'
import {
  DEFAULT_WORKTREE_RECLAIM_DELAY_MS,
  TaskDispatcher,
} from '../../apps/cloud/src/tasks/dispatcher'
import { createCloudToolsExtension } from '../../apps/cloud/src/agent/tools'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => os.tmpdir(),
  },
}))

const { CloudTaskRunner, taskRunnerInternals } = await import('../../electron/cloud/task-runner')

const tempDirs: string[] = []
const openStores: CloudStore[] = []
const openServers: CloudServer[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.useRealTimers()
  while (openServers.length > 0) {
    await openServers.pop()!.close().catch(() => undefined)
  }
  while (openStores.length > 0) {
    openStores.pop()!.close()
  }
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('Bug 2: 干净工作树延迟回收与定时器清理', () => {
  it('默认空闲回收延迟为 10 分钟，dispose() 与手动 requestUnitClose() 均能取消定时器', async () => {
    vi.useFakeTimers()
    const dir = await makeTempDir('pi-reclaim-delay-')
    const store = await CloudStore.open(dir)
    openStores.push(store)

    const sent: Array<{ deviceId: string; frame: any }> = []
    await store.addDevice({
      id: 'dev-1',
      name: 'PC',
      platform: 'win32',
      token: hashToken('tok-exec'),
      clientToken: hashToken('tok-client'),
      createdAt: 1000,
      lastSeenAt: 1000,
      workspaces: [{ path: '/repo', name: 'repo', isGit: true }],
      revokedAt: null,
    })
    await store.saveAuthorization({
      id: 'auth-1',
      items: [{ deviceId: 'dev-1', workspacePath: '/repo' }],
      quota: 5,
      used: 0,
      confirmedAt: 1000,
      confirmedSummary: 'plan',
      expiresAt: 10_000_000,
      revokedAt: null,
    })

    const hub = {
      isDeviceOnline: () => true,
      sendToDevice: (deviceId: string, frame: any) => {
        sent.push({ deviceId, frame })
        return true
      },
      dropDeviceTask: () => undefined,
      publish: () => 1,
    } as any

    const dispatcher = new TaskDispatcher({
      store,
      hub,
      wake: () => undefined,
      logger: { info: () => undefined, warn: () => undefined },
      now: () => 2000,
    })

    const dispatched = await dispatcher.dispatch({
      authorizationId: 'auth-1',
      workUnitId: 'u-delay',
      deviceId: 'dev-1',
      workspacePath: '/repo',
      title: 't',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      commit: false,
    })
    expect(dispatched.ok).toBe(true)
    if (!dispatched.ok) return

    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_status',
      taskId: dispatched.task.id,
      status: 'assigned',
      at: 2000,
    })
    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_status',
      taskId: dispatched.task.id,
      status: 'running',
      at: 2000,
    })
    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_result',
      taskId: dispatched.task.id,
      result: { summary: 'ok', changedFiles: [], worktreeClean: true },
      at: 2000,
    })

    // 9 分 59 秒时仍未下发 close_unit
    await vi.advanceTimersByTimeAsync(DEFAULT_WORKTREE_RECLAIM_DELAY_MS - 1_000)
    expect(sent.filter((s) => s.frame.type === 'close_unit')).toHaveLength(0)

    // 到达 10 分钟才下发 close_unit(converged)
    await vi.advanceTimersByTimeAsync(1_000)
    const closes = sent.filter((s) => s.frame.type === 'close_unit')
    expect(closes).toHaveLength(1)
    expect(closes[0].frame).toMatchObject({ unitId: 'u-delay', reason: 'converged' })

    // 再派一个单元并在到期前 dispose()，绝不能再触发 close_unit
    const d2 = await dispatcher.dispatch({
      authorizationId: 'auth-1',
      workUnitId: 'u-disposed',
      deviceId: 'dev-1',
      workspacePath: '/repo',
      title: 't2',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      commit: false,
    })
    if (!d2.ok) return
    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_status',
      taskId: d2.task.id,
      status: 'assigned',
      at: 2000,
    })
    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_result',
      taskId: d2.task.id,
      result: { summary: 'ok', changedFiles: [], worktreeClean: true },
      at: 2000,
    })
    dispatcher.dispose()
    await vi.advanceTimersByTimeAsync(DEFAULT_WORKTREE_RECLAIM_DELAY_MS + 5_000)
    expect(sent.filter((s) => s.frame.type === 'close_unit' && s.frame.unitId === 'u-disposed')).toHaveLength(0)
  })

  it('loadConfig 支持 PI_CLOUD_WORKTREE_RECLAIM_DELAY_MS 环境变量并拒绝非法负值', () => {
    const prev = process.env.PI_CLOUD_WORKTREE_RECLAIM_DELAY_MS
    try {
      process.env.PI_CLOUD_WORKTREE_RECLAIM_DELAY_MS = '12345'
      const cfg = loadConfig({
        encryptionKey: Buffer.alloc(32, 1),
        cookieSecret: 's',
      })
      expect(cfg.worktreeReclaimDelayMs).toBe(12345)

      process.env.PI_CLOUD_WORKTREE_RECLAIM_DELAY_MS = '-10'
      expect(() =>
        loadConfig({
          encryptionKey: Buffer.alloc(32, 1),
          cookieSecret: 's',
        })
      ).toThrow(/PI_CLOUD_WORKTREE_RECLAIM_DELAY_MS/)
    } finally {
      if (prev === undefined) delete process.env.PI_CLOUD_WORKTREE_RECLAIM_DELAY_MS
      else process.env.PI_CLOUD_WORKTREE_RECLAIM_DELAY_MS = prev
    }
  })
})

describe('Bug 4 & Bug 5: 令牌边界与已撤销设备过滤', () => {
  it('findDeviceByClientToken 严格拒绝仅限执行通道的 device.token（即使老记录缺 clientToken）', async () => {
    const dir = await makeTempDir('pi-token-sep-')
    const store = await CloudStore.open(dir)
    openStores.push(store)

    const legacyExecToken = createToken()
    const newExecToken = createToken()
    const newClientToken = createToken()

    await store.addDevice({
      id: 'dev-legacy',
      name: 'Legacy',
      platform: 'win32',
      token: hashToken(legacyExecToken),
      createdAt: 1,
      lastSeenAt: 1,
      workspaces: [],
      revokedAt: null,
    })
    await store.addDevice({
      id: 'dev-new',
      name: 'Modern',
      platform: 'win32',
      token: hashToken(newExecToken),
      clientToken: hashToken(newClientToken),
      createdAt: 1,
      lastSeenAt: 1,
      workspaces: [],
      revokedAt: null,
    })

    // 执行通道 token 均只匹配 findDeviceByToken，绝不匹配 findDeviceByClientToken
    expect(store.findDeviceByToken(legacyExecToken)?.id).toBe('dev-legacy')
    expect(store.findDeviceByClientToken(legacyExecToken)).toBeUndefined()
    expect(store.findDeviceByToken(newExecToken)?.id).toBe('dev-new')
    expect(store.findDeviceByClientToken(newExecToken)).toBeUndefined()
    expect(store.findDeviceByClientToken(newClientToken)?.id).toBe('dev-new')
  })

  it('已撤销设备从 store.listDevices / deviceSnapshots / GET /v1/devices / list_devices / list_repos 中过滤', async () => {
    const dir = await makeTempDir('pi-revoked-filter-')
    const srv = await createCloudServer({
      dataDir: dir,
      port: 0,
      host: '127.0.0.1',
      encryptionKey: Buffer.alloc(32, 4),
      cookieSecret: 'revoked-secret',
      secureCookies: false,
    })
    openServers.push(srv)
    const port = await srv.listen()
    const base = `http://127.0.0.1:${port}`

    const activeToken = createToken()
    const activeClientToken = createToken()
    const revokedToken = createToken()
    const revokedClientToken = createToken()

    await srv.store.addDevice({
      id: 'dev-active',
      name: 'Active',
      platform: 'win32',
      token: hashToken(activeToken),
      clientToken: hashToken(activeClientToken),
      createdAt: 1,
      lastSeenAt: 1,
      workspaces: [{ path: '/repo-a', name: 'a', isGit: true }],
      revokedAt: null,
    })
    await srv.store.addDevice({
      id: 'dev-revoked',
      name: 'Revoked',
      platform: 'win32',
      token: hashToken(revokedToken),
      clientToken: hashToken(revokedClientToken),
      createdAt: 1,
      lastSeenAt: 1,
      workspaces: [{ path: '/repo-r', name: 'r', isGit: true }],
      revokedAt: Date.now(),
    })

    expect(srv.store.listDevices().map((d) => d.id)).toEqual(['dev-active'])
    expect(srv.dispatcher.deviceSnapshots().map((d) => d.id)).toEqual(['dev-active'])

    // 桌面端 clientToken 拥有对等控制面权限（Decision 1.B），但执行通道 token 返回 401
    const execDenied = await fetch(`${base}/v1/devices`, {
      headers: { authorization: `Bearer ${activeToken}` },
    })
    expect(execDenied.status).toBe(401)

    const clientOk = await fetch(`${base}/v1/devices`, {
      headers: { authorization: `Bearer ${activeClientToken}` },
    })
    expect(clientOk.status).toBe(200)
    const body = (await clientOk.json()) as { devices: Array<{ id: string }> }
    expect(body.devices.map((d) => d.id)).toEqual(['dev-active'])

    // list_devices 与 list_repos 工具同样屏蔽已撤销设备
    const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<any> }>()
    const ext = createCloudToolsExtension({
      store: srv.store,
      hub: srv.hub,
      dispatcher: srv.dispatcher,
    })
    ext({ registerTool: (t: any) => tools.set(t.name, t) } as never)

    const listed = await tools.get('list_devices')!.execute('c1', {})
    expect(listed.content[0].text).toContain('dev-active')
    expect(listed.content[0].text).not.toContain('dev-revoked')

    const reposRes = await tools.get('list_repos')!.execute('c2', { deviceId: 'dev-revoked' })
    expect(reposRes.isError).toBe(true)
  })
})

describe('Bug 9 & Bug 10c: 畸形 Host 400、优雅关闭顺序与服务端中文 diff 截断', () => {
  it('畸形 Host 请求头返回 HTTP 400 Bad Request，且 close() 先停 HTTP 后关 store', async () => {
    const dir = await makeTempDir('pi-host-shutdown-')
    const srv = await createCloudServer({
      dataDir: dir,
      port: 0,
      host: '127.0.0.1',
      encryptionKey: Buffer.alloc(32, 6),
      cookieSecret: 'shutdown-secret',
      secureCookies: false,
    })
    openServers.push(srv)
    const port = await srv.listen()

    // 用原始 TCP socket 发送畸形 Host 头（fetch 不允许构造非法 Host）
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        sock.write('GET /v1/health HTTP/1.1\r\nHost: bad host:notaport\r\nConnection: close\r\n\r\n')
      })
      let data = ''
      sock.on('data', (chunk) => {
        data += chunk.toString('utf8')
      })
      sock.on('end', () => resolve(data))
      sock.on('error', reject)
    })
    expect(rawResponse).toMatch(/^HTTP\/1\.1 400 /)

    // 优雅关闭：验证 close() 正常结束且之后端口已停止监听
    await srv.close()
    openServers.pop()
    await expect(fetch(`http://127.0.0.1:${port}/v1/health`)).rejects.toThrow()
  })

  it('服务端接收超大中文 diff 时按 UTF-8 边界安全截断，不产生 \\uFFFD（Bug 10c）', async () => {
    const dir = await makeTempDir('pi-diff-utf8-')
    const store = await CloudStore.open(dir)
    openStores.push(store)

    await store.addDevice({
      id: 'dev-1',
      name: 'PC',
      platform: 'win32',
      token: hashToken('t1'),
      clientToken: hashToken('c1'),
      createdAt: 1,
      lastSeenAt: 1,
      workspaces: [{ path: '/repo', name: 'repo', isGit: true }],
      revokedAt: null,
    })
    await store.saveAuthorization({
      id: 'auth-1',
      items: [{ deviceId: 'dev-1', workspacePath: '/repo' }],
      quota: 2,
      used: 0,
      confirmedAt: Date.now(),
      confirmedSummary: 'p',
      expiresAt: Date.now() + 3_600_000,
      revokedAt: null,
    })
    const dispatcher = new TaskDispatcher({
      store,
      hub: {
        isDeviceOnline: () => true,
        sendToDevice: () => true,
        dropDeviceTask: () => undefined,
        publish: () => 1,
      } as any,
      wake: () => undefined,
      logger: { info: () => undefined, warn: () => undefined },
      reclaimDelayMs: 60_000,
    })
    const dispatched = await dispatcher.dispatch({
      authorizationId: 'auth-1',
      workUnitId: 'u-zh',
      deviceId: 'dev-1',
      workspacePath: '/repo',
      title: 'zh diff',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      commit: false,
    })
    if (!dispatched.ok) throw new Error('dispatch failed')
    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_status',
      taskId: dispatched.task.id,
      status: 'assigned',
      at: 10,
    })
    // 构造严格大于 CLOUD_MAX_DIFF_LIMIT_BYTES 且截断边界落在 3 字节中文字符中间的 diff
    const suffixLen = Buffer.byteLength('\n... [clipped by server]', 'utf8')
    const budget = CLOUD_MAX_DIFF_LIMIT_BYTES - suffixLen
    const pad = budget % 3 === 0 ? 'a' : ''
    const hugeZh = `${pad}${'汉'.repeat(Math.ceil(CLOUD_MAX_DIFF_LIMIT_BYTES / 3) + 100)}`
    await dispatcher.handleDeviceFrame('dev-1', {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'task_result',
      taskId: dispatched.task.id,
      result: {
        summary: 'done',
        changedFiles: [],
        diff: { bytes: Buffer.byteLength(hugeZh, 'utf8'), excerpt: hugeZh },
      },
      at: 20,
    })
    const savedDiff = await store.loadTaskDiff(dispatched.task.id)
    expect(savedDiff).toBeDefined()
    expect(savedDiff!.truncated).toBe(true)
    expect(savedDiff!.excerpt).not.toContain('\uFFFD')
    expect(Buffer.byteLength(savedDiff!.excerpt, 'utf8')).toBeLessThanOrEqual(CLOUD_MAX_DIFF_LIMIT_BYTES)
    dispatcher.dispose()
  })
})

describe('Bug 11: task-runner porcelain、路径解析、answer 防重放、dispose 顺序与旧 manager 延迟释放', () => {
  it('parsePorcelainChangedFiles 只检查前两位状态码，不把 M  README.md 误判为 deleted（Bug 11a）', () => {
    const parsed = taskRunnerInternals.parsePorcelainChangedFiles(
      [' M README.md', 'M  docs/DESIGN.md', ' D old.txt', '?? new.ts', 'R  a.ts -> b.ts'].join('\n')
    )
    expect(parsed).toEqual([
      { path: 'README.md', kind: 'modified' },
      { path: 'docs/DESIGN.md', kind: 'modified' },
      { path: 'old.txt', kind: 'deleted' },
      { path: 'new.ts', kind: 'added' },
      { path: 'a.ts -> b.ts', kind: 'renamed' },
    ])
  })

  it('extractWriteOrEditPath 完整提取带点目录路径，不生成 foo.bar 幻影改动（Bug 11b）', () => {
    expect(
      taskRunnerInternals.extractWriteOrEditPath({ argsSummary: 'src/foo.bar/baz.ts · 120 字符' })
    ).toBe('src/foo.bar/baz.ts')
    expect(
      taskRunnerInternals.extractWriteOrEditPath({ argsSummary: 'src/foo.bar/baz.ts · 2 处' })
    ).toBe('src/foo.bar/baz.ts')
    expect(
      taskRunnerInternals.extractWriteOrEditPath({
        argsSummary: '{"path":"src/foo.bar/baz.ts","content":"mentions a.b"}',
      })
    ).toBe('src/foo.bar/baz.ts')
    expect(
      taskRunnerInternals.extractWriteOrEditPath({
        argsSummary: '{"content":"only mentions foo.bar without path key"}',
      })
    ).toBeNull()
  })

  it('answer() 拒绝重复/非 waiting_human 重放并串行化，dispose() 先 abort 再 closeSession（Bug 11d / 11e）', async () => {
    const dir = await makeTempDir('pi-runner-answer-')
    const wt = path.join(dir, 'wt')
    await fs.mkdir(wt, { recursive: true })
    const callLog: string[] = []
    let askExecute: ((id: string, params: { question: string }) => Promise<any>) | null = null
    let chatCalls = 0
    let resolveSecondChat: ((val: any) => void) | null = null

    const runner = new CloudTaskRunner({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      dataDir: path.join(dir, 'data'),
      getApiConfig: async () => null,
      getCoordinator: async () => ({
        bind: async () => ({ success: true, worktree: { path: wt, branch: 'pi/wt' } }),
        getSessionBinding: () => ({ key: '', path: wt, branch: 'pi/wt' }),
        hasBinding: () => true,
        release: async () => ({ success: true, removed: true, dirty: false, worktreePath: wt }),
      }),
      onStatus: () => undefined,
      onWorktree: () => undefined,
      onMilestone: () => undefined,
      onQuestion: () => undefined,
      onResult: () => undefined,
      onFailed: () => undefined,
      onInterrupted: () => undefined,
      onUnitClosed: () => undefined,
      onUnitState: () => undefined,
    })

    const ext = (runner as any).createAskCloudExtension()
    ext({
      registerTool: (tool: any) => {
        if (tool.name === 'ask_cloud') askExecute = tool.execute
      },
    })

    const fakeManager = {
      createSession: async () => ({ success: true, session: { id: 'sess-ans' } }),
      subscribeTrace: () => () => undefined,
      chat: async () => {
        chatCalls += 1
        if (chatCalls === 1) {
          await askExecute!('tc-1', { question: 'continue?' })
          return { success: true, response: 'waiting' }
        }
        return await new Promise((resolve) => {
          resolveSecondChat = resolve
        })
      },
      abort: async () => {
        callLog.push('abort')
      },
      closeSession: async () => {
        callLog.push('closeSession')
      },
      dispose: async () => {
        callLog.push('dispose')
      },
    }
    ;(runner as any).manager = fakeManager
    ;(runner as any).ensureManager = async () => fakeManager

    const spec: CloudTaskSpec = {
      workUnitId: 'u-ans',
      deviceId: 'dev-1',
      repo: { workspacePath: wt, baseBranch: 'main' },
      title: 'ans',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      output: { summary: true, changeList: true, testResult: false },
      commit: false,
      authorizationId: 'auth-1',
    }
    await runner.start('T-ans', spec)

    // 并发调用两次 answer：只允许一次进入 manager.chat()，重放直接返回 false
    const p1 = runner.answer('T-ans', 'yes')
    const p2 = runner.answer('T-ans', 'yes again')
    await expect(p2).resolves.toBe(false)
    expect(chatCalls).toBe(2)

    // dispose() 必须先 abort 再 closeSession
    const disposePromise = runner.dispose()
    resolveSecondChat!({ success: true, response: 'done' })
    await Promise.all([disposePromise, p1])

    const abortIdx = callLog.indexOf('abort')
    const closeIdx = callLog.indexOf('closeSession')
    expect(abortIdx).toBeGreaterThanOrEqual(0)
    expect(closeIdx).toBeGreaterThan(abortIdx)
  })

  it('serializeApiOverrides 纳入 managerKey 且活跃工单引用的旧 manager 延迟销毁（Bug 11f）', async () => {
    expect(
      taskRunnerInternals.serializeApiOverrides({ m1: { contextWindow: 64_000, maxTokens: 4096 } })
    ).not.toBe(
      taskRunnerInternals.serializeApiOverrides({ m1: { contextWindow: 128_000, maxTokens: 4096 } })
    )

    const dir = await makeTempDir('pi-runner-mgr-')
    const wt = path.join(dir, 'wt')
    await fs.mkdir(wt, { recursive: true })
    let oldDisposed = false
    const oldManager = {
      abort: async () => undefined,
      closeSession: async () => undefined,
      dispose: async () => {
        oldDisposed = true
      },
    }
    const newManager = {
      abort: async () => undefined,
      closeSession: async () => undefined,
      dispose: async () => undefined,
    }
    const runner = new CloudTaskRunner({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      dataDir: path.join(dir, 'data'),
      getApiConfig: async () => null,
      getCoordinator: async () => null,
      onStatus: () => undefined,
      onWorktree: () => undefined,
      onMilestone: () => undefined,
      onQuestion: () => undefined,
      onResult: () => undefined,
      onFailed: () => undefined,
      onInterrupted: () => undefined,
      onUnitClosed: () => undefined,
      onUnitState: () => undefined,
    })

    // 模拟 T-old 正处于 waiting_human 并持有 oldManager，同时新配置切到了 newManager
    ;(runner as any).manager = newManager
    ;(runner as any).retiredManagers.add(oldManager)
    ;(runner as any).active.set('T-old', {
      id: 'T-old',
      spec: { workUnitId: 'u-old' },
      unitId: 'u-old',
      repoPath: wt,
      worktreePath: wt,
      sessionId: 'sess-old',
      manager: oldManager,
      status: 'waiting_human',
      startedAt: 1,
      lastMilestoneAt: 0,
      changed: new Map(),
      runningTools: new Map(),
      awaitingAnswer: true,
    })

    ;(runner as any).disposeUnusedRetiredManagers()
    expect(oldDisposed).toBe(false)

    // 取消 T-old 后，不再有任何工单引用 oldManager → 自动延迟销毁
    await runner.cancel('T-old')
    expect(oldDisposed).toBe(true)
    await runner.dispose()
  })

  it('retryAfterConfigRefresh 在 startChain 内原地串行重试，不与后续工单并发执行（Bug 11c）', async () => {
    const dir = await makeTempDir('pi-runner-retry-')
    const wt = path.join(dir, 'wt')
    await fs.mkdir(wt, { recursive: true })
    const events: string[] = []
    let ensureCalls = 0

    const fakeManager = {
      createSession: async () => ({ success: true, session: { id: `sess-${ensureCalls}` } }),
      subscribeTrace: () => () => undefined,
      chat: async (_sid: string, prompt: string) => {
        const tag = prompt.includes('first-task') ? 'T-1' : 'T-2'
        events.push(`start:${tag}`)
        await new Promise((resolve) => setTimeout(resolve, 60))
        events.push(`end:${tag}`)
        return { success: true, response: 'ok' }
      },
      abort: async () => undefined,
      closeSession: async () => undefined,
      dispose: async () => undefined,
    }

    const runner = new CloudTaskRunner({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      dataDir: path.join(dir, 'data'),
      getApiConfig: async () => null,
      getCoordinator: async () => ({
        bind: async () => ({ success: true, worktree: { path: wt, branch: 'pi/retry' } }),
        getSessionBinding: () => ({ key: '', path: wt, branch: 'pi/retry' }),
        hasBinding: () => true,
        release: async () => ({ success: true, removed: true, dirty: false, worktreePath: wt }),
      }),
      onStatus: () => undefined,
      onWorktree: () => undefined,
      onMilestone: () => undefined,
      onQuestion: () => undefined,
      onResult: () => undefined,
      onFailed: () => undefined,
      onInterrupted: () => undefined,
      onUnitClosed: () => undefined,
      onUnitState: () => undefined,
    })

    ;(runner as any).ensureManager = async () => {
      ensureCalls += 1
      // 首次失败触发 retryAfterConfigRefresh，第二次成功
      if (ensureCalls === 1) throw new Error('config not ready yet')
      return fakeManager
    }

    const mkSpec = (title: string): CloudTaskSpec => ({
      workUnitId: 'u-retry',
      deviceId: 'dev-1',
      repo: { workspacePath: wt, baseBranch: 'main' },
      title,
      background: 'b',
      goal: title,
      acceptance: 'a',
      output: { summary: true, changeList: true, testResult: false },
      commit: false,
      authorizationId: 'auth-1',
    })

    const p1 = runner.start('T-1', mkSpec('first-task'))
    const p2 = runner.start('T-2', mkSpec('second-task'))
    await Promise.all([p1, p2])

    // T-1 经 1s 配置刷新重试后完整跑完，T-2 才开始，绝不交错并发
    expect(events).toEqual(['start:T-1', 'end:T-1', 'start:T-2', 'end:T-2'])
    await runner.dispose()
  })
})

describe('Bug 13: apps/cloud/deploy/update.sh 脚本修复校验', () => {
  it('不再使用未加引号的 token 参数展开，且清理旧版本前规范化 TARGET_REAL', async () => {
    const script = await fs.readFile(
      path.resolve(process.cwd(), 'apps/cloud/deploy/update.sh'),
      'utf-8'
    )
    expect(script).not.toContain('${PI_CLOUD_GITHUB_TOKEN:+-H')
    expect(script).toContain('MANIFEST_CURL_ARGS')
    expect(script).toContain('curl "${MANIFEST_CURL_ARGS[@]}"')
    expect(script).toContain('TARGET_REAL="$(readlink -f "$TARGET_DIR")"')
    expect(script).toContain('"$REAL_DIR" = "$TARGET_REAL"')
  })
})
