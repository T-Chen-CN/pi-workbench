import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  LEGACY_API_CONFIG_FILE,
  LEGACY_AUTH_FILE,
  createProvidersConfigStore,
  credentialFingerprint,
  emptyProvidersConfig,
  legacyProviderFromUrl,
} from '../pi-bridge/src/providers-config'
import { createFileCredentialStore } from '../pi-bridge/src/credentials-store'
import { normalizeOverrides, resolveLimits } from '../pi-bridge/src/provider-presets'
import {
  computeCompactionThresholds,
  writeCompactionSettings,
} from '../pi-bridge/src/model-config'
import { providerConfigKey } from '../electron/agent-config-key'

const PREFIX = 'enc:'
const cipher = {
  encrypt: (plain: string) => PREFIX + Buffer.from(plain, 'utf-8').toString('base64'),
  decrypt: (stored: string) => Buffer.from(stored.slice(PREFIX.length), 'base64').toString('utf-8'),
}

/** 固定一份模型表，避免用例随 Pi catalog 升级而变 */
const CATALOG: Record<string, Array<{ id: string; contextWindow: number; maxTokens: number }>> = {
  deepseek: [
    { id: 'deepseek-flash', contextWindow: 1_000_000, maxTokens: 384_000 },
    { id: 'deepseek-v4-pro', contextWindow: 256_000, maxTokens: 64_000 },
  ],
  openai: [{ id: 'gpt-test', contextWindow: 400_000, maxTokens: 128_000 }],
  anthropic: [{ id: 'claude-test', contextWindow: 200_000, maxTokens: 64_000 }],
}

