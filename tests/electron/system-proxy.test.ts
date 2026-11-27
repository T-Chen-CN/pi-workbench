import { afterEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  ready: true,
  netFetch: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    isReady: () => electronMock.ready,
  },
  net: {
    fetch: (...args: unknown[]) => electronMock.netFetch(...args),
  },
}))

import {
  createSystemProxyFetch,
  extractHttpUrl,
  installSystemProxy,
  refreshSystemProxy,
  uninstallSystemProxy,
} from '../../electron/system-proxy'

afterEach(() => {
  uninstallSystemProxy()
  electronMock.ready = true
  electronMock.netFetch.mockReset()
})

describe('extractHttpUrl', () => {
  it('accepts http and https strings, URLs, and Request objects', () => {
    expect(extractHttpUrl('https://generativelanguage.googleapis.com/v1beta/models')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models'
    )
    expect(extractHttpUrl(new URL('http://127.0.0.1:11434/v1/models'))).toBe(
      'http://127.0.0.1:11434/v1/models'
    )
    expect(extractHttpUrl(new Request('https://api.openai.com/v1/responses'))).toBe(
      'https://api.openai.com/v1/responses'
    )
  })

  it('rejects non-http(s) schemes and invalid URLs', () => {
    expect(extractHttpUrl('file:///tmp/a.txt')).toBeNull()
    expect(extractHttpUrl('data:text/plain,hello')).toBeNull()
    expect(extractHttpUrl('pw-app://index.html')).toBeNull()
    expect(extractHttpUrl('/relative/path')).toBeNull()
  })
})

describe('createSystemProxyFetch', () => {
  it('routes http(s) requests to net.fetch when enabled and ready', async () => {
    const baseFetch = vi.fn(async () => new Response('base'))
    const netFetch = vi.fn(async () => new Response('net'))
    const wrapped = createSystemProxyFetch({
      isEnabled: () => true,
      isAppReady: () => true,
      baseFetch,
      netFetch,
    })

    const ac = new AbortController()
    const res = await wrapped('https://example.com/api', {
      method: 'POST',
      headers: { authorization: 'Bearer test' },
      body: '{}',
      signal: ac.signal,
    })

    expect(await res.text()).toBe('net')
    expect(baseFetch).not.toHaveBeenCalled()
    expect(netFetch).toHaveBeenCalledWith('https://example.com/api', {
      method: 'POST',
      headers: { authorization: 'Bearer test' },
      body: '{}',
      signal: ac.signal,
      bypassCustomProtocolHandlers: true,
    })
  })

  it('normalizes URL inputs to string and preserves Request inputs for net.fetch', async () => {
    const baseFetch = vi.fn(async () => new Response('base'))
    const netFetch = vi.fn(async () => new Response('net'))
    const wrapped = createSystemProxyFetch({
      isEnabled: () => true,
      isAppReady: () => true,
      baseFetch,
      netFetch,
    })

    await wrapped(new URL('https://example.com/from-url'))
    expect(netFetch).toHaveBeenNthCalledWith(1, 'https://example.com/from-url', {
      bypassCustomProtocolHandlers: true,
    })

    const req = new Request('https://example.com/from-request', { method: 'POST', body: 'hi' })
    await wrapped(req)
    expect(netFetch).toHaveBeenNthCalledWith(2, req, {
      bypassCustomProtocolHandlers: true,
    })
  })

  it('falls back to baseFetch when disabled, app not ready, netFetch missing, or non-http(s)', async () => {
    let enabled = false
    let ready = true
    const baseFetch = vi.fn(async () => new Response('base'))
    const netFetch = vi.fn(async () => new Response('net'))
    const wrapped = createSystemProxyFetch({
      isEnabled: () => enabled,
      isAppReady: () => ready,
      baseFetch,
      netFetch,
    })

    // disabled -> baseFetch
    await wrapped('https://example.com/1')
    expect(baseFetch).toHaveBeenCalledTimes(1)
    expect(netFetch).not.toHaveBeenCalled()

    // enabled + not ready -> baseFetch
    enabled = true
    ready = false
    await wrapped('https://example.com/2')
    expect(baseFetch).toHaveBeenCalledTimes(2)
    expect(netFetch).not.toHaveBeenCalled()

    // enabled + ready + non-http(s) -> baseFetch
    ready = true
    await wrapped('data:text/plain,abc')
    expect(baseFetch).toHaveBeenCalledTimes(3)
    expect(netFetch).not.toHaveBeenCalled()

    // enabled + ready + http(s) -> netFetch (same wrapper instance hot-switches)
    await wrapped('https://example.com/3')
    expect(netFetch).toHaveBeenCalledTimes(1)

    // netFetch null -> baseFetch
    const noNet = createSystemProxyFetch({
      isEnabled: () => true,
      isAppReady: () => true,
      baseFetch,
      netFetch: null,
    })
    await noNet('https://example.com/4')
    expect(baseFetch).toHaveBeenCalledTimes(4)
  })
})

describe('installSystemProxy', () => {
  it('hot-toggles globalThis.fetch, logs state transitions once, and restores on uninstall', async () => {
    const saved = globalThis.fetch
    const stubBase = vi.fn(async () => new Response('base'))
    globalThis.fetch = stubBase as unknown as typeof globalThis.fetch
    electronMock.netFetch.mockResolvedValue(new Response('net'))

    let enabled = true
    const logger = { log: vi.fn(), warn: vi.fn() }

    try {
      installSystemProxy({ getEnabled: () => enabled, logger })
      expect(logger.log).toHaveBeenCalledTimes(1)
      expect(logger.log).toHaveBeenLastCalledWith('[Main] System proxy enabled')

      const capturedFetch = globalThis.fetch
      const r1 = await capturedFetch('https://example.com/a')
      expect(await r1.text()).toBe('net')
      expect(electronMock.netFetch).toHaveBeenCalledTimes(1)

      // 相同状态重复刷新不重复打日志
      refreshSystemProxy()
      expect(logger.log).toHaveBeenCalledTimes(1)

      // 关闭后，即便调用方缓存了早期 fetch 引用，也能立刻切回原始 fetch
      enabled = false
      refreshSystemProxy()
      expect(logger.log).toHaveBeenCalledTimes(2)
      expect(logger.log).toHaveBeenLastCalledWith('[Main] System proxy disabled')

      const r2 = await capturedFetch('https://example.com/b')
      expect(await r2.text()).toBe('base')
      expect(stubBase).toHaveBeenCalledTimes(1)

      uninstallSystemProxy()
      expect(globalThis.fetch).toBe(stubBase)
    } finally {
      uninstallSystemProxy()
      globalThis.fetch = saved
    }
  })
})
