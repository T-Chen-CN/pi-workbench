/**
 * 联网搜索配置（应用基础能力，pi-web-access 为内置实现）。
 *
 * - 用户配置存在 `{appDir}/config/web-search.json`，Key 用 safeStorage 加密。
 * - 下发给扩展的 `{appDir}/data/agent/web-search.json` 只写环境变量名。
 * - 同一时刻只启用一家供应商；已保存的 Key 在切换时保留。
 */

import * as path from 'path'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { getAppDir } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.js'
import { decryptSecret, encryptSecret } from '../secret-crypto.js'
import { handleIpc } from './register.js'
import {
  WEB_SEARCH_PROVIDER_IDS,
  getWebSearchProvider,
  isWebSearchProviderId,
  type WebSearchProviderId,
} from './web-search-providers.js'
import {
  WEB_SEARCH_KEY_ENV_PREFIX,
  WebSearchConfig,
  WebSearchEndpoint,
  buildAgentWebSearchConfig,
  providerRequiresKey,
  webSearchConfigVersion,
  webSearchKeyEnv,
} from './web-search-config.js'

export {
  WEB_SEARCH_KEY_ENV_PREFIX,
  buildAgentWebSearchConfig,
  providerRequiresKey,
  webSearchConfigVersion,
  webSearchKeyEnv,
}
export type { WebSearchConfig, WebSearchEndpoint }

const requireFromMain = createRequire(import.meta.url)

const MAX_KEY_LENGTH = 4096
const CONFIG_FILE = 'web-search.json'

interface StoredWebSearchConfig {
  provider?: unknown
  endpoint?: unknown
  keys?: unknown
}

function configPath(): string {
  return path.join(getAppDir(), 'config', CONFIG_FILE)
}

function agentConfigPath(): string {
  return path.join(getAppDir(), 'data', 'agent', CONFIG_FILE)
}

function emptyConfig(): WebSearchConfig {
  return { provider: null, endpoint: 'china', keys: {} }
}

function normalizeEndpoint(value: unknown): WebSearchEndpoint {
  return value === 'global' ? 'global' : 'china'
}

function normalizeKeys(value: unknown): Partial<Record<WebSearchProviderId, string>> {
  const keys: Partial<Record<WebSearchProviderId, string>> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return keys
  for (const [provider, key] of Object.entries(value as Record<string, unknown>)) {
    if (!isWebSearchProviderId(provider)) continue
    if (typeof key !== 'string') continue
    const trimmed = key.trim()
    if (trimmed.length === 0) continue
    keys[provider] = trimmed.slice(0, MAX_KEY_LENGTH)
  }
  return keys
}

/** 读取并解密用户配置；文件缺失或损坏时返回空配置 */
export async function loadWebSearchConfig(): Promise<WebSearchConfig> {
  try {
    const result = readJsonWithBackup<StoredWebSearchConfig>(configPath())
    if (!result.data || typeof result.data !== 'object') return emptyConfig()
    const raw = result.data
    const provider = isWebSearchProviderId(raw.provider) ? raw.provider : null
    const storedKeys =
      raw.keys && typeof raw.keys === 'object' && !Array.isArray(raw.keys)
        ? (raw.keys as Record<string, unknown>)
        : {}
    const keys: Partial<Record<WebSearchProviderId, string>> = {}
    for (const [id, value] of Object.entries(storedKeys)) {
      if (!isWebSearchProviderId(id) || typeof value !== 'string' || !value) continue
      const decrypted = decryptSecret(value)
      if (decrypted) keys[id] = decrypted
    }
    return { provider, endpoint: normalizeEndpoint(raw.endpoint), keys }
  } catch (error) {
    console.error('[Main] Failed to load web search config:', error)
    return emptyConfig()
  }
}

async function writeStoredConfig(config: WebSearchConfig): Promise<void> {
  const keys: Record<string, string> = {}
  for (const id of WEB_SEARCH_PROVIDER_IDS) {
    const value = config.keys[id]
    if (value) keys[id] = encryptSecret(value)
  }
  await writeJsonAtomic(configPath(), {
    provider: config.provider,
    endpoint: config.endpoint,
    keys,
  })
}

let appliedVersion = ''

/** 当前已下发给扩展的配置版本（保存后立即更新，供新会话判断是否需要重新加载扩展） */
export function currentWebSearchConfigVersion(): string {
  return appliedVersion
}

/** 把配置落到 Agent 目录并注入 Key 环境变量 */
async function applyWebSearchConfig(config: WebSearchConfig): Promise<void> {
  await writeJsonAtomic(agentConfigPath(), buildAgentWebSearchConfig(config))
  appliedVersion = webSearchConfigVersion(config)
  // 按供应商分别注入：切换来源时旧会话仍能读到自己那份 Key
  for (const id of WEB_SEARCH_PROVIDER_IDS) {
    const envName = webSearchKeyEnv(id)
    const key = config.keys[id]
    if (key) {
      process.env[envName] = key
    } else {
      delete process.env[envName]
    }
  }
}

/** 启动时调用：确保 Agent 侧配置与进程环境就绪 */
export async function initializeWebSearch(): Promise<void> {
  try {
    await applyWebSearchConfig(await loadWebSearchConfig())
  } catch (error) {
    console.error('[Main] Failed to initialize web search config:', error)
  }
}

/**
 * 内置联网扩展的加载路径（pi-web-access 包根目录，包内 pi.extensions 指向 dist）。
 * 包随应用分发；缺失时返回空数组，Agent 只是没有联网工具，不影响启动。
 */
export function webAccessExtensionPaths(): string[] {
  try {
    const packageJson = requireFromMain.resolve('pi-web-access/package.json')
    const root = path.dirname(packageJson)
    const entry = path.join(root, 'dist', 'index.js')
    if (!existsSync(entry)) {
      console.warn('[Main] pi-web-access entry is missing:', entry)
      return []
    }
    return [root]
  } catch (error) {
    console.warn('[Main] pi-web-access is unavailable:', error)
    return []
  }
}

handleIpc('webSearch:get', async () => {
  try {
    return { success: true, config: await loadWebSearchConfig() }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
})

handleIpc('webSearch:save', async (_event, input: unknown) => {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { success: false, error: 'Invalid web search configuration' }
    }
    const raw = input as Record<string, unknown>
    const provider =
      raw.provider === null || raw.provider === undefined
        ? null
        : isWebSearchProviderId(raw.provider)
          ? raw.provider
          : undefined
    if (provider === undefined) {
      return { success: false, error: 'Unknown web search provider' }
    }

    const config: WebSearchConfig = {
      provider,
      endpoint: normalizeEndpoint(raw.endpoint),
      keys: normalizeKeys(raw.keys),
    }

    if (provider) {
      const spec = getWebSearchProvider(provider)
      if (providerRequiresKey(spec) && !config.keys[provider]) {
        return { success: false, error: 'API key is required for this provider' }
      }
    }

    await writeStoredConfig(config)
    await applyWebSearchConfig(config)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
})
