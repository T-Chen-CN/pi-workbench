/**
 * 网关管理面（`electron/cloud/gateway.ts`）单测。
 *
 * 这里守的是三件事：
 * 1. 登记用的凭据是 `X-Pi-Admin-Key`，业务请求用的是 `Bearer`——拿错就是安全事件；
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

describe('registerDevice', () => {
  it('sends the admin key header and pins the local device id', async () => {
    mocks.fetch.mockResolvedValueOnce(
      json({
        deviceId: 'b8235e0e',
        name: 'TChen-Legion',
        scopes: ['chat', 'dispatch'],
        token: 'pi_secret',
        tokenPrefix: 'pi_secret_ab',
      })
    )
    const result = await gateway.registerDevice({
      gatewayUrl: 'https://hub.example.com',
      adminKey: 'admin-key',
      deviceId: 'b8235e0e',
      name: 'TChen-Legion',
    })
    expect(result.token).toBe('pi_secret')

    const [url, init] = mocks.fetch.mock.calls[0]
    expect(url).toBe('https://hub.example.com/v1/devices/register')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['X-Pi-Admin-Key']).toBe('admin-key')
    // 管理密钥绝不能同时当成业务凭据混进去
    expect(headers.Authorization).toBeUndefined()
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      deviceId: 'b8235e0e',
      name: 'TChen-Legion',
      scopes: ['chat', 'dispatch'],
    })
  })
})

describe('revokeDevice', () => {
  it('prefers the admin key and falls back to the device token', async () => {
    // Response 的 body 只能读一次，每次调用都要给新的实例
    mocks.fetch.mockImplementation(async () => json({ success: true }))
    await gateway.revokeDevice({
      gatewayUrl: 'https://hub.example.com',
      deviceId: 'dev 1',
      adminKey: 'admin-key',
    })
    const [url, init] = mocks.fetch.mock.calls[0]
    // id 必须编码：不然后缀被当成另一条路径
    expect(url).toBe('https://hub.example.com/v1/devices/dev%201/revoke')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['X-Pi-Admin-Key']).toBe('admin-key')
    expect(headers.Authorization).toBeUndefined()

    mocks.fetch.mockClear()
    await gateway.revokeDevice({
      gatewayUrl: 'https://hub.example.com',
      deviceId: 'dev_1',
      deviceToken: 'pi_abc',
    })
    const second = mocks.fetch.mock.calls[0][1] as RequestInit
    expect((second.headers as Record<string, string>).Authorization).toBe('Bearer pi_abc')
  })

  it('refuses to call the server with no credential at all', async () => {
    await expect(
      gateway.revokeDevice({ gatewayUrl: 'https://hub.example.com', deviceId: 'dev_1' })
    ).rejects.toThrow(/管理密钥/)
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
