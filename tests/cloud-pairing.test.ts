import { describe, expect, it } from 'vitest'
import {
  normalizePairingCode,
  normalizePairingGateway,
  parsePairingInput,
} from '../src/utils/cloudPairing'

describe('normalizePairingCode', () => {
  it('uppercases and strips spaces / hyphens', () => {
    expect(normalizePairingCode(' abcd-efgh ijkl ')).toBe('ABCDEFGHIJKL')
  })

  it('keeps an empty value empty', () => {
    expect(normalizePairingCode('  - ')).toBe('')
  })
})

describe('normalizePairingGateway', () => {
  it('keeps only the origin', () => {
    expect(normalizePairingGateway('https://hub.example.com/v1/')).toBe('https://hub.example.com')
  })

  it('rejects non-http protocols and garbage', () => {
    expect(normalizePairingGateway('ftp://hub.example.com')).toBe('')
    expect(normalizePairingGateway('not a url')).toBe('')
  })
})

describe('parsePairingInput', () => {
  it('accepts a bare code with the fallback gateway', () => {
    expect(parsePairingInput('abcde-fghij', 'https://hub.example.com')).toEqual({
      ok: true,
      gatewayUrl: 'https://hub.example.com',
      code: 'ABCDEFGHIJ',
    })
  })

  it('splits a full pairing link', () => {
    expect(
      parsePairingInput('https://hub.example.com/#pair=ABCDE-FGHIJ', 'https://fallback.test')
    ).toEqual({
      ok: true,
      gatewayUrl: 'https://hub.example.com',
      code: 'ABCDEFGHIJ',
    })
  })

  it('also accepts the code in the query string', () => {
    expect(parsePairingInput('https://hub.example.com/?pair=ABCDE-FGHIJ', '')).toEqual({
      ok: true,
      gatewayUrl: 'https://hub.example.com',
      code: 'ABCDEFGHIJ',
    })
  })

  it('reports a link without a code instead of sending the URL as a code', () => {
    expect(parsePairingInput('https://hub.example.com/', 'https://hub.example.com')).toEqual({
      ok: false,
      reason: 'missing_code',
    })
  })

  it('reports an empty code', () => {
    expect(parsePairingInput('   ', 'https://hub.example.com')).toEqual({
      ok: false,
      reason: 'missing_code',
    })
  })

  it('reports a bad fallback gateway', () => {
    expect(parsePairingInput('ABCDE-FGHIJ', 'not a url')).toEqual({
      ok: false,
      reason: 'bad_gateway',
    })
  })
})
