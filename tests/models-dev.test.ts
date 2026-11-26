/**
 * P-07（models.dev 独立富数据解析与缓存）+ P-05（Google/xAI 400 探测与 clampMaxTokensToContext 边界）。
 */

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import {
  extractModelsDevSnapshot,
  isInvalidKeyProbeResponse,
  lookupModelsDevEnrichment,
  parseModelsDevCacheSnapshot,
  resolveLimits,
} from 'pi-bridge'

let appDir = ''

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => appDir,
    getPath: () => appDir,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (buf: Buffer) => buf.toString('utf-8'),
  },
}))

const {
  MODELS_DEV_TTL_MS,
  getModelsDevSnapshot,
  modelsDevCacheFilePath,
  refreshModelsDevSnapshot,
  resetModelsDevStore,
} = await import('../electron/models-dev-store')
const { probeApiKey, resetCatalogRuntime } = await import('../electron/providers-service')

beforeEach(async () => {
  appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-models-dev-'))
  await fs.mkdir(path.join(appDir, 'cache'), { recursive: true })
  await fs.mkdir(path.join(appDir, 'data', 'agent'), { recursive: true })
  resetModelsDevStore()
  resetCatalogRuntime()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  resetModelsDevStore()
  resetCatalogRuntime()
  await fs.rm(appDir, { recursive: true, force: true }).catch(() => undefined)
})

describe('P-07：models.dev 富数据解析与映射', () => {
  it('只提取 6 家上游供应商的精简字段，并映射 8 家预设（含 xiaomi-token-plan-cn 与 openai-codex）', () => {
    const raw = {
      openai: {
        models: {
          'gpt-5': {
            description: 'Flagship OpenAI model',
            cost: { input: 2.5, output: 10, cache_read: 0.25 },
            modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
            knowledge: '2026-01',
            release_date: '2026-02-01',
            open_weights: false,
          },
        },
      },
      xiaomi: {
        models: {
          'mimo-v2.6-pro': {
            description: 'MiMo Pro',
            cost: { input: 0.4, output: 1.2 },
            open_weights: true,
          },
        },
      },
      anthropic: {
        models: {
          'claude-old': {
            status: 'deprecated',
            cost: { input: 5, output: 25 },
          },
        },
      },
      unrelated_provider: {
        models: {
          'should-ignore': { description: 'ignored' },
        },
      },
    }

    const snap = extractModelsDevSnapshot(raw, 1_700_000_000_000, 'W/"v1"')
    expect(Object.keys(snap.providers).sort()).toEqual(['anthropic', 'openai', 'xiaomi'])
    expect(snap.etag).toBe('W/"v1"')

    expect(lookupModelsDevEnrichment(snap, 'openai', 'gpt-5')).toEqual({
      description: 'Flagship OpenAI model',
      cost: { input: 2.5, output: 10, cacheRead: 0.25 },
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      knowledge: '2026-01',
      releaseDate: '2026-02-01',
      openWeights: false,
    })
    // openai-codex 复用 openai 命名空间，xiaomi-token-plan-cn 复用 xiaomi 命名空间
    expect(lookupModelsDevEnrichment(snap, 'openai-codex', 'gpt-5')?.cost?.input).toBe(2.5)
    expect(
      lookupModelsDevEnrichment(snap, 'xiaomi-token-plan-cn', 'mimo-v2.6-pro')?.openWeights
    ).toBe(true)
    expect(lookupModelsDevEnrichment(snap, 'anthropic', 'claude-old')?.status).toBe('deprecated')
    expect(lookupModelsDevEnrichment(snap, 'deepseek', 'unknown')).toBeUndefined()
  })

  it('缓存校验在版本不符或损坏时返回 null', () => {
    expect(parseModelsDevCacheSnapshot(null)).toBeNull()
    expect(parseModelsDevCacheSnapshot({ version: 99, fetchedAt: 1, providers: {} })).toBeNull()
    expect(parseModelsDevCacheSnapshot({ version: 1, fetchedAt: 0, providers: {} })).toBeNull()
  })
})

