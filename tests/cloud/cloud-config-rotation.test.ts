/**
 * F-13 / A-16：云端模型配置轮换必须在**轮次边界**生效，而且不许打断进行中的轮次。
 *
 * 这里把 `AgentManager` 换成假类（真实现要真实供应商 Key），只验证调度语义：
 * ① 写配置后入口处重建一次；② 本轮在跑时不动；③ 新配置不可用时回退到上一份可用配置。
 *
 * 配置写入走 `store.saveCloudConfig`（等价于 PUT 落盘后的状态），这样用例只验证轮换，
 * 不与「PUT 时校验白名单 / catalog / Key 探测」纠缠（那是 routes 的职责）。
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
  /** 探测阶段被拒的 provider（模拟“Key 无效”）：旧运行时必须毫发无伤 */
  invalidProviders: [] as string[],
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
const { createCloudServer } = await import('../../apps/cloud/src/main')
const { encryptSecret } = await import('../../apps/cloud/src/secure/config-crypto')

let tmpRoot: string
let server: Awaited<ReturnType<typeof createCloudServer>>
let base = ''
let cookie = ''
const encryptionKey = Buffer.alloc(32, 5)

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-rotation-'))
  server = await createCloudServer(
    {
      dataDir: tmpRoot,
      workspaceDir: path.join(tmpRoot, 'workspace'),
      agentDir: path.join(tmpRoot, 'agent'),
      port: 0,
      encryptionKey,
      cookieSecret: 'config-rotation-secret',
      secureCookies: false,
      version: 'test',
    },
    {
      // 真探测要打供应商 `/models`：这里换成替身，只记次数并按名单拉黑
      probeConfig: async (input) => {
        state.probes += 1
        if (state.invalidProviders.includes(input.providerId)) {
          return { ok: false, reason: `401 invalid api key for ${input.providerId}` }
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
  state.invalidProviders = []
  state.probes = 0
})

const headers = () => ({ 'content-type': 'application/json', cookie })

/** 直接写盘（等价于 PUT 成功后的状态），避免用例依赖路由校验 */
async function pushConfig(model: string, providerId = 'deepseek'): Promise<void> {
  await server.store.saveCloudConfig({
    providerId,
    model,
    credentialCipher: encryptSecret(
      JSON.stringify({ type: 'api_key', key: `key-for-${model}` }),
      encryptionKey
    ),
    updatedAt: Date.now(),
  })
}

let turnSeq = 0

/** 轮次入口（session.say → ensureAgent）才会触发配置轮换；只读 GET /v1/snapshot 不拆运行时 */
async function touchEntry(): Promise<void> {
  turnSeq += 1
  await server.session.say(`turn-check-${turnSeq}`, `rot-${turnSeq}`)
}

function runningModel(): string | undefined {
  return state.lastConfig?.apiConfig.modelId
}

describe('云端配置轮换（F-13 / A-16）', () => {
  it('首次写配置在入口处初始化一次，同一份配置不会重复重建', async () => {
    const before = calls.initialize
    await pushConfig('deepseek-flash')
    await touchEntry()
    expect(calls.initialize).toBe(before + 1)
    expect(runningModel()).toBe('deepseek-flash')

    // 同一份配置再进一次入口：不重建
    const settled = calls.initialize
    await touchEntry()
    expect(calls.initialize).toBe(settled)
  })

  it('只读 GET /v1/snapshot 绝不拆毁重建正在运行的 Agent，轮换严格延后到下一轮入口', async () => {
    await pushConfig('deepseek-v4-pro')
    const beforeInit = calls.initialize
    const beforeDispose = calls.dispose

    const snap = await fetch(`${base}/v1/snapshot`, { headers: headers() })
    expect(snap.status).toBe(200)
    expect(calls.initialize).toBe(beforeInit)
    expect(calls.dispose).toBe(beforeDispose)
    expect(runningModel()).toBe('deepseek-flash')

    await touchEntry()
    expect(calls.initialize).toBe(beforeInit + 1)
    expect(calls.dispose).toBe(beforeDispose + 1)
    expect(runningModel()).toBe('deepseek-v4-pro')
  })

  it('写新配置后，下一次入口重建运行时并用新模型（不重启进程）', async () => {
    await pushConfig('deepseek-flash')
    const beforeInit = calls.initialize
    const beforeDispose = calls.dispose
    await touchEntry()

    expect(calls.initialize).toBe(beforeInit + 1)
    expect(calls.dispose).toBe(beforeDispose + 1)
    expect(runningModel()).toBe('deepseek-flash')

    await pushConfig('deepseek-v4-pro')
    await touchEntry()
    expect(runningModel()).toBe('deepseek-v4-pro')
  })

  it('本轮在跑时不重建；轮次结束后才生效', async () => {
    await pushConfig('deepseek-flash')
    state.busy = true
    const whileBusy = calls.initialize
    await touchEntry()
    expect(calls.initialize).toBe(whileBusy)
    expect(runningModel()).toBe('deepseek-v4-pro')

    state.busy = false
    await touchEntry()
    expect(calls.initialize).toBe(whileBusy + 1)
    expect(runningModel()).toBe('deepseek-flash')
  })

  it('initialize 失败时回退到上一份可用配置，服务不被坏配置打死', async () => {
    await pushConfig('deepseek-v4-pro')
    state.rejectedModels = ['deepseek-v4-pro']
    const beforeInit = calls.initialize
    await touchEntry()

    // 一次失败的尝试 + 一次回滚
    expect(calls.initialize).toBe(beforeInit + 2)
    expect(runningModel()).toBe('deepseek-flash')

    // 同一份坏配置不再反复重试
    const afterRollback = calls.initialize
    await touchEntry()
    await touchEntry()
    expect(calls.initialize).toBe(afterRollback)
    expect(runningModel()).toBe('deepseek-flash')
  })

  it('OAuth token 刷新（saveCloudCredential）不改 updatedAt，不触发 AgentManager 拆毁重建（Bug 8）', async () => {
    await pushConfig('deepseek-flash')
    await touchEntry()
    const beforeInit = calls.initialize
    const beforeDispose = calls.dispose
    const stampBefore = server.store.getCloudConfig()?.updatedAt

    const refreshedCipher = encryptSecret(
      JSON.stringify({ type: 'oauth', access: 'new-access-token', refresh: 'r1', expires: Date.now() + 3600_000 }),
      encryptionKey
    )
    await server.store.saveCloudCredential('deepseek', refreshedCipher)

    const afterRecord = server.store.getCloudConfig()
    expect(afterRecord?.updatedAt).toBe(stampBefore)
    expect(afterRecord?.credentialCipher).toBe(refreshedCipher)
    expect(typeof afterRecord?.credentialUpdatedAt).toBe('number')

    // 下一轮入口绝不能因为 OAuth 刷新去 dispose/re-initialize AgentManager
    await touchEntry()
    expect(calls.initialize).toBe(beforeInit)
    expect(calls.dispose).toBe(beforeDispose)
  })
})

describe('保存配置时探测 Key（D24）', () => {
  it('探测判不可用 → 400 且不改动已保存的配置', async () => {
    state.invalidProviders = ['google']
    const response = await fetch(`${base}/v1/cloud-config`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        providerId: 'google',
        model: 'gemini-2.5-computer-use-preview-10-2025',
        apiKey: 'sk-bad',
      }),
    })
    expect(response.status).toBe(400)
    expect(state.probes).toBeGreaterThan(0)
    expect(server.store.getCloudConfig()?.providerId).toBe('deepseek')
  })

  it('白名单外的 provider 与 catalog 外的模型都被拒', async () => {
    const unknownProvider = await fetch(`${base}/v1/cloud-config`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ providerId: 'custom', model: 'x', apiKey: 'k' }),
    })
    expect(unknownProvider.status).toBe(400)

    const unknownModel = await fetch(`${base}/v1/cloud-config`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ providerId: 'deepseek', model: 'no-such-model', apiKey: 'k' }),
    })
    expect(unknownModel.status).toBe(400)
  })

  it('旧记录（provider + apiUrl 形态）整体作废', async () => {
    await server.store.saveCloudConfig({
      // 直接写一条旧形态的行，模拟升级前留下的记录
      provider: 'custom',
      apiUrl: 'https://api.example.com/v1',
      model: 'model-a',
      apiKeyCipher: 'enc:x',
      updatedAt: Date.now(),
    } as never)
    expect(server.store.getCloudConfig()).toBeNull()

    const response = await fetch(`${base}/v1/cloud-config`, { headers: headers() })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ configured: false })
  })
})
