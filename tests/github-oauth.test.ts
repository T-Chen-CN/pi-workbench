import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => ({ appDir: '' }))
const shellMock = vi.hoisted(() => ({ openExternal: vi.fn() }))

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
  shell: shellMock,
}))

import { readGithubAuth } from '../electron/github-auth'
import {
  completeGithubOAuth,
  isGithubCallbackUrl,
  startGithubOAuth,
} from '../electron/github-oauth'

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  } as Response
}

describe('GitHub OAuth web flow', () => {
  const fetchMock = vi.fn()

  beforeEach(async () => {
    state.appDir = await fs.mkdtemp(path.join(tmpdir(), 'pi-github-oauth-test-'))
    await fs.mkdir(path.join(state.appDir, 'config'), { recursive: true })
    await fs.writeFile(
      path.join(state.appDir, 'config', 'github-oauth.json'),
      JSON.stringify({ clientId: 'test-client', clientSecret: 'test-secret' }),
      'utf8'
    )
    delete process.env.PI_WORKBENCH_GITHUB_CLIENT_ID
    delete process.env.PI_WORKBENCH_GITHUB_CLIENT_SECRET
    fetchMock.mockReset()
    shellMock.openExternal.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await fs.rm(state.appDir, { recursive: true, force: true })
  })

  it('builds an authorization URL with PKCE and opens the browser', async () => {
    const start = await startGithubOAuth()
    expect(start.success).toBe(true)
    expect(start.authUrl).toBeTruthy()
    const url = new URL(start.authUrl!)
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('test-client')
    expect(url.searchParams.get('redirect_uri')).toBe('pi-workbench://oauth')
    expect(url.searchParams.get('scope')).toBe('repo read:user')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(shellMock.openExternal).toHaveBeenCalledWith(start.authUrl)
  })

  it('exchanges the code with the verifier and stores the token', async () => {
    const start = await startGithubOAuth()
    const stateParam = new URL(start.authUrl!).searchParams.get('state')!
    fetchMock
      .mockResolvedValueOnce(response({ access_token: 'gho_test' }))
      .mockResolvedValueOnce(
        response({ login: 'octocat', name: 'Octo Cat', avatar_url: 'https://example.com/a.png' })
      )

    const result = await completeGithubOAuth(
      `pi-workbench://oauth?code=abc123&state=${encodeURIComponent(stateParam)}`
    )
    expect(result.success).toBe(true)
    expect(result.user?.login).toBe('octocat')
    await expect(readGithubAuth()).resolves.toMatchObject({ token: 'gho_test' })

    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0]
    expect(String(tokenUrl)).toBe('https://github.com/login/oauth/access_token')
    const body = String((tokenOptions as RequestInit).body)
    expect(body).toContain('code=abc123')
    expect(body).toContain('client_id=test-client')
    expect(body).toContain('client_secret=test-secret')
    expect(body).toContain('code_verifier=')
    expect(body).toContain('redirect_uri=pi-workbench%3A%2F%2Foauth')
  })

  it('rejects a callback with a wrong state without calling GitHub', async () => {
    await startGithubOAuth()
    const result = await completeGithubOAuth('pi-workbench://oauth?code=abc&state=wrong')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/state/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('recognizes only the expected callback URL', () => {
    expect(isGithubCallbackUrl('pi-workbench://oauth?code=a&state=b')).toBe(true)
    expect(isGithubCallbackUrl('pi-workbench://oauth/')).toBe(true)
    expect(isGithubCallbackUrl('pi-workbench://other?code=a')).toBe(false)
    expect(isGithubCallbackUrl('https://github.com/login/oauth/authorize')).toBe(false)
  })

  it('reports a missing OAuth App configuration', async () => {
    await fs.rm(path.join(state.appDir, 'config', 'github-oauth.json'))
    const result = await startGithubOAuth()
    expect(result.success).toBe(false)
    expect(result.error).toBe('OAUTH_APP_NOT_CONFIGURED')
  })
})
