// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '../src/components/Settings'
import { useI18nStore } from '../src/store/i18nStore'
import { useSettingsStore } from '../src/store/settingsStore'
import { api } from '../src/api'

vi.mock('../src/api', () => ({
  api: {
    getSettings: vi.fn(async () => ({ success: true, settings: {} })),
    saveSettings: vi.fn(async () => ({ success: true })),
    apiConfigGet: vi.fn(async () => ({ success: false })),
    appGetInfo: vi.fn(async () => ({ success: false })),
  },
}))

beforeEach(() => {
  useI18nStore.setState({ language: 'zh' })
  useSettingsStore.setState({ closeToTray: true })
  vi.mocked(api.getSettings).mockResolvedValue({ success: true, settings: {} } as never)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('close to tray setting', () => {
  it('shows the tray option as checked by default', () => {
    render(<Settings initialSection="general" />)
    expect(screen.getByText('关闭主窗口')).toBeTruthy()
    expect(screen.getByText('收进托盘')).toBeTruthy()
    const checkbox = screen
      .getByText('收进托盘')
      .closest('label')
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
  })

  it('turns the option off and persists it to settings.json', async () => {
    render(<Settings initialSection="general" />)
    const checkbox = screen
      .getByText('收进托盘')
      .closest('label')
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(checkbox)

    expect(useSettingsStore.getState().closeToTray).toBe(false)
    expect(screen.getByText('直接退出')).toBeTruthy()
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    const calls = vi.mocked(api.saveSettings).mock.calls
    expect(calls[calls.length - 1]?.[0]).toMatchObject({
      closeToTray: false,
    })
  })
})
