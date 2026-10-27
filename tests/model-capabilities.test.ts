import { describe, expect, it } from 'vitest'
import {
  CONTEXT_WINDOW_OPTIONS as RENDERER_OPTIONS,
  contextWindowLabel,
  mergeModelEntries,
} from '../src/utils/model-capabilities'
import {
  CONTEXT_WINDOW_OPTIONS as BRIDGE_OPTIONS,
  normalizeModelEntries,
  resolveMaxTokens,
} from '../pi-bridge/src/model-config'

describe('context window options', () => {
  it('stays in sync between the renderer and pi-bridge', () => {
    expect([...RENDERER_OPTIONS]).toEqual([...BRIDGE_OPTIONS])
    expect([...RENDERER_OPTIONS]).toEqual([64_000, 128_000, 256_000, 1_000_000])
  })

  it('renders the four fixed labels', () => {
    expect(RENDERER_OPTIONS.map(contextWindowLabel)).toEqual(['64K', '128K', '256K', '1M'])
  })
})

describe('mergeModelEntries', () => {
  const previous = [
    { id: 'a', contextWindow: 256_000 as const, image: true },
    { id: 'removed', contextWindow: 64_000 as const, image: false },
  ]

  it('keeps the settings of models that still exist', () => {
    expect(mergeModelEntries(previous, ['a'])).toEqual([
      { id: 'a', contextWindow: 256_000, image: true },
    ])
  })

  it('appends new models with the default entry and drops removed ones', () => {
    expect(mergeModelEntries(previous, ['a', 'b'])).toEqual([
      { id: 'a', contextWindow: 256_000, image: true },
      { id: 'b', contextWindow: 128_000, image: false },
    ])
  })

  it('ignores blanks and duplicates from the provider', () => {
    expect(mergeModelEntries([], ['b', ' ', 'b', ''])).toEqual([
      { id: 'b', contextWindow: 128_000, image: false },
    ])
  })
})

describe('normalizeModelEntries', () => {
  it('drops blanks and duplicates and falls back to 128K', () => {
    expect(
      normalizeModelEntries({
        provider: 'custom',
        apiUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        selectedModel: 'a',
        models: [
          { id: 'a', contextWindow: 32_000 as never, image: true },
          { id: ' a ', contextWindow: 1_000_000, image: true },
          { id: '', contextWindow: 128_000, image: false },
          { id: 'b', contextWindow: 1_000_000, image: false },
        ],
      })
    ).toEqual([
      { id: 'a', contextWindow: 128_000, image: true },
      { id: 'b', contextWindow: 1_000_000, image: false },
    ])
  })

  it('restores a selected model that is missing from the list', () => {
    expect(
      normalizeModelEntries({
        provider: 'custom',
        apiUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        selectedModel: 'ghost',
        models: [{ id: 'a', contextWindow: 1_000_000, image: true }],
      })
    ).toEqual([
      { id: 'ghost', contextWindow: 128_000, image: false },
      { id: 'a', contextWindow: 1_000_000, image: true },
    ])
  })
})

describe('resolveMaxTokens', () => {
  it('never raises the catalog limit', () => {
    // 1M 档位配套 16384，但 catalog 只声明 8192
    expect(resolveMaxTokens(1_000_000, 8_192)).toBe(8_192)
    // 未登记模型没有 catalog 值，直接用档位配套值
    expect(resolveMaxTokens(64_000)).toBe(8_192)
    expect(resolveMaxTokens(256_000)).toBe(16_384)
  })
})
