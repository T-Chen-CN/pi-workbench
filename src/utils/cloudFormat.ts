/** 云端会话的数值 / 文本格式化（纯函数，便于单测） */

import type { CloudSession } from '../types/cloud'

/** 花费：0 显示 $0，1 美元以下保留 4 位，其余 2 位；无效值显示破折号 */
export function formatCost(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value === 0) return '$0'
  if (value < 1) {
    const text = value.toFixed(4)
    // $0.0000 这种四舍五入后为 0 的极小值，标成 <$0.0001 更诚实
    return text === '0.0000' ? '<$0.0001' : `$${text.replace(/0+$/, '').replace(/\.$/, '')}`
  }
  return `$${value.toFixed(2)}`
}

/** 会话花费：实际值优先，后端未回填时退回估算值 */
export function sessionCostUsd(session: Pick<CloudSession, 'costUsd'>): number {
  return Number.isFinite(session.costUsd) ? session.costUsd : 0
}

/** 工具结果 / 预览文本：压平空白后截断，避免撑破卡片 */
export function truncateText(text: string | null | undefined, max: number): string {
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** 首行摘要（列表预览、工具参数） */
export function firstLine(text: string | null | undefined, max: number): string {
  if (!text) return ''
  const line = text.split('\n')[0]
  return truncateText(line, max)
}
