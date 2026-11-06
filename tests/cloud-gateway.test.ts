/**
 * 网关管理面（`electron/cloud/gateway.ts`）单测。
 *
 * 这里守的是三件事：
 * 1. 业务请求只带设备 token（`Bearer`），管理密钥不进入桌面端；
 * 2. 一次性明文 token 原样回给调用方（只有主进程会看见），前缀用于对账；
 * 3. 网关自己的错误码要翻成人话，不能把 `device_revoked` 这种原样丢给用户。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('electron', () => ({
  net: { fetch: mocks.fetch },
  // client.ts 会经 config.ts 摸到 app-paths，给最小可用替身
  app: {
    isPackaged: false,
    getVersion: () => '0.0.0-test',
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf-8'),
  },
}))

type Gateway = typeof import('../electron/cloud/gateway')

let gateway: Gateway

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

beforeEach(async () => {
  mocks.fetch.mockReset()
  gateway = await import('../electron/cloud/gateway')
})

describe('gatewayWhoAmI', () => {
  it('uses the device token as a bearer credential', async () => {
    mocks.fetch.mockResolvedValueOnce(
      json({ deviceId: 'dev_1', name: 'TChen-Legion', scopes: ['chat'], hub: '0.1.0' })
    )
    const me = await gateway.gatewayWhoAmI('https://hub.example.com', 'pi_abc')
    expect(me.deviceId).toBe('dev_1')
    const [url, init] = mocks.fetch.mock.calls[0]
    expect(url).toBe('https://hub.example.com/v1/devices/me')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer pi_abc' })
  })
})

describe('revokeDevice', () => {
  it('uses the device token as a bearer credential and encodes the id', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ success: true }))
    await gateway.revokeDevice({
      gatewayUrl: 'https://hub.example.com',
      deviceId: 'dev 1',
      deviceToken: 'pi_abc',
    })
    const [url, init] = mocks.fetch.mock.calls[0]
    // id 必须编码：不然后缀被当成另一条路径
    expect(url).toBe('https://hub.example.com/v1/devices/dev%201/revoke')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer pi_abc')
    expect(headers['X-Pi-Admin-Key']).toBeUndefined()
  })

  it('refuses to call the server without a device credential', async () => {
    await expect(
      gateway.revokeDevice({
        gatewayUrl: 'https://hub.example.com',
        deviceId: 'dev_1',
        deviceToken: '',
      })
    ).rejects.toThrow(/设备凭据/)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})

describe('error mapping', () => {
  it('turns a revoked device into actionable text, not a code', async () => {
    mocks.fetch.mockResolvedValueOnce(
      json({ error: { code: 'device_revoked', message: 'revoked' } }, 401)
    )
    await expect(gateway.gatewayWhoAmI('https://hub.example.com', 'pi_abc')).rejects.toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('注销'),
    })
  })

  it('maps rate limiting separately so the UI can say "slow down"', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ error: { code: 'rate_limited' } }, 429))
    await expect(gateway.gatewayHealth('https://hub.example.com')).rejects.toMatchObject({
      code: 'rate_limited',
    })
  })

  it('reports a bad gateway url without touching the network', async () => {
    await expect(gateway.gatewayHealth('hub.example.com')).rejects.toThrow(/http/)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('keeps the upstream version when the cloud agent is down', async () => {
    mocks.fetch.mockResolvedValueOnce(
      json({ status: 'ok', hub: '0.1.0', upstream: 'http://127.0.0.1:8642', upstreamOk: false })
    )
    const health = await gateway.gatewayHealth('https://hub.example.com')
    // upstreamOk=false 是正常响应（网关活着、上游挂了），不能当成错误
    expect(health.upstreamOk).toBe(false)
    expect(health.upstreamVersion).toBeUndefined()
  })
})
