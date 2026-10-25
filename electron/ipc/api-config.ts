/** 供应商 API 配置、Key 加密与模型拉取 IPC */

import * as fs from 'fs/promises'
import * as path from 'path'
import { existsSync } from 'fs'
import { safeStorage } from 'electron'
import { getAppDir } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.js'
import { handleIpc } from './register.js'

let activeProviderApiKey = ''

/** 终端环境过滤需要知道当前生效的 Key，避免误删用户自己的同名变量 */
export function getActiveProviderApiKey(): string {
  return activeProviderApiKey
}

/**
 * API Key 静态加密（Electron safeStorage：Windows DPAPI / macOS Keychain / Linux libsecret）。
 * 文件仍保存在便携式目录中，只有加密所用的系统密钥来自操作系统。
 * 系统不支持加密时回退为明文，并打印警告。
 */
function encryptApiKey(apiKey: string): string {
  if (!apiKey) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(apiKey).toString('base64')
    }
  } catch (error) {
    console.warn('[Main] safeStorage encryption failed:', error)
  }
  console.warn('[Main] safeStorage unavailable — API key will be stored in plain text')
  return apiKey
}

function decryptApiKey(stored: string): string {
  if (!stored) return ''
  if (!stored.startsWith('enc:')) {
    // 兼容旧版明文配置
    return stored
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  } catch (error) {
    console.error('[Main] Failed to decrypt stored API key:', error)
    return ''
  }
}

/** 只支持 OpenAI 兼容渠道；provider 字段保留给 AgentManager 兼容旧结构 */
const DEFAULT_API_CONFIG = {
  provider: 'custom',
  apiUrl: '',
  apiKey: '',
  availableModels: [] as string[],
  selectedModel: '',
  /** 已知支持图片的模型；仅用于旧配置迁移时的预勾选 */
  imageModels: ['deepseek-flash'] as string[],
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
    config.imageModels = Array.isArray(config.imageModels)
      ? config.imageModels.filter((id: unknown): id is string => typeof id === 'string')
      : [...DEFAULT_API_CONFIG.imageModels]
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

    const stored = {
      ...config,
      availableModels: Array.isArray(config?.availableModels)
        ? [
            ...new Set(
              config.availableModels.filter(
                (id: unknown): id is string => typeof id === 'string' && id.length > 0
              )
            ),
          ]
        : [],
      imageModels: Array.isArray(config?.imageModels)
        ? [
            ...new Set(
              config.imageModels.filter(
                (id: unknown): id is string => typeof id === 'string' && id.length > 0
              )
            ),
          ]
        : [...DEFAULT_API_CONFIG.imageModels],
      apiKey: encryptApiKey(String(config?.apiKey ?? '')),
    }
    await writeJsonAtomic(configPath, stored)
    activeProviderApiKey = String(config?.apiKey ?? '')

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
