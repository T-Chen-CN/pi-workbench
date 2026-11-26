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

/**
 * 语义词族下面**只有这些 token 存在**（`tailwind.config.js` 的 `colors`）。
 * 名单外的名字（`text-warn` / `text-ink-faint`）不报错，只是**什么都没渲染**——
 * 颜色静默失灵比报错难发现，所以把这类拼错体变成测试失败。
 */
const SEMANTIC_TOKENS: Record<string, string[]> = {
  ink: ['muted', 'subtle', 'inverted'],
  accent: ['hover', 'fg'],
  success: ['hover'],
  warning: ['hover'],
  danger: ['hover', 'fg'],
}
/** 族名拼错体（`text-warn`）：颜色后缀根本没参与解析，shade 校验看不到它 */
const SEMANTIC_ALIASES: Record<string, string> = {
  warn: 'warning',
  succes: 'success',
  dange: 'danger',
}
const SEMANTIC_PATTERN =
  /\b(?:text|bg|border)-(ink|accent|success|warning|danger|warn|succes|dange)(-[a-z0-9-]+)?(?=\/|\s|'|"|`|\)|\}|,)/g

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

  it('does not invent semantic color tokens that would render nothing', () => {
    const violations: string[] = []

    for (const file of businessFiles) {
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(SEMANTIC_PATTERN)) {
        const family = match[1]
        if (SEMANTIC_ALIASES[family]) {
          const line = source.slice(0, match.index).split('\n').length
          violations.push(
            `${relative(SRC, file).replace(/\\/g, '/')}:${line} — misspelled color family: ${match[0]} (use ${SEMANTIC_ALIASES[family]})`
          )
          continue
        }
        const shade = match[2]?.slice(1)
        if (!shade) continue
        if (SEMANTIC_TOKENS[family]?.includes(shade)) continue
        const line = source.slice(0, match.index).split('\n').length
        violations.push(
          `${relative(SRC, file).replace(/\\/g, '/')}:${line} — unknown semantic color: ${match[0]}`
        )
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
      'components/ChatSessionList.tsx',
      'components/CloudStatusIndicator.tsx',
      'components/CommandPalette.tsx',
      'components/DiffViewer.tsx',
      'components/FileExplorer.tsx',
      'components/PanelContextMenu.tsx',
      'components/SelectionQuoteButton.tsx',
      'components/StreamingTranscript.tsx',
      'components/Toast.tsx'
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

  it('rejects undefined rule, surface, and shadow utility classes across all TSX files', () => {
    const UNDEFINED_UTILITIES = [
      {
        label: 'undefined rule token (use rule-control|rule-divide|rule-hairline|rule-seam)',
        pattern: /(?<!-)\b(?:border|bg|text|divide)-rule(?!-(?:control|divide|hairline|seam)\b)(?:-[a-z0-9-]+)?(?=\/|\s|'|"|`|\)|\}|,|$)/g,
      },
      {
        label: 'undefined surface shade (use surface|panel|raised|sunken)',
        pattern: /(?<!-)\b(?:bg|text|border)-surface-[a-z0-9-]+(?=\/|\s|'|"|`|\)|\}|,|$)/g,
      },
      {
        label: 'undefined shadow token (only shadow-print, shadow-panel, shadow-none exist)',
        pattern: /(?<!-)\bshadow-(?!print\b|panel\b|none\b)[a-z0-9-]+(?=\s|'|"|`|\)|\}|,|$)/g,
      },
    ]
    const violations: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file).replace(/\\/g, '/')
      const source = readFileSync(file, 'utf-8')
      for (const rule of UNDEFINED_UTILITIES) {
        for (const match of source.matchAll(rule.pattern)) {
          const line = source.slice(0, match.index).split('\n').length
          violations.push(`${rel}:${line} — ${rule.label}: ${match[0]}`)
        }
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

  // 命中区规则：标签的可点区域必须是标签矩形本体（patterns.tsx 的 Tab），
  // 不允许业务组件再拼一层「wrapper + 内层小按钮」，那会让 padding 变成死区。
  it('builds tabs only from the shared Tab pattern', () => {
    const violations: string[] = []
    for (const file of businessFiles) {
      const rel = relative(SRC, file).replace(/\\/g, '/')
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(/role="tab"/g)) {
        const line = source.slice(0, match.index).split('\n').length
        violations.push(`${rel}:${line} — 自行拼装 role="tab"，改用 patterns.tsx 的 Tab`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('keeps the tab close target at least 24px', () => {
    const patterns = readFileSync(resolve(SRC, 'components/patterns.tsx'), 'utf-8')
    const close = patterns.slice(patterns.indexOf('data-tab-aux=""'))
    expect(close).toContain('h-6 w-6')
  })
})

describe('cloud web design system compliance (D-06)', () => {
  const CLOUD_WEB_SRC = resolve(__dirname, '../apps/cloud/web-src')
  const webTsxFiles = walk(CLOUD_WEB_SRC).filter((file) => file.endsWith('.tsx'))
  const webAllTsFiles = walk(CLOUD_WEB_SRC).filter((file) => /\.(ts|tsx)$/.test(file))
  const indexHtml = readFileSync(resolve(CLOUD_WEB_SRC, 'index.html'), 'utf-8')
  const faviconSvg = readFileSync(resolve(CLOUD_WEB_SRC, 'public/favicon.svg'), 'utf-8')
  const mainTsx = readFileSync(resolve(CLOUD_WEB_SRC, 'main.tsx'), 'utf-8')

  it('reuses shared Paper & Ink stylesheet, bundled fonts, and Pine favicon', () => {
    expect(mainTsx).toContain("import '../../../src/index.css'")
    expect(mainTsx).toContain('@fontsource/instrument-serif')
    expect(mainTsx).toContain('@fontsource-variable/noto-sans-sc')
    expect(mainTsx).toContain('@fontsource-variable/geist-mono')
    expect(faviconSvg).toContain('#2F5D4E')
    expect(indexHtml).toContain('viewport-fit=cover')
  })

  it('obeys the same Paper & Ink typography, palette, and semantic token rules as desktop', () => {
    const violations: string[] = []
    for (const file of webTsxFiles) {
      const rel = relative(CLOUD_WEB_SRC, file).replace(/\\/g, '/')
      const source = readFileSync(file, 'utf-8')
      for (const rule of FORBIDDEN) {
        for (const match of source.matchAll(rule.pattern)) {
          const line = source.slice(0, match.index).split('\n').length
          violations.push(`${rel}:${line} — ${rule.label}: ${match[0]}`)
        }
      }
      for (const match of source.matchAll(SEMANTIC_PATTERN)) {
        const family = match[1]
        if (SEMANTIC_ALIASES[family]) {
          const line = source.slice(0, match.index).split('\n').length
          violations.push(`${rel}:${line} — misspelled color family: ${match[0]}`)
          continue
        }
        const shade = match[2]?.slice(1)
        if (!shade || SEMANTIC_TOKENS[family]?.includes(shade)) continue
        const line = source.slice(0, match.index).split('\n').length
        violations.push(`${rel}:${line} — unknown semantic color: ${match[0]}`)
      }
      for (const match of source.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) {
        const line = source.slice(0, match.index).split('\n').length
        violations.push(`${rel}:${line} — hardcoded color: ${match[0]}`)
      }
      for (const match of source.matchAll(/role="tab"/g)) {
        const line = source.slice(0, match.index).split('\n').length
        violations.push(`${rel}:${line} — 自行拼装 role="tab"，改用 patterns.tsx 的 Tab`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('reserves full-ink borders for floating layers in Cloud Web', () => {
    const CLOUD_WEB_FLOATING = new Set(['CloudWebApp.tsx'])
    const violations: string[] = []
    for (const file of webTsxFiles) {
      const rel = relative(CLOUD_WEB_SRC, file).replace(/\\/g, '/')
      if (CLOUD_WEB_FLOATING.has(rel)) continue
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(/\bborder-line\b/g)) {
        const line = source.slice(0, match.index).split('\n').length
        violations.push(`${rel}:${line} — full-ink border outside a floating layer`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('forbids innerHTML, dangerouslySetInnerHTML, and eval in Cloud Web sources', () => {
    const forbidden = [
      /[.]innerHTML\b/,
      /[.]outerHTML\b/,
      /insertAdjacentHTML/,
      /document[.]write\(/,
      /\beval\(/,
      /\bdangerouslySetInnerHTML\b/,
    ]
    for (const file of webAllTsFiles) {
      const source = readFileSync(file, 'utf-8')
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${pattern} in ${file}`).toBe(false)
      }
    }
  })
})
