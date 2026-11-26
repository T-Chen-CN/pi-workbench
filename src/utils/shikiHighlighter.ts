/**
 * 零 WASM 的 Shiki 纯 JS 正则高亮插件（供 Streamdown v2 使用）。
 *
 * 必须使用 `shiki/engine/javascript` 而非默认 Oniguruma WASM：
 * Electron 生产环境与云端 Web 均启用严格 CSP（不含 `wasm-unsafe-eval`），
 * WASM 引擎会在 `WebAssembly.instantiate()` 处被直接拦截。
 *
 * 主题直接复用 `src/index.css` 的 Paper & Ink 印刷低饱和语法色；
 * 语言包按需动态 import，不拖慢冷启动与手机首屏加载。
 */

import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemeRegistrationRaw } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type {
  BundledLanguage,
  CodeHighlighterPlugin,
  HighlightOptions,
  HighlightResult,
  ThemeInput,
} from 'streamdown'

const PI_PAPER_THEME: ThemeRegistrationRaw = {
  name: 'pi-paper',
  type: 'light',
  settings: [],
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#171512',
  },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#9A9284', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'storage.type', 'keyword.control', 'keyword.operator.new', 'keyword.operator.expression'], settings: { foreground: '#8A3B2A' } },
    { scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string'], settings: { foreground: '#4F6B3A' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character', 'variable.other.constant'], settings: { foreground: '#8A6A3B' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call'], settings: { foreground: '#6B4E2E' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.name.tag'], settings: { foreground: '#3E5D66' } },
    { scope: ['entity.other.attribute-name', 'variable.other.property', 'support.type.property-name'], settings: { foreground: '#7A4B36' } },
    { scope: ['keyword.operator', 'punctuation.separator', 'punctuation.accessor'], settings: { foreground: '#2F5D4E' } },
    { scope: ['markup.inserted', 'meta.diff.header.to-file'], settings: { foreground: '#4F6B3A' } },
    { scope: ['markup.deleted', 'meta.diff.header.from-file'], settings: { foreground: '#A83A22' } },
    { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: '#2F5D4E', fontStyle: 'bold' } },
  ],
}

const PI_INK_THEME: ThemeRegistrationRaw = {
  name: 'pi-ink',
  type: 'dark',
  settings: [],
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#EDE7DC',
  },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#7C7466', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'storage.type', 'keyword.control', 'keyword.operator.new', 'keyword.operator.expression'], settings: { foreground: '#E08A72' } },
    { scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string'], settings: { foreground: '#9DBF8A' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character', 'variable.other.constant'], settings: { foreground: '#D6B26E' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call'], settings: { foreground: '#DEC49E' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.name.tag'], settings: { foreground: '#8FC4CF' } },
    { scope: ['entity.other.attribute-name', 'variable.other.property', 'support.type.property-name'], settings: { foreground: '#C8A88A' } },
    { scope: ['keyword.operator', 'punctuation.separator', 'punctuation.accessor'], settings: { foreground: '#8FC7B4' } },
    { scope: ['markup.inserted', 'meta.diff.header.to-file'], settings: { foreground: '#A8BF7A' } },
    { scope: ['markup.deleted', 'meta.diff.header.from-file'], settings: { foreground: '#E06A4A' } },
    { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: '#8FC7B4', fontStyle: 'bold' } },
  ],
}

export const PI_SHIKI_THEMES: [ThemeInput, ThemeInput] = ['pi-paper', 'pi-ink']

type LangLoader = () => Promise<{ default: LanguageRegistration | LanguageRegistration[] }>

/** 高频开发语言按需加载表：静态字面量 import 保证 Vite 独立拆包且不把 200+ 冷门语言打进 bundle */
const LANG_LOADERS: Record<string, LangLoader> = {
  bash: () => import('shiki/langs/bash.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  regex: () => import('shiki/langs/regex.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
}

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  shellscript: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  docker: 'dockerfile',
  rb: 'ruby',
  kt: 'kotlin',
  gql: 'graphql',
  patch: 'diff',
  svg: 'xml',
  json5: 'jsonc',
}

const SUPPORTED_LANGUAGES: BundledLanguage[] = [
  ...Object.keys(LANG_LOADERS),
  ...Object.keys(LANG_ALIASES),
]

