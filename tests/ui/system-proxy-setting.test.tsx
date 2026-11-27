// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '../../src/components/settings/Settings'
import { useI18nStore } from '../../src/store/i18nStore'
import { useSettingsStore } from '../../src/store/settingsStore'
import { api } from '../../src/api'

vi.mock('../../src/api', () => ({
  api: {
    getSettings: vi.fn(async () => ({ success: true, settings: {} })),
    saveSettings: vi.fn(async () => ({ success: true })),
    apiConfigGet: vi.fn(async () => ({ success: false })),
    appGetInfo: vi.fn(async () => ({ success: false })),
  },
}))

beforeEach(() => {
  useI18nStore.setState({ language: 'zh' })
  useSettingsStore.setState({ useSystemProxy: true })
  vi.mocked(api.getSettings).mockResolvedValue({ success: true, settings: {} } as never)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('system proxy setting', () => {
  it('shows the system proxy toggle checked by default', () => {
    render(<Settings initialSection="general" />)
    const checkbox = screen.getByLabelText('使用系统代理') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
  })

  it('toggles system proxy off and persists it to settings.json', async () => {
    render(<Settings initialSection="general" />)
    const checkbox = screen.getByLabelText('使用系统代理') as HTMLInputElement
    fireEvent.click(checkbox)

    expect(useSettingsStore.getState().useSystemProxy).toBe(false)
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    const calls = vi.mocked(api.saveSettings).mock.calls
    expect(calls[calls.length - 1]?.[0]).toMatchObject({
      useSystemProxy: false,
    })
  })
})
