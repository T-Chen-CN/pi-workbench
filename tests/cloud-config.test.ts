import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  for (const file of [config.cloudConfigFile(), `${config.cloudConfigFile()}.bak`]) {
    fs.rmSync(file, { force: true })
  }
})

afterAll(() => {
  fs.rmSync(mocks.state.appDir, { recursive: true, force: true })
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
  it('maps hub.<domain> to dash.<domain>', () => {
    expect(config.deriveDashboardUrl('https://hub.example.com')).toBe(
      'https://dash.example.com'
    )
  })

  it('keeps the old api.<domain> rule for compatibility', () => {
    expect(config.deriveDashboardUrl('https://api.example.com')).toBe(
      'https://dash.example.com'
    )
  })

  it('keeps other hosts untouched', () => {
    expect(config.deriveDashboardUrl('https://cloud.example.com')).toBe(
      'https://cloud.example.com'
    )
  })

  it('returns nothing for garbage instead of inventing a domain', () => {
    expect(config.deriveDashboardUrl('')).toBe('')
    expect(config.deriveDashboardUrl('not a url')).toBe('')
  })
})

describe('read/write connection', () => {
  it('persists the device token encrypted and never exposes it publicly', () => {
    const saved = config.writeCloudConfig({
      gatewayUrl: 'https://hub.example.com',
      dashboardUrl: 'https://dash.example.com',
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
      gatewayUrl: 'https://hub.example.com',
      dashboardUrl: 'https://dash.example.com',
      hasDeviceToken: true,
      deviceScopes: ['chat'],
      deviceId: 'dev-1',
    })
    expect(publicView).not.toHaveProperty('deviceToken')
    expect(publicView).not.toHaveProperty('adminKey')
  })

  it('keeps the previous device token when the next save omits it', () => {
    config.writeCloudConfig({ gatewayUrl: 'https://hub.example.com', deviceToken: 'pi_secret' })
    config.writeCloudConfig({ gatewayUrl: 'https://hub.example.com' })
    expect(config.readCloudConfig().deviceToken).toBe('pi_secret')
  })

  it('has no built-in gateway URL: nothing stored means empty', () => {
    const saved = config.writeCloudConfig({})
    // 网关地址是用户自己的部署，客户端不内置任何域名
    expect(saved.gatewayUrl).toBe('')
    expect(saved.dashboardUrl).toBe('')
    expect(saved).not.toHaveProperty('baseUrl')
  })

  it('keeps a stored gateway URL untouched across saves', () => {
    config.writeCloudConfig({ gatewayUrl: 'https://hub.example.com' })
    expect(config.readCloudConfig().gatewayUrl).toBe('https://hub.example.com')
    expect(config.writeCloudConfig({}).gatewayUrl).toBe('https://hub.example.com')
  })
})

describe('目标 schema', () => {
  it('ignores and prunes legacy fields, keeping only the target keys', () => {
    const file = config.cloudConfigFile()
    config.writeCloudConfig({
      gatewayUrl: 'https://hub.example.com',
      dashboardUrl: 'https://dash.example.com',
      deviceToken: 'pi_dev',
      deviceScopes: ['chat', 'dispatch'],
      deviceId: 'dev-1',
    })
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...stored,
        baseUrl: 'https://api.example.com',
        apiKey: 'legacy-api-key',
        dashboardToken: 'dash-token',
        adminKey: 'enc:admin-secret',
        dashboardUser: 'admin',
        dashboardPassword: 'enc:p@ss',
        handoffImportedAt: 1_800_000_000_000,
        handoffProfile: 'pi-cloud',
      }),
      'utf-8'
    )

    // 读取时就不认识旧字段
    const read = config.readCloudConfig()
    expect(read.deviceToken).toBe('pi_dev')
    expect(read).not.toHaveProperty('adminKey')
    expect(read).not.toHaveProperty('dashboardUser')

    config.pruneUnknownCloudConfig()
    const after = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
    expect(Object.keys(after).sort()).toEqual(
      ['dashboardUrl', 'deviceId', 'deviceScopes', 'deviceToken', 'gatewayUrl'].sort()
    )
    expect(after.deviceToken).toMatch(/^enc:/)
    expect(after.deviceToken).not.toContain('pi_dev')
    expect(after.gatewayUrl).toBe('https://hub.example.com')
  })

  it('does not rewrite the file when there is nothing to prune', () => {
    const file = config.cloudConfigFile()
    config.writeCloudConfig({ gatewayUrl: 'https://hub.example.com' })
    const before = fs.statSync(file).mtimeMs
    config.pruneUnknownCloudConfig()
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })

  it('keeps the legacy api key out of the transport', () => {
    config.writeCloudConfig({ gatewayUrl: 'https://hub.example.com' })
    const stored = JSON.parse(
      fs.readFileSync(config.cloudConfigFile(), 'utf-8')
    ) as Record<string, unknown>
    fs.writeFileSync(
      config.cloudConfigFile(),
      JSON.stringify({ ...stored, apiKey: 'plain-legacy-key' }),
      'utf-8'
    )
    expect(config.cloudTransport()).toEqual({
      baseUrl: 'https://hub.example.com',
      credential: '',
    })
  })
})

describe('clearDeviceCredentials', () => {
  it('drops token / scope / id but keeps the gateway and dashboard addresses', () => {
    config.writeCloudConfig({
      gatewayUrl: 'https://hub.example.com',
      dashboardUrl: 'https://dash.example.com',
      deviceToken: 'pi_secret',
      deviceId: 'dev-1',
      deviceScopes: ['chat'],
    })

    const cleared = config.clearDeviceCredentials()
    expect(cleared.hasDeviceToken).toBe(false)
    expect(cleared.deviceScopes).toEqual([])
    expect(cleared.deviceId).toBe('')
    expect(cleared.gatewayUrl).toBe('https://hub.example.com')
    expect(cleared.dashboardUrl).toBe('https://dash.example.com')

    const reread = config.readCloudConfig()
    expect(reread.hasDeviceToken).toBe(false)
    expect(reread.gatewayUrl).toBe('https://hub.example.com')
    expect(reread.dashboardUrl).toBe('https://dash.example.com')
  })
})

describe('单入口：本地只有一扇门（C-2）', () => {
  it('always talks to the gateway, even with a legacy api key on disk', () => {
    config.writeCloudConfig({
      gatewayUrl: 'https://hub.example.com',
      deviceToken: 'pi_dev',
    })
    const stored = JSON.parse(
      fs.readFileSync(config.cloudConfigFile(), 'utf-8')
    ) as Record<string, unknown>
    fs.writeFileSync(
      config.cloudConfigFile(),
      JSON.stringify({ ...stored, apiKey: 'plain-legacy-key' }),
      'utf-8'
    )
    const transport = config.cloudTransport()
    expect(transport.baseUrl).toBe('https://hub.example.com')
    expect(transport.credential).toBe('pi_dev')
    expect(transport.credential).not.toBe('plain-legacy-key')
  })

  it('has no credential at all when the device is not paired', () => {
    config.writeCloudConfig({ gatewayUrl: 'https://hub.example.com' })
    const transport = config.cloudTransport()
    expect(transport.baseUrl).toBe('https://hub.example.com')
    expect(transport.credential).toBe('')
  })

  it('loses the credential after the device is revoked', () => {
    config.writeCloudConfig({
      gatewayUrl: 'https://hub.example.com',
      deviceToken: 'pi_dev',
      deviceId: 'dev-1',
    })
    config.clearDeviceCredentials()
    expect(config.cloudTransport().credential).toBe('')
    expect(config.readCloudConfig().deviceId).toBe('')
  })
})
