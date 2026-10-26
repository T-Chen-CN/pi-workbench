/**
 * 联网搜索的供应商目录（渲染层展示用）。
 *
 * id 与 keyField 必须与主进程的 `electron/ipc/web-search-providers.ts` 一致，
 * 由 `tests/web-search.test.ts` 校验。
 */

import type { TranslationKey } from '../i18n/translations'
import type { WebSearchProviderId } from '../types/electron'

export interface WebSearchProviderOption {
  id: WebSearchProviderId
  labelKey: TranslationKey
  noteKey: TranslationKey
  /** 必须填 Key 才能保存；Exa 可留空 */
  requiresKey: boolean
  /** 支持下 global / china 端点切换 */
  endpoint?: boolean
  keyField: string | null
}

export const WEB_SEARCH_PROVIDER_OPTIONS: readonly WebSearchProviderOption[] = [
  {
    id: 'tavily',
    labelKey: 'webSearchProviderTavily',
    noteKey: 'webSearchNoteTavily',
    requiresKey: true,
    keyField: 'tavilyApiKey',
  },
  {
    id: 'exa',
    labelKey: 'webSearchProviderExa',
    noteKey: 'webSearchNoteExa',
    requiresKey: false,
    keyField: 'exaApiKey',
  },
  {
    id: 'brave',
    labelKey: 'webSearchProviderBrave',
    noteKey: 'webSearchNoteBrave',
    requiresKey: true,
    keyField: 'braveApiKey',
  },
  {
    id: 'firecrawl',
    labelKey: 'webSearchProviderFirecrawl',
    noteKey: 'webSearchNoteFirecrawl',
    requiresKey: true,
    keyField: 'firecrawlApiKey',
  },
  {
    id: 'perplexity',
    labelKey: 'webSearchProviderPerplexity',
    noteKey: 'webSearchNotePerplexity',
    requiresKey: true,
    keyField: 'perplexityApiKey',
  },
  {
    id: 'parallel',
    labelKey: 'webSearchProviderParallel',
    noteKey: 'webSearchNoteParallel',
    requiresKey: true,
    keyField: 'parallelApiKey',
  },
  {
    id: 'jina',
    labelKey: 'webSearchProviderJina',
    noteKey: 'webSearchNoteJina',
    requiresKey: true,
    keyField: 'jinaApiKey',
  },
  {
    id: 'bocha',
    labelKey: 'webSearchProviderBocha',
    noteKey: 'webSearchNoteBocha',
    requiresKey: true,
    keyField: 'bochaApiKey',
  },
  {
    id: 'zai',
    labelKey: 'webSearchProviderZai',
    noteKey: 'webSearchNoteZai',
    requiresKey: true,
    endpoint: true,
    keyField: 'zaiApiKey',
  },
  {
    id: 'duckduckgo',
    labelKey: 'webSearchProviderDuckDuckGo',
    noteKey: 'webSearchNoteDuckDuckGo',
    requiresKey: false,
    keyField: null,
  },
]

export function findWebSearchProvider(
  id: WebSearchProviderId
): WebSearchProviderOption | undefined {
  return WEB_SEARCH_PROVIDER_OPTIONS.find((provider) => provider.id === id)
}
