/**
 * 配对接口（`POST /v1/devices/pair`）的客户端契约。
 *
 * 这里守三件事：
 * 1. 配对请求不带管理凭据，连接码本身就是这一次的授权；
 * 2. 连接码在发出去之前已经规范化（大写、去空格/连字符）；
 * 3. 服务端错误码要保留下来，旧网关的 404 要区分成「没有配对接口」。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('electron', () => ({
  net: { fetch: mocks.fetch },
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

const pair = (code = 'ABCDE-FGHIJ') =>
  gateway.pairDevice({
    gatewayUrl: 'https://hub.example.com',
    code,
    deviceId: 'dev-1',
    name: 'TChen-Legion',
  })

beforeEach(async () => {
  mocks.fetch.mockReset()
  gateway = await import('../electron/cloud/gateway')
})

describe('pairDevice', () => {
  it('posts the normalized code with no admin or bearer credential', async () => {
    mocks.fetch.mockResolvedValueOnce(
      json({
        deviceId: 'dev-1',
        name: 'TChen-Legion',
        scopes: ['chat', 'dispatch'],
        token: 'pi_secret',
        tokenPrefix: 'pi_secret_ab',
        dashboardUrl: 'https://dash.example.com',
      })
    )
    const result = await pair('abcde-fgh ij')
    expect(result.token).toBe('pi_secret')
    expect(result.dashboardUrl).toBe('https://dash.example.com')

    const [url, init] = mocks.fetch.mock.calls[0]
    expect(url).toBe('https://hub.example.com/v1/devices/pair')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['X-Pi-Admin-Key']).toBeUndefined()
    expect(headers.Authorization).toBeUndefined()
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      code: 'ABCDEFGHIJ',
      deviceId: 'dev-1',
      name: 'TChen-Legion',
    })
  })

  it('rejects a 2xx response without a token instead of writing an empty credential', async () => {
    mocks.fetch.mockResolvedValueOnce(
      json({ deviceId: 'dev-1', name: 'TChen-Legion', scopes: ['chat'], tokenPrefix: 'pi_ab' })
    )
    await expect(pair()).rejects.toMatchObject({
      message: '网关返回的配对结果缺少设备凭据',
      code: 'bad_response',
    })
  })

  it('keeps the server error code and translates it', async () => {
    mocks.fetch.mockResolvedValueOnce(
      json({ error: { code: 'pairing_not_found', message: 'not found' } }, 404)
    )
    await expect(pair()).rejects.toMatchObject({
      backendCode: 'pairing_not_found',
      message: expect.stringContaining('连接码'),
    })
  })

  it.each([
    ['pairing_expired', 410],
    ['pairing_used', 409],
    ['rate_limited', 429],
    ['pairing_disabled', 503],
  ])('maps %s', async (code, status) => {
    mocks.fetch.mockResolvedValueOnce(json({ error: { code, message: code } }, status))
    await expect(pair()).rejects.toMatchObject({ backendCode: code })
  })

  it('reports an old plugin when a 404 has no error code', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('', { status: 404 }))
    await expect(pair()).rejects.toMatchObject({
      status: 404,
      backendCode: 'pairing_unsupported',
    })
  })

  it('refuses an empty code without calling the gateway', async () => {
    await expect(pair(' - ')).rejects.toThrow(/连接码/)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('refuses an invalid gateway url without calling the gateway', async () => {
    await expect(
      gateway.pairDevice({
        gatewayUrl: 'not a url',
        code: 'ABCDE-FGHIJ',
        deviceId: 'dev-1',
        name: 'TChen-Legion',
      })
    ).rejects.toThrow(/网关地址/)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
