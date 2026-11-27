import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const SRC = resolve(ROOT, 'src')
const UI_PKG_SRC = resolve(ROOT, 'packages/ui/src')
const CLOUD_UI_SRC = resolve(ROOT, 'packages/cloud-ui/src')
const CLOUD_WEB_SRC = resolve(ROOT, 'apps/cloud/web-src')

const EXEMPT_STYLE_FILES = new Set([
  'src/components/ui/ui.tsx',
  'src/components/ui/patterns.tsx',
  'src/utils/shikiHighlighter.ts',
  'packages/ui/src/primitives.tsx',
  'packages/ui/src/patterns.tsx',
  'packages/ui/src/shikiHighlighter.ts',
  'packages/cloud-ui/src/primitives.tsx',
])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function relFromRoot(file: string): string {
  return relative(ROOT, file).replace(/\\/g, '/')
}

function isTsSource(file: string): boolean {
  return /\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts')
}

function isExemptFromStyleGuards(rel: string): boolean {
  if (EXEMPT_STYLE_FILES.has(rel)) return true
  if (rel.startsWith('src/theme/')) return true
  return false
}

const srcAllFiles = walk(SRC).filter(isTsSource)
const uiPkgAllFiles = walk(UI_PKG_SRC).filter(isTsSource)
const cloudUiAllFiles = walk(CLOUD_UI_SRC).filter(isTsSource)
const cloudWebAllFiles = walk(CLOUD_WEB_SRC).filter(isTsSource)

const allScannedFiles = [
  ...srcAllFiles,
  ...uiPkgAllFiles,
  ...cloudUiAllFiles,
  ...cloudWebAllFiles,
]
const businessFiles = allScannedFiles.filter((file) => !isExemptFromStyleGuards(relFromRoot(file)))
const allTsxFiles = allScannedFiles.filter((file) => file.endsWith('.tsx'))

interface StringSpan {
  text: string
  offset: number
}

interface ParsedFile {
  rel: string
  sourceFile: ts.SourceFile
  stringSpans: StringSpan[]
  rawTabRoleLines: number[]
}

const parsedCache = new Map<string, ParsedFile>()

/**
 * 用 TypeScript 编译器 AST 提取源码中的字符串/模板字面量片段与 `role="tab"` JSX 属性，
 * 自动跳过 `//`、`/*`、`{/* *\/}` 注释与正则表达式字面量，消除注释误报。
 */
function parseDesignFile(file: string): ParsedFile {
  const cached = parsedCache.get(file)
  if (cached) return cached
  const source = readFileSync(file, 'utf-8')
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const stringSpans: StringSpan[] = []
  const rawTabRoleLines: number[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // +1 跳过起始引号 / 反引号（TemplateMiddle/Tail 以 `}` 开头同样 +1）
      stringSpans.push({ text: node.text, offset: node.getStart(sourceFile) + 1 })
    } else if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === 'role') {
      const init = node.initializer
      const value =
        init && ts.isStringLiteral(init)
          ? init.text
          : init && ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)
            ? init.expression.text
            : null
      if (value === 'tab') {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        rawTabRoleLines.push(line + 1)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  const parsed: ParsedFile = {
    rel: relFromRoot(file),
    sourceFile,
    stringSpans,
    rawTabRoleLines,
  }
  parsedCache.set(file, parsed)
  return parsed
}

function lineForOffset(sourceFile: ts.SourceFile, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, sourceFile.text.length))
  return sourceFile.getLineAndCharacterOfPosition(clamped).line + 1
}

const TAILWIND_PALETTES =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black'

