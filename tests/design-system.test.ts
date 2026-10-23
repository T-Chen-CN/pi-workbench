import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '../src')
const ALLOWED = new Set(['components/ui.tsx', 'components/patterns.tsx'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const files = walk(SRC).filter((file) => file.endsWith('.tsx'))
const businessFiles = files.filter((file) => {
  const rel = relative(SRC, file).replace(/\\/g, '/')
  return !ALLOWED.has(rel)
})

const FORBIDDEN = [
  { label: 'font family utility', pattern: /\bfont-(sans|mono|display|reading)\b/g },
  { label: 'arbitrary font size', pattern: /\btext-\[[0-9.]+px\]/g },
  { label: 'named font size', pattern: /\btext-(xs|sm|base|lg|xl|2xl|3xl)\b/g },
  { label: 'uppercase', pattern: /\buppercase\b/g },
  { label: 'arbitrary tracking', pattern: /\btracking-\[[^\]]+\]/g },
  { label: 'arbitrary line height', pattern: /\bleading-\[[^\]]+\]/g },
  { label: 'raw palette color', pattern: /\b(?:bg|text|border)-(?:gray|blue|red|green|yellow|zinc|neutral|slate|white|black)\b/g },
  { label: 'oversized radius', pattern: /\brounded-(?:md|lg|xl|2xl|3xl)\b/g },
  { label: 'soft shadow', pattern: /\bshadow-(?:sm|md|lg|xl|2xl)\b/g },
  { label: 'slow motion', pattern: /\bduration-(?:300|500|700|1000)\b/g },
  { label: 'dark variant', pattern: /\bdark:/g },
]

describe('design system usage', () => {
  it('does not allow raw typography outside ui.tsx and patterns.tsx', () => {
    const violations: string[] = []

    for (const file of businessFiles) {
      const source = readFileSync(file, 'utf-8')
      for (const rule of FORBIDDEN) {
        for (const match of source.matchAll(rule.pattern)) {
          const line = source.slice(0, match.index).split('\n').length
          violations.push(
            `${relative(SRC, file).replace(/\\/g, '/')}:${line} — ${rule.label}: ${match[0]}`
          )
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })

  it('does not allow hardcoded hex colors in renderer components', () => {
    const violations: string[] = []

    for (const file of businessFiles) {
      const rel = relative(SRC, file).replace(/\\/g, '/')
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) {
        const line = source.slice(0, match.index).split('\n').length
        violations.push(`${rel}:${line} — hardcoded color: ${match[0]}`)
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })

  it('keeps the semantic typography roles in one place', () => {
    const css = readFileSync(resolve(SRC, 'index.css'), 'utf-8')
    for (const role of [
      'type-eyebrow',
      'type-eyebrow-cjk',
      'type-display',
      'type-brand',
      'type-title',
      'type-subtitle',
      'type-project',
      'type-reading',
      'type-body',
      'type-label',
      'type-value',
      'type-caption',
      'type-data',
      'type-code',
      'type-key',
      'type-stamp',
      'type-stamp-sub',
      'type-wordmark',
    ]) {
      expect(css).toContain(`.${role}`)
    }
  })

  it('exports the shared content patterns', () => {
    const patterns = readFileSync(resolve(SRC, 'components/patterns.tsx'), 'utf-8')
    for (const component of [
      'Card',
      'CardHeader',
      'SectionHeader',
      'Stat',
      'StatGrid',
      'StatusText',
      'QuickAction',
      'ListRow',
      'KeyCap',
      'SearchField',
      'Meter',
    ]) {
      expect(patterns).toContain(`export const ${component}`)
    }
  })

  it('exports the semantic text primitives', () => {
    const ui = readFileSync(resolve(SRC, 'components/ui.tsx'), 'utf-8')
    for (const primitive of ['Label', 'Value', 'Caption', 'DataText', 'Eyebrow']) {
      expect(ui).toContain(`export const ${primitive}`)
    }
  })

  it('defines the line roles and maps them to Tailwind', () => {
    const css = readFileSync(resolve(SRC, 'index.css'), 'utf-8')
    const tailwind = readFileSync(resolve(__dirname, '../tailwind.config.js'), 'utf-8')
    for (const role of ['rule-control', 'rule-divide', 'rule-hairline', 'rule-seam']) {
      expect(css).toContain(`--${role}`)
      expect(tailwind).toContain(`'${role}'`)
    }
  })

  it('builds cards from the raised surface and a hairline border', () => {
    const patterns = readFileSync(resolve(SRC, 'components/patterns.tsx'), 'utf-8')
    expect(patterns).toContain('border border-rule-hairline bg-raised')
    expect(patterns).not.toContain('shadow-print')
    expect(patterns).toContain('border-b border-rule-divide')
  })

  it('does not bypass the line roles with raw opacity', () => {
    const violations: string[] = []
    for (const file of businessFiles) {
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(/\bborder-line\/[^\s'"`]+/g)) {
        const line = source.slice(0, match.index).split('\n').length
        violations.push(
          `${relative(SRC, file).replace(/\\/g, '/')}:${line} — raw line opacity: ${match[0]}`
        )
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('reserves full-ink borders for floating layers', () => {
    const FLOATING = new Set([
      'App.tsx',
      'components/ChatPanel.tsx',
      'components/CommandPalette.tsx',
      'components/DiffViewer.tsx',
      'components/FileExplorer.tsx',
      'components/FleetPanel.tsx',
      'components/Toast.tsx',
    ])
    const violations: string[] = []
    for (const file of businessFiles) {
      const rel = relative(SRC, file).replace(/\\/g, '/')
      if (FLOATING.has(rel)) continue
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(/\bborder-line\b/g)) {
        const line = source.slice(0, match.index).split('\n').length
        violations.push(`${rel}:${line} — full-ink border outside a floating layer`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('does not paint full-ink backgrounds as separators', () => {
    const violations: string[] = []
    for (const file of businessFiles) {
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(/\bbg-line\b/g)) {
        const line = source.slice(0, match.index).split('\n').length
        violations.push(
          `${relative(SRC, file).replace(/\\/g, '/')}:${line} — full-ink separator background`
        )
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})