describe('P-07：models.dev 独立缓存（cache/models-dev.json）', () => {
  it('成功拉取落盘、TTL 内免重拉、ETag 304 更新时间戳、失败静默保留旧缓存', async () => {
    let now = 1_700_000_000_000
    const calls: Array<{ url: string; etag: string | null }> = []
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(url), etag: headers.get('if-none-match') })
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            deepseek: {
              models: {
                'deepseek-v4-pro': {
                  cost: { input: 0.66, output: 1.98, cache_read: 0.022 },
                  open_weights: true,
                },
              },
            },
          }),
          { status: 200, headers: { etag: '"etag-1"' } }
        )
      }
      if (calls.length === 2) {
        return new Response(null, { status: 304 })
      }
      throw new Error('network down')
    })

    // allowNetwork=false 时不发请求
    expect(await refreshModelsDevSnapshot({ allowNetwork: false, fetchImpl: fetchMock as typeof fetch })).toBeNull()
    expect(calls).toHaveLength(0)

    // 首次拉取并落盘到独立缓存文件
    const first = await refreshModelsDevSnapshot({
      allowNetwork: true,
      now: () => now,
      fetchImpl: fetchMock as typeof fetch,
    })
    expect(first?.providers.deepseek?.['deepseek-v4-pro']?.cost?.input).toBe(0.66)
    const diskRaw = await fs.readFile(modelsDevCacheFilePath(), 'utf-8')
    expect(JSON.parse(diskRaw).etag).toBe('"etag-1"')

    // TTL 内非强制刷新直接命中缓存，不再请求网络
    now += 60_000
    await refreshModelsDevSnapshot({
      allowNetwork: true,
      now: () => now,
      fetchImpl: fetchMock as typeof fetch,
    })
    expect(calls).toHaveLength(1)

    // 过期后携带 If-None-Match 收到 304，保留内容并续期 fetchedAt
    now += MODELS_DEV_TTL_MS + 1_000
    const second = await refreshModelsDevSnapshot({
      allowNetwork: true,
      now: () => now,
      fetchImpl: fetchMock as typeof fetch,
    })
    expect(calls).toHaveLength(2)
    expect(calls[1].etag).toBe('"etag-1"')
    expect(second?.fetchedAt).toBe(now)
    expect(second?.providers.deepseek?.['deepseek-v4-pro']?.openWeights).toBe(true)

    // 强制刷新遇网络错误：静默降级保留旧快照，不抛错
    const third = await refreshModelsDevSnapshot({
      force: true,
      allowNetwork: true,
      now: () => now + 5000,
      fetchImpl: fetchMock as typeof fetch,
    })
    expect(third?.providers.deepseek?.['deepseek-v4-pro']?.cost?.output).toBe(1.98)

    // 重置内存态后可从磁盘恢复
    resetModelsDevStore()
    const reloaded = await getModelsDevSnapshot()
    expect(reloaded?.providers.deepseek?.['deepseek-v4-pro']?.cost?.cacheRead).toBe(0.022)
  })
})

describe('P-05：SDK 行为实测与探测边界', () => {
  it('Google / xAI 的无效 Key 返回 HTTP 400 时被识别为 INVALID_KEY，Google 地区限制 400 不误判', async () => {
    expect(
      isInvalidKeyProbeResponse('google', 400, '{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid."}}')
    ).toBe(true)
    expect(
      isInvalidKeyProbeResponse('google', 400, '{"error":{"message":"User location is not supported for the API use."}}')
    ).toBe(false)
    expect(
      isInvalidKeyProbeResponse('xai', 400, '{"code":"invalid-argument","error":"Incorrect API key provided."}')
    ).toBe(true)
    expect(isInvalidKeyProbeResponse('deepseek', 401, '')).toBe(true)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } }),
          { status: 400 }
        )
      )
    )
    const googleBad = await probeApiKey('google', 'AIza-bad')
    expect(googleBad).toEqual({ ok: false, error: 'INVALID_KEY' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ code: 'invalid-argument', error: 'Incorrect API key provided.' }),
          { status: 400 }
        )
      )
    )
    const xaiBad = await probeApiKey('xai', 'xai-bad')
    expect(xaiBad).toEqual({ ok: false, error: 'INVALID_KEY' })
  })

  it('resolveLimits 下调后与 SDK clampMaxTokensToContext 边界一致（4096 安全缓冲，保底 1）', () => {
    const catalog = { contextWindow: 200_000, maxTokens: 64_000 }
    const effective = resolveLimits(catalog, { contextWindow: 16_384, maxTokens: 8_192 })
    expect(effective).toEqual({ contextWindow: 16_384, maxTokens: 8_192 })

    const fakeModel = {
      id: 'test-model',
      name: 'Test',
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: effective.contextWindow,
      maxTokens: effective.maxTokens,
    } as never

    // 空上下文：剩余 16384 - 4096 = 12288 > 8192 → 保持用户下调的 8192
    const emptyCtx = { messages: [] } as never
    expect(clampMaxTokensToContext(fakeModel, emptyCtx, effective.maxTokens)).toBe(8_192)

    // 大上下文逼近窗口时，SDK 自动夹取到安全余量并保底 1
    const hugeText = 'a'.repeat(16_384 * 4)
    const fullCtx = {
      messages: [{ role: 'user', content: hugeText, timestamp: Date.now() }],
    } as never
    expect(clampMaxTokensToContext(fakeModel, fullCtx, effective.maxTokens)).toBe(1)
  })
})
