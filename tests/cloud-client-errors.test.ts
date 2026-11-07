import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}))

vi.mock('electron', () => ({
  net: { fetch: mocks.fetch },
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { CloudApiError, createCloudClient } from '../electron/cloud/client'

function client() {
  return createCloudClient({ baseUrl: 'https://api.example.com', credential: 'k' })
}

describe('云端错误文案', () => {
  it('uses the server error code instead of leaking the 409 generic text', async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            message: 'Run is not currently accepting steer input: run_1',
            code: 'run_not_accepting_steer',
          },
        },
        { status: 409 }
      )
    )
    const error = (await client()
      .request('/v1/runs/run_1/steer', { method: 'POST', body: { input: 'hi' } })
      .catch((reason) => reason)) as CloudApiError
    expect(error).toBeInstanceOf(CloudApiError)
    // 409 的通用文案是「幂等键冲突」，套在插话上是错的
    expect(error.message).toContain('不再接受插话')
    expect(error.message).not.toContain('幂等键')
    expect(error.code).toBe('conflict')
  })


  it('translates gateway codes instead of showing the Python/errno sentence', async () => {
    // 网关在线、上游 Hermes 挂了：插件回 502 + upstream_unavailable
    mocks.fetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: 'upstream_unavailable',
            message: 'api_server is not reachable: [Errno 111] Connection refused',
          },
        },
        { status: 502 }
      )
    )
    const error = (await client()
      .request('/v1/capabilities')
      .catch((reason) => reason)) as CloudApiError
    expect(error.message).toBe('网关在线，但云端的 Hermes 没有响应')
    // 英文原句 / errno 不许漏到界面上
    expect(error.message).not.toContain('Errno')
    expect(error.message).not.toContain('api_server')
    expect(error.backendCode).toBe('upstream_unavailable')
  })

  it('maps Chromium net errors to plain words but keeps the code', async () => {
    const { networkFailureText } = await import('../electron/cloud/client')
    expect(networkFailureText(new Error('net:ERR_CONNECTION_CLOSED'))).toBe(
      '连接被关闭（ERR_CONNECTION_CLOSED）'
    )
    expect(networkFailureText(new Error('net:ERR_NAME_NOT_RESOLVED'))).toContain('域名解析失败')
    // 认不出来的码原样返回，别丢掉排查线索
    expect(networkFailureText(new Error('net:ERR_SOMETHING_NEW'))).toBe('net:ERR_SOMETHING_NEW')
  })

  it('still explains unknown codes with the status and the original text', async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ error: { message: 'weird failure', code: 'made_up' } }, { status: 400 })
    )
    const error = (await client()
      .request('/v1/whatever')
      .catch((reason) => reason)) as CloudApiError
    expect(error.message).toContain('weird failure')
    expect(error.message).toContain('400')
  })
})
