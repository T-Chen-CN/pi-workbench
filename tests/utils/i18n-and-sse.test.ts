// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { translations } from '../../src/i18n/translations'
import { useI18nStore } from '../../src/store/i18nStore'
import { localizeError } from '../../src/i18n/errors'
import { piAgentAPI } from '../../src/api/piAgentAPI'
import { ensurePdfWorker } from '../../src/pdf/worker'

const workerSpy = vi.hoisted(() => vi.fn())

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?worker', () => ({
  default: class FakePdfWorker {
    constructor() {
      workerSpy()
    }
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
  useI18nStore.getState().setLanguage('zh')
})

describe('i18n placeholders and error localization', () => {
  it('contains zero double-brace placeholders across zh and en translations', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const [key, value] of Object.entries(translations[lang])) {
        expect(value, `${lang}.${key}`).not.toMatch(/\{\{|\}\}/)
      }
    }

    useI18nStore.getState().setLanguage('zh')
    const zh = useI18nStore.getState().t
    expect(zh('agentOutputTruncated', { reasoning: '100', body: '200', limit: '300' })).toContain(
      '思考 100 + 正文 200 token，已用满上限 300'
    )
    expect(zh('agentEmptyResponse', { limit: '16,384' })).toContain('16,384 token')
    expect(zh('usageReasoningTokens', { count: '42' })).toBe('思考 42')
    expect(localizeError('File already exists')).toBe('文件已存在')

    useI18nStore.getState().setLanguage('en')
    const en = useI18nStore.getState().t
    expect(en('agentOutputTruncated', { reasoning: '100', body: '200', limit: '300' })).toContain(
      'reasoning 100 + text 200 of 300 tokens'
    )
    expect(en('agentEmptyResponse', { limit: '16,384' })).toContain('16,384-token')
    expect(en('usageReasoningTokens', { count: '42' })).toBe('thinking 42')
    expect(localizeError('File already exists')).toBe('File already exists')
  })
})

describe('piAgentAPI SSE EOF flush', () => {
  it('flushes a trailing done frame even when the SSE stream omits a final blank line', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      encoder.encode('event: trace\ndata: {"type":"text_delta","delta":"hello"}\n\n'),
      // 刻意不带末尾 \n\n
      encoder.encode('event: done\ndata: {"success":true,"response":"hello world"}'),
    ]
    let index = 0
    const fakeResponse = {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (index < chunks.length) {
              return { value: chunks[index++], done: false }
            }
            return { value: undefined, done: true }
          },
        }),
      },
    } as unknown as Response

    const originalElectron = (window as { electronAPI?: unknown }).electronAPI
    ;(window as { electronAPI?: unknown }).electronAPI = undefined
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse)
    const deltas: string[] = []

    try {
      const result = await piAgentAPI.chat('hi', {
        onTextDelta: (delta) => deltas.push(delta),
      })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(deltas).toEqual(['hello'])
      expect(result).toEqual({ success: true, response: 'hello world' })
    } finally {
      ;(window as { electronAPI?: unknown }).electronAPI = originalElectron
    }
  })
})

describe('ensurePdfWorker singleton initialization', () => {
  it('initializes GlobalWorkerOptions.workerPort only once across concurrent and repeated calls', async () => {
    workerSpy.mockClear()
    const fakePdfjs = { GlobalWorkerOptions: { workerPort: null as unknown } }

    await Promise.all([
      ensurePdfWorker(fakePdfjs as never),
      ensurePdfWorker(fakePdfjs as never),
    ])
    const firstPort = fakePdfjs.GlobalWorkerOptions.workerPort
    expect(firstPort).toBeTruthy()
    expect(workerSpy).toHaveBeenCalledTimes(1)

    await ensurePdfWorker(fakePdfjs as never)
    expect(fakePdfjs.GlobalWorkerOptions.workerPort).toBe(firstPort)
    expect(workerSpy).toHaveBeenCalledTimes(1)
  })
})