function normalizeLanguage(language: string): string | null {
  const clean = language.trim().toLowerCase()
  if (!clean) return null
  const mapped = LANG_ALIASES[clean] ?? clean
  return mapped in LANG_LOADERS ? mapped : null
}

let highlighterInstance: HighlighterCore | null = null
let highlighterPromise: Promise<HighlighterCore> | null = null
let initCount = 0
const loadedLangs = new Set<string>()
const loadingLangs = new Map<string, Promise<boolean>>()
const tokenCache = new Map<string, HighlightResult>()
const MAX_CACHE_ENTRIES = 200

/** 仅供性能回归测试核验单例初始化次数 */
export function getShikiInitCount(): number {
  return initCount
}

function ensureHighlighter(): Promise<HighlighterCore> {
  if (highlighterInstance) return Promise.resolve(highlighterInstance)
  if (!highlighterPromise) {
    initCount += 1
    highlighterPromise = createHighlighterCore({
      themes: [PI_PAPER_THEME, PI_INK_THEME],
      langs: [],
      // 纯 JS 正则引擎：零 WASM，满足严格 CSP；forgiving 忽略极少数不兼容的 Oniguruma 语法特性
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    }).then((instance) => {
      highlighterInstance = instance
      return instance
    })
  }
  return highlighterPromise
}

async function ensureLanguage(lang: string): Promise<HighlighterCore | null> {
  try {
    const instance = await ensureHighlighter()
    if (loadedLangs.has(lang)) return instance
    let inflight = loadingLangs.get(lang)
    if (!inflight) {
      const loader = LANG_LOADERS[lang]
      if (!loader) return null
      inflight = loader()
        .then(async (mod) => {
          await instance.loadLanguage(mod.default)
          loadedLangs.add(lang)
          return true
        })
        .catch(() => false)
        .finally(() => {
          loadingLangs.delete(lang)
        })
      loadingLangs.set(lang, inflight)
    }
    const ok = await inflight
    return ok ? instance : null
  } catch {
    return null
  }
}

function runHighlight(instance: HighlighterCore, code: string, lang: string, isIncomplete?: boolean): HighlightResult {
  const cacheKey = `${lang}\u0000${code}`
  if (!isIncomplete) {
    const cached = tokenCache.get(cacheKey)
    if (cached) return cached
  }
  const result = instance.codeToTokens(code, {
    lang,
    themes: { light: 'pi-paper', dark: 'pi-ink' },
    defaultColor: 'light',
  })
  const formatted: HighlightResult = {
    bg: 'transparent',
    fg: result.fg,
    tokens: result.tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        color: token.color,
        bgColor: token.bgColor,
        offset: token.offset,
        htmlStyle: token.htmlStyle,
        htmlAttrs: token.htmlAttrs,
      }))
    ),
  }
  if (!isIncomplete) {
    if (tokenCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = tokenCache.keys().next().value
      if (oldest !== undefined) tokenCache.delete(oldest)
    }
    tokenCache.set(cacheKey, formatted)
  }
  return formatted
}

/** 创建零 WASM Shiki 纯 JS 代码高亮插件（传入 Streamdown `plugins.code`） */
export function createPiShikiPlugin(): CodeHighlighterPlugin {
  return {
    name: 'shiki',
    type: 'code-highlighter',
    getSupportedLanguages: () => SUPPORTED_LANGUAGES,
    getThemes: () => PI_SHIKI_THEMES,
    supportsLanguage: (language) => normalizeLanguage(language) !== null,
    highlight(options: HighlightOptions, callback?: (result: HighlightResult) => void): HighlightResult | null {
      const lang = normalizeLanguage(options.language)
      if (!lang || options.code.length > 50_000) return null
      if (highlighterInstance && loadedLangs.has(lang)) {
        try {
          return runHighlight(highlighterInstance, options.code, lang, options.isIncomplete)
        } catch {
          return null
        }
      }
      if (callback) {
        void ensureLanguage(lang).then((instance) => {
          if (!instance) return
          try {
            callback(runHighlight(instance, options.code, lang, options.isIncomplete))
          } catch {
            // 忽略冷门语法偶发解析失败，保持纯文本可读
          }
        })
      }
      return null
    },
  }
}

export const piShikiCodePlugin = createPiShikiPlugin()
