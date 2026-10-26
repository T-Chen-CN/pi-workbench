import { describe, expect, it } from 'vitest'
import {
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_PROVIDER_IDS,
  getWebSearchProvider,
  isWebSearchProviderId,
} from '../electron/ipc/web-search-providers'
import {
  buildAgentWebSearchConfig,
  providerRequiresKey,
  webSearchConfigVersion,
  webSearchKeyEnv,
} from '../electron/ipc/web-search-config'
import { WEB_SEARCH_PROVIDER_OPTIONS } from '../src/utils/webSearchProviders'

describe('web search provider catalog', () => {
  it('keeps the renderer catalog in sync with the main-process catalog', () => {
    expect(WEB_SEARCH_PROVIDER_OPTIONS.map((option) => option.id)).toEqual([
      ...WEB_SEARCH_PROVIDER_IDS,
    ])
    for (const option of WEB_SEARCH_PROVIDER_OPTIONS) {
      const spec = getWebSearchProvider(option.id)
      expect(spec, option.id).toBeDefined()
      expect(option.keyField, option.id).toBe(spec?.keyField ?? null)
      expect(Boolean(option.endpoint), option.id).toBe(Boolean(spec?.endpoint))
    }
  })

  it('rejects unknown provider ids', () => {
    expect(isWebSearchProviderId('bocha')).toBe(true)
    expect(isWebSearchProviderId('duckduckgo')).toBe(true)
    expect(isWebSearchProviderId('google')).toBe(false)
    expect(isWebSearchProviderId(null)).toBe(false)
  })

  it('only Exa and keyless providers can work without a key', () => {
    for (const provider of WEB_SEARCH_PROVIDERS) {
      const requiresKey = providerRequiresKey(provider)
      if (provider.id === 'exa' || provider.id === 'duckduckgo') {
        expect(requiresKey, provider.id).toBe(false)
      } else {
        expect(requiresKey, provider.id).toBe(true)
      }
    }
  })
})

describe('buildAgentWebSearchConfig', () => {
  it('always pins eager activation and direct exposure', () => {
    const config = buildAgentWebSearchConfig({
      provider: null,
      endpoint: 'china',
      keys: {},
    })
    expect(config).toEqual({ toolActivation: 'eager', toolExposure: 'direct' })
  })

  it('writes the provider key field as an environment reference', () => {
    const config = buildAgentWebSearchConfig({
      provider: 'bocha',
      endpoint: 'china',
      keys: { bocha: 'sk-secret' },
    })
    expect(config).toEqual({
      provider: 'bocha',
      toolActivation: 'eager',
      toolExposure: 'direct',
      bochaApiKey: `$${webSearchKeyEnv('bocha')}`,
    })
    expect(webSearchKeyEnv('bocha')).toBe('PI_WORKBENCH_WEB_SEARCH_KEY_BOCHA')
    expect(JSON.stringify(config)).not.toContain('sk-secret')
  })

  it('adds the endpoint only for providers that support it', () => {
    expect(
      buildAgentWebSearchConfig({
        provider: 'zai',
        endpoint: 'global',
        keys: { zai: 'z' },
      })
    ).toMatchObject({ zaiEndpoint: 'global' })
    expect(
      buildAgentWebSearchConfig({
        provider: 'tavily',
        endpoint: 'global',
        keys: { tavily: 't' },
      })
    ).not.toHaveProperty('zaiEndpoint')
  })

  it('omits the key field when no key is stored', () => {
    expect(
      buildAgentWebSearchConfig({ provider: 'exa', endpoint: 'china', keys: {} })
    ).toEqual({
      provider: 'exa',
      toolActivation: 'eager',
      toolExposure: 'direct',
    })
    expect(
      buildAgentWebSearchConfig({
        provider: 'duckduckgo',
        endpoint: 'china',
        keys: {},
      })
    ).toEqual({
      provider: 'duckduckgo',
      toolActivation: 'eager',
      toolExposure: 'direct',
    })
  })

  it('changes version when the active provider changes', () => {
    const base = { endpoint: 'china' as const, keys: {} }
    expect(webSearchConfigVersion({ ...base, provider: null })).not.toEqual(
      webSearchConfigVersion({ ...base, provider: 'bocha' })
    )
    expect(webSearchConfigVersion({ ...base, provider: 'bocha' })).toEqual(
      webSearchConfigVersion({ ...base, provider: 'bocha' })
    )
  })
})
