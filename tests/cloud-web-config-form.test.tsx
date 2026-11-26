/**
 * Web 客户端「云端模型配置」卡行为回归：
 * 1. 刷新模型目录期间与返回后，用户已输入的 API Key 不被覆盖。
 * 2. 固定 8 家内置供应商白名单，没有自建 Base URL 输入框。
 * 3. 保存成功后清空 draft（Key 不再留在页面状态里）并保留「已保存，下一轮生效」反馈。
 */

// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigCard, type WebRequestFn } from '../apps/cloud/web-src/CloudWebCards'
import {
  PROVIDER_PRESETS,
  type WebCatalogModel,
  type WebCloudConfig,
  type WebConfigDraft,
} from '../apps/cloud/web-src/cloudWebClient'

function ConfigCardHarness({
  initialConfig = { configured: false },
  request,
  onReloadAuxiliary = async () => {},
}: {
  initialConfig?: WebCloudConfig | null
  request: WebRequestFn
  onReloadAuxiliary?: () => Promise<void>
}) {
  const [draft, setDraft] = useState<WebConfigDraft | null>(null)
  const [models, setModels] = useState<WebCatalogModel[]>([])
  const [feedback, setFeedback] = useState('')
  return (
    <ConfigCard
      config={initialConfig}
      draft={draft}
      models={models}
      feedback={feedback}
      onDraftChange={setDraft}
      onModelsChange={setModels}
      onFeedbackChange={setFeedback}
      onReloadAuxiliary={onReloadAuxiliary}
      request={request}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('云端配置卡的输入保持与白名单约束', () => {
  it('使用 8 家固定供应商白名单，无自建 Base URL 输入框', async () => {
    const request = vi.fn(async () => ({
      ok: true,
      status: 200,
      payload: {
        models: [
          {
            id: 'deepseek-flash',
            name: 'DeepSeek Flash',
            contextWindow: 1_000_000,
            maxTokens: 64_000,
            reasoning: true,
            vision: false,
          },
        ],
      },
    })) as unknown as WebRequestFn

    render(<ConfigCardHarness request={request} />)
    const providerSelect = screen.getByLabelText('供应商') as HTMLSelectElement
    expect(providerSelect.options.length).toBe(PROVIDER_PRESETS.length)
    expect(PROVIDER_PRESETS.length).toBe(8)
    expect(screen.queryByLabelText(/Base URL|端点/i)).toBeNull()
    expect(await screen.findByText(/上下文 1M/)).toBeTruthy()
  })

  it('拉取/刷新目录异步返回时，已输入的 API Key 必须保留不被旧闭包覆盖', async () => {
    const pending: { resolveCatalog?: (value: any) => void } = {}
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          pending.resolveCatalog = resolve
        })
    ) as unknown as WebRequestFn

    render(<ConfigCardHarness request={request} />)
    const keyInput = screen.getByLabelText('API Key') as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'sk-in-flight-key' } })
    expect(keyInput.value).toBe('sk-in-flight-key')

    // 首次拉目录在用户输入之后才返回，不得冲掉已输入的 Key
    pending.resolveCatalog?.({
      ok: true,
      status: 200,
      payload: {
        models: [
          {
            id: 'deepseek-flash',
            name: 'DeepSeek Flash',
            contextWindow: 1_000_000,
            maxTokens: 384_000,
            reasoning: true,
            vision: true,
          },
        ],
      },
    })

    await waitFor(() => expect(screen.getByText(/DeepSeek Flash/)).toBeTruthy())
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('sk-in-flight-key')
  })

  it('保存成功后清空 Key 输入框并保留「已保存，下一轮生效」反馈', async () => {
    const onReloadAuxiliary = vi.fn(async () => {})
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/v1/cloud-config/catalog')) {
        return {
          ok: true,
          status: 200,
          payload: {
            models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 128_000 }],
          },
        }
      }
      if (method === 'PUT' && path === '/v1/cloud-config') {
        return {
          ok: true,
          status: 200,
          payload: { ok: true, apiKeyMasked: 'sk-****9999', takesEffect: 'next-turn' },
        }
      }
      return { ok: false, status: 404, payload: null }
    }) as unknown as WebRequestFn

    render(<ConfigCardHarness request={request} onReloadAuxiliary={onReloadAuxiliary} />)
    await screen.findByText(/DeepSeek Flash/)

    const keyInput = screen.getByLabelText('API Key') as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'sk-secret-9999' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.getByText('已保存，下一轮生效')).toBeTruthy())
    expect(onReloadAuxiliary).toHaveBeenCalledTimes(1)
    // draft 已清零，Key 不再留在页面状态里
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('')
  })
})