describe('供应商配置', () => {
  let appDir: string
  let agentDir: string
  let configPath: string

  beforeEach(async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-providers-'))
    agentDir = path.join(appDir, 'data', 'agent')
    configPath = path.join(appDir, 'config', 'providers.json')
  })

  afterEach(async () => {
    await fs.rm(appDir, { recursive: true, force: true })
  })

  function createStore(overrides: { credentials?: any; decryptSecret?: (v: string) => string } = {}) {
    const logger = { warn: vi.fn() }
    const store = createProvidersConfigStore({
      path: configPath,
      agentDir,
      logger,
      listModels: (providerId) => CATALOG[providerId] ?? [],
      decryptSecret: overrides.decryptSecret ?? cipher.decrypt,
      credentials: overrides.credentials,
    })
    return { store, logger }
  }

  async function writeLegacyApiConfig(value: unknown): Promise<void> {
    await fs.mkdir(path.join(appDir, 'config'), { recursive: true })
    await fs.writeFile(
      path.join(appDir, 'config', 'api-config.json'),
      JSON.stringify(value),
      'utf-8'
    )
  }

  async function writeAuthJson(value: unknown): Promise<void> {
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(path.join(agentDir, 'auth.json'), JSON.stringify(value), 'utf-8')
  }

  it('没有文件时返回空配置', async () => {
    const { store } = createStore()
    expect(await store.read()).toEqual(emptyProvidersConfig())
  })

  it('写入时过滤白名单、归一化 overrides', async () => {
    const { store } = createStore()
    store.write({
      version: 1,
      activeProvider: 'volcengine',
      providers: {
        deepseek: {
          model: 'deepseek-flash',
          overrides: {
            'deepseek-flash': { contextWindow: 500_000, maxTokens: 999_999 },
            ghost: { contextWindow: 1000 },
          },
        },
        volcengine: { model: 'whatever' },
      },
    })

    const saved = JSON.parse(await fs.readFile(configPath, 'utf-8'))
    expect(Object.keys(saved.providers)).toEqual(['deepseek'])
    // 上下文降到 500K 后，输出上限也被夹到同一水位
    expect(saved.providers.deepseek.overrides['deepseek-flash']).toEqual({
      contextWindow: 500_000,
      maxTokens: 384_000,
    })
    expect(saved.providers.deepseek.overrides.ghost).toBeUndefined()
    // active 指向未配置 / 白名单外时清零
    expect(saved.activeProvider).toBeNull()
  })

  it('模型不存在时回落到 catalog 首个并告警', async () => {
    const { store, logger } = createStore()
    store.write({ version: 1, activeProvider: 'deepseek', providers: { deepseek: { model: 'gone' } } })

    const config = await store.read()
    expect(config.providers.deepseek.model).toBe('deepseek-flash')
    expect(config.activeProvider).toBe('deepseek')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('坏 JSON 回落空配置', async () => {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, '{ nope', 'utf-8')
    const { store } = createStore()
    expect(await store.read()).toEqual(emptyProvidersConfig())
  })

  describe('setActive', () => {
    const base = {
      version: 1,
      activeProvider: 'deepseek',
      providers: { deepseek: { model: 'deepseek-flash' }, openai: { model: 'gpt-test' } },
    }

    it('切换供应商与模型', () => {
      const { store } = createStore()
      const result = store.setActive(base, 'openai', 'gpt-test')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.config.activeProvider).toBe('openai')
    })

    it('拒绝白名单外 / 未连接 / 不存在的模型', () => {
      const { store } = createStore()
      expect(store.setActive(base, 'volcengine')).toEqual({ ok: false, code: 'PROVIDER_UNKNOWN' })
      expect(store.setActive(base, 'anthropic')).toEqual({ ok: false, code: 'NOT_CONNECTED' })
      expect(store.setActive(base, 'deepseek', 'nope')).toEqual({ ok: false, code: 'MODEL_UNKNOWN' })
    })
  })

  describe('setOverrides', () => {
    const base = {
      version: 1,
      activeProvider: 'deepseek',
      providers: { deepseek: { model: 'deepseek-flash' } },
    }

    it('夹到 catalog 真值并返回生效值', () => {
      const { store } = createStore()
      const result = store.setOverrides(base, 'deepseek', 'deepseek-flash', {
        contextWindow: 2_000_000,
        maxTokens: 500_000,
      })
      expect('error' in result).toBe(false)
      if ('error' in result) return
      expect(result.effective).toEqual({ contextWindow: 1_000_000, maxTokens: 384_000 })
    })

    it('清空覆盖时移除条目', () => {
      const { store } = createStore()
      const withOverride = store.setOverrides(base, 'deepseek', 'deepseek-flash', {
        contextWindow: 128_000,
      })
      if ('error' in withOverride) throw new Error('unexpected')
      const cleared = store.setOverrides(withOverride.config, 'deepseek', 'deepseek-flash', {})
      if ('error' in cleared) throw new Error('unexpected')
      expect(cleared.config.providers.deepseek.overrides).toBeUndefined()
      expect(cleared.effective).toEqual({ contextWindow: 1_000_000, maxTokens: 384_000 })
    })
  })

  describe('迁移', () => {
    function credentialStore() {
      return createFileCredentialStore({
        path: path.join(appDir, 'config', 'credentials.json'),
        cipher,
      })
    }

    it('deepseek 旧配置：provider / 模型 / key 全部迁过来', async () => {
      await writeLegacyApiConfig({
        provider: 'custom',
        apiUrl: 'https://api.deepseek.com/v1',
        apiKey: PREFIX + Buffer.from('sk-legacy').toString('base64'),
        selectedModel: 'deepseek-flash',
      })
      const credentials = credentialStore()
      const { store } = createStore({ credentials })

      const result = await store.migrateLegacy()
      expect(result).toMatchObject({ migrated: true, providerId: 'deepseek', modelId: 'deepseek-flash' })
      expect(result.importedCredentials).toEqual(['deepseek'])
      expect(result.legacyArchived).toBe(true)

      const config = await store.read()
      expect(config.activeProvider).toBe('deepseek')
      expect(config.providers.deepseek.model).toBe('deepseek-flash')
      expect(await credentials.read('deepseek')).toEqual({ type: 'api_key', key: 'sk-legacy' })

      const dir = await fs.readdir(path.join(appDir, 'config'))
      expect(dir).toContain(LEGACY_API_CONFIG_FILE)
      expect(dir).not.toContain('api-config.json')
    })

    it('认不出的地址不猜：落空配置并要求重新选择', async () => {
      await writeLegacyApiConfig({
        provider: 'custom',
        apiUrl: 'https://my-relay.example.com/v1',
        apiKey: 'enc:x',
        selectedModel: 'anything',
      })
      const { store } = createStore({ credentials: credentialStore() })

      const result = await store.migrateLegacy()
      expect(result).toMatchObject({ migrated: false, reason: 'unmapped-provider', legacyArchived: true })
      expect((await store.read()).providers).toEqual({})
    })

    it('没有旧配置时落空配置，不报错', async () => {
      const { store } = createStore()
      const result = await store.migrateLegacy()
      expect(result).toMatchObject({ migrated: false, reason: 'no-legacy-config' })
      expect(await fs.readFile(configPath, 'utf-8')).toContain('"providers": {}')
    })

    it('幂等：已有 providers.json 时直接跳过', async () => {
      const { store } = createStore()
      store.write({ version: 1, activeProvider: 'deepseek', providers: { deepseek: { model: 'deepseek-flash' } } })
      await writeLegacyApiConfig({ provider: 'custom', apiUrl: 'https://api.deepseek.com' })

      const result = await store.migrateLegacy()
      expect(result).toMatchObject({ migrated: false, reason: 'already-migrated' })
      expect((await store.read()).activeProvider).toBe('deepseek')
    })

    it('旧 auth.json 逐条导入后归档，且不覆盖已有凭证', async () => {
      await writeLegacyApiConfig({
        provider: 'custom',
        apiUrl: 'https://api.deepseek.com',
        apiKey: PREFIX + Buffer.from('sk-legacy').toString('base64'),
      })
      await writeAuthJson({
        openai: { type: 'api_key', key: 'sk-openai' },
        deepseek: { type: 'api_key', key: 'sk-should-lose' },
        volcengine: { type: 'api_key', key: 'sk-unknown' },
      })
      const credentials = credentialStore()
      const { store } = createStore({ credentials })

      const result = await store.migrateLegacy()
      expect(result.importedCredentials.sort()).toEqual(['deepseek', 'openai'])
      expect(await credentials.read('openai')).toEqual({ type: 'api_key', key: 'sk-openai' })
      // 旧 api-config 的 key 已写入，auth.json 不覆盖它
      expect(await credentials.read('deepseek')).toEqual({ type: 'api_key', key: 'sk-legacy' })
      expect(await credentials.read('volcengine')).toBeUndefined()

      const agentFiles = await fs.readdir(agentDir)
      expect(agentFiles).toContain(LEGACY_AUTH_FILE)
      expect(agentFiles).not.toContain('auth.json')
    })
  })

  describe('工具函数', () => {
    it('legacyProviderFromUrl 只认三家', () => {
      expect(legacyProviderFromUrl('https://api.deepseek.com/v1')).toBe('deepseek')
      expect(legacyProviderFromUrl('https://api.anthropic.com')).toBe('anthropic')
      expect(legacyProviderFromUrl('https://api.openai.com/v1')).toBe('openai')
      expect(legacyProviderFromUrl('https://relay.example.com')).toBeUndefined()
      expect(legacyProviderFromUrl(undefined)).toBeUndefined()
    })

    it('credentialFingerprint 对 OAuth 稳定、对 api_key 敏感', () => {
      expect(credentialFingerprint(undefined)).toBe('none')
      expect(credentialFingerprint({ type: 'oauth' })).toBe('oauth')
      expect(credentialFingerprint({ type: 'oauth' })).toBe(credentialFingerprint({ type: 'oauth' }))
      const a = credentialFingerprint({ type: 'api_key', key: 'sk-1' })
      const b = credentialFingerprint({ type: 'api_key', key: 'sk-2' })
      expect(a).toMatch(/^api_key:[0-9a-f]{12}$/)
      expect(a).not.toBe(b)
      expect(a).toBe(credentialFingerprint({ type: 'api_key', key: 'sk-1' }))
    })

    it('normalizeOverrides / resolveLimits 互相自洽', () => {
      const catalog = { contextWindow: 200_000, maxTokens: 64_000 }
      expect(normalizeOverrides(catalog, { contextWindow: 100_000, maxTokens: 200_000 })).toEqual({
        contextWindow: 100_000,
        maxTokens: 64_000,
      })
      expect(resolveLimits(catalog, undefined)).toEqual(catalog)
      expect(resolveLimits(catalog, { contextWindow: 32_000, maxTokens: 64_000 })).toEqual({
        contextWindow: 32_000,
        maxTokens: 32_000,
      })
    })

    it('providerConfigKey 只对身份变化敏感', () => {
      const base = {
        providerId: 'deepseek',
        modelId: 'deepseek-flash',
        credentialFingerprint: 'api_key:aaaaaaaaaaaa',
      }
      expect(providerConfigKey(base)).toBe(providerConfigKey({ ...base }))
      expect(providerConfigKey(base)).not.toBe(
        providerConfigKey({ ...base, modelId: 'deepseek-v4-pro' })
      )
      expect(providerConfigKey(base)).not.toBe(
        providerConfigKey({ ...base, credentialFingerprint: 'api_key:bbbbbbbbbbbb' })
      )
      // 覆盖项字段顺序无关
      expect(
        providerConfigKey({ ...base, overrides: { contextWindow: 1, maxTokens: 2 } })
      ).toBe(providerConfigKey({ ...base, overrides: { maxTokens: 2, contextWindow: 1 } }))
      // 改非默认模型的上下文上限也要改变签名，确保老会话会重建并刷新 models.json
      expect(
        providerConfigKey({
          ...base,
          overridesByModel: { 'deepseek-v4-pro': { contextWindow: 65_536 } },
        })
      ).not.toBe(providerConfigKey(base))
      expect(
        providerConfigKey({
          ...base,
          overridesByModel: {
            'deepseek-v4-pro': { contextWindow: 65_536 },
            'deepseek-flash': { maxTokens: 8_192 },
          },
        })
      ).toBe(
        providerConfigKey({
          ...base,
          overridesByModel: {
            'deepseek-flash': { maxTokens: 8_192 },
            'deepseek-v4-pro': { contextWindow: 65_536 },
          },
        })
      )
      // OAuth 刷新不改指纹 → 不触发重建
      expect(providerConfigKey({ ...base, credentialFingerprint: 'oauth' })).toBe(
        providerConfigKey({ ...base, credentialFingerprint: 'oauth' })
      )
    })

    it('computeCompactionThresholds 按 85% 与小窗口下限计算自动压缩参数', () => {
      expect(computeCompactionThresholds(1_000_000)).toMatchObject({
        reserveTokens: 150_000,
        keepRecentTokens: 20_000,
        triggerPercent: 85,
      })
      expect(computeCompactionThresholds(262_144)).toMatchObject({
        reserveTokens: 39_322,
        keepRecentTokens: 20_000,
        triggerPercent: 85,
      })
      expect(computeCompactionThresholds(131_072)).toMatchObject({
        reserveTokens: 19_661,
        keepRecentTokens: 20_000,
        triggerPercent: 85,
      })
      expect(computeCompactionThresholds(65_536)).toMatchObject({
        reserveTokens: 16_384,
        triggerPercent: 75,
      })
      const small = computeCompactionThresholds(32_768)
      expect(small.triggerPercent).toBe(65)
      expect(small.keepRecentTokens).toBeLessThan(32_768 - small.reserveTokens)
    })

    it('writeCompactionSettings 写入当前供应商模型覆盖并保留其他设置', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-compaction-settings-'))
      try {
        await fs.writeFile(
          path.join(dir, 'settings.json'),
          JSON.stringify({
            theme: 'dark',
            compaction: {
              modelOverrides: {
                'openai/gpt-5.4': { reserveTokens: 30_000, keepRecentTokens: 20_000 },
                'deepseek/stale-model': { reserveTokens: 16_384, keepRecentTokens: 20_000 },
              },
            },
          })
        )
        const file = await writeCompactionSettings(dir, 'deepseek', [
          { id: 'deepseek-flash', contextWindow: 262_144 },
        ])
        const saved = JSON.parse(await fs.readFile(file, 'utf-8'))
        expect(saved.theme).toBe('dark')
        expect(saved.compaction.enabled).toBe(true)
        expect(saved.compaction.modelOverrides['openai/gpt-5.4']).toEqual({
          reserveTokens: 30_000,
          keepRecentTokens: 20_000,
        })
        expect(saved.compaction.modelOverrides['deepseek/stale-model']).toBeUndefined()
        expect(saved.compaction.modelOverrides['deepseek/deepseek-flash']).toEqual({
          reserveTokens: 39_322,
          keepRecentTokens: 20_000,
        })
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  })
})
