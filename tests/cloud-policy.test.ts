import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * 策略层只做三件事：读白名单子集、写一个键、读回复核。
 *
 * 这里用假的 `net.fetch` 断言三件不能退让的事：
 * 1. GET 回来的整份配置**不能**整个透出（里面有明文密钥）；
 * 2. PUT 只发最小 patch，绝不把 GET 结果回写；
 * 3. 读回不一致必须报错，不能假装切换成功。
 */
const state = vi.hoisted(() => ({
  appDir: '',
  /** 服务端当前生效的档位（PUT 之后变） */
  mode: 'manual',
  /** 服务端是否「吃了 patch 但没生效」（模拟版本守卫 / 有东西改回去） */
  ignoreWrites: false,
  puts: [] as string[],
  gets: 0,
  headers: [] as Array<Record<string, string>>,
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => state.appDir,
    getPath: () => state.appDir,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf-8').slice(4),
  },
  net: {
    fetch: async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const route = new URL(url).pathname
      state.headers.push(init?.headers ?? {})
      if (route !== '/api/config') return new Response('not found', { status: 404 })
      if (init?.method === 'PUT') {
        state.puts.push(String(init.body ?? ''))
        if (!state.ignoreWrites) {
          const patch = JSON.parse(String(init.body ?? '{}')) as {
            config?: { approvals?: { mode?: string } }
          }
          if (patch.config?.approvals?.mode) state.mode = patch.config.approvals.mode
        }
        return Response.json({ ok: true })
      }
      state.gets += 1
      return Response.json({
        approvals: {
          mode: state.mode,
          timeout: 120,
          deny: ['curl|sh', 'dd to device'],
        },
        agent: { disabled_toolsets: ['code_execution'], max_turns: 40 },
        terminal: { backend: 'local', workdir: '/srv/app' },
        providers: { openai: { api_key: 'sk-live-should-never-leak' } },
        secrets: { gateway_token: 'tok-should-never-leak' },
      })
    },
  },
}))

type PolicyModule = typeof import('../electron/cloud/policy')
type ConfigModule = typeof import('../electron/cloud/config')

let policy: PolicyModule
let config: ConfigModule

beforeAll(async () => {
  state.appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cloud-policy-'))
  policy = await import('../electron/cloud/policy')
  config = await import('../electron/cloud/config')
  config.writeCloudConfig({
    gatewayUrl: 'https://hub.example.com',
    deviceToken: 'pi_dev',
    dashboardUrl: 'https://dash.example.com',
  })
})

afterAll(() => {
  fs.rmSync(state.appDir, { recursive: true, force: true })
})

beforeEach(() => {
  state.mode = 'manual'
  state.ignoreWrites = false
  state.puts = []
  state.gets = 0
  state.headers = []
})

describe('pickApprovalPolicy', () => {
  it('keeps only the whitelisted subset', () => {
    const picked = policy.pickApprovalPolicy({
      approvals: { mode: 'manual', timeout: 120, deny: ['a', 'b', 'c'] },
      agent: { disabled_toolsets: ['code_execution'], max_turns: 40 },
      terminal: { backend: 'local', workdir: '/srv/app' },
      providers: { openai: { api_key: 'sk-live' } },
    })
    expect(picked).toEqual({
      mode: 'manual',
      timeoutSeconds: 120,
      denyCount: 3,
      disabledToolsets: ['code_execution'],
      terminalBackend: 'local',
    })
    expect(JSON.stringify(picked)).not.toContain('sk-live')
  })


  it('reads the count the gateway actually sends (policy.denyCount)', () => {
    // 过网关时 deny 内容被剥掉，只剩条数：`{"policy":{"denyCount":12}}`
    const picked = policy.pickApprovalPolicy({
      approvals: { mode: 'manual', timeout: 300 },
      agent: { disabled_toolsets: ['code_execution'] },
      terminal: { backend: 'local' },
      policy: { denyCount: 12 },
    })
    expect(picked.denyCount).toBe(12)
    // 0 也要如实取，不能当成"没这个字段"退回别的来源
    expect(policy.pickApprovalPolicy({ policy: { denyCount: 0 } }).denyCount).toBe(0)
  })

  it('prefers the gateway count when both shapes are present', () => {
    const picked = policy.pickApprovalPolicy({
      approvals: { mode: 'manual', deny: ['a', 'b'] },
      policy: { denyCount: 7 },
    })
    expect(picked.denyCount).toBe(7)
  })

  it('reports an unknown mode as null instead of guessing', () => {
    const picked = policy.pickApprovalPolicy({ approvals: { mode: 'yolo' } })
    expect(picked.mode).toBeNull()
    expect(picked.timeoutSeconds).toBeNull()
    expect(picked.denyCount).toBe(0)
    expect(picked.disabledToolsets).toEqual([])
    expect(picked.terminalBackend).toBe('')
  })
})

describe('readApprovalPolicy', () => {
  it('reads the mode through the gateway with the device token', async () => {
    const result = await policy.readApprovalPolicy()
    expect(result.mode).toBe('manual')
    expect(result.denyCount).toBe(2)
    expect(state.gets).toBe(1)
    expect(state.headers[0]?.Authorization).toBe('Bearer pi_dev')
  })

  it('ignores fields outside the whitelist', () => {
    const picked = policy.pickApprovalPolicy({
      approvals: { mode: 'smart', timeout: '120' },
      agent: { disabled_toolsets: 'code_execution' },
    })
    // 类型不对就报 null / 空数组，不做隐式转换
    expect(picked.mode).toBe('smart')
    expect(picked.timeoutSeconds).toBeNull()
    expect(picked.disabledToolsets).toEqual([])
  })
})

describe('writeApprovalMode', () => {
  it('sends a minimal patch and verifies by reading back', async () => {
    const result = await policy.writeApprovalMode('off')
    expect(state.puts).toHaveLength(1)
    expect(JSON.parse(state.puts[0])).toEqual({ config: { approvals: { mode: 'off' } } })
    // 绝不把 GET 结果回写：patch 里只有一个键
    expect(Object.keys(JSON.parse(state.puts[0]).config)).toEqual(['approvals'])
    expect(result.mode).toBe('off')
    expect(result.timeoutSeconds).toBe(120)
  })

  it('throws when the server keeps the old mode', async () => {
    state.ignoreWrites = true
    await expect(policy.writeApprovalMode('off')).rejects.toThrow(/没有生效/)
  })

  it('refuses a mode Hermes does not have, without touching the network', async () => {
    await expect(
      policy.writeApprovalMode('readonly' as unknown as 'manual')
    ).rejects.toThrow(/不支持/)
    expect(state.puts).toHaveLength(0)
  })

  it('only knows the three native tiers', () => {
    expect(policy.APPROVAL_MODES).toEqual(['manual', 'smart', 'off'])
    expect(policy.isApprovalMode('manual')).toBe(true)
    expect(policy.isApprovalMode('always')).toBe(false)
    expect(policy.isApprovalMode(null)).toBe(false)
  })
})
