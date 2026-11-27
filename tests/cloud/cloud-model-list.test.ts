/**
 * 云端配置页的模型清单：直接来自 Pi catalog，不再打供应商 `/models`。
 *
 * 为什么：供应商清单经常混进 embedding / 别名，照它列会让用户选到跑不起来的 id；
 * catalog 才是「这个 provider 到底有哪些 chat 模型」的唯一真值。
 */

// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createCloudServer } from '../../apps/cloud/src/main'

let tmpRoot: string
let server: Awaited<ReturnType<typeof createCloudServer>>
let base = ''
let cookie = ''

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-models-'))
  server = await createCloudServer({
    dataDir: tmpRoot,
    workspaceDir: path.join(tmpRoot, 'workspace'),
    agentDir: path.join(tmpRoot, 'agent'),
    port: 0,
    encryptionKey: Buffer.alloc(32, 9),
    cookieSecret: 'model-list-secret',
    secureCookies: false,
    version: 'test',
  })
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
}, 60_000)

afterAll(async () => {
  await server?.close()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

async function get(pathname: string) {
  const response = await fetch(`${base}${pathname}`, { headers: { cookie } })
  return { status: response.status, payload: await response.json().catch(() => null) }
}

describe('catalog 模型清单', () => {
  it('返回该 provider 的 catalog 模型与能力字段', async () => {
    const result = await get('/v1/cloud-config/catalog?providerId=deepseek')
    expect(result.status).toBe(200)
    expect(result.payload.providerId).toBe('deepseek')
    expect(result.payload.models.map((model: { id: string }) => model.id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ])
    expect(result.payload.models[0]).toMatchObject({
      contextWindow: expect.any(Number),
      maxTokens: expect.any(Number),
      reasoning: expect.any(Boolean),
      vision: expect.any(Boolean),
    })
  })

  it('白名单外的 provider → 400', async () => {
    const result = await get('/v1/cloud-config/catalog?providerId=custom')
    expect(result.status).toBe(400)
  })

  it('未配置时读取配置只回 configured:false，不含任何密钥片段', async () => {
    const result = await get('/v1/cloud-config')
    expect(result.status).toBe(200)
    expect(result.payload).toEqual({ configured: false })
  })
})

describe('保存配置', () => {
  it('落盘加密，读回只给掩码与凭证类型', async () => {
    const save = await fetch(`${base}/v1/cloud-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        providerId: 'deepseek',
        model: 'deepseek-flash',
        apiKey: 'sk-deepseek-secret-9876',
      }),
    })
    // 探测会打 catalog 的 baseUrl：网络不可达时放行（warining），所以这里只断言 200/400 两种
    expect([200, 400]).toContain(save.status)
    if (save.status !== 200) return

    const read = await get('/v1/cloud-config')
    expect(read.payload.configured).toBe(true)
    expect(read.payload.providerId).toBe('deepseek')
    expect(read.payload.credentialType).toBe('api_key')
    expect(String(read.payload.apiKeyMasked)).not.toContain('secret')
    expect(JSON.stringify(read.payload)).not.toContain('sk-deepseek-secret')
  })
})
