import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type RGB = [number, number, number]

const css = readFileSync(resolve(__dirname, '../src/index.css'), 'utf-8')

function parseTheme(block: RegExpMatchArray | null): Record<string, RGB> {
  expect(block).not.toBeNull()
  const vars: Record<string, RGB> = {}
  const pattern = /--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g
  for (const match of block![1].matchAll(pattern)) {
    vars[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])]
  }
  return vars
}

const paper = parseTheme(css.match(/:root\s*{([\s\S]*?)}/))
const ink = parseTheme(css.match(/html\.dark\s*{([\s\S]*?)}/))

function luminance([r, g, b]: RGB): number {
  const channel = (value: number) => {
    const scaled = value / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: RGB, b: RGB): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

function blend(fg: RGB, alpha: number, bg: RGB): RGB {
  return fg.map((value, index) => Math.round(value * alpha + bg[index] * (1 - alpha))) as RGB
}

function ruleAlpha(role: string): number {
  const match = css.match(
    new RegExp(`--${role}:\\s*rgb\\(var\\(--line\\)\\s*/\\s*([0-9.]+)\\)`)
  )
  expect(match, role).not.toBeNull()
  return Number(match![1])
}

describe.each([
  ['Paper', paper],
  ['Ink', ink],
])('%s text token contrast', (_name, theme) => {
  it('keeps informative text at or above 4.5:1 on both surface and panel', () => {
    for (const background of ['surface', 'panel'] as const) {
      for (const foreground of ['ink', 'ink-muted'] as const) {
        expect(
          contrast(theme[foreground], theme[background]),
          `${foreground} on ${background}`
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps the accent readable on the main surface', () => {
    expect(contrast(theme.accent, theme.surface)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps ink-subtle out of the informative text tier', () => {
    expect(contrast(theme['ink-subtle'], theme.panel)).toBeLessThan(4.5)
  })

  it('keeps control borders at or above 3:1', () => {
    const alpha = ruleAlpha('rule-control')
    for (const background of ['surface', 'panel'] as const) {
      expect(
        contrast(blend(theme.line, alpha, theme[background]), theme[background]),
        `rule-control on ${background}`
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps dividers, hairlines and seams decorative', () => {
    for (const role of ['rule-divide', 'rule-hairline', 'rule-seam']) {
      const alpha = ruleAlpha(role)
      for (const background of ['surface', 'panel'] as const) {
        expect(
          contrast(blend(theme.line, alpha, theme[background]), theme[background]),
          `${role} on ${background}`
        ).toBeLessThan(3)
      }
    }
  })

  it('orders the hairline below the divider', () => {
    expect(ruleAlpha('rule-hairline')).toBeLessThan(ruleAlpha('rule-divide'))
  })
})

describe('font stacks', () => {
  const ui = css.match(/--font-ui:\s*([^;]+);/)?.[1] ?? ''
  const mono = css.match(/--font-mono:\s*([^;]+);/)?.[1] ?? ''

  it('pairs Noto Sans with an explicit Simplified Chinese fallback', () => {
    expect(ui).toContain('Noto Sans')
    expect(ui).toContain('Noto Sans SC')
    expect(ui).not.toContain('Inter')
  })

  it('uses Geist Mono for data and falls back to Simplified Chinese', () => {
    expect(mono).toContain('Geist Mono')
    expect(mono).toContain('Noto Sans SC')
    expect(mono).not.toContain('IBM Plex Mono')
  })
})
