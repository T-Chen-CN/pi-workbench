/**
 * 联网搜索的供应商目录（主进程侧）。
 *
 * `keyField` 是 pi-web-access 在 web-search.json 里读取的 Key 字段名；
 * `null` 表示该供应商不需要 Key。渲染层有一份展示用的同名目录，
 * 两者的 id / keyField 由 `tests/web-search.test.ts` 保证一致。
 */

export const WEB_SEARCH_PROVIDER_IDS = [
  'tavily',
  'exa',
  'brave',
  'firecrawl',
  'perplexity',
  'parallel',
  'jina',
  'bocha',
  'zai',
  'duckduckgo',
] as const

export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number]

export interface WebSearchProviderSpec {
  id: WebSearchProviderId
  /** web-search.json 中的 Key 字段名；null 表示免 Key */
  keyField: string | null
  /** 是否支持 global / china 端点切换（目前只有智谱） */
  endpoint?: boolean
}

export const WEB_SEARCH_PROVIDERS: readonly WebSearchProviderSpec[] = [
  { id: 'tavily', keyField: 'tavilyApiKey' },
  { id: 'exa', keyField: 'exaApiKey' },
  { id: 'brave', keyField: 'braveApiKey' },
  { id: 'firecrawl', keyField: 'firecrawlApiKey' },
  { id: 'perplexity', keyField: 'perplexityApiKey' },
  { id: 'parallel', keyField: 'parallelApiKey' },
  { id: 'jina', keyField: 'jinaApiKey' },
  { id: 'bocha', keyField: 'bochaApiKey' },
  { id: 'zai', keyField: 'zaiApiKey', endpoint: true },
  { id: 'duckduckgo', keyField: null },
]

export function isWebSearchProviderId(value: unknown): value is WebSearchProviderId {
  return (
    typeof value === 'string' &&
    (WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(value)
  )
}

export function getWebSearchProvider(
  id: WebSearchProviderId
): WebSearchProviderSpec | undefined {
  return WEB_SEARCH_PROVIDERS.find((provider) => provider.id === id)
}
