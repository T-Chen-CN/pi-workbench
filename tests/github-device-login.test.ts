import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  startDeviceFlow: vi.fn(),
  pollDeviceFlow: vi.fn(),
  saveGithubToken: vi.fn(),
  fetchGithubUser: vi.fn(),
  openExternal: vi.fn(),
  clientId: 'client-1' as string | null,
}))

vi.mock('electron', () => ({
  shell: { openExternal: mocks.openExternal },
}))

vi.mock('../electron/github-app', () => ({
  getGithubClientId: () => mocks.clientId,
}))

vi.mock('../electron/github-auth', () => ({
  GITHUB_DEVICE_VERIFICATION_URI: 'https://github.com/login/device',
  startDeviceFlow: mocks.startDeviceFlow,
  pollDeviceFlow: mocks.pollDeviceFlow,
  saveGithubToken: mocks.saveGithubToken,
  fetchGithubUser: mocks.fetchGithubUser,
}))

import {
  cancelGithubDeviceLogin,
  openGithubDeviceVerification,
  startGithubDeviceLogin,
} from '../electron/github-device-login'

const deviceStart = {
  success: true,
  deviceCode: 'dev-1',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  expiresIn: 900,
  interval: 5,
}

function sinks() {
  return { onEvent: vi.fn(), onComplete: vi.fn() }
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.clientId = 'client-1'
  mocks.startDeviceFlow.mockReset().mockResolvedValue({ ...deviceStart })
  mocks.pollDeviceFlow.mockReset()
  mocks.saveGithubToken.mockReset().mockResolvedValue(undefined)
  mocks.fetchGithubUser
    .mockReset()
    .mockResolvedValue({ login: 'octocat', name: null, avatarUrl: null })
  mocks.openExternal.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cancelGithubDeviceLogin()
  vi.useRealTimers()
})

describe('GitHub device login session', () => {
  it('polls until the user confirms and stores the token', async () => {
    mocks.pollDeviceFlow
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'success', token: 'gho-1' })
    const listener = sinks()

    const started = await startGithubDeviceLogin(listener)
    expect(started).toMatchObject({ success: true, userCode: 'ABCD-1234', interval: 5 })
    expect(mocks.startDeviceFlow).toHaveBeenCalledWith('client-1')
    expect(mocks.openExternal).toHaveBeenCalledWith('https://github.com/login/device')

    await vi.advanceTimersByTimeAsync(5000)
    expect(listener.onEvent).toHaveBeenCalledWith({ status: 'pending' })

    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.saveGithubToken).toHaveBeenCalledWith('gho-1')
    expect(listener.onComplete).toHaveBeenCalledWith({
      success: true,
      user: { login: 'octocat', name: null, avatarUrl: null },
    })
  })

  it('backs off when GitHub asks to slow down', async () => {
    mocks.pollDeviceFlow
      .mockResolvedValueOnce({ status: 'slow_down', interval: 10 })
      .mockResolvedValueOnce({ status: 'success', token: 'gho-1' })
    const listener = sinks()
    await startGithubDeviceLogin(listener)

    await vi.advanceTimersByTimeAsync(5000)
    expect(listener.onEvent).toHaveBeenCalledWith({ status: 'slow_down', interval: 10 })

    await vi.advanceTimersByTimeAsync(9999)
    expect(mocks.pollDeviceFlow).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(listener.onComplete).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
  })

  it.each(['expired', 'denied'] as const)('stops polling when the code is %s', async (status) => {
    mocks.pollDeviceFlow.mockResolvedValueOnce({ status, error: `${status}-error` })
    const listener = sinks()
    await startGithubDeviceLogin(listener)

    await vi.advanceTimersByTimeAsync(5000)
    expect(listener.onEvent).toHaveBeenCalledWith({ status, error: `${status}-error` })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.pollDeviceFlow).toHaveBeenCalledTimes(1)
  })

  it('retries network failures before giving up', async () => {
    mocks.pollDeviceFlow.mockResolvedValue({
      status: 'error',
      error: 'fetch failed',
      retryable: true,
    })
    const listener = sinks()
    await startGithubDeviceLogin(listener)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(listener.onEvent).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5000)
    expect(listener.onEvent).toHaveBeenCalledWith({ status: 'error', error: 'fetch failed' })
    expect(mocks.pollDeviceFlow).toHaveBeenCalledTimes(4)
  })

  it('does not retry terminal API errors', async () => {
    mocks.pollDeviceFlow.mockResolvedValue({
      status: 'error',
      error: 'incorrect_client_credentials',
      retryable: false,
    })
    const listener = sinks()
    await startGithubDeviceLogin(listener)

    await vi.advanceTimersByTimeAsync(5000)
    expect(listener.onEvent).toHaveBeenCalledWith({
      status: 'error',
      error: 'incorrect_client_credentials',
    })
    expect(mocks.pollDeviceFlow).toHaveBeenCalledTimes(1)
  })

  it('stops polling after cancellation', async () => {
    mocks.pollDeviceFlow.mockResolvedValue({ status: 'pending' })
    const listener = sinks()
    await startGithubDeviceLogin(listener)

    expect(cancelGithubDeviceLogin()).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.pollDeviceFlow).not.toHaveBeenCalled()
  })

  it('keeps a single login session at a time', async () => {
    mocks.pollDeviceFlow.mockResolvedValue({ status: 'pending' })
    await startGithubDeviceLogin(sinks())
    await startGithubDeviceLogin(sinks())

    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.pollDeviceFlow).toHaveBeenCalledTimes(1)
  })

  it('fails when no client id is available', async () => {
    mocks.clientId = null
    const result = await startGithubDeviceLogin(sinks())
    expect(result).toEqual({ success: false, error: 'CLIENT_ID_NOT_CONFIGURED' })
    expect(mocks.startDeviceFlow).not.toHaveBeenCalled()
  })

  it('reopens the verification page', async () => {
    mocks.pollDeviceFlow.mockResolvedValue({ status: 'pending' })
    await startGithubDeviceLogin(sinks())

    await expect(openGithubDeviceVerification()).resolves.toBe(true)
    expect(mocks.openExternal).toHaveBeenLastCalledWith('https://github.com/login/device')

    cancelGithubDeviceLogin()
    await expect(openGithubDeviceVerification()).resolves.toBe(true)
    expect(mocks.openExternal).toHaveBeenLastCalledWith('https://github.com/login/device')
  })
})
