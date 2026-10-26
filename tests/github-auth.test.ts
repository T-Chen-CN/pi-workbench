import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({ appDir: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => state.appDir,
    getPath: () => '',
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
  },
}))

import {
  clearGithubToken,
  fetchGithubUser,
  pollDeviceFlow,
  readGithubAuth,
  saveGithubClientId,
  saveGithubToken,
  startDeviceFlow,
} from '../electron/github-auth'

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  } as Response
}

describe('GitHub device flow', () => {
  const fetchMock = vi.fn()

  beforeEach(async () => {
    state.appDir = await fs.mkdtemp(path.join(tmpdir(), 'pi-github-test-'))
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await fs.rm(state.appDir, { recursive: true, force: true })
  })

  it('starts a device flow and returns the user code', async () => {
    fetchMock.mockResolvedValueOnce(
      response({
        device_code: 'device-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      })
    )
    const result = await startDeviceFlow('client-1')
    expect(result).toMatchObject({
      success: true,
      deviceCode: 'device-1',
      userCode: 'ABCD-1234',
      interval: 5,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.com/login/device/code',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('requires a client id', async () => {
    const result = await startDeviceFlow('')
    expect(result.success).toBe(false)
    expect(result.error).toBe('CLIENT_ID_REQUIRED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('handles pending, slow_down, success, expired and denied polls', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(response({ error: 'slow_down', interval: 10 }))
      .mockResolvedValueOnce(response({ access_token: 'gho_token', scope: 'repo' }))
      .mockResolvedValueOnce(response({ error: 'expired_token' }))
      .mockResolvedValueOnce(response({ error: 'access_denied' }))

    await expect(pollDeviceFlow('client-1', 'device-1')).resolves.toEqual({
      status: 'pending',
    })
    await expect(pollDeviceFlow('client-1', 'device-1')).resolves.toEqual({
      status: 'slow_down',
      interval: 10,
    })
    await expect(pollDeviceFlow('client-1', 'device-1')).resolves.toEqual({
      status: 'success',
      token: 'gho_token',
      scope: 'repo',
    })
    await expect(pollDeviceFlow('client-1', 'device-1')).resolves.toMatchObject({
      status: 'expired',
    })
    await expect(pollDeviceFlow('client-1', 'device-1')).resolves.toMatchObject({
      status: 'denied',
    })
  })

  it('fetches the authenticated GitHub user', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ login: 'octocat', name: 'Octo Cat', avatar_url: 'https://example.com/a.png' })
    )
    await expect(fetchGithubUser('gho_token')).resolves.toEqual({
      login: 'octocat',
      name: 'Octo Cat',
      avatarUrl: 'https://example.com/a.png',
    })
  })

  it('stores the token encrypted and keeps the client id', async () => {
    await saveGithubClientId('client-1')
    await saveGithubToken('gho_secret')
    const auth = await readGithubAuth()
    expect(auth).toEqual({ token: 'gho_secret', clientId: 'client-1' })

    const raw = await fs.readFile(path.join(state.appDir, 'config', 'github.json'), 'utf8')
    expect(raw).not.toContain('gho_secret')
    expect(JSON.parse(raw).token).toMatch(/^enc:/)

    await clearGithubToken()
    await expect(readGithubAuth()).resolves.toEqual({ token: null, clientId: 'client-1' })
  })
})
