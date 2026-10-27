import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatRelativeTime } from '../src/utils/relativeTime'

const NOW = new Date('2026-05-20T12:00:00Z')

function ago(ms: number): number {
  return NOW.getTime() - ms
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('中文保持自然说法，英文使用紧凑单位', () => {
    expect(formatRelativeTime(ago(MINUTE), 'zh')).toBe('1分钟前')
    expect(formatRelativeTime(ago(1), 'zh')).toBe('1分钟前')
    expect(formatRelativeTime(ago(5 * MINUTE), 'zh')).toBe('5分钟前')
    expect(formatRelativeTime(ago(59 * MINUTE), 'zh')).toBe('59分钟前')
    expect(formatRelativeTime(ago(3 * HOUR), 'zh')).toBe('3小时前')
    expect(formatRelativeTime(ago(23 * HOUR), 'zh')).toBe('23小时前')
    expect(formatRelativeTime(ago(29 * DAY), 'zh')).toBe('29天前')

    expect(formatRelativeTime(ago(MINUTE), 'en')).toBe('1m')
    expect(formatRelativeTime(ago(59 * MINUTE), 'en')).toBe('59m')
    expect(formatRelativeTime(ago(3 * HOUR), 'en')).toBe('3h')
    expect(formatRelativeTime(ago(23 * HOUR), 'en')).toBe('23h')
    expect(formatRelativeTime(ago(29 * DAY), 'en')).toBe('29d')
  })

  it('一天与两天：中文保留「昨天 / 前天」，英文走 1d / 2d', () => {
    expect(formatRelativeTime(ago(DAY), 'zh')).toBe('昨天')
    expect(formatRelativeTime(ago(2 * DAY), 'zh')).toBe('前天')
    expect(formatRelativeTime(ago(DAY), 'en')).toBe('1d')
    expect(formatRelativeTime(ago(2 * DAY), 'en')).toBe('2d')
  })

  it('超过 30 天走两位年份的本地化日期，两种语言宽度一致', () => {
    const zh = formatRelativeTime(ago(30 * DAY), 'zh')
    const en = formatRelativeTime(ago(30 * DAY), 'en')
    expect(zh).toBe('26/04/20')
    expect(en).toBe('04/20/26')
    expect(zh).toHaveLength(8)
    expect(en).toHaveLength(8)
    expect(formatRelativeTime('2025-12-31T00:00:00Z', 'zh')).toBe('25/12/31')
    expect(formatRelativeTime('2025-12-31T00:00:00Z', 'en')).toBe('12/31/25')
  })

  it('非法输入返回空串', () => {
    expect(formatRelativeTime('not-a-date', 'zh')).toBe('')
  })
})
