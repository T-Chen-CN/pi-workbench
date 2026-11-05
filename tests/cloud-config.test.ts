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
      // 网关地址默认由 `api.` 派生成 `hub.`（单入口）
      gatewayUrl: 'https://hub.example.com',
      dashboardUrl: 'https://dash.example.com',
      hasToken: true,
      hasDeviceToken: false,
      deviceScopes: [],
      deviceId: '',
      // 从没登记过设备 = 老直连配置，直连仍然可用（运维回滚路径）
      transportMode: 'direct',
      hasDashboardToken: false,
      dashboardUser: '',
      hasDashboardPassword: false,
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

describe('控制台会话令牌', () => {
  it('is encrypted at rest and never leaves the main process', () => {
    config.writeCloudConfig({ baseUrl: 'https://api.example.com', apiKey: 'gateway-key' })
    config.writeCloudConfig({ baseUrl: 'https://api.example.com', dashboardToken: 'dash-token' })

    expect(config.readCloudConfig().hasDashboardToken).toBe(true)
    expect(config.readCloudConfig().dashboardToken).toBe('dash-token')
    // 公开字段里只有「有没有」，没有明文
    expect(config.publicCloudConfig()).toEqual({
      baseUrl: 'https://api.example.com',
      gatewayUrl: 'https://hub.example.com',
      dashboardUrl: 'https://dash.example.com',
      hasToken: true,
      hasDeviceToken: false,
      deviceScopes: [],
      deviceId: '',
      transportMode: 'direct',
      hasDashboardToken: true,
      dashboardUser: '',
      hasDashboardPassword: false,
    })
    expect(JSON.stringify(config.publicCloudConfig())).not.toContain('dash-token')
  })

  it('keeps the existing token when the field is left empty', () => {
    config.writeCloudConfig({ baseUrl: 'https://api.example.com', dashboardToken: 'dash-token' })
    config.writeCloudConfig({ baseUrl: 'https://api.example.com' })
    expect(config.readCloudConfig().dashboardToken).toBe('dash-token')
  })

  it('drops it on disconnect along with the API key', () => {
    config.writeCloudConfig({ baseUrl: 'https://api.example.com', dashboardToken: 'dash-token' })
    config.clearCloudToken()
    expect(config.readCloudConfig().hasDashboardToken).toBe(false)
    expect(config.readCloudConfig().baseUrl).toBe('https://api.example.com')
  })
})

describe('控制台账号与导入记录', () => {
  it('stores the password encrypted and only exposes the flag', () => {
    config.writeCloudConfig({
      baseUrl: 'https://api.example.com',
      dashboardUser: 'admin',
      dashboardPassword: 'p@ss=word',
    })
    const read = config.readCloudConfig()
    expect(read.dashboardUser).toBe('admin')
    expect(read.dashboardPassword).toBe('p@ss=word')
    expect(read.hasDashboardPassword).toBe(true)

    const raw = fs.readFileSync(config.cloudConfigFile(), 'utf-8')
    expect(raw).not.toContain('p@ss=word')
    expect(JSON.stringify(config.publicCloudConfig())).not.toContain('p@ss=word')
    expect(config.publicCloudConfig().dashboardUser).toBe('admin')
  })

  it('honours an explicit dashboard url from the handoff file', () => {
    const saved = config.writeCloudConfig({
      baseUrl: 'https://api.example.com',
      dashboardUrl: 'https://console.elsewhere.test',
    })
    expect(saved.dashboardUrl).toBe('https://console.elsewhere.test')
    expect(config.readCloudConfig().dashboardUrl).toBe('https://console.elsewhere.test')
  })

  it('records where the import came from', () => {
    config.writeCloudConfig({
      baseUrl: 'https://api.example.com',
      handoffImportedAt: 1_800_000_000_000,
      handoffProfile: 'pi-cloud',
    })
    expect(config.readCloudConfig().handoffImportedAt).toBe(1_800_000_000_000)
    expect(config.readCloudConfig().handoffProfile).toBe('pi-cloud')
  })

  it('keeps the account but drops every secret on disconnect', () => {
    config.writeCloudConfig({
      baseUrl: 'https://api.example.com',
      apiKey: 'secret-key',
      dashboardToken: 'dash-token',
      dashboardUser: 'admin',
      dashboardPassword: 'p@ss=word',
      handoffProfile: 'pi-cloud',
    })
    config.clearCloudToken()
    const read = config.readCloudConfig()
    expect(read.hasToken).toBe(false)
    expect(read.hasDashboardToken).toBe(false)
    expect(read.hasDashboardPassword).toBe(false)
    expect(read.dashboardUser).toBe('admin')
    expect(read.handoffProfile).toBe('pi-cloud')
  })

  it('reads legacy files without the new fields', () => {
    fs.writeFileSync(
      config.cloudConfigFile(),
      JSON.stringify({ baseUrl: 'https://api.example.com', apiKey: 'plain-legacy-key' }),
      'utf-8'
    )
    const read = config.readCloudConfig()
    expect(read.apiKey).toBe('plain-legacy-key')
    expect(read.dashboardUser).toBe('')
    expect(read.hasDashboardPassword).toBe(false)
    expect(read.handoffImportedAt).toBeNull()
    expect(read.handoffProfile).toBe('')
  })
})

describe('transport 模式（注销后不许回落直连）', () => {
  function freshFile(): void {
    fs.rmSync(config.cloudConfigFile(), { force: true })
  }

  it('starts in direct mode so a legacy api-key-only setup still works', () => {
    freshFile()
    config.writeCloudConfig({ baseUrl: 'https://api.example.com', apiKey: 'sk-legacy' })
    const transport = config.cloudTransport()
    expect(transport.viaGateway).toBe(false)
    expect(transport.credential).toBe('sk-legacy')
  })

  it('locks to the gateway once a device token exists', () => {
    freshFile()
    config.writeCloudConfig({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-legacy',
      deviceToken: 'pi_dev',
      deviceId: 'dev-1',
    })
    const transport = config.cloudTransport()
    expect(transport.viaGateway).toBe(true)
    expect(transport.credential).toBe('pi_dev')
    // 密钥还在盘上（回滚用），但正常路径绝不用它
    expect(transport.credential).not.toBe('sk-legacy')
  })

  it('has no credential at all after the device is revoked', () => {
    freshFile()
    config.writeCloudConfig({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-legacy',
      deviceToken: 'pi_dev',
      deviceId: 'dev-1',
    })
    config.clearDeviceCredentials()

    const transport = config.cloudTransport()
    // 关键：即使 apiKey 还在，也**不能**拿它当凭据 —— 注销必须真的关门
    expect(transport.viaGateway).toBe(true)
    expect(transport.credential).toBe('')
    expect(transport.dashboardToken).toBe('')
    expect(config.readCloudConfig().transportMode).toBe('gateway')
    // 回滚手段仍然保留（要人工改配置才会用上）
    expect(config.readCloudConfig().apiKey).toBe('sk-legacy')
  })

  it('keeps the gateway lock across a plain disconnect', () => {
    freshFile()
    config.writeCloudConfig({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-legacy',
      deviceToken: 'pi_dev',
      deviceId: 'dev-1',
    })
    config.clearCloudToken()
    expect(config.readCloudConfig().transportMode).toBe('gateway')
  })
})
