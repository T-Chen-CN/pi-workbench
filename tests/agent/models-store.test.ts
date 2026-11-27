import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { createFileModelsStore } from '../../pi-bridge/src/models-store'
import {
  diffCatalogSnapshots,
  filterEffectiveCatalogModels,
  isRemoteCatalogEffective,
  providerModelsProbeRequest,
} from '../../pi-bridge/src/provider-presets'
import type { ModelsStoreEntry } from '@earendil-works/pi-ai'

const model = (id: string): any => ({
  id,
  name: id,
  provider: 'deepseek',
  api: 'openai-completions',
  contextWindow: 1000,
  maxTokens: 100,
})

function entry(ids: string[], extra: Partial<ModelsStoreEntry> = {}): ModelsStoreEntry {
  return { models: ids.map(model), checkedAt: 1_700_000_000_000, ...extra }
}

describe('目录缓存与远端判据', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-models-store-'))
    filePath = path.join(dir, 'models-store.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  function createStore() {
    const logger = { warn: vi.fn() }
    return { store: createFileModelsStore({ path: filePath, logger }), logger }
  }

  it('读写往返并保持 SDK 的磁盘格式', async () => {
    const { store } = createStore()
    await store.write('deepseek', entry(['deepseek-flash'], { lastModified: 123, etag: '"abc"' }))

    const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    expect(Object.keys(raw)).toEqual(['deepseek'])
    expect(raw.deepseek).toMatchObject({ lastModified: 123, checkedAt: 1_700_000_000_000, etag: '"abc"' })

    const read = await store.read('deepseek')
    expect(read?.models.map((m) => m.id)).toEqual(['deepseek-flash'])
    expect(await store.read('openai')).toBeUndefined()
  })

  it('快照给出 id 清单与时间戳', async () => {
    const { store } = createStore()
    await store.write('deepseek', entry(['a', 'b'], { lastModified: 5 }))
    await store.write('openai', entry(['c']))

    expect(await store.snapshotFor('deepseek')).toEqual({
      providerId: 'deepseek',
      checkedAt: 1_700_000_000_000,
      lastModified: 5,
      ids: ['a', 'b'],
    })
    expect((await store.snapshot()).map((s) => s.providerId)).toEqual(['deepseek', 'openai'])
  })

  it('不同 provider 并发写入互不覆盖', async () => {
    const { store } = createStore()
    await Promise.all([
      store.write('deepseek', entry(['a'])),
      store.write('openai', entry(['b'])),
      store.write('xai', entry(['c'])),
    ])
    const snapshot = await store.snapshot()
    expect(snapshot.map((s) => s.providerId)).toEqual(['deepseek', 'openai', 'xai'])
  })

  it('delete 只删指定 provider', async () => {
    const { store } = createStore()
    await store.write('deepseek', entry(['a']))
    await store.write('openai', entry(['b']))
    await store.delete('deepseek')
    expect(await store.read('deepseek')).toBeUndefined()
    expect((await store.read('openai'))?.models.map((m) => m.id)).toEqual(['b'])
    await store.delete('never-existed')
  })

  it('坏文件与坏条目都回落而不抛错', async () => {
    const { store, logger } = createStore()
    await fs.writeFile(filePath, 'not json', 'utf-8')
    expect(await store.snapshot()).toEqual([])
    expect(await store.read('deepseek')).toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()

    await fs.writeFile(
      filePath,
      JSON.stringify({ deepseek: { models: [model('ok')] }, broken: { nope: true } }),
      'utf-8'
    )
    expect((await store.snapshot()).map((s) => s.providerId)).toEqual(['deepseek'])
  })

  it('写完不留临时文件', async () => {
    const { store } = createStore()
    await store.write('deepseek', entry(['a']))
    expect(await fs.readdir(dir)).toEqual(['models-store.json'])
  })

  it('已 abort 的 signal 直接拒绝', async () => {
    const { store } = createStore()
    const controller = new AbortController()
    controller.abort()
    await expect(store.write('deepseek', entry(['a']), { signal: controller.signal })).rejects.toBeDefined()
    await expect(store.read('deepseek', { signal: controller.signal })).rejects.toBeDefined()
  })

  describe('isRemoteCatalogEffective', () => {
    it('没有时间戳或为 0 时不生效', () => {
      expect(isRemoteCatalogEffective(undefined)).toBe(false)
      expect(isRemoteCatalogEffective(0)).toBe(false)
    })

    it('与内置快照生成时间比较', () => {
      // 2026-10-15 之前 → 远端比内置旧，SDK 会忽略
      expect(isRemoteCatalogEffective(Date.parse('2026-01-01T00:00:00Z'))).toBe(false)
      expect(isRemoteCatalogEffective(Date.parse('2030-01-01T00:00:00Z'))).toBe(true)
    })
  })

  describe('filterEffectiveCatalogModels (D12 / D26)', () => {
    const models = [{ id: 'keep-1' }, { id: 'removed-upstream' }, { id: 'added-remote' }]

    it('远端比内置新时剔除上游已下架的模型，保留远端新增模型', () => {
      const filtered = filterEffectiveCatalogModels(models, {
        lastModified: Date.parse('2030-01-01T00:00:00Z'),
        ids: ['keep-1', 'added-remote'],
      })
      expect(filtered.map((m) => m.id)).toEqual(['keep-1', 'added-remote'])
    })

    it('无快照 / 远端比内置旧 / 交集为空时原样保留', () => {
      expect(filterEffectiveCatalogModels(models, undefined)).toEqual(models)
      expect(
        filterEffectiveCatalogModels(models, {
          lastModified: Date.parse('2026-01-01T00:00:00Z'),
          ids: ['keep-1'],
        })
      ).toEqual(models)
      expect(
        filterEffectiveCatalogModels(models, {
          lastModified: Date.parse('2030-01-01T00:00:00Z'),
          ids: ['nonexistent'],
        })
      ).toEqual(models)
    })
  })

  describe('diffCatalogSnapshots', () => {
    it('按 provider 精确统计增删数量，不把增删相互抵消', () => {
      const diff = diffCatalogSnapshots(
        [{ providerId: 'google', ids: ['a', 'b'] }],
        [{ providerId: 'google', ids: ['a', 'c', 'd'] }]
      )
      expect(diff).toEqual({ added: 2, removed: 1 })
    })
  })

  describe('providerModelsProbeRequest', () => {
    it('Google 使用 x-goog-api-key，Anthropic 补全 /v1/models 并用 x-api-key', () => {
      expect(
        providerModelsProbeRequest('google', 'https://generativelanguage.googleapis.com/v1beta', 'g-key')
      ).toEqual({
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        headers: { 'x-goog-api-key': 'g-key' },
      })

      expect(providerModelsProbeRequest('anthropic', 'https://api.anthropic.com', 'a-key')).toEqual({
        url: 'https://api.anthropic.com/v1/models',
        headers: { 'x-api-key': 'a-key', 'anthropic-version': '2023-06-01' },
      })

      expect(providerModelsProbeRequest('anthropic', 'https://api.anthropic.com/v1/', 'a-key').url).toBe(
        'https://api.anthropic.com/v1/models'
      )

      expect(providerModelsProbeRequest('openai', 'https://api.openai.com/v1', 'o-key')).toEqual({
        url: 'https://api.openai.com/v1/models',
        headers: { authorization: 'Bearer o-key' },
      })
    })
  })
})
