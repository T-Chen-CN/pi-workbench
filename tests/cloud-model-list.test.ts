/**
 * F-10 辅助：云端拉模型清单（`POST /v1/cloud-config/models`）。
 *
 * 覆盖：鉴权、三种返回形状兼容、`anthropic` 的鉴权头、用已保存的 Key 免重填、
 * 坏 URL 与供应商错误不回显 Key。供应商用本地 http 服务替身，不打外网。
 */

// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createCloudServer, type CloudServer } from '../apps/cloud/src/main'

let tmpRoot: string
let cloud: CloudServer
let base: string
let cookie = ''
let provider: Server
let providerBase = ''
let lastAuthHeader = ''
let lastRequestPath = ''
let replyBody: unknown = { data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }] }
let replyStatus = 200

async function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, payload: (await response.json().catch(() => null)) as any }
}

beforeAll(async () => {
  provider = createServer((req, res) => {
    lastAuthHeader = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '')
    lastRequestPath = String(req.url ?? '')
    res.writeHead(replyStatus, { 'content-type': 'application/json' })
    res.end(JSON.stringify(replyBody))
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address()
  const port = typeof address === 'object' && address ? address.port : 0
  providerBase = `http://127.0.0.1:${port}/v1`

  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-models-'))
  cloud = await createCloudServer({
    dataDir: tmpRoot,
    workspaceDir: path.join(tmpRoot, 'workspace'),
    agentDir: path.join(tmpRoot, 'agent'),
    port: 0,
    encryptionKey: Buffer.alloc(32, 5),
    cookieSecret: 'models-cookie-secret',
    secureCookies: false,
    version: 'test',
  })
  const cloudPort = await cloud.listen()
  base = `http://127.0.0.1:${cloudPort}`

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
  cookie = String(login.headers.get('set-cookie') ?? '').split(';')[0]
})

afterAll(async () => {
  await cloud?.close()
  await new Promise<void>((resolve) => provider?.close(() => resolve()))
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('拉模型清单', () => {
  it('未登录一律 401', async () => {
    const result = await post('/v1/cloud-config/models', { provider: 'custom', apiUrl: providerBase, apiKey: 'k' })
    expect(result.status).toBe(401)
  })

  it('兼容 { data: [{ id }] } 形状并对齐 /models 路径', async () => {
    const result = await post(
      '/v1/cloud-config/models',
      { provider: 'custom', apiUrl: providerBase, apiKey: 'sk-test-1' },
      { cookie }
    )
    expect(result.status).toBe(200)
    expect(result.payload.models).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-5'])
    expect(lastRequestPath).toBe('/v1/models')
    expect(lastAuthHeader).toBe('Bearer sk-test-1')
  })

  it('兼容 { models: [...] } 与纯数组、去重', async () => {
    replyBody = { models: ['m-b', 'm-a', 'm-b'] }
    const first = await post(
      '/v1/cloud-config/models',
      { provider: 'custom', apiUrl: providerBase, apiKey: 'k' },
      { cookie }
    )
    expect(first.payload.models).toEqual(['m-a', 'm-b'])

    replyBody = ['only-one']
    const second = await post(
      '/v1/cloud-config/models',
      { provider: 'custom', apiUrl: providerBase, apiKey: 'k' },
      { cookie }
    )
    expect(second.payload.models).toEqual(['only-one'])
    replyBody = { data: [{ id: 'claude-sonnet-4-5' }] }
  })

  it('anthropic 用 x-api-key + anthropic-version，不用 Bearer', async () => {
    await post(
      '/v1/cloud-config/models',
      { provider: 'anthropic', apiUrl: providerBase, apiKey: 'sk-ant-1' },
      { cookie }
    )
    expect(lastAuthHeader).toBe('sk-ant-1')
  })

  it('不传 Key 时用已保存的 Key（先保存再刷新列表）', async () => {
    const saved = await fetch(`${base}/v1/cloud-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        provider: 'custom',
        apiUrl: providerBase,
        model: 'claude-sonnet-4-5',
        apiKey: 'sk-saved-9999',
      }),
    })
    expect(saved.status).toBe(200)

    const result = await post('/v1/cloud-config/models', {}, { cookie })
    expect(result.status).toBe(200)
    expect(lastAuthHeader).toBe('Bearer sk-saved-9999')
    expect(result.payload.apiUrl).toBe(providerBase)
  })

  it('坏 URL 400，且不把 Key 回显到错误里', async () => {
    const bad = await post(
      '/v1/cloud-config/models',
      { provider: 'custom', apiUrl: 'file:///etc/passwd', apiKey: 'sk-secret-1234' },
      { cookie }
    )
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.payload)).not.toContain('sk-secret-1234')
  })

  it('供应商报错回 502，带状态码但不带 Key', async () => {
    replyStatus = 401
    replyBody = { error: 'invalid api key' }
    const result = await post(
      '/v1/cloud-config/models',
      { provider: 'custom', apiUrl: providerBase, apiKey: 'sk-leak-check-4321' },
      { cookie }
    )
    expect(result.status).toBe(502)
    expect(String(result.payload.error)).toContain('401')
    expect(JSON.stringify(result.payload)).not.toContain('sk-leak-check-4321')
    replyStatus = 200
  })

  it('连不上供应商回 502 provider-unreachable', async () => {
    const result = await post(
      '/v1/cloud-config/models',
      { provider: 'custom', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' },
      { cookie }
    )
    expect(result.status).toBe(502)
    expect(result.payload.code).toBe('provider-unreachable')
  })
})
