/**
 * F-13 / A-16：轮换前的配置探测（`probeProviderConfig`）。
 *
 * 起因：`AgentManager.initialize()` 只校验「模型 id 在本地 models.json 里」，而那份文件正是
 * 按 apiConfig 生成的——所以任何 Key 都能初始化成功，推错 Key 也会报「配置已生效」。
 * 探测必须把这类配置挡在“拆旧运行时”之前，同时不能因为供应商不提供 `/models` 就拒绝一切。
 */

// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { probeProviderConfig } from '../apps/cloud/src/agent/provider-models'

let provider: Server
let base = ''
let replyStatus = 200
let replyBody: unknown = { data: [{ id: 'model-a' }, { id: 'model-b' }] }
let lastAuthHeader = ''

beforeAll(async () => {
  provider = createServer((req, res) => {
    lastAuthHeader = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '')
    res.writeHead(replyStatus, { 'content-type': 'application/json' })
    res.end(typeof replyBody === 'string' ? replyBody : JSON.stringify(replyBody))
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', () => resolve()))
  const address = provider.address() as { port: number }
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => provider.close(() => resolve()))
})

function probe(model: string, apiKey = 'sk-test-1234') {
  return probeProviderConfig({ provider: 'custom', apiUrl: base, apiKey, model }, 2_000)
}

describe('配置探测', () => {
  it('Key 能用、模型在清单里 → 通过', async () => {
    replyStatus = 200
    replyBody = { data: [{ id: 'model-a' }, { id: 'model-b' }] }
    await expect(probe('model-a')).resolves.toEqual({ ok: true })
    expect(lastAuthHeader).toBe('Bearer sk-test-1234')
  })

  it('Key 无效（401）→ 不通过，并说清原因', async () => {
    replyStatus = 401
    replyBody = { error: { message: 'Incorrect API key' } }
    const result = await probe('model-a')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('401')
  })

  it('模型不在清单里（拼错 id）→ 不通过，并给出可选模型', async () => {
    replyStatus = 200
    replyBody = { data: [{ id: 'model-a' }, { id: 'model-b' }] }
    const result = await probe('model-typo')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('model-typo')
      expect(result.reason).toContain('model-a')
    }
  })

  it('连不上供应商 → 不通过（不出词“回退”，由调用方保留旧配置）', async () => {
    const result = await probeProviderConfig(
      { provider: 'custom', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' },
      2_000
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('Cannot reach')
  })

  it('供应商不提供 /models（404）→ 放行但带警告', async () => {
    replyStatus = 404
    replyBody = 'not found'
    const result = await probe('model-a')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warning).toContain('404')
  })

  it('空清单不下“模型不存在”的结论（有些网关只回空数组）', async () => {
    replyStatus = 200
    replyBody = { data: [] }
    await expect(probe('whatever-model')).resolves.toEqual({ ok: true })
  })
})
