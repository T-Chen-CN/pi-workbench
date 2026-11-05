import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mocks = vi.hoisted(() => {
  const state = { appDir: '' }
  return { state }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => mocks.state.appDir,
    getPath: () => mocks.state.appDir,
  },
  safeStorage: { isEncryptionAvailable: () => true },
}))

type DeviceModule = typeof import('../electron/cloud/device')
let device: DeviceModule

beforeAll(async () => {
  mocks.state.appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cloud-device-'))
  device = await import('../electron/cloud/device')
})

afterAll(() => {
  fs.rmSync(mocks.state.appDir, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(device.cloudDeviceDir(), { recursive: true, force: true })
})

describe('sanitizeDeviceName', () => {
  it('drops control characters and the path separator but keeps emoji intact', () => {
    expect(device.sanitizeDeviceName(' 唐辰\u0000的\u001b Mac/Book 🚀 ')).toBe('唐辰的 MacBook 🚀')
  })

  it('keeps ZWJ sequences whole (Cf is not a dropped category)', () => {
    const family = '👨‍👩‍👧‍👦'
    expect(device.sanitizeDeviceName(family)).toBe(family)
  })

  it('collapses whitespace and truncates at 40 chars', () => {
    expect(device.sanitizeDeviceName('a   b\n\tc')).toBe('a b c')
    expect(device.sanitizeDeviceName('x'.repeat(60))).toHaveLength(40)
  })

  it('truncates by code point so the 40-char edge never leaves a lone surrogate', () => {
    const name = device.sanitizeDeviceName(`${'a'.repeat(39)}🚀`)
    expect(Array.from(name)).toHaveLength(40)
    expect(name.endsWith('🚀')).toBe(true)
    // 40 个码点 = 41 个 UTF-16 单元：说明 🚀 没被劈成孤立代理
    expect(name.length).toBe(41)
  })

  it('returns empty for non-strings and blank input', () => {
    expect(device.sanitizeDeviceName(undefined)).toBe('')
    expect(device.sanitizeDeviceName('   \u0007 ')).toBe('')
  })
})

describe('readCloudDevice', () => {
  it('creates an identity on first read and persists it', () => {
    const first = device.readCloudDevice()
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.name.length).toBeGreaterThan(0)
    expect(first.nameEditedAt).toBeNull()
    expect(fs.existsSync(device.deviceFile())).toBe(true)

    // 再读一次必须是同一个身份
    expect(device.readCloudDevice().id).toBe(first.id)
  })

  it('regenerates the id when the file is unusable instead of resurrecting a broken one', () => {
    const first = device.readCloudDevice()
    fs.writeFileSync(device.deviceFile(), '{ not json', 'utf-8')
    const second = device.readCloudDevice()
    expect(second.id).not.toBe(first.id)
    expect(second.name.length).toBeGreaterThan(0)
  })

  it('falls back to a readable placeholder when even the hostname is unusable', () => {
    const record = device.readCloudDevice('\u0000\u0001')
    expect(record.name).toMatch(/^设备 /)
    expect(record.defaultName).toBe(record.name)
    expect(device.readCloudDevice('\u0000\u0001').id).toBe(record.id)
  })
})

describe('updateCloudDeviceName', () => {
  it('renames without touching the id and marks the name as user-edited', () => {
    const before = device.readCloudDevice()
    const after = device.updateCloudDeviceName('  公司的台式  ')
    expect(after.name).toBe('公司的台式')
    expect(after.id).toBe(before.id)
    expect(after.nameEditedAt).toBeTypeOf('number')
    expect(device.readCloudDevice()).toMatchObject({ id: before.id, name: '公司的台式' })
  })

  it('treats a blank name as "restore the system default"', () => {
    const original = device.readCloudDevice()
    device.updateCloudDeviceName('随便改一个')
    const restored = device.updateCloudDeviceName('   ')
    expect(restored.name).toBe(original.defaultName)
    expect(restored.nameEditedAt).toBeNull()
  })

  it('sanitizes the incoming name (no control chars, max 40)', () => {
    const record = device.updateCloudDeviceName(`a\u0007b${'c'.repeat(60)}`)
    expect(record.name).toBe(`ab${'c'.repeat(38)}`)
  })
})

