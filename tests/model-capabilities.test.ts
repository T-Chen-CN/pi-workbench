import { describe, expect, it } from 'vitest'
import {
  CONTEXT_WINDOW_OPTIONS as RENDERER_OPTIONS,
  MAX_TOKENS_OPTIONS as RENDERER_MAX_TOKENS,
  contextWindowLabel,
  maxTokensLabel,
  mergeModelEntries,
} from '../src/utils/model-capabilities'
import {
  CONTEXT_WINDOW_OPTIONS as BRIDGE_OPTIONS,
  MAX_TOKENS_OPTIONS as BRIDGE_MAX_TOKENS,
  normalizeModelEntries,
  resolveMaxTokens,
  resolveMaxTokensDetail,
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

describe('max tokens options', () => {
  it('stays in sync between the renderer and pi-bridge', () => {
    expect([...RENDERER_MAX_TOKENS]).toEqual([...BRIDGE_MAX_TOKENS])
    expect([...RENDERER_MAX_TOKENS]).toEqual([0, 16_384, 32_768, 65_536, 131_072, 262_144])
  })

  it('renders fixed labels and leaves auto to the caller', () => {
    expect(RENDERER_MAX_TOKENS.slice(1).map(maxTokensLabel)).toEqual([
      '16K',
      '32K',
      '64K',
      '128K',
      '256K',
    ])
  })
})

describe('mergeModelEntries', () => {
  const previous = [
    { id: 'a', contextWindow: 256_000 as const, image: true, maxTokens: 131_072 as const },
    { id: 'removed', contextWindow: 64_000 as const, image: false },
  ]

  it('keeps the settings of models that still exist', () => {
    expect(mergeModelEntries(previous, ['a'])).toEqual([
      { id: 'a', contextWindow: 256_000, image: true, maxTokens: 131_072 },
    ])
  })

  it('appends new models with the default entry and drops removed ones', () => {
    expect(mergeModelEntries(previous, ['a', 'b'])).toEqual([
      { id: 'a', contextWindow: 256_000, image: true, maxTokens: 131_072 },
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
    // catalog 更小时取 catalog
    expect(resolveMaxTokens(1_000_000, 8_192)).toBe(8_192)
    // 未登记模型没有 catalog 值，直接用档位配套值
    expect(resolveMaxTokens(64_000)).toBe(8_192)
    expect(resolveMaxTokens(256_000)).toBe(65_536)
    // 用户档位优先，但仍受 catalog 封顶
    expect(resolveMaxTokens(256_000, 393_216, 131_072)).toBe(131_072)
    expect(resolveMaxTokens(256_000, 65_536, 131_072)).toBe(65_536)
    // 非法档位回落到自动
    expect(resolveMaxTokens(256_000, undefined, 999)).toBe(65_536)
  })

  it('reports where the effective value came from', () => {
    expect(resolveMaxTokensDetail(256_000).source).toBe('auto')
    expect(resolveMaxTokensDetail(256_000, undefined, 131_072).source).toBe('user')
    expect(resolveMaxTokensDetail(256_000, 65_536, 131_072).source).toBe('clamped')
  })
})
