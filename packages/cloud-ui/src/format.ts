/**
 * 云端前端共享格式化工具（时间 / 耗时 / Token / 标签 / 工单摘要单行预览）。
 */

export function formatCloudTime(ts?: number, withSeconds = false): string {
  if (!ts) return ''
  try {
    const date = new Date(ts)
    if (withSeconds) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  } catch {
    return ''
  }
}

export function formatCloudDuration(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest}s`
}

export function formatCloudTokens(value?: number): string {
  if (!value) return '-'
  if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`
  return `${Math.round(value / 1024)}K`
}

export function parseCloudTagsInput(raw: string): string[] {
  return String(raw || '')
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12)
}

/** 将可能包含 Markdown 标题、表格与加粗符号的长文本收成干净的单行纯文本预览 */
export function summarizeCloudTaskPreview(raw?: string, maxChars = 140): string {
  if (!raw) return ''
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[-*_]{3,}$/.test(line) && !/^\|?(?:\s*:?-+:?\s*\|)+$/.test(line))
  if (lines.length === 0) return ''

  const cleaned = lines
    .slice(0, 3)
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s*/, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_`~]+/g, '')
        .replace(/\s*\|\s*/g, ' · ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim()

  if (cleaned.length <= maxChars) return cleaned
  return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`
}
