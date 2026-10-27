/** 供应商 API 配置、Key 加密与模型拉取 IPC */

import * as fs from 'fs/promises'
import * as path from 'path'
import { existsSync } from 'fs'
import { getAppDir } from '../app-paths.js'
import { agentConfigKey } from '../agent-config-key.js'
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.js'
import { decryptSecret, encryptSecret } from '../secret-crypto.js'
import { handleIpc } from './register.js'

let activeProviderApiKey = ''

/** 由 main.ts 注入：返回各工作区运行中的 Agent 会话；保存前用于避免打断正在跑的轮次 */
let listRunningAgents: (() => Array<{ workspaceDir: string; sessionIds: string[] }>) | null = null

export function setRunningAgentsProvider(
  provider: () => Array<{ workspaceDir: string; sessionIds: string[] }>
): void {
  listRunningAgents = provider
}

/** 终端环境过滤需要知道当前生效的 Key，避免误删用户自己的同名变量 */
export function getActiveProviderApiKey(): string {
  return activeProviderApiKey
}

const encryptApiKey = encryptSecret
const decryptApiKey = decryptSecret

/** 上下文容量只允许四档；与 pi-bridge 的 CONTEXT_WINDOW_OPTIONS 一致（单测校验） */
export const CONTEXT_WINDOW_VALUES = [64_000, 128_000, 256_000, 1_000_000] as const
const DEFAULT_CONTEXT_WINDOW = 128_000
/** 旧配置没有 imageModels 时的历史默认预勾选，只在迁移旧结构时使用 */
const LEGACY_DEFAULT_IMAGE_MODELS = ['deepseek-flash']

export interface StoredModelEntry {
  id: string
  contextWindow: number
  image: boolean
}

/** 只支持 OpenAI 兼容渠道；provider 字段保留给 AgentManager 兼容旧结构 */
const DEFAULT_API_CONFIG = {
  provider: 'custom',
  apiUrl: '',
  apiKey: '',
  selectedModel: '',
  models: [] as StoredModelEntry[],
}

function normalizeContextWindow(value: unknown): number {
  return typeof value === 'number' &&
    (CONTEXT_WINDOW_VALUES as readonly number[]).includes(value)
    ? value
    : DEFAULT_CONTEXT_WINDOW
}

/**
 * 归一化模型列表。
 * 新结构直接清洗；旧结构（availableModels + imageModels）就地转换，不写盘。
 * selectedModel 不在列表里时补一条默认条目，避免模型下拉与能力提示失配。
 */
export function normalizeApiModels(raw: any): StoredModelEntry[] {
  const entries: StoredModelEntry[] = []
  const seen = new Set<string>()

  const push = (id: unknown, image: boolean, contextWindow: unknown): void => {
    const value = typeof id === 'string' ? id.trim() : ''
    if (!value || seen.has(value)) return
    seen.add(value)
    entries.push({
      id: value,
      contextWindow: normalizeContextWindow(contextWindow),
      image,
    })
  }

  if (Array.isArray(raw?.models)) {
    for (const item of raw.models) {
      push(item?.id, item?.image === true, item?.contextWindow)
    }
  } else {
    const images = new Set(
      Array.isArray(raw?.imageModels)
        ? raw.imageModels.filter((id: unknown): id is string => typeof id === 'string')
        : LEGACY_DEFAULT_IMAGE_MODELS
    )
    const available = Array.isArray(raw?.availableModels) ? raw.availableModels : []
    for (const id of available) {
      push(id, images.has(String(id)), DEFAULT_CONTEXT_WINDOW)
    }
  }

  const selected = typeof raw?.selectedModel === 'string' ? raw.selectedModel.trim() : ''
  if (selected && !seen.has(selected)) {
    entries.unshift({ id: selected, contextWindow: DEFAULT_CONTEXT_WINDOW, image: false })
  }

  return entries
}

