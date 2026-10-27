import { describe, expect, it } from 'vitest'
import {
  REF_BADGE_CHROME,
  REF_GAP,
  REF_OVERFLOW_CHROME,
  fitRefChips,
  splitRefsByCount,
} from '../src/utils/refBadges'
import type { GitRefChip } from '../src/utils/gitRefs'

function chip(label: string): GitRefChip {
  return { kind: 'branch', label, title: label }
}

/** 每字符 6px 的假字宽，便于手算 */
const measure = (text: string) => text.length * 6

const widthOf = (labels: string[]) =>
  labels.reduce(
    (sum, label, index) => sum + (index > 0 ? REF_GAP : 0) + REF_BADGE_CHROME + measure(label),
    0
  )

const overflowWidth = (count: number) => REF_GAP + REF_OVERFLOW_CHROME + measure(`+${count}`)

describe('fitRefChips', () => {
  it('放得下时全部显示，不出现 +N', () => {
    const chips = [chip('main'), chip('origin')]
    const result = fitRefChips(chips, widthOf(['main', 'origin']) + 40, measure)
    expect(result.shown.map((item) => item.label)).toEqual(['main', 'origin'])
    expect(result.hidden).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('宽度不足时依次截断，并为 +N 预留位置', () => {
    const chips = [chip('main'), chip('origin'), chip('feat/a'), chip('feat/b')]
    const available = widthOf(['main', 'origin']) + overflowWidth(2)
    const result = fitRefChips(chips, available, measure)
    expect(result.shown.map((item) => item.label)).toEqual(['main', 'origin'])
    expect(result.hidden.map((item) => item.label)).toEqual(['feat/a', 'feat/b'])
  })

  it('刚好差 1px 时少显示一个徽章', () => {
    const chips = [chip('main'), chip('origin'), chip('feat/a'), chip('feat/b')]
    const available = widthOf(['main', 'origin']) + overflowWidth(2) - 1
    const result = fitRefChips(chips, available, measure)
    expect(result.shown.map((item) => item.label)).toEqual(['main'])
    expect(result.hidden).toHaveLength(3)
  })

  it('单个徽章都比整列宽时保留第一个并标记截断', () => {
    const chips = [chip('very-long-branch-name'), chip('other')]
    const result = fitRefChips(chips, REF_BADGE_CHROME + 10, measure)
    expect(result.shown.map((item) => item.label)).toEqual(['very-long-branch-name'])
    expect(result.hidden.map((item) => item.label)).toEqual(['other'])
    expect(result.truncated).toBe(true)
  })

  it('列宽无效时不渲染任何徽章，全部进 +N', () => {
    const chips = [chip('main'), chip('origin')]
    const result = fitRefChips(chips, 0, measure)
    expect(result.shown).toEqual([])
    expect(result.hidden).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })

  it('字宽为 0 时仍按徽章最小宽度估算，不会把全部徽章塞进一行', () => {
    const chips = [chip('a'), chip('b'), chip('c')]
    const result = fitRefChips(chips, 50, () => 0)
    expect(result.shown).toHaveLength(1)
    expect(result.hidden).toHaveLength(2)
  })
})

describe('splitRefsByCount', () => {
  it('超过上限时只留第一个，其余折叠', () => {
    const chips = [chip('main'), chip('origin'), chip('feat/a')]
    const result = splitRefsByCount(chips, 2)
    expect(result.shown.map((item) => item.label)).toEqual(['main'])
    expect(result.hidden).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })

  it('未超过上限时原样显示', () => {
    const chips = [chip('main'), chip('origin')]
    expect(splitRefsByCount(chips, 2).hidden).toEqual([])
  })
})
