/**
 * 联网搜索配置的纯逻辑（不依赖 Electron，便于单元测试）。
 */

import {
  getWebSearchProvider,
  type WebSearchProviderId,
  type WebSearchProviderSpec,
} from './web-search-providers.js'

/** 环境变量名前缀：按供应商分别注入，切换来源不会覆盖旧会话正在使用的 Key */
export const WEB_SEARCH_KEY_ENV_PREFIX = 'PI_WORKBENCH_WEB_SEARCH_KEY'

export function webSearchKeyEnv(provider: WebSearchProviderId): string {
  return `${WEB_SEARCH_KEY_ENV_PREFIX}_${provider.toUpperCase()}`
}

export type WebSearchEndpoint = 'global' | 'china'

export interface WebSearchConfig {
  /** null 表示尚未选择来源，交给扩展的默认路由 */
  provider: WebSearchProviderId | null
  endpoint: WebSearchEndpoint
  /** 明文 Key（只在主进程内与受信 IPC 之间传递；磁盘上为密文） */
  keys: Partial<Record<WebSearchProviderId, string>>
}

/** 需要 Key 才能工作的供应商；Exa 允许留空走免 Key 的 MCP 通道 */
export function providerRequiresKey(spec: WebSearchProviderSpec | undefined): boolean {
  if (!spec || !spec.keyField) return false
  return spec.id !== 'exa'
}

/**
 * 生成下发给扩展的配置。
 * toolActivation / toolExposure 固定为 eager / direct：
 * 工具常驻声明，由应用的会话模式白名单决定是否可用，扩展不再自行增删激活集。
 */
export function buildAgentWebSearchConfig(
  config: WebSearchConfig
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    toolActivation: 'eager',
    toolExposure: 'direct',
  }
  if (!config.provider) return base
  const spec = getWebSearchProvider(config.provider)
  const result: Record<string, unknown> = {
    provider: config.provider,
    ...base,
  }
  if (spec?.endpoint) result.zaiEndpoint = config.endpoint
  if (spec?.keyField && config.keys[config.provider]) {
    result[spec.keyField] = `$${webSearchKeyEnv(config.provider)}`
  }
  return result
}

/** 配置版本：用于判断新会话是否需要重新加载扩展以读取新配置 */
export function webSearchConfigVersion(config: WebSearchConfig): string {
  return JSON.stringify(buildAgentWebSearchConfig(config))
}
