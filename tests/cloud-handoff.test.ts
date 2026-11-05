import { describe, expect, it } from 'vitest'
import {
  HANDOFF_MAX_BYTES,
  maskSecret,
  parseHandoff,
  pendingPatch,
  toPreview,
} from '../electron/cloud/handoff'

/** 一份「标准」交接文件：后续用例在此基础上做变形 */
function handoff(overrides: Record<string, string | null> = {}, header = 'v1'): string {
  const base: Record<string, string | null> = {
    PROFILE: 'pi-cloud',
    API_BASE_URL: 'https://api.example.com',
    API_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    DASHBOARD_URL: 'https://dash.example.com',
    DASHBOARD_USER: 'admin',
    DASHBOARD_PASSWORD: 'p@ss=word',
    DASHBOARD_SESSION_TOKEN: null,
    AUTH_MODE: 'basic',
    HERMES_VERSION: '0.9.1',
    SERVER_HOST: '1.2.3.4',
    GENERATED_AT: '2026-11-06T01:00:00Z',
    DNS_OK: 'true',
    CAPABILITIES_HTTP: '200',
    TLS_NOT_AFTER: '2027-02-01T00:00:00Z',
    DASHBOARD_HTTP: '200',
    SSE_OK: 'true',
    ...overrides,
  }
  const body = Object.entries(base)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  return `# hermes-handoff ${header}\n# 本文件含明文密钥，导入后请删除\n${body}\n# ---- 校验结果 ----\n`
}

function parseOk(text: string) {
  const result = parseHandoff(text)
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`)
  return result.data
}

function warningCodes(text: string): string[] {
  return parseOk(text).warnings.map((warning) => warning.code)
}

describe('parseHandoff', () => {
  it('parses a v1 handoff file', () => {
    const data = parseOk(handoff())
    expect(data.version).toBe('v1')
    expect(data.baseUrl).toBe('https://api.example.com')
    expect(data.apiKey).toBe('abcdefghijklmnopqrstuvwxyz0123456789ABCD')
    expect(data.dashboardUrl).toBe('https://dash.example.com')
    expect(data.dashboardUser).toBe('admin')
    expect(data.dashboardPassword).toBe('p@ss=word')
    expect(data.authMode).toBe('basic')
    expect(data.profile).toBe('pi-cloud')
    expect(data.hermesVersion).toBe('0.9.1')
    expect(data.serverHost).toBe('1.2.3.4')
    expect(data.generatedAt).toBe('2026-11-06T01:00:00Z')
    expect(data.checks).toEqual({
      dnsOk: true,
      capabilitiesHttp: 200,
      dashboardHttp: 200,
      sseOk: true,
      tlsNotAfter: '2027-02-01T00:00:00Z',
    })
    expect(data.warnings.map((warning) => warning.code)).toEqual(['no_dashboard_token'])
  })

  it('recognises v1.1 and picks up the dashboard session token', () => {
    const data = parseOk(handoff({ DASHBOARD_SESSION_TOKEN: 'tok-123' }, 'v1.1'))
    expect(data.version).toBe('v1.1')
    expect(data.dashboardToken).toBe('tok-123')
    expect(data.warnings.map((warning) => warning.code)).not.toContain('no_dashboard_token')
  })

  it('tolerates BOM and CRLF', () => {
    const text = `\uFEFF${handoff().replace(/\n/g, '\r\n')}`
    expect(parseOk(text).baseUrl).toBe('https://api.example.com')
  })

  it('accepts spaces around the separator and quoted values', () => {
    const text = `# hermes-handoff v1\nAPI_BASE_URL = "https://api.example.com"\nAPI_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCD"\n`
    const data = parseOk(text)
    expect(data.baseUrl).toBe('https://api.example.com')
    expect(data.apiKey).toBe('abcdefghijklmnopqrstuvwxyz0123456789ABCD')
  })

  it('strips inline comments that follow whitespace', () => {
    const data = parseOk(handoff({ AUTH_MODE: 'none            # basic | form | none' }))
    expect(data.authMode).toBe('none')
    expect(data.warnings.map((warning) => warning.code)).not.toContain('unknown_auth_mode')
  })

  it('keeps the last value when a key repeats, and warns about it', () => {
    const text = `# hermes-handoff v1\nAPI_BASE_URL=https://old.example.com\nAPI_BASE_URL=https://api.example.com\nAPI_KEY=abcdefghijklmnopqrstuvwxyz0123456789ABCD\n`
    const data = parseOk(text)
    expect(data.baseUrl).toBe('https://api.example.com')
    expect(warningCodes(text)).toContain('duplicate_key')
  })

  it('records unknown keys by name only', () => {
    const text = `${handoff()}\nSOMETHING_NEW=whatever\n`
    const data = parseOk(text)
    expect(data.ignored).toContain('SOMETHING_NEW')
    expect(JSON.stringify(data.ignored)).not.toContain('whatever')
  })

  it('derives the dashboard url when the file omits it', () => {
    const data = parseOk(handoff({ DASHBOARD_URL: null }))
    expect(data.dashboardUrl).toBe('https://dash.example.com')
  })

  it('strips a trailing /v1 from the api url', () => {
    expect(parseOk(handoff({ API_BASE_URL: 'https://api.example.com/v1/' })).baseUrl).toBe(
      'https://api.example.com'
    )
  })

  it('rejects files without the hermes-handoff header', () => {
    const result = parseHandoff('API_BASE_URL=https://api.example.com\n')
    expect(result).toEqual({ ok: false, code: 'not_handoff' })
  })

  it('rejects empty files', () => {
    expect(parseHandoff('')).toEqual({ ok: false, code: 'not_handoff' })
  })

  it('rejects a missing base url', () => {
    expect(parseHandoff(handoff({ API_BASE_URL: null }))).toEqual({
      ok: false,
      code: 'missing_base_url',
    })
  })

  it('rejects an unparsable base url', () => {
    expect(parseHandoff(handoff({ API_BASE_URL: 'ftp://api.example.com' }))).toEqual({
      ok: false,
      code: 'bad_base_url',
    })
  })

  it('rejects a missing api key', () => {
    expect(parseHandoff(handoff({ API_KEY: null }))).toEqual({ ok: false, code: 'missing_key' })
  })

  it('rejects an api key containing whitespace', () => {
    expect(parseHandoff(handoff({ API_KEY: 'abc def' }))).toEqual({ ok: false, code: 'bad_key' })
  })

  it('rejects binary content', () => {
    expect(parseHandoff('# hermes-handoff v1\nAPI_KEY=a\u0000b')).toEqual({
      ok: false,
      code: 'binary',
    })
  })

  it('rejects oversized files', () => {
    const huge = `# hermes-handoff v1\nAPI_KEY=${'a'.repeat(HANDOFF_MAX_BYTES)}`
    expect(parseHandoff(huge)).toEqual({ ok: false, code: 'too_large' })
  })

  it('allows plain http for loopback addresses only', () => {
    const loopback = warningCodes(handoff({ API_BASE_URL: 'http://127.0.0.1:8642' }))
    expect(loopback).not.toContain('http_not_loopback')
    const publicHost = warningCodes(handoff({ API_BASE_URL: 'http://api.example.com' }))
    expect(publicHost).toContain('http_not_loopback')
  })

  it('warns about a short api key', () => {
    expect(warningCodes(handoff({ API_KEY: 'short-key-123456' }))).toContain('short_key')
  })

  it('warns when the file reports a failed capability probe', () => {
    expect(warningCodes(handoff({ CAPABILITIES_HTTP: '401' }))).toContain('capabilities_not_ok')
  })

  it('warns when the certificate expires within a week', () => {
    expect(warningCodes(handoff({ TLS_NOT_AFTER: '2020-01-01T00:00:00Z' }))).toContain(
      'tls_expiring'
    )
  })

  it('falls back to basic auth for unknown modes', () => {
    const data = parseOk(handoff({ AUTH_MODE: 'saml' }))
    expect(data.authMode).toBe('basic')
    expect(data.warnings.map((warning) => warning.code)).toContain('unknown_auth_mode')
  })
})

