import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mocks = vi.hoisted(() => {
  const state = { appDir: '' }
  return {
    state,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
      decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf-8').slice(4),
    },
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => mocks.state.appDir,
    getPath: () => mocks.state.appDir,
  },
  safeStorage: mocks.safeStorage,
}))

type ConfigModule = typeof import('../electron/cloud/config')
let config: ConfigModule

beforeAll(async () => {
  mocks.state.appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cloud-config-'))
  config = await import('../electron/cloud/config')
})

afterAll(() => {
  fs.rmSync(mocks.state.appDir, { recursive: true, force: true })
})

describe('clearCloudToken', () => {
  it('drops the key but keeps the base url so reconnecting only needs the key', () => {
    config.writeCloudConfig({ baseUrl: 'https://api.tchen-xiaoxiao.com', apiKey: 'sk-secret' })
    expect(config.readCloudConfig().hasToken).toBe(true)

    const cleared = config.clearCloudToken()
    expect(cleared.hasToken).toBe(false)
    expect(cleared.baseUrl).toBe('https://api.tchen-xiaoxiao.com')
    expect(cleared.apiKey).toBe('')

    const reread = config.readCloudConfig()
    expect(reread.hasToken).toBe(false)
    expect(reread.baseUrl).toBe('https://api.tchen-xiaoxiao.com')
  })
})

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and a /v1 suffix', () => {
    expect(config.normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com')
    expect(config.normalizeBaseUrl(' https://api.example.com/v1/ ')).toBe(
      'https://api.example.com'
    )
    expect(config.normalizeBaseUrl('https://api.example.com/base')).toBe(
      'https://api.example.com/base'
    )
  })

  it('rejects non-http protocols and garbage', () => {
    expect(config.normalizeBaseUrl('ftp://x')).toBe('')
    expect(config.normalizeBaseUrl('not a url')).toBe('')
    expect(config.normalizeBaseUrl('')).toBe('')
  })
})

describe('deriveDashboardUrl', () => {
  it('maps api.<domain> to dash.<domain>', () => {
    expect(config.deriveDashboardUrl('https://api.tchen-xiaoxiao.com')).toBe(
      'https://dash.tchen-xiaoxiao.com'
    )
  })

  it('keeps other hosts untouched', () => {
    expect(config.deriveDashboardUrl('https://cloud.example.com')).toBe(
      'https://cloud.example.com'
    )
  })
})

describe('read/write connection', () => {
  it('persists the key encrypted and never exposes it publicly', () => {
    const saved = config.writeCloudConfig({
      baseUrl: 'https://api.example.com',
      apiKey: 'secret-key',
    })
    expect(saved.hasToken).toBe(true)
    expect(saved.apiKey).toBe('secret-key')

    const raw = fs.readFileSync(config.cloudConfigFile(), 'utf-8')
    expect(raw).not.toContain('secret-key')
    expect(raw).toContain('enc:')

    const publicView = config.publicCloudConfig()
    expect(publicView).toEqual({
      baseUrl: 'https://api.example.com',
      dashboardUrl: 'https://dash.example.com',
      hasToken: true,
    })
    expect(publicView).not.toHaveProperty('apiKey')
  })

  it('keeps the previous key when the next save omits it', () => {
    config.writeCloudConfig({ baseUrl: 'https://api.example.com' })
    expect(config.readCloudConfig().apiKey).toBe('secret-key')
  })

  it('falls back to the default endpoint for invalid input', () => {
    const saved = config.writeCloudConfig({ baseUrl: 'nonsense' })
    expect(saved.baseUrl).toBe(config.DEFAULT_CLOUD_BASE_URL)
  })
})
