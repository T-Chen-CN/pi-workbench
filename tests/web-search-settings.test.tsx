// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSearchSettings } from '../src/components/WebSearchSettings'
import { useI18nStore } from '../src/store/i18nStore'
import { api } from '../src/api'
import { translations } from '../src/i18n/translations'

vi.mock('../src/api', () => ({
  api: {
    webSearchGet: vi.fn(async () => ({
      success: true,
      config: { provider: null, endpoint: 'china', keys: {} },
    })),
    webSearchSave: vi.fn(async () => ({ success: true })),
  },
}))

beforeEach(() => {
  useI18nStore.setState({ language: 'zh' })
  vi.mocked(api.webSearchGet).mockResolvedValue({
    success: true,
    config: { provider: null, endpoint: 'china', keys: {} },
  })
  vi.mocked(api.webSearchSave).mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WebSearchSettings', () => {
  it('lists every provider and starts without a selection', async () => {
    render(<WebSearchSettings />)

    expect(await screen.findByText(translations.zh.webSearchProviderDefault)).toBeTruthy()
    for (const label of [
      translations.zh.webSearchProviderTavily,
      translations.zh.webSearchProviderBocha,
      translations.zh.webSearchProviderZai,
      translations.zh.webSearchProviderDuckDuckGo,
    ]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('refuses to save a provider that needs a key', async () => {
    render(<WebSearchSettings />)

    fireEvent.click(await screen.findByText(translations.zh.webSearchProviderBocha))
    fireEvent.click(screen.getByRole('button', { name: translations.zh.webSearchSave }))

    await waitFor(() => expect(api.webSearchSave).not.toHaveBeenCalled())
  })

  it('saves the selected provider together with its key', async () => {
    render(<WebSearchSettings />)

    fireEvent.click(await screen.findByText(translations.zh.webSearchProviderBocha))
    fireEvent.change(screen.getByLabelText(translations.zh.webSearchApiKey), {
      target: { value: 'sk-bocha' },
    })
    fireEvent.click(screen.getByRole('button', { name: translations.zh.webSearchSave }))

    await waitFor(() => expect(api.webSearchSave).toHaveBeenCalled())
    expect(vi.mocked(api.webSearchSave).mock.calls[0][0]).toMatchObject({
      provider: 'bocha',
      keys: { bocha: 'sk-bocha' },
    })
  })

  it('lets Exa save without a key', async () => {
    render(<WebSearchSettings />)

    fireEvent.click(await screen.findByText(translations.zh.webSearchProviderExa))
    fireEvent.click(screen.getByRole('button', { name: translations.zh.webSearchSave }))

    await waitFor(() => expect(api.webSearchSave).toHaveBeenCalled())
    expect(vi.mocked(api.webSearchSave).mock.calls[0][0]).toMatchObject({
      provider: 'exa',
    })
  })

  it('shows the endpoint selector only for Z.ai', async () => {
    render(<WebSearchSettings />)

    fireEvent.click(await screen.findByText(translations.zh.webSearchProviderBocha))
    expect(screen.queryByLabelText(translations.zh.webSearchEndpoint)).toBeNull()

    fireEvent.click(screen.getByText(translations.zh.webSearchProviderZai))
    expect(screen.getByLabelText(translations.zh.webSearchEndpoint)).toBeTruthy()
  })
})