describe('maskSecret', () => {
  it('keeps enough of a long key to recognise it', () => {
    expect(maskSecret('abcdefghijklmnop')).toBe('abc****mnop')
  })

  it('masks medium keys harder', () => {
    expect(maskSecret('abcdefgh')).toBe('ab****gh')
  })

  it('fully masks short keys', () => {
    expect(maskSecret('abcdef')).toBe('******')
    expect(maskSecret('')).toBe('')
  })
})

describe('toPreview', () => {
  it('never leaks the plaintext secrets', () => {
    const data = parseOk(handoff({ DASHBOARD_SESSION_TOKEN: 'tok-123' }, 'v1.1'))
    const preview = toPreview(data, 'pi-cloud-20261106-0123.txt')
    expect(preview.fileName).toBe('pi-cloud-20261106-0123.txt')
    const serialized = JSON.stringify(preview)
    expect(serialized).not.toContain(data.apiKey)
    expect(serialized).not.toContain('p@ss=word')
    expect(serialized).not.toContain('tok-123')
    expect(preview.keyMask).toBe('abc****ABCD')
    expect(preview.hasDashboardPassword).toBe(true)
    expect(preview.hasDashboardToken).toBe(true)
  })
})

describe('pendingPatch', () => {
  it('drops empty optional fields so the existing values survive', () => {
    const data = parseOk(handoff({ DASHBOARD_SESSION_TOKEN: null, DASHBOARD_USER: null }))
    const patch = pendingPatch(data)
    expect(patch.apiKey).toBe(data.apiKey)
    expect(patch.dashboardUrl).toBe('https://dash.example.com')
    expect(patch.dashboardToken).toBeUndefined()
    expect(patch.dashboardUser).toBeUndefined()
    expect(patch.handoffProfile).toBe('pi-cloud')
  })
})
