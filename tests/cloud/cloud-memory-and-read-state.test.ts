/**
 * C-03a / C-03c / C-03d 集成测试：
 * - 记忆自动抽取（A-25：50 轮对话压缩前提炼 → 下一轮 `before_agent_start` 召回）
 * - 手工记忆保护（自动抽取与梦境整理绝不覆盖或删除 `source === 'manual'`）
 * - 留存文档白名单（AGENTS.md / SOUL.md 读写 + 路径穿越拦截）
 * - 梦境整理时间线（`/v1/dreams` + `/v1/dreams/run`）
 * - 多端已读/未读同步（F-52：`mark_read` / `POST /v1/read` / `read_state` 广播）
 * - 客户端直发 `task_message`（running 转发终端 / waiting_human 走回答）
 * - 托盘角标与 Tooltip（`formatTrayTooltip` / `updateTrayBadge`）
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createCloudServer, type CloudServer } from '../../apps/cloud/src/main.js'
import { CloudMemoryStore } from '../../apps/cloud/src/memory/memory-store.js'
import {
  buildMemoryContextBlock,
  createCloudMemoryExtension,
  extractMemoriesBeforeCompact,
  runDreamConsolidation,
} from '../../apps/cloud/src/memory/memory-engine.js'
import { CLOUD_PROTOCOL_VERSION, type CloudEvent } from '../../pi-bridge/src/cloud-protocol'

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

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function waitForEvent(
  ws: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 5_000
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

const TEST_ENC_KEY = Buffer.alloc(32, 7)
const TEST_COOKIE_SECRET = 'test-cookie-secret-32-bytes-long!'

async function setupServerWithDevice(hooks: Parameters<typeof createCloudServer>[1] = {}) {
  const dataDir = await makeTempDir('pi-cloud-mem-')
  const srv = await createCloudServer(
    {
      dataDir,
      port: 0,
      host: '127.0.0.1',
      encryptionKey: TEST_ENC_KEY,
      cookieSecret: TEST_COOKIE_SECRET,
      secureCookies: false,
    },
    hooks
  )
  servers.push(srv)
  const port = await srv.listen()
  const baseUrl = `http://127.0.0.1:${port}`

  const setupRes = await fetch(`${baseUrl}/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-123456' }),
  })
  expect(setupRes.status).toBe(200)
  const loginRes = await fetch(`${baseUrl}/v1/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-123456' }),
  })
  expect(loginRes.status).toBe(200)
  const cookie = (loginRes.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? ''

  const pairCodeRes = await fetch(`${baseUrl}/v1/pair/code`, {
    method: 'POST',
    headers: { cookie },
  })
  const { code } = (await pairCodeRes.json()) as { code: string }

  const pairRes = await fetch(`${baseUrl}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'Test-PC', platform: 'win32' }),
  })
  const { deviceId, token, clientToken } = (await pairRes.json()) as {
    deviceId: string
    token: string
    clientToken: string
  }

  return { srv, port, baseUrl, cookie, deviceId, token, clientToken }
}

describe('C-03a: 云端记忆自动抽取、手工保护、留存文档与梦境整理', () => {
  it('A-25：50 轮对话压缩前自动提炼长期记忆，下一轮 before_agent_start 命中并注入系统提示', async () => {
    const dir = await makeTempDir('pi-mem-a25-')
    const store = await CloudMemoryStore.open(dir)

    // 构造 50 轮对话历史，第 1 轮约定了一个关键代号和端口
    const branchEntries: unknown[] = [
      {
        type: 'message',
        message: {
          role: 'user',
          content: '记住：画板开发仓库的发布代号是 ORION-942，必须跑 vitest 才能推包。',
        },
      },
      {
        type: 'message',
        message: { role: 'assistant', content: '好的，我记下了发布代号 ORION-942 和测试要求。' },
      },
    ]
    for (let i = 2; i <= 50; i += 1) {
      branchEntries.push(
        { type: 'message', message: { role: 'user', content: `第 ${i} 轮讨论细节 ${i}` } },
        { type: 'message', message: { role: 'assistant', content: `第 ${i} 轮回复 ${i}` } }
      )
    }

    const added = await extractMemoriesBeforeCompact(store, branchEntries, async (_sys, user) => {
      // 验证压缩前对话摘要被送给抽取模型
      expect(user).toContain('第 50 轮')
      return JSON.stringify({
        items: [
          {
            kind: 'project',
            content: '画板开发仓库发布代号为 ORION-942，发布前必须通过 vitest。',
            tags: ['画板开发', 'ORION-942'],
          },
        ],
      })
    })
    expect(added).toHaveLength(1)
    expect(added[0].source).toBe('auto')

    // 同时写入 AGENTS.md 和 SOUL.md
    await store.writeDoc('SOUL.md', '保持简洁直接，中文回复。')
    await store.writeDoc('AGENTS.md', '任何涉及发版的工单都必须先跑单测。')

    // 模拟 Pi SDK `before_agent_start` 钩子：下一轮问起「画板开发发布代号」
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>()
    const ext = createCloudMemoryExtension(store)
    ext({
      on: (name: string, fn: (event: unknown) => Promise<unknown>) => {
        handlers.set(name, fn)
      },
    } as never)

    const beforeStart = handlers.get('before_agent_start')
    expect(beforeStart).toBeDefined()
    const injected = (await beforeStart!({
      prompt: '画板开发的发布代号是什么？',
      systemPrompt: 'BASE_SYSTEM_PROMPT',
    })) as { systemPrompt: string }

    expect(injected.systemPrompt).toContain('BASE_SYSTEM_PROMPT')
    expect(injected.systemPrompt).toContain('ORION-942')
    expect(injected.systemPrompt).toContain('保持简洁直接，中文回复。')
    expect(injected.systemPrompt).toContain('任何涉及发版的工单都必须先跑单测。')
  })

  it('手工记忆永不被自动抽取或梦境整理覆盖/删除', async () => {
    const dir = await makeTempDir('pi-mem-manual-')
    const store = await CloudMemoryStore.open(dir)

    const manual = await store.addMemory({
      kind: 'preference',
      content: '不要修改 .npmrc 里的 electron_mirror。',
      source: 'manual',
      pinned: true,
    })
    const auto1 = await store.addMemory({
      kind: 'fact',
      content: '服务器部署在新加坡 203.0.113.10。',
      source: 'auto',
    })
    const auto2 = await store.addMemory({
      kind: 'fact',
      content: '生产服务器 IP 为 203.0.113.10（新加坡节点）。',
      source: 'auto',
    })

    // 即使模型恶意把 manual.id 放进 removeIds，也必须被底层硬拦截
    const dream = await runDreamConsolidation(store, 'manual', async () =>
      JSON.stringify({
        summary: '合并 2 条重复的服务器 IP 记忆。',
        removeIds: [manual.id, auto1.id, auto2.id],
        upsert: [
          {
            kind: 'fact',
            content: '生产服务器位于新加坡节点 203.0.113.10。',
            tags: ['prod'],
          },
        ],
      })
    )

    expect(dream).not.toBeNull()
    expect(dream!.removed).toBe(2)
    expect(dream!.added).toBe(1)

    const list = store.listMemories()
    expect(list.some((m) => m.id === manual.id && m.source === 'manual')).toBe(true)
    expect(list.some((m) => m.id === auto1.id)).toBe(false)
    expect(list.some((m) => m.content.includes('新加坡节点 203.0.113.10'))).toBe(true)

    // 注入块里置顶的手工记忆优先出现
    const block = await buildMemoryContextBlock(store, '任意问题')
    expect(block).toContain('electron_mirror')
  })

  it('梦境整理按最旧 auto 优先分批，避免 #51..#200 旧自动记忆永久饿死（Bug 7）', async () => {
    const dir = await makeTempDir('pi-mem-starve-')
    const store = await CloudMemoryStore.open(dir)

    // 写入 65 条 auto 记忆，时间戳从 1001 递增到 1065
    const ids: string[] = []
    for (let i = 1; i <= 65; i += 1) {
      const item = await store.addMemory({
        kind: 'fact',
        content: `auto-memory-${String(i).padStart(3, '0')}`,
        source: 'auto',
        now: 1000 + i,
      })
      ids.push(item.id)
    }

    const batches: string[][] = []
    const captureIds = (prompt: string) =>
      [...prompt.matchAll(/\[(mem-[a-f0-9]+)\]/g)].map((m) => m[1])

    // 第一轮整理：应优先挑最旧的 50 条（#1..#50），并把它们合并成新 dream 条目
    await runDreamConsolidation(
      store,
      'manual',
      async (_sys, user) => {
        const seen = captureIds(user)
        batches.push(seen)
        return JSON.stringify({
          summary: '整理首批 50 条',
          removeIds: seen,
          upsert: Array.from({ length: 10 }, (_, idx) => ({
            kind: 'fact',
            content: `dream-merged-batch1-${idx}`,
          })),
        })
      },
      2000
    )

    // 第二轮整理：新生成的 dream 条目不能挤占剩余 15 条旧 auto 记忆（#51..#65）
    await runDreamConsolidation(
      store,
      'manual',
      async (_sys, user) => {
        const seen = captureIds(user)
        batches.push(seen)
        return JSON.stringify({
          summary: '整理剩余 15 条',
          removeIds: [],
          upsert: [],
        })
      },
      3000
    )

    expect(batches).toHaveLength(2)
    // 第一批包含最旧的第 1 条、不包含最新的第 65 条
    expect(batches[0]).toContain(ids[0])
    expect(batches[0]).not.toContain(ids[64])
    // 第二批覆盖了第 51..65 条（没有任何 auto 记忆饿死）
    for (let i = 50; i < 65; i += 1) {
      expect(batches[1]).toContain(ids[i])
    }
  })

  it('REST 端点：记忆 CRUD、留存文档白名单防穿越、梦境查询与手动触发', async () => {
    const { baseUrl, cookie } = await setupServerWithDevice({
      completeAuxiliary: async () =>
        JSON.stringify({
          summary: '测试梦境整理完成',
          removeIds: [],
          upsert: [],
        }),
    })

    // 未登录必须 401
    const unauth = await fetch(`${baseUrl}/v1/memories`)
    expect(unauth.status).toBe(401)

    // 新增手工记忆
    const addRes = await fetch(`${baseUrl}/v1/memories`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'decision', content: '云端记忆目录放在 /var/lib/pi-cloud/memory' }),
    })
    expect(addRes.status).toBe(200)
    const { memory } = (await addRes.json()) as { memory: { id: string; pinned: boolean } }
    expect(memory.pinned).toBe(false)

    // 置顶
    const patchRes = await fetch(`${baseUrl}/v1/memories/${memory.id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    })
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as { memory: { pinned: boolean } }
    expect(patched.memory.pinned).toBe(true)

    // 写 AGENTS.md 并读回
    const putDoc = await fetch(`${baseUrl}/v1/cloud-docs/AGENTS.md`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Rules\nAlways test.' }),
    })
    expect(putDoc.status).toBe(200)
    const getDocs = await fetch(`${baseUrl}/v1/cloud-docs`, { headers: { cookie } })
    const { docs } = (await getDocs.json()) as { docs: Array<{ name: string; content: string }> }
    expect(docs.find((d) => d.name === 'AGENTS.md')?.content).toBe('# Rules\nAlways test.')

    // 路径穿越或非白名单文件名必须 400 拒绝
    const badDoc1 = await fetch(`${baseUrl}/v1/cloud-docs/..%2Fadmin.json`, { headers: { cookie } })
    expect(badDoc1.status).toBe(400)
    const badDoc2 = await fetch(`${baseUrl}/v1/cloud-docs/secrets.md`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hack' }),
    })
    expect(badDoc2.status).toBe(400)

    // 手动触发梦境并读回记录
    const dreamRun = await fetch(`${baseUrl}/v1/dreams/run`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(dreamRun.status).toBe(200)
    const dreamsList = await fetch(`${baseUrl}/v1/dreams`, { headers: { cookie } })
    const { dreams } = (await dreamsList.json()) as { dreams: Array<{ trigger: string }> }
    expect(dreams.length).toBeGreaterThanOrEqual(1)
    expect(dreams[0].trigger).toBe('manual')
  })
})

describe('C-03c & C-03d: 多端已读同步与 task_message 直达终端', () => {
  it('F-52：服务端累计未读数，一个端 mark_read 后同步广播 read_state 给其他在线端', async () => {
    const { srv, port, clientToken } = await setupServerWithDevice()

    const wsA = new WebSocket(`ws://127.0.0.1:${port}/client/ws`, {
      headers: { authorization: `Bearer ${clientToken}` },
    })
    const wsB = new WebSocket(`ws://127.0.0.1:${port}/client/ws`, {
      headers: { authorization: `Bearer ${clientToken}` },
    })
    await Promise.all([
      waitForEvent(wsA, (f) => f.type === 'snapshot'),
      waitForEvent(wsB, (f) => f.type === 'snapshot'),
    ])

    // 服务端发布一条助手回复结束事件（应计入未读）
    const assistantMsg: CloudEvent = {
      type: 'message_end',
      messageId: 'a-1',
      text: '工单已完成',
      at: Date.now(),
    }
    const seq = srv.hub.publish(assistantMsg)
    await waitForEvent(wsA, (f) => f.type === 'event' && (f.event as { type?: string })?.type === 'message_end')

    const snapBefore = await srv.snapshot()
    expect(snapBefore.unreadCount).toBe(1)

    // 客户端 A 发送 mark_read，客户端 B 应收到 read_state(unreadCount=0)
    const bReadPromise = waitForEvent(
      wsB,
      (f) => f.type === 'event' && (f.event as { type?: string })?.type === 'read_state'
    )
    wsA.send(JSON.stringify({ v: CLOUD_PROTOCOL_VERSION, type: 'mark_read', seq }))
    const bReadFrame = await bReadPromise
    const readEvt = bReadFrame.event as { type: string; lastReadSeq: number; unreadCount: number }
    expect(readEvt.unreadCount).toBe(0)
    expect(readEvt.lastReadSeq).toBe(seq)

    const snapAfter = await srv.snapshot()
    expect(snapAfter.unreadCount).toBe(0)

    wsA.close()
    wsB.close()
  })

  it('C-03d：客户端发送 task_message 时，运行中工单直接转发 task_message 到对应设备', async () => {
    const { srv, port, deviceId, token, clientToken } = await setupServerWithDevice()

    const devWs = new WebSocket(`ws://127.0.0.1:${port}/device/ws`, {
      headers: { authorization: `Bearer ${token}` },
    })
    await new Promise<void>((resolve) => devWs.once('open', () => resolve()))
    const pongPromise = waitForEvent(devWs, (f) => f.type === 'pong')
    devWs.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'hello',
        deviceId,
        name: 'Test-PC',
        platform: 'win32',
        workspaces: [{ path: '/repo/demo', name: 'demo', isGit: true }],
      })
    )
    devWs.send(JSON.stringify({ v: CLOUD_PROTOCOL_VERSION, type: 'ping', at: Date.now() }))
    await pongPromise

    // 注入一条 running 工单
    await srv.store.saveTask({
      id: 'T-RUN-1',
      status: 'running',
      idempotencyKey: 'key-run-1',
      spec: {
        workUnitId: 'unit-run-1',
        deviceId,
        repo: { workspacePath: '/repo/demo' },
        title: '修测试',
        background: 'test',
        goal: '跑通测试',
        acceptance: 'pass',
        output: { summary: true, changeList: true, testResult: true },
        commit: false,
        authorizationId: 'auth-1',
      },
      createdAt: Date.now(),
      dispatchedAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      progress: { step: 1, lastEventAt: Date.now(), changedFiles: [], secretHits: [] },
    })

    const clientWs = new WebSocket(`ws://127.0.0.1:${port}/client/ws`, {
      headers: { authorization: `Bearer ${clientToken}` },
    })
    await waitForEvent(clientWs, (f) => f.type === 'snapshot')

    const forwarded = waitForEvent(devWs, (f) => f.type === 'task_message')
    clientWs.send(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'task_message',
        taskId: 'T-RUN-1',
        text: '顺便把 lint 也跑一下',
      })
    )
    const frame = await forwarded
    expect(frame.taskId).toBe('T-RUN-1')
    expect(frame.text).toBe('顺便把 lint 也跑一下')

    clientWs.close()
    devWs.close()
  })
})

describe('C-03c: 托盘角标与 Tooltip', () => {
  it('formatTrayTooltip 与 updateTrayBadge 根据执行中工单数与未读数更新 Tooltip 与角标', async () => {
    const setBadgeCount = vi.fn()
    const setToolTip = vi.fn()
    const setOverlayIcon = vi.fn()
    const fakeImage = {
      isEmpty: () => false,
      setTemplateImage: vi.fn(),
      resize: () => fakeImage,
    }
    const createFromBitmap = vi.fn(() => fakeImage)

    vi.resetModules()
    vi.doMock('electron', () => ({
      app: { setBadgeCount },
      Menu: { buildFromTemplate: vi.fn(() => ({})) },
      Tray: vi.fn(() => ({
        setToolTip,
        setContextMenu: vi.fn(),
        setIgnoreDoubleClickEvents: vi.fn(),
        on: vi.fn(),
        destroy: vi.fn(),
        isDestroyed: () => false,
      })),
      nativeImage: {
        createFromPath: vi.fn(() => fakeImage),
        createFromBitmap,
      },
    }))

    const trayMod = await import('../../electron/tray')
    expect(trayMod.formatTrayTooltip('zh', { runningTasks: 0, unreadCount: 0 })).toBe('Pi Workbench')
    expect(trayMod.formatTrayTooltip('zh', { runningTasks: 2, unreadCount: 3 })).toBe(
      'Pi Workbench · 2 个工单执行中 · 3 条未读'
    )
    expect(trayMod.formatTrayTooltip('en', { runningTasks: 1, unreadCount: 2 })).toBe(
      'Pi Workbench · 1 task running · 2 unread'
    )

    const fakeWin = {
      isDestroyed: () => false,
      setOverlayIcon,
    }
    trayMod.installTray({
      getEnabled: () => true,
      getLanguage: () => 'zh',
      showMainWindow: () => {},
      quit: () => {},
      getMainWindow: () => fakeWin as never,
    })

    trayMod.updateTrayBadge({ runningTasks: 1, unreadCount: 4 })
    if (process.platform !== 'linux') {
      expect(setToolTip).toHaveBeenCalledWith('Pi Workbench · 1 个工单执行中 · 4 条未读')
    }
    if (process.platform === 'win32') {
      expect(setOverlayIcon).toHaveBeenCalled()
    } else {
      expect(setBadgeCount).toHaveBeenCalledWith(5)
    }

    trayMod.updateTrayBadge({ runningTasks: 0, unreadCount: 0 })
    if (process.platform === 'win32') {
      expect(setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    } else {
      expect(setBadgeCount).toHaveBeenCalledWith(0)
    }
    trayMod.destroyTray()
  })
})
