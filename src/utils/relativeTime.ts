/** 相对时间文本：刚发生显示分钟，超过 30 天显示日期 */

export type RelativeTimeLanguage = 'zh' | 'en'

export function formatRelativeTime(
  value: number | string,
  language: RelativeTimeLanguage
): string {
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const diff = Date.now() - timestamp
  const minutes = Math.max(1, Math.round(diff / 60_000))
  const formatter = new Intl.RelativeTimeFormat(language === 'zh' ? 'zh-CN' : 'en', {
    numeric: 'auto',
  })
  if (minutes < 60) return formatter.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 24) return formatter.format(-hours, 'hour')
  const days = Math.round(hours / 24)
  if (days < 30) return formatter.format(-days, 'day')
  return new Date(timestamp).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')
}
