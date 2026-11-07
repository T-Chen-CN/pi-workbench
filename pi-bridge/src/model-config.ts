/** 模型能力元数据与 models.json 生成（R-06） */

import * as fs from 'fs/promises'
import * as path from 'path'
import { writeJsonAtomicSync } from './atomic-json.js'
import { CONTEXT_WINDOW_OPTIONS, MAX_TOKENS_OPTIONS } from './types.js'
import type { ApiModelEntry, ModelContextWindow, ModelMaxTokens } from './types.js'

export { CONTEXT_WINDOW_OPTIONS, MAX_TOKENS_OPTIONS }

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
 * 「自动」档的配套输出上限，最终取 min(配套值, catalog)。
 * 值对齐主流区间（各供应商 p10–p75）：256K → 64K（DeepSeek 思考默认 / Gemini 档），
 * 1M → 128K（OpenAI / Anthropic 旗舰档）。用户可在设置页手动覆盖。
 */
const PAIRED_MAX_TOKENS: Record<ModelContextWindow, number> = {
  64_000: 8_192,
  128_000: 16_384,
  256_000: 65_536,
  1_000_000: 131_072,
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
  // maxTokens 是**供应商硬上限**（官方文档 1–384K），不是推荐值；
  // 推荐值由上下文档位推导，用户也可在设置页覆盖
  'deepseek-flash': {
    maxTokens: 393_216,
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

/** 非法 / 缺失的输出档位回落到「自动」 */
export function normalizeMaxTokens(value: unknown): ModelMaxTokens {
  return typeof value === 'number' && (MAX_TOKENS_OPTIONS as readonly number[]).includes(value)
    ? (value as ModelMaxTokens)
    : 0
}

export type MaxTokensSource = 'auto' | 'user' | 'clamped'

/**
 * 解析输出上限：用户档位优先，其次按上下文档位推导；两者都以 catalog 封顶。
 * source 用于设置页说明生效值从哪来（auto / user / clamped）。
 */
export function resolveMaxTokensDetail(
  contextWindow: number,
  catalogMaxTokens?: number,
  userMaxTokens?: number | null
): { value: number; source: MaxTokensSource } {
  const catalog =
    typeof catalogMaxTokens === 'number' && catalogMaxTokens > 0 ? catalogMaxTokens : Number.POSITIVE_INFINITY
  const user = normalizeMaxTokens(userMaxTokens)
  if (user > 0) {
    const value = Math.min(user, catalog)
    return { value, source: value < user ? 'clamped' : 'user' }
  }
  const paired = PAIRED_MAX_TOKENS[normalizeContextWindow(contextWindow)]
  const value = Math.min(paired, catalog)
  return { value, source: value < paired ? 'clamped' : 'auto' }
}

/** 输出上限只缩不放大：catalog 与用户档位都更小时保留较小的那个 */
export function resolveMaxTokens(
  contextWindow: number,
  catalogMaxTokens?: number,
  userMaxTokens?: number | null
): number {
  return resolveMaxTokensDetail(contextWindow, catalogMaxTokens, userMaxTokens).value
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
      // 0 视为自动，不写入配置，保持旧配置形状不变
      ...(normalizeMaxTokens(item.maxTokens) > 0
        ? { maxTokens: normalizeMaxTokens(item.maxTokens) }
        : {}),
    })
  }

  const selected = typeof apiConfig.selectedModel === 'string' ? apiConfig.selectedModel.trim() : ''
  if (selected && !seen.has(selected)) {
    entries.unshift({ id: selected, contextWindow: DEFAULT_CONTEXT_WINDOW, image: false })
  }

  return entries
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
            maxTokens: resolveMaxTokens(entry.contextWindow, known.maxTokens, entry.maxTokens),
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
