/**
 * D24：保存云端配置前的轻量 Key 探测。
 *
 * 探测只判断「这把 Key 被不被供应商接受」：401/403 拒绝；供应商不提供 `/models`
 * 或网络异常都按可用处理（云端不该因为供应商抖动拒绝一份有效 Key）。
 * 模型是否存在由 catalog 校验，与探测无关。
 */

// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogModelList, isCatalogModel, probeProviderKey } from '../apps/cloud/src/agent/provider-models'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', vi.fn(impl))
}

describe('catalog 校验', () => {
  it('只认白名单内的 provider 与 catalog 内的模型', () => {
    expect(isCatalogModel('deepseek', 'deepseek-flash')).toBe(true)
    expect(isCatalogModel('deepseek', 'no-such-model')).toBe(false)
    expect(isCatalogModel('custom', 'x')).toBe(false)
  })

  it('模型清单带能力字段，供配置页展示', () => {
    const models = catalogModelList('deepseek')
    expect(models.map((model) => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(models[0]).toMatchObject({ contextWindow: expect.any(Number), reasoning: expect.any(Boolean) })
  })

  it('白名单外的 provider 没有模型', () => {
    expect(catalogModelList('custom')).toEqual([])
  })
})

describe('Key 探测', () => {
  it('Key 被接受（200）→ 通过，并带上 catalog 的鉴权头', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    stubFetch((url, init) => {
      calls.push({ url, init })
      return new Response('{}', { status: 200 })
    })

    await expect(probeProviderKey({ providerId: 'deepseek', apiKey: 'sk-test' })).resolves.toEqual({
      ok: true,
    })
    expect(calls[0].url.endsWith('/models')).toBe(true)
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
  })

  it('Google 使用 x-goog-api-key，Anthropic 请求 /v1/models + x-api-key', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    stubFetch((url, init) => {
      calls.push({ url, init })
      return new Response('{}', { status: 200 })
    })

    await expect(probeProviderKey({ providerId: 'google', apiKey: 'AIza-test' })).resolves.toEqual({
      ok: true,
    })
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(calls[0].init?.headers).toEqual({ 'x-goog-api-key': 'AIza-test' })

    await expect(probeProviderKey({ providerId: 'anthropic', apiKey: 'sk-ant-test' })).resolves.toEqual({
      ok: true,
    })
    expect(calls[1].url).toBe('https://api.anthropic.com/v1/models')
    expect(calls[1].init?.headers).toEqual({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    })
  })

  it('Key 无效（401）→ 不通过，并说清原因', async () => {
    stubFetch(() => new Response('{}', { status: 401 }))
    const result = await probeProviderKey({ providerId: 'deepseek', apiKey: 'sk-bad' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('401')
  })

  it('供应商不提供 /models（404）→ 放行但带警告', async () => {
    stubFetch(() => new Response('not found', { status: 404 }))
    const result = await probeProviderKey({ providerId: 'deepseek', apiKey: 'sk-test' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warning).toContain('404')
  })

  it('400 等非 2xx 错误 → 透出供应商返回的 error.message 且脱敏原始 Key', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: 'User location is not supported for the API use. key=AIza-secret-123',
            },
          }),
          { status: 400 }
        )
    )
    const result = await probeProviderKey({ providerId: 'google', apiKey: 'AIza-secret-123' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('HTTP 400')
      expect(result.reason).toContain('User location is not supported')
      expect(result.reason).not.toContain('AIza-secret-123')
    }
  })

  it('连不上供应商 → 放行但带警告（不因抖动拒绝有效 Key）', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED')
    })
    const result = await probeProviderKey({ providerId: 'deepseek', apiKey: 'sk-test' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warning).toContain('ECONNREFUSED')
  })
})
