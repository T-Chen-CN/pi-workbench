// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '../../src/components/settings/Settings'
import { useI18nStore } from '../../src/store/i18nStore'
import { INITIAL_UPDATE_STATE, useUpdaterStore } from '../../src/store/updaterStore'
import { api } from '../../src/api'
import { translations } from '../../src/i18n/translations'
import type { UpdateState } from '../../src/types/electron'

vi.mock('../../src/api', () => ({
  api: {
    providersList: vi.fn(async () => ({ success: true, providers: [], activeProvider: null })),
    providersSetActive: vi.fn(async () => ({ success: true })),
    providersSetOverrides: vi.fn(async () => ({
      success: true,
      effective: { contextWindow: 128_000, maxTokens: 16_384 },
      pending: false,
    })),
    providersRefresh: vi.fn(async () => ({
      success: true,
      added: 0,
      removed: 0,
      checkedAt: Date.now(),
    })),
    providersSetApiKey: vi.fn(async () => ({ success: true })),
    providersForget: vi.fn(async () => ({ success: true })),
    providersLogin: vi.fn(async () => ({ success: true })),
    providersAuthAnswer: vi.fn(async () => ({ ok: true })),
    providersCancelLogin: vi.fn(async () => ({ ok: true })),
    onProvidersAuthEvent: vi.fn(() => () => {}),
    webSearchGet: vi.fn(async () => ({
      success: true,
      config: { provider: null, endpoint: 'china', keys: {} },
    })),
    webSearchSave: vi.fn(async () => ({ success: true })),
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

function providerView(): {
  success: true
  providers: unknown[]
  activeProvider: string
} {
  return {
    success: true,
    activeProvider: 'deepseek',
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        connected: true,
        credentialType: 'api_key',
        authMethods: ['api_key'],
        active: true,
        model: 'deepseek-flash',
        models: [
          {
            id: 'deepseek-flash',
            name: 'DeepSeek Flash',
            limits: { contextWindow: 128_000, maxTokens: 16_384 },
            reasoning: true,
            vision: true,
            api: 'openai-completions',
            thinkingLevels: ['low', 'medium', 'high'],
            input: ['text', 'image'],
          },
          {
            id: 'text-only-model',
            name: 'Text Only',
            limits: { contextWindow: 64_000, maxTokens: 8_192 },
            reasoning: false,
            vision: false,
            api: 'openai-completions',
            thinkingLevels: [],
            input: ['text'],
          },
        ],
      },
    ],
  }
}

describe('settings provider model capabilities', () => {
  it('writes the tuned context window back to the main process', async () => {
    vi.mocked(api.providersList).mockResolvedValue(providerView() as never)

    render(<Settings initialSection="api" />)

    // 能力表只读展示目录真值；下调走下拉，按模型存覆盖值
    const select = (await screen.findByLabelText(
      'text-only-model 上下文容量'
    )) as HTMLSelectElement
    expect(select.value).toBe('64000')
    fireEvent.change(select, { target: { value: '32768' } })

    await waitFor(() =>
      expect(api.providersSetOverrides).toHaveBeenCalledWith('deepseek', 'text-only-model', {
        contextWindow: 32_768
      })
    )
  })

  it('removes the stored credentials of the selected provider', async () => {
    vi.mocked(api.providersList).mockResolvedValue(providerView() as never)

    render(<Settings initialSection="api" />)

    fireEvent.click(await screen.findByRole('button', { name: translations.zh.providerForget }))

    await waitFor(() => expect(api.providersForget).toHaveBeenCalledWith('deepseek'))
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

describe('settings mode legend', () => {
  it('lists all four session modes and marks plan as session-only', () => {
    render(<Settings initialSection="permissions" />)

    expect(screen.getByText(translations.zh.modeLegendTitle)).toBeTruthy()
    expect(screen.getByText(translations.zh.modeReadonlyDesc)).toBeTruthy()
    expect(screen.getByText(translations.zh.modePlanDesc)).toBeTruthy()
    expect(screen.getByText(translations.zh.modeAskDesc)).toBeTruthy()
    expect(screen.getByText(translations.zh.modeAutoDesc)).toBeTruthy()
    expect(screen.getByText(translations.zh.modeSessionOnly)).toBeTruthy()
    expect(screen.getAllByText(translations.zh.modeDefaultAllowed)).toHaveLength(3)
  })
})
