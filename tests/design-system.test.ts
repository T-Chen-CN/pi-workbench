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
      'components/CommandPalette.tsx',
      'components/DiffViewer.tsx',
      'components/FileExplorer.tsx',
      'components/PanelContextMenu.tsx',
      'components/SelectionQuoteButton.tsx',
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
  const CLOUD_WEB = resolve(__dirname, '../apps/cloud/web')
  const appCss = readFileSync(resolve(CLOUD_WEB, 'app.css'), 'utf-8')
  const appJs = readFileSync(resolve(CLOUD_WEB, 'app.js'), 'utf-8')
  const indexHtml = readFileSync(resolve(CLOUD_WEB, 'index.html'), 'utf-8')
  const faviconSvg = readFileSync(resolve(CLOUD_WEB, 'favicon.svg'), 'utf-8')

  it('uses Paper & Ink Pine tokens, four surfaces, and three derived ink rules', () => {
    expect(appCss).toContain('--accent: 47 93 78;')
    expect(appCss).toContain('--accent: 143 199 180;')
    for (const token of [
      '--surface:',
      '--panel:',
      '--raised:',
      '--sunken:',
      '--rule-control:',
      '--rule-divide:',
      '--rule-hairline:',
      '--accent-fg:',
      '--success:',
    ]) {
      expect(appCss).toContain(token)
    }
    expect(appCss.toLowerCase()).not.toContain('#8a5a2b')
    expect(appCss.toLowerCase()).not.toContain('#d0a068')
    expect(faviconSvg).toContain('#2F5D4E')
  })

  it('forbids 999px capsule buttons and legacy .pill classes', () => {
    expect(appCss).not.toMatch(/\.pill\b/)
    expect(appJs).not.toMatch(/['"]pill(?:\s|['"])/)
    expect(appCss).not.toMatch(/border-radius:\s*999px\b/)
    // 9999px 圆角只允许给 6px 状态小圆点使用，不得用于按钮/卡片/输入框
    const radiusMatches = [...appCss.matchAll(/([^{}]+)\{[^{}]*border-radius:\s*9999px[^{}]*\}/g)]
    for (const match of radiusMatches) {
      const selector = match[1].trim()
      expect(selector).toMatch(/^\.(?:status-dot|msg-streaming)$/)
    }
  })

  it('forbids innerHTML and HTML string injection in app.js', () => {
    for (const forbidden of [
      /[.]innerHTML\b/,
      /[.]outerHTML\b/,
      /insertAdjacentHTML/,
      /document[.]write\(/,
      /\beval\(/,
    ]) {
      expect(forbidden.test(appJs), `forbidden pattern ${forbidden}`).toBe(false)
    }
  })

  it('keeps Chinese card titles and form labels in UI sans without uppercase', () => {
    const cardH3 = appCss.match(/\.card\s+h3\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(cardH3).toContain('var(--font-ui)')
    expect(cardH3).not.toContain('uppercase')
    expect(cardH3).not.toContain('letter-spacing')
    // 表单中文字段标签不得套 .mono
    expect(appJs).not.toMatch(/el\('label',\s*\{\s*class:\s*'[^']*mono/)
    expect(indexHtml).toContain('href="/fonts.css"')
    expect(indexHtml).toContain('viewport-fit=cover')
  })
})
