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
  it('drops the device token but keeps the gateway url', () => {
    config.writeCloudConfig({
      baseUrl: 'https://api.tchen-xiaoxiao.com',
      deviceToken: 'pi_secret',
      deviceId: 'dev-1',
    })
    expect(config.readCloudConfig().hasDeviceToken).toBe(true)

    const cleared = config.clearCloudToken()
    expect(cleared.hasDeviceToken).toBe(false)
    expect(cleared.gatewayUrl).toBe('https://hub.tchen-xiaoxiao.com')

    const reread = config.readCloudConfig()
    expect(reread.hasDeviceToken).toBe(false)
    expect(reread.gatewayUrl).toBe('https://hub.tchen-xiaoxiao.com')
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
  it('persists the device token encrypted and never exposes it publicly', () => {
    const saved = config.writeCloudConfig({
      baseUrl: 'https://api.example.com',
      deviceToken: 'pi_secret',
      deviceId: 'dev-1',
      deviceScopes: ['chat'],
    })
    expect(saved.hasDeviceToken).toBe(true)
    expect(saved.deviceToken).toBe('pi_secret')

    const raw = fs.readFileSync(config.cloudConfigFile(), 'utf-8')
    expect(raw).not.toContain('pi_secret')
    expect(raw).toContain('enc:')

    const publicView = config.publicCloudConfig()
    expect(publicView).toEqual({
      // 网关地址默认由 `api.` 派生成 `hub.`（单入口）
      gatewayUrl: 'https://hub.example.com',
      dashboardUrl: 'https://dash.example.com',
      hasDeviceToken: true,
      deviceScopes: ['chat'],
      deviceId: 'dev-1',
      hasAdminKey: false,
      dashboardUser: '',
      hasDashboardPassword: false,
    })
    // 明文凭据永远不进渲染层
    expect(publicView).not.toHaveProperty('deviceToken')
    expect(publicView).not.toHaveProperty('apiKey')
  })

  it('keeps the previous device token when the next save omits it', () => {
    config.writeCloudConfig({ baseUrl: 'https://api.example.com' })
    expect(config.readCloudConfig().deviceToken).toBe('pi_secret')
  })

  it('falls back to the default endpoint for invalid input', () => {
    const saved = config.writeCloudConfig({ baseUrl: 'nonsense' })
    expect(saved.baseUrl).toBe(config.DEFAULT_CLOUD_BASE_URL)
  })
})

describe('控制台会话令牌（已废弃）', () => {
  it('ignores a token left behind by older builds', () => {
    // 单入口之后图片旁路也用设备 token；老文件里的 dash-token 一个字都不许进传输
    config.writeCloudConfig({ baseUrl: 'https://api.example.com', deviceToken: 'pi_dev' })
    const file = config.cloudConfigFile()
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8'))
    stored.dashboardToken = 'dash-token'
    fs.writeFileSync(file, JSON.stringify(stored))

    const transport = config.cloudTransport()
    expect(transport.dashboardToken).toBe('pi_dev')
    expect(transport.dashboardToken).not.toBe('dash-token')
    expect(config.publicCloudConfig()).not.toHaveProperty('hasDashboardToken')
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
      deviceToken: 'pi_secret',
      dashboardUser: 'admin',
      dashboardPassword: 'p@ss=word',
      handoffProfile: 'pi-cloud',
    })
    config.clearCloudToken()
    const read = config.readCloudConfig()
    expect(read.hasDeviceToken).toBe(false)
    expect(read.hasDashboardPassword).toBe(false)
    expect(read.dashboardUser).toBe('admin')
    expect(read.handoffProfile).toBe('pi-cloud')
  })

  it('ignores the legacy api key: there is only one way in', () => {
    // 老文件里的 apiKey 现在完全不参与传输，读出来就该是空的
    fs.writeFileSync(
      config.cloudConfigFile(),
      JSON.stringify({ baseUrl: 'https://api.example.com', apiKey: 'plain-legacy-key' }),
      'utf-8'
    )
    const read = config.readCloudConfig()
    expect(read).not.toHaveProperty('apiKey')
    expect(config.cloudTransport().credential).toBe('')
    expect(read.dashboardUser).toBe('')
    expect(read.hasDashboardPassword).toBe(false)
    expect(read.handoffImportedAt).toBeNull()
    expect(read.handoffProfile).toBe('')
  })
})

