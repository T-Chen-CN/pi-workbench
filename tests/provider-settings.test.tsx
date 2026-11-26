// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderSettings } from '../src/components/ProviderSettings'
import { useI18nStore } from '../src/store/i18nStore'
import { useSettingsStore } from '../src/store/settingsStore'
import { api } from '../src/api'
import type { ProviderView } from '../src/types/electron'

vi.mock('../src/api', () => ({
  api: {
    providersList: vi.fn(),
    providersRefresh: vi.fn(async () => ({ success: true, added: 0, removed: 0, checkedAt: 1 })),
    providersSetApiKey: vi.fn(async () => ({ success: true })),
    providersSetActive: vi.fn(async () => ({ success: true })),
    providersSetOverrides: vi.fn(async () => ({ success: true, pending: false })),
    providersForget: vi.fn(async () => ({ success: true })),
    providersLogin: vi.fn(async () => ({ success: true })),
    onProvidersAuthEvent: vi.fn(() => () => {}),
    getSettings: vi.fn(async () => ({ success: true, settings: {} })),
    saveSettings: vi.fn(async () => ({ success: true })),
  },
}))

const sampleProviders: ProviderView[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    connected: true,
    credentialType: 'api_key',
    authMethods: ['api_key', 'oauth'],
    active: true,
    model: 'gpt-5',
    models: [
      {
        id: 'gpt-5',
        name: 'GPT-5',
        limits: { contextWindow: 128_000, maxTokens: 16_384 },
        reasoning: true,
        vision: true,
        api: 'openai-responses',
        thinkingLevels: ['low', 'high'],
        input: ['text', 'image'],
      },
    ],
    directory: {
      source: 'remote',
      checkedAt: Date.UTC(2026, 10, 26, 8, 30),
      lastModified: Date.UTC(2026, 10, 25, 0, 0),
    },
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    connected: false,
    authMethods: ['oauth'],
    active: false,
    models: [],
    directory: { source: 'bundled' },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    connected: false,
    authMethods: ['api_key'],
    active: false,
    models: [],
    directory: { source: 'bundled' },
  },
]

beforeEach(() => {
  useI18nStore.setState({ language: 'zh' })
  useSettingsStore.setState({ autoRefreshCatalog: true })
  vi.mocked(api.providersList).mockResolvedValue({
    success: true,
    providers: sampleProviders,
    activeProvider: 'openai',
    offline: false,
    builtinGeneratedAt: Date.UTC(2026, 9, 15),
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProviderSettings（P-04 / P-06 / P-10）', () => {
  it('展示远端目录来源与 OpenAI/Codex 凭证独立提示，并支持关闭自动刷新', async () => {
    render(<ProviderSettings />)

    await waitFor(() => {
      expect(screen.getByText(/目录来源：远端同步/)).toBeTruthy()
    })
    // P-10：openai 下显示两套凭证独立提示
    expect(
      screen.getByText(/OpenAI（API Key）与 OpenAI Codex（ChatGPT 订阅）是两套独立凭证/)
    ).toBeTruthy()

    const toggle = screen.getByLabelText('自动更新模型目录') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)

    expect(useSettingsStore.getState().autoRefreshCatalog).toBe(false)
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled())
    const calls = vi.mocked(api.saveSettings).mock.calls
    expect(calls[calls.length - 1]?.[0]).toMatchObject({ autoRefreshCatalog: false })
  })

  it('切到内置快照的供应商时显示删除同步说明，切到非 OpenAI 供应商时隐藏 Codex 提示', async () => {
    render(<ProviderSettings />)
    await waitFor(() => expect(screen.getByText(/目录来源：远端同步/)).toBeTruthy())

    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'deepseek' } })

    // P-06：bundled 快照给出删除同步提示
    expect(screen.getByText(/目录来源：内置快照（2026-10-15）/)).toBeTruthy()
    expect(screen.getByText(/同步远端后会移除上游已下架模型/)).toBeTruthy()
    // P-10：非 OpenAI 供应商不显示 Codex 提示
    expect(
      screen.queryByText(/OpenAI（API Key）与 OpenAI Codex（ChatGPT 订阅）是两套独立凭证/)
    ).toBeNull()
  })

  it('PI_OFFLINE 生效时禁用自动刷新与手动刷新按钮', async () => {
    vi.mocked(api.providersList).mockResolvedValueOnce({
      success: true,
      providers: sampleProviders,
      activeProvider: 'openai',
      offline: true,
      builtinGeneratedAt: Date.UTC(2026, 9, 15),
    })

    render(<ProviderSettings />)
    await waitFor(() => {
      expect(screen.getAllByText(/已启用离线模式（PI_OFFLINE）/).length).toBeGreaterThan(0)
    })

    const toggle = screen.getByLabelText('自动更新模型目录') as HTMLInputElement
    expect(toggle.disabled).toBe(true)
    const refreshButton = screen.getByRole('button', { name: '刷新模型目录' }) as HTMLButtonElement
    expect(refreshButton.disabled).toBe(true)
  })

  it('下调上下文容量后下拉框仍保留直到目录上限的更高档位', async () => {
    vi.mocked(api.providersList).mockResolvedValueOnce({
      success: true,
      providers: [
        {
          ...sampleProviders[0],
          models: [
            {
              ...sampleProviders[0].models[0],
              limits: { contextWindow: 65_536, maxTokens: 16_384 },
              catalogLimits: { contextWindow: 262_144, maxTokens: 32_768 },
              overrides: { contextWindow: 65_536, maxTokens: 16_384 },
            },
          ],
        },
      ],
      activeProvider: 'openai',
      offline: false,
      builtinGeneratedAt: Date.UTC(2026, 9, 15),
    })

    render(<ProviderSettings />)
    const contextSelect = (await screen.findByLabelText('gpt-5 上下文容量')) as HTMLSelectElement
    const optionValues = Array.from(contextSelect.options).map((option) => Number(option.value))
    expect(optionValues).toContain(65_536)
    expect(optionValues).toContain(131_072)
    expect(optionValues).toContain(262_144)
  })
})
