/** 模型能力元数据与 models.json 生成（R-06） */

import * as fs from 'fs/promises'
import * as path from 'path'
import { writeJsonAtomicSync } from './atomic-json.js'

export interface ApiConfigInput {
  provider: string
  apiUrl: string
  apiKey: string
  selectedModel: string
  availableModels?: string[]
  imageModels?: string[]
}

/** 已知模型的能力元数据；自定义端点不会返回这些信息 */
export const KNOWN_MODEL_METADATA: Record<
  string,
  {
    contextWindow?: number
    maxTokens?: number
    reasoning?: boolean
    input?: Array<'text' | 'image'>
  }
> = {
  // 2026-10-24 由项目所有者确认：DeepSeek flash 支持图像输入；上下文 128K
  'deepseek-flash': {
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: true,
    input: ['text', 'image'],
  },
}

/** 思考级别与 setSessionThinking 的允许值一致 */
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

/** 写入 models.json 的自定义供应商 ID */
export const WORKBENCH_PROVIDER_ID = 'pi-workbench'
/** models.json 中引用的环境变量名（避免把 API Key 写进磁盘） */
export const API_KEY_ENV = 'PI_WORKBENCH_API_KEY'

export function buildModelIds(apiConfig: ApiConfigInput): string[] {
  return [
    ...new Set(
      [apiConfig.selectedModel, ...(apiConfig.availableModels ?? [])].filter(
        (id): id is string => typeof id === 'string' && id.length > 0
      )
    ),
  ]
}

/** 将用户配置的 URL / 模型写入 Pi 的 models.json；API Key 只存变量名 */
export async function writeModelsConfig(
  agentDir: string,
  apiConfig: ApiConfigInput
): Promise<string> {
  const { provider, apiUrl } = apiConfig
  const modelIds = buildModelIds(apiConfig)
  const modelsPath = path.join(agentDir, 'models.json')
  const imageModels = Array.isArray(apiConfig.imageModels)
    ? apiConfig.imageModels
    : modelIds.filter((id) => KNOWN_MODEL_METADATA[id]?.input?.includes('image'))
  const imageSet = new Set(imageModels)
  const modelsConfig = {
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers: {
      [WORKBENCH_PROVIDER_ID]: {
        baseUrl: apiUrl.replace(/\/+$/, ''),
        api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
        apiKey: `$${API_KEY_ENV}`,
        models: modelIds.map((id) => ({
          id,
          ...(KNOWN_MODEL_METADATA[id] ?? {}),
          // Pi SDK 按 input 决定是否把图片传给模型；以用户勾选为准
          input: imageSet.has(id) ? ['text', 'image'] : ['text'],
        })),
      },
    },
  }

  await fs.mkdir(agentDir, { recursive: true })
  writeJsonAtomicSync(modelsPath, modelsConfig)
  return modelsPath
}
