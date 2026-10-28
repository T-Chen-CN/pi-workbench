import { describe, expect, it, vi } from 'vitest'

const protocolMock = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd(), isPackaged: false },
  protocol: protocolMock
}))

const { registerSchemePrivileges, SCHEME_PRIVILEGES } = await import('../electron/scheme-privileges.js')
const { APP_SCHEME } = await import('../electron/app-protocol.js')
const { FILE_SCHEME } = await import('../electron/file-protocol.js')

describe('scheme privileges', () => {
  it('declares both schemes in a single call', () => {
    protocolMock.registerSchemesAsPrivileged.mockClear()
    registerSchemePrivileges()

    // Electron 只保留最后一次 registerSchemesAsPrivileged 的调用，分两次注册会让
    // 先注册的 scheme 丢掉 standard / secure / fetch / stream 特权
    expect(protocolMock.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1)
    const [schemes] = protocolMock.registerSchemesAsPrivileged.mock.calls[0] as [
      { scheme: string; privileges: Record<string, boolean> }[]
    ]
    expect(schemes.map((item) => item.scheme)).toEqual([APP_SCHEME, FILE_SCHEME])
  })

  it('keeps the privileges media elements, iframes and fetch need', () => {
    expect(SCHEME_PRIVILEGES).toEqual({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: false
    })
  })

  it('passes a fresh privileges object per scheme', () => {
    protocolMock.registerSchemesAsPrivileged.mockClear()
    registerSchemePrivileges()
    const [schemes] = protocolMock.registerSchemesAsPrivileged.mock.calls[0] as [
      { privileges: Record<string, boolean> }[]
    ]
    expect(schemes[0].privileges).not.toBe(schemes[1].privileges)
    expect(schemes[0].privileges).toEqual(schemes[1].privileges)
  })
})
