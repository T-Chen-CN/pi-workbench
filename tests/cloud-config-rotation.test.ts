/**
 * F-13 / A-16：云端模型配置轮换必须在**轮次边界**生效，而且不许打断进行中的轮次。
 *
 * 这里把 `AgentManager` 换成假类（真实现要真实供应商 Key），只验证调度语义：
 * ① 推配置后入口处重建一次；② 本轮在跑时不动；③ 新配置不可用就回退到上一份可用配置。
 */

// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

interface FakeConfig {
  apiConfig: { providerId: string; modelId: string }
}

const calls = { initialize: 0, dispose: 0 }
const state = {
  busy: false,
  /** initialize 阶段被拒的模型（模拟“结构上就建不起来”：模型不存在等） */
  rejectedModels: [] as string[],
  /** 探测阶段被拒的模型（模拟“Key 无效 / 连不上供应商”）：旧运行时必须毫发无伤 */
  invalidConfigs: [] as string[],
  probes: 0,
  lastConfig: null as FakeConfig | null,
}

class FakeAgentManager {
  async initialize(config: FakeConfig) {
    calls.initialize += 1
    const model = config.apiConfig.modelId
    if (state.rejectedModels.includes(model)) {
      return { success: false, error: `${model} rejected` }
    }
    state.lastConfig = config
    return { success: true }
  }

  async openSession() {
    return {
      success: true,
      session: { id: 'cloud-session-1', dispose: () => undefined, abort: async () => undefined },
      history: [],
    }
  }

  async subscribeTrace() {
    return { success: true }
  }

  isSessionBusy() {
    return state.busy
  }

  async dispose() {
    calls.dispose += 1
  }

  async chat() {
    return { success: true, response: 'ok' }
  }

  async steer() {
    return { success: true }
  }

  async abort() {
    return { success: true }
  }

  async sendCustomMessage() {
    return { success: true }
  }
}

vi.mock('pi-bridge', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, AgentManager: FakeAgentManager }
})

// 必须放在 vi.mock 之后：main.ts 会通过被 mock 的模块拿 AgentManager
const { createCloudServer } = await import('../apps/cloud/src/main')

let tmpRoot: string
let server: Awaited<ReturnType<typeof createCloudServer>>
let base = ''
let cookie = ''

const headers = () => ({ 'content-type': 'application/json', cookie })

async function pushConfig(model: string): Promise<void> {
  const response = await fetch(`${base}/v1/cloud-config`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({
      provider: 'custom',
      apiUrl: 'https://example.invalid/v1',
      model,
      apiKey: `key-for-${model}`,
    }),
  })
  expect(response.status).toBe(200)
}

/** 所有入口都会先 `ensureAgent()`，所以拉一次快照就等于「开始下一轮前的检查」 */
async function touchEntry(): Promise<void> {
  const response = await fetch(`${base}/v1/snapshot`, { headers: headers() })
  expect(response.status).toBe(200)
}

function runningModel(): string | undefined {
  return state.lastConfig?.apiConfig.modelId
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-config-'))
  server = await createCloudServer(
    {
      dataDir: tmpRoot,
      workspaceDir: path.join(tmpRoot, 'workspace'),
      agentDir: path.join(tmpRoot, 'agent'),
      port: 0,
      encryptionKey: Buffer.alloc(32, 5),
      cookieSecret: 'config-rotation-secret',
      secureCookies: false,
      version: 'test',
    },
    {
      // 真探测要打供应商 `/models`：这里换成替身，只记次数并按名单拉黑
      probeConfig: async (config) => {
        state.probes += 1
        if (state.invalidConfigs.includes(config.model)) {
          return { ok: false, reason: `401 invalid api key for ${config.model}` }
        }
        return { ok: true }
      },
    }
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
})

afterAll(async () => {
  await server?.close()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  state.busy = false
  state.rejectedModels = []
  state.invalidConfigs = []
  state.probes = 0
})

describe('云端配置轮换（F-13 / A-16）', () => {
  it('首次推送配置在入口处初始化一次，同一份配置不会重复重建', async () => {
    const before = calls.initialize
    await pushConfig('model-a')
    await touchEntry()
    expect(calls.initialize).toBe(before + 1)
    expect(runningModel()).toBe('model-a')

    // 同一份配置再进一次入口：不重建
    const settled = calls.initialize
    await touchEntry()
    expect(calls.initialize).toBe(settled)
  })

  it('推新配置后，下一次入口重建运行时并用新模型（不重启进程）', async () => {
    await pushConfig('model-b')
    const beforeInit = calls.initialize
    const beforeDispose = calls.dispose
    await touchEntry()

    expect(calls.initialize).toBe(beforeInit + 1)
    expect(calls.dispose).toBe(beforeDispose + 1)
    expect(runningModel()).toBe('model-b')
  })

  it('本轮在跑时不重建；轮次结束后才生效', async () => {
    await pushConfig('model-c')
    state.busy = true
    const whileBusy = calls.initialize
    await touchEntry()
    expect(calls.initialize).toBe(whileBusy)
    expect(runningModel()).toBe('model-b')

    state.busy = false
    await touchEntry()
    expect(calls.initialize).toBe(whileBusy + 1)
    expect(runningModel()).toBe('model-c')
  })

  it('新配置不可用时回退到上一份可用配置，服务不被坏配置打死', async () => {
    await pushConfig('model-broken')
    state.rejectedModels = ['model-broken']
    const beforeInit = calls.initialize
    await touchEntry()

    // 一次失败的尝试 + 一次回滚
    expect(calls.initialize).toBe(beforeInit + 2)
    expect(runningModel()).toBe('model-c')

    // 同一份坏配置不再反复重试
    const afterRollback = calls.initialize
    await touchEntry()
    await touchEntry()
    expect(calls.initialize).toBe(afterRollback)
    expect(runningModel()).toBe('model-c')
  })
})

describe('探测失败：坏 Key 不许把旧运行时拆掉', () => {
  it('探测判不可用 → 一次 initialize 都不发生，旧模型继续用', async () => {
    // 先确保运行时在 model-c 上
    await pushConfig('model-c')
    await touchEntry()
    expect(runningModel()).toBe('model-c')

    await pushConfig('model-bad-key')
    state.invalidConfigs = ['model-bad-key']
    const beforeInit = calls.initialize
    const beforeDispose = calls.dispose
    await touchEntry()

    expect(state.probes).toBeGreaterThan(0)
    expect(calls.initialize).toBe(beforeInit)
    expect(calls.dispose).toBe(beforeDispose)
    expect(runningModel()).toBe('model-c')

    // 同一份坏配置再进两次入口：不再探测（failedConfigStamp 生效）
    const settledProbes = state.probes
    await touchEntry()
    await touchEntry()
    expect(state.probes).toBe(settledProbes)

    // 推一份好的立刻恢复轮换
    await pushConfig('model-d')
    await touchEntry()
    expect(runningModel()).toBe('model-d')
  })
})
