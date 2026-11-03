import { describe, expect, it } from 'vitest'
import { firstLine, formatCost, sessionCostUsd, truncateText } from '../src/utils/cloudFormat'

describe('formatCost', () => {
  it('keeps zero and small values readable', () => {
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(0.0004)).toBe('$0.0004')
    expect(formatCost(0.5)).toBe('$0.5')
    expect(formatCost(0.00001)).toBe('<$0.0001')
  })

  it('rounds dollars to cents', () => {
    expect(formatCost(1.234)).toBe('$1.23')
    expect(formatCost(12)).toBe('$12.00')
  })

  it('returns a dash for missing or invalid values', () => {
    expect(formatCost(null)).toBe('—')
    expect(formatCost(undefined)).toBe('—')
    expect(formatCost(Number.NaN)).toBe('—')
    expect(formatCost(-1)).toBe('—')
  })
})

describe('sessionCostUsd', () => {
  it('falls back to zero when cost is not a number', () => {
    expect(sessionCostUsd({ costUsd: Number.NaN })).toBe(0)
    expect(sessionCostUsd({ costUsd: 0.02 })).toBe(0.02)
  })
})

describe('truncateText', () => {
  it('flattens whitespace and keeps short text intact', () => {
    expect(truncateText('  a\n\n  b\tc ', 40)).toBe('a b c')
  })

  it('cuts with an ellipsis at the limit', () => {
    expect(truncateText('abcdefghij', 5)).toBe('abcd…')
  })

  it('treats empty input as empty string', () => {
    expect(truncateText('', 10)).toBe('')
    expect(truncateText(null, 10)).toBe('')
  })
})

describe('firstLine', () => {
  it('keeps only the first line', () => {
    expect(firstLine('line one\nline two', 40)).toBe('line one')
    expect(firstLine('line one\nline two', 4)).toBe('lin…')
  })
})
