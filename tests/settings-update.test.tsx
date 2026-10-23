// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '../src/components/Settings'
import { useI18nStore } from '../src/store/i18nStore'
import { INITIAL_UPDATE_STATE, useUpdaterStore } from '../src/store/updaterStore'
import { api } from '../src/api'
import { translations } from '../src/i18n/translations'
import type { UpdateState } from '../src/types/electron'

vi.mock('../src/api', () => ({
  api: {
    apiConfigGet: vi.fn(async () => ({ success: false })),
    apiConfigSave: vi.fn(async () => ({ success: true })),
    apiConfigFetchModels: vi.fn(async () => ({ success: true, models: [] })),
    appGetInfo: vi.fn(async () => ({
      success: true,
      info: {
        version: '0.2.0',
        electron: '44.9.1',
        chrome: '140.0.0',
        node: '24.0.0',
        platform: 'win32',
        arch: 'x64',
        appDir: '/tmp/pi-workbench',
      },
    })),
    updateCheck: vi.fn(async () => ({
      success: true,
      state: {
        status: 'not-available',
        currentVersion: '0.2.0',
        platform: 'win32',
        canAutoInstall: true,
      },
    })),
    updateDownload: vi.fn(async () => ({ success: true })),
    updateOpenDownload: vi.fn(async () => ({ success: true })),
  },
}))

const baseState: UpdateState = {
  status: 'idle',
  currentVersion: '0.2.0',
  platform: 'win32',
  canAutoInstall: true,
}

function setUpdateState(patch: Partial<UpdateState>) {
  useUpdaterStore.setState({
    state: { ...baseState, ...patch },
    deferredVersion: null,
    promptRequested: false,
  })
}

beforeEach(() => {
  useI18nStore.setState({ language: 'zh' })
  setUpdateState({})
})

afterEach(() => {
  cleanup()
  useUpdaterStore.setState({
    state: INITIAL_UPDATE_STATE,
    deferredVersion: null,
    promptRequested: false,
  })
})

describe('settings provider image capability', () => {
  it('persists the models checked as image-capable', async () => {
    vi.mocked(api.apiConfigGet).mockResolvedValue({
      success: true,
      config: {
        provider: 'custom',
        apiUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        availableModels: ['deepseek-flash', 'text-only-model'],
        selectedModel: 'deepseek-flash',
        imageModels: ['deepseek-flash'],
      },
    })

    render(<Settings initialSection="api" />)

    const flash = (await screen.findByRole('checkbox', {
      name: 'deepseek-flash',
    })) as HTMLInputElement
    expect(flash.checked).toBe(true)

    fireEvent.click(screen.getByRole('checkbox', { name: 'text-only-model' }))
    fireEvent.click(
      screen.getByRole('button', { name: translations.zh.saveConfiguration })
    )

    await waitFor(() => expect(api.apiConfigSave).toHaveBeenCalled())
    const saved = vi.mocked(api.apiConfigSave).mock.calls[0][0] as {
      imageModels: string[]
    }
    expect(saved.imageModels).toEqual(['deepseek-flash', 'text-only-model'])
  })
})

describe('settings update section', () => {
  it('shows the real app version and disables updates outside packaged builds', async () => {
    setUpdateState({ status: 'unsupported', canAutoInstall: false, currentVersion: '0.2.0' })
    render(<Settings initialSection="about" />)

    await waitFor(() => expect(screen.getByText('版本 0.2.0')).toBeTruthy())
    expect(screen.getByText('仅打包版本支持自动更新')).toBeTruthy()
    expect(screen.queryByText('检查更新')).toBeNull()
  })

  it('offers download for an available Windows update', async () => {
    setUpdateState({ status: 'available', version: '0.3.0' })
    render(<Settings initialSection="about" />)

    expect(screen.getByText('下载更新')).toBeTruthy()
    expect(screen.getByText('发现新版本 0.3.0')).toBeTruthy()
  })

  it('opens the install prompt for a downloaded update', async () => {
    setUpdateState({ status: 'downloaded', version: '0.3.0', percent: 100 })
    render(<Settings initialSection="about" />)

    fireEvent.click(screen.getByText('重启并安装'))
    expect(useUpdaterStore.getState().promptRequested).toBe(true)
  })

  it('links to the release page on macOS instead of downloading', async () => {
    setUpdateState({
      status: 'available',
      version: '0.3.0',
      platform: 'darwin',
      canAutoInstall: false,
    })
    render(<Settings initialSection="about" />)

    expect(screen.getByText('前往下载')).toBeTruthy()
    expect(screen.getByText(/macOS 未签名/)).toBeTruthy()
    expect(screen.queryByText('下载更新')).toBeNull()
  })
})
