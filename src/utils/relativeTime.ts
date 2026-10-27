/** 相对时间文本：分钟/小时/天内用相对说法，超过 30 天显示两位年份的日期 */

export type RelativeTimeLanguage = 'zh' | 'en'

/** 日期分支统一走 Intl 的两位年格式：zh-CN 出 `25/12/31`，en-US 出 `12/31/25` */
const DATE_OPTIONS = { year: '2-digit', month: '2-digit', day: '2-digit' } as const

/** 中文保持 Intl 的自然说法（含「昨天 / 前天」）；英文走紧凑单位，故保留 auto 只给中文用 */
const ZH_RELATIVE = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

function compactZh(value: number, unit: 'minute' | 'hour' | 'day'): string {
  return ZH_RELATIVE.format(-value, unit)
}

function compactEn(value: number, unit: 'm' | 'h' | 'd'): string {
  return `${value}${unit}`
}

export function formatRelativeTime(
  value: number | string,
  language: RelativeTimeLanguage
): string {
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const diff = Date.now() - timestamp
  const minutes = Math.max(1, Math.round(diff / 60_000))
  if (minutes < 60) {
    return language === 'en' ? compactEn(minutes, 'm') : compactZh(minutes, 'minute')
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return language === 'en' ? compactEn(hours, 'h') : compactZh(hours, 'hour')
  }
  const days = Math.round(hours / 24)
  if (days < 30) {
    return language === 'en' ? compactEn(days, 'd') : compactZh(days, 'day')
  }
  return new Date(timestamp).toLocaleDateString(
    language === 'zh' ? 'zh-CN' : 'en-US',
    DATE_OPTIONS
  )
}
