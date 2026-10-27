/** 提交行 ref 徽章的折叠：窄面板按可用宽度放，宽面板按个数折 */

import type { GitRefChip } from './gitRefs'

/** 徽章固定装饰：边框 2px + px-1 左右 8px + 图标 10px + gap-0.5 2px */
export const REF_BADGE_CHROME = 22
/** `+N` 徽章固定装饰：边框 2px + px-1 左右 */
export const REF_OVERFLOW_CHROME = 10
/** 徽章之间的间距（gap-1） */
export const REF_GAP = 4

export interface FittedRefs {
  shown: GitRefChip[]
  hidden: GitRefChip[]
  /** 连一个徽章都放不下：shown 里唯一那个需要允许截断 */
  truncated: boolean
}

/** 宽面板的计数折叠：超过上限时只留第一个 */
export function splitRefsByCount(chips: GitRefChip[], maxVisible: number): FittedRefs {
  const shown = chips.length > maxVisible ? chips.slice(0, 1) : chips
  return { shown, hidden: chips.slice(shown.length), truncated: false }
}

/**
 * 窄面板的宽度折叠：按顺序累加徽章宽度，同时为末尾的 `+N` 预留位置。
 * `measureText` 返回文本在 `type-caption` 下的宽度；量不到时返回 0，调用方应改走计数折叠。
 */
export function fitRefChips(
  chips: GitRefChip[],
  availableWidth: number,
  measureText: (text: string) => number
): FittedRefs {
  if (availableWidth <= 0) return { shown: [], hidden: chips, truncated: false }
  let used = 0
  let shown = 0
  for (let index = 0; index < chips.length; index += 1) {
    const gap = index > 0 ? REF_GAP : 0
    const width = REF_BADGE_CHROME + measureText(chips[index].label)
    const rest = chips.length - index - 1
    const tail = rest > 0 ? REF_GAP + REF_OVERFLOW_CHROME + measureText(`+${rest}`) : 0
    if (used + gap + width + tail > availableWidth) break
    used += gap + width
    shown = index + 1
  }
  if (shown === 0) return { shown: chips.slice(0, 1), hidden: chips.slice(1), truncated: true }
  return { shown: chips.slice(0, shown), hidden: chips.slice(shown), truncated: false }
}
