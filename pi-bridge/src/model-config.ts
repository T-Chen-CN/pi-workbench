/**
 * `models.json` 写入与思考档位常量。
 *
 * 这份文件完全由应用生成（D13）：只写 `modelOverrides`（用户下调的容量），
 * provider 身份 / baseUrl / api 协议 / 模型元数据全部来自 Pi 内置 catalog +
 * pi.dev 增量，我们不再维护副本。
 *
 * 两条约束：
 * - 只写白名单内的 provider（D25）：未知 id 会被 SDK 当成「零模型 provider」
 *   重新注册，`getModel` 永远拿不到模型；
 * - 每次 `AgentManager.initialize()` 覆盖写，旧版本的 `pi-workbench` 条目
 *   必须随之消失，否则会残留陈旧模型定义。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { writeJsonAtomicAsync } from './atomic-json.js'
import { isPresetProviderId, type ModelOverrides } from './provider-presets.js'

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

export interface ModelsConfigInput {
  providerId: string
  /** 该 provider 下按模型存的下调值；空表 = 全部用 catalog 真值 */
  overrides?: Record<string, ModelOverrides>
  /** 额外写入的 provider（多 provider 覆盖时用），同样受白名单约束 */
  extraProviders?: Record<string, Record<string, ModelOverrides> | undefined>
}

/**
 * 把容量下调写进 Pi 的 models.json，返回文件路径。
 *
 * SDK 的 `modelOverrides` 是最上层（`applyModelOverride`），所以写进去之后
 * `getModel()` 返回的对象里 `contextWindow` / `maxTokens` 已是生效值。
 */
export async function writeModelsConfig(
  agentDir: string,
  input: ModelsConfigInput
): Promise<string> {
  const modelsPath = path.join(agentDir, 'models.json')
  const providers: Record<string, { modelOverrides?: Record<string, ModelOverrides> }> = {}

  const assign = (providerId: string, overrides?: Record<string, ModelOverrides>): void => {
    if (!isPresetProviderId(providerId)) return
    if (!overrides || Object.keys(overrides).length === 0) return
    const cleaned: Record<string, ModelOverrides> = {}
    for (const [modelId, value] of Object.entries(overrides)) {
      if (!value) continue
      const entry: ModelOverrides = {}
      if (typeof value.contextWindow === 'number' && value.contextWindow > 0) {
        entry.contextWindow = value.contextWindow
      }
      if (typeof value.maxTokens === 'number' && value.maxTokens > 0) {
        entry.maxTokens = value.maxTokens
      }
      if (Object.keys(entry).length > 0) cleaned[modelId] = entry
    }
    if (Object.keys(cleaned).length > 0) providers[providerId] = { modelOverrides: cleaned }
  }

  assign(input.providerId, input.overrides)
  for (const [providerId, overrides] of Object.entries(input.extraProviders ?? {})) {
    assign(providerId, overrides)
  }

  const modelsConfig = {
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers,
  }

  await fs.mkdir(agentDir, { recursive: true })
  await writeJsonAtomicAsync(modelsPath, modelsConfig)
  return modelsPath
}

/** 自动压缩默认目标占比（85%，留 15% buffer），与主流 Coding Agent 口径对齐 */
const DEFAULT_COMPACTION_TARGET_RATIO = 0.85
/** 最小预留 token，保证模型有足够输出与系统开销空间 */
const MIN_COMPACTION_RESERVE_TOKENS = 16_384
/** 极小窗口保护：预留不超过总窗口的 35%，避免 32K 以下过早触发压缩 */
const MAX_COMPACTION_RESERVE_RATIO = 0.35
const DEFAULT_KEEP_RECENT_TOKENS = 20_000
const MIN_KEEP_RECENT_TOKENS = 2_048

export interface CompactionThresholds {
  reserveTokens: number
  keepRecentTokens: number
  /** 近似触发百分比（整数，如 85） */
  triggerPercent: number
}

/**
 * 按模型生效的上下文窗口计算自动压缩参数。
 * - 大窗口（>=128K）：约 85% 触发（留 15% buffer）
 * - 64K 窗口：75% 触发（留 16,384 tokens）
 * - 极小窗口（<=32K）：按 35% 上限夹取预留，并同比收缩 keepRecentTokens 避免压不动
 */
export function computeCompactionThresholds(contextWindow: number): CompactionThresholds {
  const windowTokens = Math.max(1, Math.floor(contextWindow))
  const desiredReserve = Math.max(
    MIN_COMPACTION_RESERVE_TOKENS,
    Math.round(windowTokens * (1 - DEFAULT_COMPACTION_TARGET_RATIO))
  )
  const reserveTokens = Math.min(
    desiredReserve,
    Math.max(1, Math.floor(windowTokens * MAX_COMPACTION_RESERVE_RATIO))
  )
  const usableBudget = Math.max(1, windowTokens - reserveTokens)
  const keepRecentTokens = Math.min(
    DEFAULT_KEEP_RECENT_TOKENS,
    Math.max(MIN_KEEP_RECENT_TOKENS, Math.floor(usableBudget * 0.35))
  )
  const triggerPercent = Math.max(
    1,
    Math.min(99, Math.round(((windowTokens - reserveTokens) / windowTokens) * 100))
  )
  return { reserveTokens, keepRecentTokens, triggerPercent }
}

/**
 * 将当前供应商各生效模型的自动压缩参数写入 `{agentDir}/settings.json`。
 * 只更新当前 `providerId/*` 对应的 `compaction.modelOverrides`，保留其他设置项与其他供应商条目。
 */
export async function writeCompactionSettings(
  agentDir: string,
  providerId: string,
  models: ReadonlyArray<{ id: string; contextWindow: number }>
): Promise<string> {
  const settingsPath = path.join(agentDir, 'settings.json')
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch {
    existing = {}
  }

  const currentCompaction =
    existing.compaction && typeof existing.compaction === 'object' && !Array.isArray(existing.compaction)
      ? ({ ...(existing.compaction as Record<string, unknown>) } as Record<string, unknown>)
      : {}
  const existingOverrides =
    currentCompaction.modelOverrides &&
    typeof currentCompaction.modelOverrides === 'object' &&
    !Array.isArray(currentCompaction.modelOverrides)
      ? ({ ...(currentCompaction.modelOverrides as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : {}

  const prefix = `${providerId}/`
  for (const key of Object.keys(existingOverrides)) {
    if (key.startsWith(prefix)) delete existingOverrides[key]
  }
  for (const model of models) {
    if (!model.id || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) continue
    const { reserveTokens, keepRecentTokens } = computeCompactionThresholds(model.contextWindow)
    existingOverrides[`${providerId}/${model.id}`] = { reserveTokens, keepRecentTokens }
  }

  const next = {
    ...existing,
    compaction: {
      ...currentCompaction,
      enabled: currentCompaction.enabled ?? true,
      modelOverrides: existingOverrides,
    },
  }
  await fs.mkdir(agentDir, { recursive: true })
  await writeJsonAtomicAsync(settingsPath, next, { backup: false })
  return settingsPath
}
