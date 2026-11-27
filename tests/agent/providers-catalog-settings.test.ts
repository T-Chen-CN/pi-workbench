/**
 * 供应商目录跟随开关、PI_OFFLINE 总开关与目录来源（P-04 / D6 / D12 / D26）。
 */

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { builtinCatalogGeneratedAt } from 'pi-bridge'

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

const { setAppSettingsCache } = await import('../../electron/ipc/settings')
const { resetModelsStoreForTests, modelsStorePath } = await import('../../electron/models-store')
const {
  isCatalogNetworkAllowed,
  isPiOffline,
  listProviders,
  refreshProviders,
  resetCatalogRuntime,
} = await import('../../electron/providers-service')

const savedOffline = process.env.PI_OFFLINE

beforeEach(async () => {
  appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-providers-catalog-'))
  await fs.mkdir(path.join(appDir, 'data', 'agent'), { recursive: true })
  await fs.mkdir(path.join(appDir, 'config'), { recursive: true })
  delete process.env.PI_OFFLINE
  setAppSettingsCache({ autoRefreshCatalog: true })
  resetModelsStoreForTests()
  resetCatalogRuntime()
})

afterEach(async () => {
  if (savedOffline === undefined) delete process.env.PI_OFFLINE
  else process.env.PI_OFFLINE = savedOffline
  resetModelsStoreForTests()
  resetCatalogRuntime()
  await fs.rm(appDir, { recursive: true, force: true }).catch(() => undefined)
})

describe('PI_OFFLINE 与目录刷新开关（P-04 / D6）', () => {
  it('正确识别 PI_OFFLINE 环境变量', () => {
    expect(isPiOffline({})).toBe(false)
    expect(isPiOffline({ PI_OFFLINE: '' })).toBe(false)
    expect(isPiOffline({ PI_OFFLINE: '0' })).toBe(false)
    expect(isPiOffline({ PI_OFFLINE: 'false' })).toBe(false)
    expect(isPiOffline({ PI_OFFLINE: '1' })).toBe(true)
    expect(isPiOffline({ PI_OFFLINE: 'true' })).toBe(true)
  })

  it('autoRefreshCatalog 控制后台刷新，PI_OFFLINE 优先级最高', () => {
    setAppSettingsCache({ autoRefreshCatalog: true })
    expect(isCatalogNetworkAllowed()).toBe(true)

    setAppSettingsCache({ autoRefreshCatalog: false })
    expect(isCatalogNetworkAllowed()).toBe(false)

    setAppSettingsCache({ autoRefreshCatalog: true })
    process.env.PI_OFFLINE = '1'
    expect(isCatalogNetworkAllowed()).toBe(false)
  })

  it('PI_OFFLINE=1 时 refreshProviders 直接拒绝联网并返回 PI_OFFLINE', async () => {
    process.env.PI_OFFLINE = '1'
    const result = await refreshProviders(true)
    expect(result.success).toBe(false)
    expect(result.error).toBe('PI_OFFLINE')
  })

  it('关闭自动刷新时非强制刷新静默跳过', async () => {
    setAppSettingsCache({ autoRefreshCatalog: false })
    const result = await refreshProviders(false)
    expect(result.success).toBe(true)
    expect(result.added).toBe(0)
    expect(result.removed).toBe(0)
  })
})

describe('listProviders 目录来源与时间戳（D12 / D26）', () => {
  it('无缓存时返回 bundled，有更新的远端快照时返回 remote', async () => {
    const first = await listProviders()
    expect(first.offline).toBe(false)
    expect(first.builtinGeneratedAt).toBe(builtinCatalogGeneratedAt())
    const deepseekBundled = first.providers.find((item) => item.id === 'deepseek')
    expect(deepseekBundled?.directory.source).toBe('bundled')

    // 写入比内置快照更新的远端目录缓存
    const baseGeneratedAt = builtinCatalogGeneratedAt() ?? Date.UTC(2026, 9, 15)
    const newer = baseGeneratedAt + 86_400_000
    const checkedAt = newer + 1_000
    await fs.writeFile(
      modelsStorePath(appDir),
      JSON.stringify({
        deepseek: {
          lastModified: newer,
          checkedAt,
          models: [
            {
              id: 'deepseek-flash',
              name: 'DeepSeek Flash',
              api: 'openai-completions',
              provider: 'deepseek',
              baseUrl: 'https://api.deepseek.com',
              reasoning: true,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
      }),
      'utf-8'
    )
    resetModelsStoreForTests()
    resetCatalogRuntime()

    const second = await listProviders()
    const deepseekRemote = second.providers.find((item) => item.id === 'deepseek')
    expect(deepseekRemote?.directory).toEqual({
      source: 'remote',
      checkedAt,
      lastModified: newer,
    })
  })
})
