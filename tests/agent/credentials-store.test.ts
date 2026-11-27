import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { createFileCredentialStore } from '../../pi-bridge/src/credentials-store'
import type { Credential } from '@earendil-works/pi-ai'

const PREFIX = 'enc:'

/** 测试用加解密：可逆、可观测，不依赖 safeStorage */
function createCipher() {
  return {
    encrypt: vi.fn((plain: string) => PREFIX + Buffer.from(plain, 'utf-8').toString('base64')),
    decrypt: vi.fn((stored: string) => {
      if (!stored.startsWith(PREFIX)) throw new Error('missing prefix')
      return Buffer.from(stored.slice(PREFIX.length), 'base64').toString('utf-8')
    }),
  }
}

const apiKey = (key: string): Credential => ({ type: 'api_key', key })
const oauth = (access: string): Credential => ({
  type: 'oauth',
  access,
  refresh: `refresh-${access}`,
  expires: Date.now() + 3600_000,
})

function createLogger() {
  return { warn: vi.fn() }
}

describe('文件凭证存储', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-credentials-'))
    filePath = path.join(dir, 'config', 'credentials.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  function createStore(overrides: { cipher?: ReturnType<typeof createCipher> } = {}) {
    const cipher = overrides.cipher ?? createCipher()
    const logger = createLogger()
    const store = createFileCredentialStore({ path: filePath, cipher, logger })
    return { store, cipher, logger }
  }

  async function readFileJson(): Promise<any> {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'))
  }

  it('没有文件时按空表处理', async () => {
    const { store } = createStore()
    expect(await store.read('deepseek')).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('modify 写入后 read 取回，且磁盘上没有明文', async () => {
    const { store } = createStore()
    const written = await store.modify('deepseek', async () => apiKey('sk-plain-secret'))
    expect(written).toEqual(apiKey('sk-plain-secret'))
    expect(await store.read('deepseek')).toEqual(apiKey('sk-plain-secret'))

    const raw = await fs.readFile(filePath, 'utf-8')
    expect(raw).not.toContain('sk-plain-secret')

    const parsed = await readFileJson()
    expect(parsed.version).toBe(1)
    // type 必须明文旁挂，list() 才能不解密
    expect(parsed.entries.deepseek.type).toBe('api_key')
    expect(parsed.entries.deepseek.secret.startsWith(PREFIX)).toBe(true)
  })

  it('list 返回类型且不解密', async () => {
    const { store, cipher } = createStore()
    await store.modify('deepseek', async () => apiKey('k1'))
    await store.modify('openai', async () => oauth('a1'))

    cipher.decrypt.mockClear()
    const infos = await store.list()
    expect([...infos].sort((a, b) => a.providerId.localeCompare(b.providerId))).toEqual([
      { providerId: 'deepseek', type: 'api_key' },
      { providerId: 'openai', type: 'oauth' },
    ])
    expect(cipher.decrypt).not.toHaveBeenCalled()
  })

  it('modify 返回 undefined 表示不改动，并解析为当前值', async () => {
    const { store } = createStore()
    await store.modify('deepseek', async () => apiKey('keep-me'))

    const result = await store.modify('deepseek', async (current) => {
      expect(current).toEqual(apiKey('keep-me'))
      return undefined
    })
    expect(result).toEqual(apiKey('keep-me'))
    expect(await store.read('deepseek')).toEqual(apiKey('keep-me'))
  })

  it('modify 能看到已有值（OAuth 刷新依赖这一点）', async () => {
    const { store } = createStore()
    await store.modify('openai', async () => oauth('old'))
    const refreshed = await store.modify('openai', async (current) => {
      const value = current as Extract<Credential, { type: 'oauth' }>
      return { ...value, access: 'new' }
    })
    expect(refreshed).toMatchObject({ type: 'oauth', access: 'new', refresh: 'refresh-old' })
    expect(await store.read('openai')).toMatchObject({ access: 'new' })
  })

  it('并发 modify 不丢更新（按 provider 串行）', async () => {
    const { store } = createStore()
    const total = 20
    await Promise.all(
      Array.from({ length: total }, () =>
        store.modify('deepseek', async (current) => {
          // 借助 env 字段承载计数器，验证串行读-改-写
          const seen = (current as { env?: Record<string, string> } | undefined)?.env?.COUNT
          const next = seen ? Number(seen) + 1 : 1
          return { type: 'api_key', key: 'k', env: { COUNT: String(next) } } as Credential
        })
      )
    )
    const value = (await store.read('deepseek')) as { env?: Record<string, string> }
    expect(value.env?.COUNT).toBe(String(total))
  })

  it('不同 provider 互不阻塞也不互相覆盖', async () => {
    const { store } = createStore()
    await Promise.all([
      store.modify('deepseek', async () => apiKey('d')),
      store.modify('openai', async () => oauth('o')),
    ])
    expect(await store.read('deepseek')).toEqual(apiKey('d'))
    expect(await store.read('openai')).toMatchObject({ type: 'oauth', access: 'o' })
  })

  it('delete 移除条目，重复 delete 不报错', async () => {
    const { store } = createStore()
    await store.modify('deepseek', async () => apiKey('k'))
    await store.delete('deepseek')
    expect(await store.read('deepseek')).toBeUndefined()
    await store.delete('deepseek')
    await store.delete('never-existed')
  })

  it('坏 JSON 且无 .bak 时只读回落空表，写路径拒绝覆盖并保留 .corrupt 现场', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, '{ this is not json', 'utf-8')

    const { store, logger } = createStore()
    expect(await store.read('deepseek')).toBeUndefined()
    expect(await store.list()).toEqual([])
    expect(logger.warn).toHaveBeenCalled()

    await expect(store.modify('deepseek', async () => apiKey('recovered'))).rejects.toThrow(
      /corrupted/i
    )
    const names = await fs.readdir(path.dirname(filePath))
    const corruptBackup = names.find((name) => name.startsWith('credentials.json.corrupt.'))
    expect(corruptBackup).toBeDefined()
    expect(
      await fs.readFile(path.join(path.dirname(filePath), corruptBackup!), 'utf-8')
    ).toBe('{ this is not json')

    // 损坏主文件已挪至 .corrupt.<ts> 后，用户明确重试写入可正常重建
    await store.modify('deepseek', async () => apiKey('recovered'))
    expect(await store.read('deepseek')).toEqual(apiKey('recovered'))
  })

  it('主文件损坏但存在健康 .bak 时自动从备份恢复且不丢失其他供应商凭证', async () => {
    const { store, logger } = createStore()
    await store.modify('deepseek', async () => apiKey('dk-1'))
    await store.modify('openai', async () => oauth('oa-1'))

    // 破坏主文件，但 .bak 保留了上一次有效状态（含 deepseek）
    await fs.writeFile(filePath, '{ broken json', 'utf-8')

    expect(await store.read('deepseek')).toEqual(apiKey('dk-1'))
    expect(logger.warn).toHaveBeenCalled()

    // 写路径从 .bak 恢复后合并写入，既保留 deepseek 又新增 anthropic，并自愈主文件
    await store.modify('anthropic', async () => apiKey('ak-1'))
    expect(await store.read('deepseek')).toEqual(apiKey('dk-1'))
    expect(await store.read('anthropic')).toEqual(apiKey('ak-1'))
  })

  it('坏 JSON 且无 .bak 时 delete 也抛出错误并保留 .corrupt 文件', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, 'not-json', 'utf-8')

    const { store } = createStore()
    await expect(store.delete('deepseek')).rejects.toThrow(/corrupted/i)
    const names = await fs.readdir(path.dirname(filePath))
    expect(names.some((name) => name.startsWith('credentials.json.corrupt.'))).toBe(true)
  })

  it('字段不完整的条目被逐条丢弃，不影响其他条目', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        entries: {
          broken: { type: 'api_key' },
          weird: { type: 'unknown', secret: 'x' },
          deepseek: { type: 'api_key', secret: PREFIX + Buffer.from(JSON.stringify(apiKey('ok'))).toString('base64') },
        },
      }),
      'utf-8'
    )

    const { store, logger } = createStore()
    expect(await store.read('broken')).toBeUndefined()
    expect(await store.read('weird')).toBeUndefined()
    expect(await store.read('deepseek')).toEqual(apiKey('ok'))
    const warned = logger.warn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(warned).toContain('broken')
    expect(warned).toContain('weird')
    expect(warned).not.toContain('deepseek')
  })

  it('解密失败当作没有凭证（换机器 / 系统密钥变化）', async () => {
    const { store } = createStore()
    await store.modify('deepseek', async () => apiKey('secret'))

    const other = createFileCredentialStore({
      path: filePath,
      cipher: {
        encrypt: (plain) => PREFIX + plain,
        decrypt: () => {
          throw new Error('cannot decrypt')
        },
      },
      logger: createLogger(),
    })
    expect(await other.read('deepseek')).toBeUndefined()
    // list 不解密，仍能看到类型
    expect(await other.list()).toEqual([{ providerId: 'deepseek', type: 'api_key' }])
  })

  it('已 abort 的 signal 直接拒绝且不写盘', async () => {
    const { store } = createStore()
    const controller = new AbortController()
    controller.abort()

    await expect(
      store.modify('deepseek', async () => apiKey('nope'), { signal: controller.signal })
    ).rejects.toBeDefined()
    await expect(fs.access(filePath)).rejects.toBeDefined()
  })

  it('写完不留临时文件', async () => {
    const { store } = createStore()
    await store.modify('deepseek', async () => apiKey('k'))
    const names = await fs.readdir(path.dirname(filePath))
    expect(names).toEqual(['credentials.json'])
  })

  it('文件权限在 POSIX 上是 0600', async () => {
    if (process.platform === 'win32') return
    const { store } = createStore()
    await store.modify('deepseek', async () => apiKey('k'))
    const stat = await fs.stat(filePath)
    expect(stat.mode & 0o777).toBe(0o600)
  })
})