const FORBIDDEN = [
  { label: 'font family utility', pattern: /\bfont-(sans|mono|display|reading)\b/g },
  { label: 'arbitrary font size', pattern: /\btext-\[[0-9.]+px\]/g },
  { label: 'named font size', pattern: /\btext-(xs|sm|base|lg|xl|2xl|3xl)\b/g },
  { label: 'uppercase', pattern: /\buppercase\b/g },
  { label: 'arbitrary tracking', pattern: /\btracking-\[[^\]]+\]/g },
  { label: 'arbitrary line height', pattern: /\bleading-\[[^\]]+\]/g },
  {
    label: 'raw palette color',
    pattern: new RegExp(`\\b(?:bg|text|border)-(?:${TAILWIND_PALETTES})\\b`, 'g'),
  },
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
  /\b(?:text|bg|border)-(ink|accent|success|warning|danger|warn|succes|dange)(-[a-z0-9-]+)?(?=\/|\s|'|"|`|\)|\}|,|$)/g

describe('design system usage', () => {
  it('does not allow raw typography, palette colors, or dark: variants outside exempted primitives', () => {
    const violations: string[] = []

    for (const file of businessFiles) {
      const parsed = parseDesignFile(file)
      for (const span of parsed.stringSpans) {
        for (const rule of FORBIDDEN) {
          for (const match of span.text.matchAll(rule.pattern)) {
            const line = lineForOffset(parsed.sourceFile, span.offset + (match.index ?? 0))
            violations.push(`${parsed.rel}:${line} — ${rule.label}: ${match[0]}`)
          }
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })

  it('does not invent semantic color tokens that would render nothing', () => {
    const violations: string[] = []

    for (const file of businessFiles) {
      const parsed = parseDesignFile(file)
      for (const span of parsed.stringSpans) {
        for (const match of span.text.matchAll(SEMANTIC_PATTERN)) {
          const family = match[1]
          const line = lineForOffset(parsed.sourceFile, span.offset + (match.index ?? 0))
          if (SEMANTIC_ALIASES[family]) {
            violations.push(
              `${parsed.rel}:${line} — misspelled color family: ${match[0]} (use ${SEMANTIC_ALIASES[family]})`
            )
            continue
          }
          const shade = match[2]?.slice(1)
          if (!shade) continue
          if (SEMANTIC_TOKENS[family]?.includes(shade)) continue
          violations.push(`${parsed.rel}:${line} — unknown semantic color: ${match[0]}`)
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([])
  })

  it('does not allow hardcoded hex colors in renderer, shared UI, or cloud web sources', () => {
    const violations: string[] = []

    for (const file of businessFiles) {
      const parsed = parseDesignFile(file)
      for (const span of parsed.stringSpans) {
        for (const match of span.text.matchAll(/(?:^|[\s:(,'"`])(#[0-9A-Fa-f]{3,8})\b/g)) {
          const hex = match[1]
          const hexOffset = (match.index ?? 0) + match[0].indexOf(hex)
          const line = lineForOffset(parsed.sourceFile, span.offset + hexOffset)
          violations.push(`${parsed.rel}:${line} — hardcoded color: ${hex}`)
        }
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

  it('enforces >= 12px floor on functional typography roles and avoids global optimizeLegibility (D10)', () => {
    const css = readFileSync(resolve(SRC, 'index.css'), 'utf-8')
    const functionalRoles = [
      'type-data',
      'type-caption',
      'type-key',
      'type-eyebrow',
      'type-eyebrow-cjk',
      'type-label',
      'type-value',
      'type-body',
      'type-reading',
      'type-code',
    ]
    for (const role of functionalRoles) {
      const block = css.match(new RegExp(`\\.${role}\\s*\\{([^}]*)\\}`))
      expect(block, `missing .${role} rule`).not.toBeNull()
      const sizeMatch = block![1].match(/font-size:\s*([0-9.]+)px\s*;/)
      expect(sizeMatch, `missing px font-size in .${role}`).not.toBeNull()
      expect(Number(sizeMatch![1]), `.${role} must be >= 12px`).toBeGreaterThanOrEqual(12)
    }

    const eyebrowCjk = css.match(/\.type-eyebrow-cjk\s*\{([^}]*)\}/)
    expect(eyebrowCjk?.[1]).toContain('font-family: var(--font-ui)')

    const bodyBlock = css.match(/\bbody\s*\{([^}]*)\}/)
    expect(bodyBlock?.[1]).not.toContain('optimizeLegibility')
  })

  it('exports the shared content patterns from @pi-workbench/ui and desktop compat layer', () => {
    const canonicalPatterns = readFileSync(resolve(UI_PKG_SRC, 'patterns.tsx'), 'utf-8')
    const compatPatterns = readFileSync(resolve(SRC, 'components/ui/patterns.tsx'), 'utf-8')
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
      expect(canonicalPatterns).toContain(`export const ${component}`)
      expect(compatPatterns).toContain(`export const ${component}`)
    }
  })

  it('exports the semantic text primitives from @pi-workbench/ui and desktop compat layer', () => {
    const canonicalUi = readFileSync(resolve(UI_PKG_SRC, 'primitives.tsx'), 'utf-8')
    const compatUi = readFileSync(resolve(SRC, 'components/ui/ui.tsx'), 'utf-8')
    for (const primitive of ['Label', 'Value', 'Caption', 'DataText', 'Eyebrow']) {
      expect(canonicalUi).toContain(`export const ${primitive}`)
      expect(compatUi).toContain(`export const ${primitive}`)
    }
  })

  it('defines the line roles and maps them to Tailwind', () => {
    const css = readFileSync(resolve(SRC, 'index.css'), 'utf-8')
    const tailwind = readFileSync(resolve(ROOT, 'tailwind.config.js'), 'utf-8')
    for (const role of ['rule-control', 'rule-divide', 'rule-hairline', 'rule-seam']) {
      expect(css).toContain(`--${role}`)
      expect(tailwind).toContain(`'${role}'`)
    }
  })

  it('builds cards from the raised surface and a hairline border in @pi-workbench/ui', () => {
    const patterns = readFileSync(resolve(UI_PKG_SRC, 'patterns.tsx'), 'utf-8')
    expect(patterns).toContain('border border-rule-hairline bg-raised')
    expect(patterns).not.toContain('shadow-print')
    expect(patterns).toContain('border-b border-rule-divide')
  })

  it('does not bypass the line roles with raw opacity', () => {
    const violations: string[] = []
    for (const file of businessFiles) {
      const parsed = parseDesignFile(file)
      for (const span of parsed.stringSpans) {
        for (const match of span.text.matchAll(/\bborder-line\/[^\s'"`]+/g)) {
          const line = lineForOffset(parsed.sourceFile, span.offset + (match.index ?? 0))
          violations.push(`${parsed.rel}:${line} — raw line opacity: ${match[0]}`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('reserves full-ink borders for floating layers', () => {
    const FLOATING = new Set([
      'src/App.tsx',
      'src/components/chat/ChatPanel.tsx',
      'src/components/chat/ChatSessionList.tsx',
      'src/components/cloud/CloudStatusIndicator.tsx',
      'src/components/workspace/CommandPalette.tsx',
      'src/components/editor/DiffViewer.tsx',
      'src/components/files/FileExplorer.tsx',
      'src/components/panels/PanelContextMenu.tsx',
      'src/components/ui/SelectionQuoteButton.tsx',
      'src/components/ui/StreamingTranscript.tsx',
      'src/components/ui/Toast.tsx',
      'packages/ui/src/StreamingTranscript.tsx',
      'apps/cloud/web-src/CloudWebApp.tsx',
    ])
    const violations: string[] = []
    for (const file of businessFiles) {
      const parsed = parseDesignFile(file)
      if (FLOATING.has(parsed.rel)) continue
      for (const span of parsed.stringSpans) {
        for (const match of span.text.matchAll(/\bborder-line\b/g)) {
          const line = lineForOffset(parsed.sourceFile, span.offset + (match.index ?? 0))
          violations.push(`${parsed.rel}:${line} — full-ink border outside a floating layer`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('rejects undefined rule, surface, and shadow utility classes across all TSX files', () => {
    const UNDEFINED_UTILITIES = [
      {
        label: 'undefined rule token (use rule-control|rule-divide|rule-hairline|rule-seam)',
        pattern:
          /(?<!-)\b(?:border|bg|text|divide)-rule(?!-(?:control|divide|hairline|seam)\b)(?:-[a-z0-9-]+)?(?=\/|\s|'|"|`|\)|\}|,|$)/g,
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
    for (const file of allTsxFiles) {
      const parsed = parseDesignFile(file)
      for (const span of parsed.stringSpans) {
        for (const rule of UNDEFINED_UTILITIES) {
          for (const match of span.text.matchAll(rule.pattern)) {
            const line = lineForOffset(parsed.sourceFile, span.offset + (match.index ?? 0))
            violations.push(`${parsed.rel}:${line} — ${rule.label}: ${match[0]}`)
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('does not paint full-ink backgrounds as separators', () => {
    const violations: string[] = []
    for (const file of businessFiles) {
      const parsed = parseDesignFile(file)
      for (const span of parsed.stringSpans) {
        for (const match of span.text.matchAll(/\bbg-line\b/g)) {
          const line = lineForOffset(parsed.sourceFile, span.offset + (match.index ?? 0))
          violations.push(`${parsed.rel}:${line} — full-ink separator background`)
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  // 命中区规则：标签的可点区域必须是标签矩形本体（patterns.tsx 的 Tab），
  // 不允许业务组件再拼一层「wrapper + 内层小按钮」，那会让 padding 变成死区。
  it('builds tabs only from the shared Tab pattern', () => {
    const violations: string[] = []
    for (const file of businessFiles) {
      const parsed = parseDesignFile(file)
      for (const line of parsed.rawTabRoleLines) {
        violations.push(`${parsed.rel}:${line} — 自行拼装 role="tab"，改用 patterns.tsx 的 Tab`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('keeps the tab close target at least 24px in @pi-workbench/ui', () => {
    const patterns = readFileSync(resolve(UI_PKG_SRC, 'patterns.tsx'), 'utf-8')
    const close = patterns.slice(patterns.indexOf('data-tab-aux=""'))
    expect(close).toContain('h-6 w-6')
  })
})

describe('cloud web design system compliance (D-06)', () => {
  const indexHtml = readFileSync(resolve(CLOUD_WEB_SRC, 'index.html'), 'utf-8')
  const faviconSvg = readFileSync(resolve(CLOUD_WEB_SRC, 'public/favicon.svg'), 'utf-8')
  const mainTsx = readFileSync(resolve(CLOUD_WEB_SRC, 'main.tsx'), 'utf-8')

  it('reuses shared Paper & Ink stylesheet, slim display/mono fonts (D11), and Pine favicon', () => {
    expect(mainTsx).toContain("import '../../../src/index.css'")
    expect(mainTsx).toContain('@fontsource/instrument-serif')
    expect(mainTsx).toContain('@fontsource-variable/geist-mono')
    expect(mainTsx).not.toContain('@fontsource-variable/noto-sans-sc')
    expect(mainTsx).not.toContain('@fontsource-variable/noto-serif-sc')
    expect(mainTsx).not.toContain('@fontsource-variable/noto-sans')
    expect(faviconSvg).toContain('#2F5D4E')
    expect(indexHtml).toContain('viewport-fit=cover')
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
    for (const file of cloudWebAllFiles) {
      const source = readFileSync(file, 'utf-8')
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${pattern} in ${file}`).toBe(false)
      }
    }
  })
})