// Helper function to load API Config
async function loadApiConfig(): Promise<any> {
  try {
    activeProviderApiKey = ''
    const appDir = getAppDir()
    const configPath = path.join(appDir, 'config', 'api-config.json')

    if (!existsSync(configPath)) {
      // Return minimal default config (no hardcoded models)
      return { ...DEFAULT_API_CONFIG }
    }

    const configResult = readJsonWithBackup<any>(configPath)
    if (!configResult.data || typeof configResult.data !== 'object') {
      if (configResult.error) {
        console.warn('[Main] Failed to parse API config:', configResult.error)
      }
      return { ...DEFAULT_API_CONFIG }
    }
    const config = configResult.data

    // 旧版供应商（Anthropic / OpenAI）配置已不再支持：备份后清空，避免旧配置继续生效
    if (config.provider !== 'custom') {
      const backupPath = path.join(path.dirname(configPath), 'api-config.legacy.json')
      try {
        if (!existsSync(backupPath)) {
          await fs.rename(configPath, backupPath)
        } else {
          await fs.unlink(configPath)
        }
      } catch (error) {
        console.warn('[Main] Failed to back up legacy API config:', error)
      }
      console.warn('[Main] Legacy provider config cleared; only OpenAI-compatible channels are supported')
      return { ...DEFAULT_API_CONFIG }
    }

    config.apiKey = decryptApiKey(config.apiKey)
    // 统一成 models[]；旧字段只在内存中转换，下一次保存才落新结构
    config.models = normalizeApiModels(config)
    delete config.availableModels
    delete config.imageModels
    activeProviderApiKey = typeof config.apiKey === 'string' ? config.apiKey : ''
    return config
  } catch (error) {
    console.error('[Main] Failed to load API config:', error)
    return null
  }
}

// Get API Configuration
handleIpc('apiConfig:get', async () => {
  try {
    const config = await loadApiConfig()
    return { success: true, config }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// Save API Configuration
handleIpc('apiConfig:save', async (_event, config: any) => {
  try {
    const appDir = getAppDir()
    const configPath = path.join(appDir, 'config', 'api-config.json')

    /** 明文配置（与 load 结果同形，便于比较配置签名） */
    const nextConfig = {
      provider: typeof config?.provider === 'string' ? config.provider : 'custom',
      apiUrl: String(config?.apiUrl ?? ''),
      apiKey: String(config?.apiKey ?? ''),
      selectedModel: String(config?.selectedModel ?? ''),
      models: normalizeApiModels(config),
    }

    // 会重建 Agent 的变更不允许在会话运行中落地：写盘后各工作区会重新初始化，
    // 正在跑的轮次会被 dispose 掉，用户看到的是“消息突然中断”。
    const previous = await loadApiConfig()
    if (previous && agentConfigKey(previous) !== agentConfigKey(nextConfig)) {
      const running = listRunningAgents?.() ?? []
      if (running.length > 0) {
        return {
          success: false,
          code: 'AGENT_BUSY',
          workspaces: running.map((entry) => ({
            path: entry.workspaceDir,
            sessionIds: entry.sessionIds,
          })),
          error: 'Agent sessions are running',
        }
      }
    }

    await writeJsonAtomic(configPath, {
      ...nextConfig,
      apiKey: encryptApiKey(nextConfig.apiKey),
    })
    activeProviderApiKey = nextConfig.apiKey

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
})

// Fetch available models from API
handleIpc('apiConfig:fetchModels', async (_event, apiUrl: string, apiKey: string, provider: string) => {
  try {
    // 归一化 Base URL：去掉末尾斜杠，模板占位符视为未填写
    const baseUrl = (apiUrl || '').trim().replace(/\/+$/, '')
    if (!baseUrl || baseUrl.includes('your-api-endpoint')) {
      throw new Error('Please enter a valid API URL')
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error('API URL must start with http:// or https://')
    }

    const modelsEndpoint = `${baseUrl}/models`
    console.log(`[Main] Fetching models from ${modelsEndpoint} (provider: ${provider})`)

    const headers: Record<string, string> = provider === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { 'Authorization': `Bearer ${apiKey}` }

    // 主进程发起请求：必须有超时，避免供应商无响应时永久挂起
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    let response: Response
    try {
      response = await fetch(modelsEndpoint, { headers, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('Request timed out after 15s')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
    console.log(`[Main] Response status: ${response.status}`)

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`)
    }

    const data: any = await response.json()

    // 兼容常见返回格式：{ data: [{id}] } / { models: [...] } / [...]
    let models: string[] = []
    if (Array.isArray(data?.data)) {
      models = data.data.map((m: any) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
    } else if (Array.isArray(data?.models)) {
      models = data.models.map((m: any) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
    } else if (Array.isArray(data)) {
      models = data.map((m: any) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
    }

    console.log(`[Main] Fetched ${models.length} models`)
    return { success: true, models }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('[Main] fetchModels error:', errorMessage)
    return {
      success: false,
      error: errorMessage,
      models: []
    }
  }
})
