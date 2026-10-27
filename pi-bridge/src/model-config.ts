/** 模型能力元数据与 models.json 生成（R-06） */

import * as fs from 'fs/promises'
import * as path from 'path'
import { writeJsonAtomicSync } from './atomic-json.js'
import { CONTEXT_WINDOW_OPTIONS } from './types.js'
import type { ApiModelEntry, ModelContextWindow } from './types.js'

export { CONTEXT_WINDOW_OPTIONS }

export interface ApiConfigInput {
  provider: string
  apiUrl: string
  apiKey: string
  selectedModel: string
  models?: ApiModelEntry[]
}

/** 默认容量档位；未显式设置时按 128K 处理 */
export const DEFAULT_CONTEXT_WINDOW: ModelContextWindow = 128_000

/**
 * 档位配套的输出上限。最终取 min(配套值, catalog)，即只缩不放大：
 * 抬高会超出供应商允许的 max_tokens，直接导致请求失败。
 */
const PAIRED_MAX_TOKENS: Record<ModelContextWindow, number> = {
  64_000: 8_192,
  128_000: 8_192,
  256_000: 16_384,
  1_000_000: 16_384,
}

/**
 * 已知模型的能力元数据；自定义端点不会返回这些信息。
 * 这里不再提供 contextWindow —— 上下文容量只由用户设置决定，避免出现第二个事实来源。
 */
export const KNOWN_MODEL_METADATA: Record<
  string,
  {
    maxTokens?: number
    reasoning?: boolean
  }
> = {
  // 2026-10-24 由项目所有者确认：DeepSeek flash 支持图像输入与思考
  'deepseek-flash': {
    maxTokens: 8_192,
    reasoning: true,
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

export function isContextWindow(value: unknown): value is ModelContextWindow {
  return (
    typeof value === 'number' && (CONTEXT_WINDOW_OPTIONS as readonly number[]).includes(value)
  )
}

/** 非法 / 缺失的档位回落到默认 128K，避免把脏值写进 models.json */
export function normalizeContextWindow(value: unknown): ModelContextWindow {
  return isContextWindow(value) ? value : DEFAULT_CONTEXT_WINDOW
}

/** 输出上限只缩不放大：catalog 更小时保留 catalog 值 */
export function resolveMaxTokens(contextWindow: number, catalogMaxTokens?: number): number {
  const paired = PAIRED_MAX_TOKENS[normalizeContextWindow(contextWindow)]
  return typeof catalogMaxTokens === 'number' && catalogMaxTokens > 0
    ? Math.min(catalogMaxTokens, paired)
    : paired
}

/**
 * 归一化模型列表：去空、去重、清洗档位与图片标记。
 * selectedModel 不在列表里时补一条默认条目，保证下拉与能力提示始终一致。
 */
export function normalizeModelEntries(apiConfig: ApiConfigInput): ApiModelEntry[] {
  const raw = Array.isArray(apiConfig.models) ? apiConfig.models : []
  const entries: ApiModelEntry[] = []
  const seen = new Set<string>()

  for (const item of raw) {
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    entries.push({
      id,
      contextWindow: normalizeContextWindow(item.contextWindow),
      image: item.image === true,
    })
  }

  const selected = typeof apiConfig.selectedModel === 'string' ? apiConfig.selectedModel.trim() : ''
  if (selected && !seen.has(selected)) {
    entries.unshift({ id: selected, contextWindow: DEFAULT_CONTEXT_WINDOW, image: false })
  }

  return entries
}

export function buildModelIds(apiConfig: ApiConfigInput): string[] {
  return normalizeModelEntries(apiConfig).map((entry) => entry.id)
}

/** 将用户配置的 URL / 模型 / 容量写入 Pi 的 models.json；API Key 只存变量名 */
export async function writeModelsConfig(
  agentDir: string,
  apiConfig: ApiConfigInput
): Promise<string> {
  const { provider, apiUrl } = apiConfig
  const entries = normalizeModelEntries(apiConfig)
  const modelsPath = path.join(agentDir, 'models.json')

  const modelsConfig = {
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers: {
      [WORKBENCH_PROVIDER_ID]: {
        baseUrl: apiUrl.replace(/\/+$/, ''),
        api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
        apiKey: `$${API_KEY_ENV}`,
        models: entries.map((entry) => {
          const known = KNOWN_MODEL_METADATA[entry.id] ?? {}
          return {
            id: entry.id,
            ...(known.reasoning ? { reasoning: true } : {}),
            // 上下文容量以用户设置为唯一来源
            contextWindow: entry.contextWindow,
            maxTokens: resolveMaxTokens(entry.contextWindow, known.maxTokens),
            // Pi SDK 按 input 决定是否把图片传给模型；以用户勾选为准
            input: entry.image ? ['text', 'image'] : ['text'],
          }
        }),
      },
    },
  }

  await fs.mkdir(agentDir, { recursive: true })
  writeJsonAtomicSync(modelsPath, modelsConfig)
  return modelsPath
}