describe('单入口：本地只有一扇门（C-2）', () => {
  function freshFile(): void {
    // 连 `.bak` 一起删：读取器在主文件缺失时会回退到备份，只删主文件等于没删
    for (const file of [config.cloudConfigFile(), `${config.cloudConfigFile()}.bak`]) {
      fs.rmSync(file, { force: true })
    }
  }

  it('always talks to the gateway, even with a legacy api key on disk', () => {
    freshFile()
    // 有人手动把 apiKey 写回文件，也不该被当成凭据
    fs.writeFileSync(
      config.cloudConfigFile(),
      JSON.stringify({
        baseUrl: 'https://api.example.com',
        apiKey: 'plain-legacy-key',
        deviceToken: 'enc:' + 'pi_dev',
      }),
      'utf-8'
    )
    const transport = config.cloudTransport()
    expect(transport.baseUrl).toBe('https://hub.example.com')
    expect(transport.credential).not.toBe('plain-legacy-key')
  })

  it('has no credential at all when the device is not registered', () => {
    freshFile()
    config.writeCloudConfig({ baseUrl: 'https://api.example.com' })
    const transport = config.cloudTransport()
    // 没有设备 token = 没有凭据 = 上层明确报错；不存在第二条路
    expect(transport.baseUrl).toBe('https://hub.example.com')
    expect(transport.credential).toBe('')
    expect(transport.dashboardToken).toBe('')
  })

  it('loses the credential after the device is revoked', () => {
    freshFile()
    config.writeCloudConfig({
      baseUrl: 'https://api.example.com',
      deviceToken: 'pi_dev',
      deviceId: 'dev-1',
    })
    config.clearDeviceCredentials()
    const transport = config.cloudTransport()
    expect(transport.credential).toBe('')
    expect(transport.dashboardToken).toBe('')
    // 登记的痕迹（deviceId）也清了：界面据此判断「已注销」
    expect(config.readCloudConfig().deviceId).toBe('')
  })

  it('keeps the gateway lock across a plain disconnect', () => {
    freshFile()
    config.writeCloudConfig({
      baseUrl: 'https://api.example.com',
      deviceToken: 'pi_dev',
      deviceId: 'dev-1',
    })
    config.clearCloudToken()
    const read = config.readCloudConfig()
    expect(read.hasDeviceToken).toBe(false)
    // 断开之后仍然只认网关地址
    expect(config.cloudTransport().baseUrl).toBe('https://hub.example.com')
  })
})

describe('记住管理密钥（默认不存）', () => {
  it('stores it encrypted only when asked, and never exposes it', () => {
    config.writeCloudConfig({ baseUrl: 'https://api.example.com', adminKey: 'admin-secret' })
    expect(config.readCloudConfig().hasAdminKey).toBe(true)
    const raw = fs.readFileSync(config.cloudConfigFile(), 'utf-8')
    expect(raw).not.toContain('admin-secret')
    expect(config.publicCloudConfig()).not.toHaveProperty('adminKey')
  })

  it('keeps it across a revoke so the next registration needs no pasting', () => {
    config.writeCloudConfig({
      baseUrl: 'https://api.example.com',
      deviceToken: 'pi_dev',
      deviceId: 'dev-1',
      adminKey: 'admin-secret',
    })
    config.clearDeviceCredentials()
    const read = config.readCloudConfig()
    expect(read.hasDeviceToken).toBe(false)
    // 注销只收设备的钥匙，管理密钥留着（否则下次还要去服务器上取）
    expect(read.hasAdminKey).toBe(true)
  })

  it('drops it when the user disconnects everything', () => {
    config.writeCloudConfig({ baseUrl: 'https://api.example.com', adminKey: 'admin-secret' })
    config.clearCloudToken()
    expect(config.readCloudConfig().hasAdminKey).toBe(false)
  })

  it('forgets it when written as an empty string', () => {
    config.writeCloudConfig({ baseUrl: 'https://api.example.com', adminKey: 'admin-secret' })
    config.writeCloudConfig({ baseUrl: 'https://api.example.com', adminKey: '' })
    expect(config.readCloudConfig().hasAdminKey).toBe(false)
  })
})
