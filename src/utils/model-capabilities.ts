/** 模型能力表共用的容量档位与合并逻辑 */

import type { ApiModelEntry, ModelContextWindow, ModelMaxTokens } from '../types/electron'

/** 与主进程的 CONTEXT_WINDOW_VALUES / pi-bridge 的 CONTEXT_WINDOW_OPTIONS 一致 */
export const CONTEXT_WINDOW_OPTIONS: ModelContextWindow[] = [64_000, 128_000, 256_000, 1_000_000]

export const DEFAULT_CONTEXT_WINDOW: ModelContextWindow = 128_000

/**
 * 输出上限档位（0 = 自动）。与 pi-bridge 的 MAX_TOKENS_OPTIONS 一致，
 * 测试会锁住两边同步。
 */
export const MAX_TOKENS_OPTIONS: ModelMaxTokens[] = [0, 16_384, 32_768, 65_536, 131_072, 262_144]

/** 输出档位是 2 的幂（16384 → 16K），0 由调用方渲染为「自动」 */
export function maxTokensLabel(value: number): string {
  return `${Math.round(value / 1024)}K`
}

/** 档位标签是固定字面量，不翻译：64000 → 64K，1000000 → 1M */
export function contextWindowLabel(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`
  return `${value / 1_000}K`
}

/**
 * 按 id 合并供应商返回的模型列表：
 * 已有 id 保留用户设定的容量与图片能力，新 id 追加默认条目，下线的 id 移除。
 */
export function mergeModelEntries(previous: ApiModelEntry[], ids: string[]): ApiModelEntry[] {
  const known = new Map(previous.map((entry) => [entry.id, entry]))
  const seen = new Set<string>()
  const merged: ApiModelEntry[] = []

  for (const id of ids) {
    const value = typeof id === 'string' ? id.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    const existing = known.get(value)
    merged.push(
      existing
        ? { ...existing }
        : { id: value, contextWindow: DEFAULT_CONTEXT_WINDOW, image: false }
    )
  }

  return merged
}
