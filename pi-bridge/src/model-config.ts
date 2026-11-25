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
import { writeJsonAtomicSync } from './atomic-json.js'
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
  writeJsonAtomicSync(modelsPath, modelsConfig)
  return modelsPath
}
