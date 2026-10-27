// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CompletePayload = {
  success: boolean
  user?: { login: string; name: string | null; avatarUrl: string | null } | null
  error?: string
}

type DevicePayload = {
  status: 'pending' | 'slow_down' | 'expired' | 'denied' | 'error'
  interval?: number
  error?: string
}

const listeners = vi.hoisted(() => ({
  complete: null as ((payload: CompletePayload) => void) | null,
  device: null as ((payload: DevicePayload) => void) | null,
}))

const apiMock = vi.hoisted(() => ({
  githubAuthStatus: vi.fn(),
  githubAuthDeviceStart: vi.fn(),
  githubAuthDeviceCancel: vi.fn(),
  githubAuthDeviceOpen: vi.fn(),
  githubAuthLogout: vi.fn(),
  onGithubAuthComplete: vi.fn((callback: (payload: CompletePayload) => void) => {
    listeners.complete = callback
    return () => {
      listeners.complete = null
    }
  }),
  onGithubAuthDeviceEvent: vi.fn((callback: (payload: DevicePayload) => void) => {
    listeners.device = callback
    return () => {
      listeners.device = null
    }
  }),
  gitSetGithubToken: vi.fn(async () => ({ success: true })),
}))

vi.mock('../src/api', () => ({ api: apiMock }))

import { GithubSettings } from '../src/components/GithubSettings'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'

beforeEach(() => {
  useI18nStore.setState({ language: 'zh' })
  listeners.complete = null
  listeners.device = null
  apiMock.githubAuthStatus.mockReset().mockResolvedValue({ success: true, configured: false })
  apiMock.githubAuthDeviceStart.mockReset().mockResolvedValue({
    success: true,
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    expiresIn: 900,
    interval: 5,
  })
  apiMock.githubAuthDeviceCancel.mockReset().mockResolvedValue({ success: true, cancelled: true })
  apiMock.githubAuthDeviceOpen.mockReset().mockResolvedValue({ success: true })
  apiMock.githubAuthLogout.mockReset().mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
})

describe('GithubSettings', () => {
  it('offers the device login entry without configuration warnings', async () => {
    render(<GithubSettings />)

    expect(
      await screen.findByRole('button', { name: translations.zh.githubLink })
    ).toBeTruthy()
    expect(screen.queryByText(/github-oauth\.json/)).toBeNull()
  })

  it('shows the one-time code after starting', async () => {
    render(<GithubSettings />)

    fireEvent.click(await screen.findByRole('button', { name: translations.zh.githubLink }))

    expect(await screen.findByText('ABCD-1234')).toBeTruthy()
    expect(screen.getByText(translations.zh.githubWaiting)).toBeTruthy()
    expect(screen.getByText(translations.zh.githubOpenBrowser)).toBeTruthy()
    expect(apiMock.githubAuthDeviceStart).toHaveBeenCalled()
  })

  it('surfaces an expired code and clears the prompt', async () => {
    render(<GithubSettings />)

    fireEvent.click(await screen.findByRole('button', { name: translations.zh.githubLink }))
    await screen.findByText('ABCD-1234')

    act(() => listeners.device?.({ status: 'expired' }))

    expect(screen.getByText(translations.zh.githubCodeExpired)).toBeTruthy()
    expect(screen.queryByText('ABCD-1234')).toBeNull()
  })

  it('shows the linked account when the login completes', async () => {
    render(<GithubSettings />)

    act(() =>
      listeners.complete?.({
        success: true,
        user: { login: 'octocat', name: null, avatarUrl: null },
      })
    )

    expect(await screen.findByText('@octocat')).toBeTruthy()
    expect(screen.getByText(translations.zh.githubUnlink)).toBeTruthy()
  })

  it('cancels a pending login', async () => {
    render(<GithubSettings />)

    fireEvent.click(await screen.findByRole('button', { name: translations.zh.githubLink }))
    await screen.findByText('ABCD-1234')

    fireEvent.click(screen.getByRole('button', { name: translations.zh.cancel }))

    expect(
      await screen.findByRole('button', { name: translations.zh.githubLink })
    ).toBeTruthy()
    expect(apiMock.githubAuthDeviceCancel).toHaveBeenCalled()
  })
})