describe('detectDefaultName', () => {
  const run = (value: string | null) => async () => value

  it('uses scutil ComputerName on macOS', async () => {
    const calls: string[] = []
    const probe = async (file: string, args: string[]) => {
      calls.push(`${file} ${args.join(' ')}`)
      return '唐辰的 MacBook Pro\n'
    }
    await expect(device.detectDefaultName('darwin', probe)).resolves.toBe('唐辰的 MacBook Pro')
    expect(calls).toEqual(['scutil --get ComputerName'])
  })

  it('uses hostnamectl --pretty on Linux and falls back when it fails', async () => {
    await expect(device.detectDefaultName('linux', run('唐辰的工作站'))).resolves.toBe('唐辰的工作站')
    await expect(device.detectDefaultName('linux', run(null))).resolves.toBeNull()
  })

  it('does not spawn anything on Windows', async () => {
    const probe = vi.fn(async () => 'ignored')
    await expect(device.detectDefaultName('win32', probe)).resolves.toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('swallows a throwing probe', async () => {
    const probe = async () => {
      throw new Error('boom')
    }
    await expect(device.detectDefaultName('darwin', probe)).resolves.toBeNull()
  })
})

describe('ensureDeviceNameProbe', () => {
  it('upgrades the hostname default to the friendly system name', async () => {
    const record = await device.ensureDeviceNameProbe(async () => '唐辰的 MacBook Pro')
    expect(record.name).toBe('唐辰的 MacBook Pro')
    expect(record.defaultName).toBe('唐辰的 MacBook Pro')
  })

  it('never overrides a name the user typed', async () => {
    device.updateCloudDeviceName('客厅那台')
    const record = await device.ensureDeviceNameProbe(async () => '唐辰的 MacBook Pro')
    expect(record.name).toBe('客厅那台')
    expect(record.defaultName).toBe('唐辰的 MacBook Pro')
  })

  it('keeps the names when the probe finds nothing, but remembers it tried', async () => {
    const before = device.readCloudDevice()
    const after = await device.ensureDeviceNameProbe(async () => null)
    expect(after.name).toBe(before.name)
    expect(after.defaultName).toBe(before.defaultName)
    // 探不到也算「做过」：别让每次打开连接页都白 spawn 一次
    expect(after.probedAt).toBeTypeOf('number')
  })

  it('only probes once — a renamed machine does not silently change the name later', async () => {
    const detect = vi.fn(async () => '唐辰的 MacBook Pro')
    await device.ensureDeviceNameProbe(detect)
    expect(detect).toHaveBeenCalledTimes(1)

    const second = vi.fn(async () => '改过名字的 Mac')
    const record = await device.ensureDeviceNameProbe(second)
    expect(second).not.toHaveBeenCalled()
    expect(record.name).toBe('唐辰的 MacBook Pro')
  })

  it('reprobe follows the system rename but still respects a name the user typed', async () => {
    await device.ensureDeviceNameProbe(async () => '旧名字')
    device.updateCloudDeviceName('客厅那台')

    const forced = await device.reprobeDeviceName(async () => '新名字')
    expect(forced.defaultName).toBe('新名字')
    expect(forced.name).toBe('客厅那台')

    // 恢复默认名之后拿到的是重探到的新名字
    expect(device.updateCloudDeviceName('').name).toBe('新名字')
  })

  it('reprobe picks the new system name when the user never edited', async () => {
    await device.ensureDeviceNameProbe(async () => '旧名字')
    const forced = await device.reprobeDeviceName(async () => '新名字')
    expect(forced.name).toBe('新名字')
  })
})

describe('ensureDeviceIdentityOnBoot', () => {
  it('creates the identity without spawning anything and is idempotent', () => {
    const first = device.ensureDeviceIdentityOnBoot()
    expect(first?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(first?.name.length).toBeGreaterThan(0)
    // 启动路径不探测：probedAt 留空，等打开连接页再说
    expect(first?.probedAt).toBeNull()
    expect(device.ensureDeviceIdentityOnBoot()?.id).toBe(first?.id)
  })

  it('never throws, even when the data dir is unusable', () => {
    const dir = device.cloudDeviceDir()
    const blocker = path.join(dir, 'device.json')
    fs.mkdirSync(dir, { recursive: true })
    // 用目录占住文件路径：写必然失败
    fs.rmSync(blocker, { force: true })
    fs.mkdirSync(blocker, { recursive: true })
    try {
      expect(() => device.ensureDeviceIdentityOnBoot()).not.toThrow()
    } finally {
      fs.rmSync(blocker, { recursive: true, force: true })
    }
  })
})

describe('deviceAuthor', () => {
  it('carries a namespaced id, the current name, and is_bot: false', () => {
    const record = device.updateCloudDeviceName('家里的台式')
    expect(device.deviceAuthor(record)).toEqual({
      id: `pi-workbench/${record.id}`,
      name: '家里的台式',
      is_bot: false,
    })
  })

  it('picks up a rename on the very next call (no reconnect needed)', () => {
    device.updateCloudDeviceName('名字一')
    expect(device.deviceAuthor().name).toBe('名字一')
    device.updateCloudDeviceName('名字二')
    expect(device.deviceAuthor().name).toBe('名字二')
  })
})

describe('recordSessionDevice', () => {
  it('records which device started a session, once', () => {
    const first = device.recordSessionDevice('sess_1')
    const second = device.recordSessionDevice('sess_1')
    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    const index = device.readSessionDevices()
    expect(Object.keys(index)).toEqual(['sess_1'])
    expect(index.sess_1.deviceName.length).toBeGreaterThan(0)
    expect(index.sess_1.deviceId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('ignores blank session ids', () => {
    device.recordSessionDevice('   ')
    expect(device.readSessionDevices()).toEqual({})
  })

  it('drops junk entries instead of throwing on a hand-edited file', () => {
    fs.mkdirSync(device.cloudDeviceDir(), { recursive: true })
    fs.writeFileSync(
      device.deviceSessionsFile(),
      JSON.stringify({
        good: { deviceId: 'dev-1', deviceName: '本机', firstSeenAt: 1 },
        nullish: null,
        number: 42,
        noId: { deviceName: '缺 id' },
        blank: { deviceId: '', deviceName: '' },
        '': { deviceId: 'dev-2', deviceName: '空键' },
      }),
      'utf-8'
    )
    expect(device.readSessionDevices()).toEqual({
      good: { deviceId: 'dev-1', deviceName: '本机', firstSeenAt: 1 },
    })
  })
})
