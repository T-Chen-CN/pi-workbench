/**
 * Paper & Ink 主题色表，供 Monaco / xterm 等无法直接使用 CSS 变量的第三方渲染器使用。
 * 数值与 `src/index.css` 的 `:root` 与 `html.dark` 保持逐项一致；纯表查询不读写 DOM，
 * 避免切换 `<html class="dark">` 触发整页样式重算与辅助窗口 MutationObserver。
 */
export const TOKEN_NAMES = [
  'surface',
  'panel',
  'raised',
  'sunken',
  'hover',
  'active',
  'line',
  'ink',
  'ink-muted',
  'ink-subtle',
  'ink-inverted',
  'accent',
  'accent-hover',
  'accent-fg',
  'success',
  'warning',
  'danger',
  'code-bg',
  'code-border',
  'hl-keyword',
  'hl-string',
  'hl-number',
  'hl-comment',
  'hl-function',
  'hl-type',
  'hl-attr',
] as const

export type ThemeToken = (typeof TOKEN_NAMES)[number]
export type ThemeTokens = Record<ThemeToken, string>

/** 与 `src/index.css` `:root` 保持一致的 Paper（浅色）RGB 三元组 */
const PAPER_TOKENS: Readonly<ThemeTokens> = {
  surface: '244 241 234',
  panel: '251 249 244',
  raised: '255 253 248',
  sunken: '239 236 228',
  hover: '238 234 225',
  active: '232 227 217',
  line: '23 21 18',
  ink: '23 21 18',
  'ink-muted': '97 92 82',
  'ink-subtle': '145 138 125',
  'ink-inverted': '251 249 244',
  accent: '47 93 78',
  'accent-hover': '36 73 61',
  'accent-fg': '251 249 244',
  success: '94 107 46',
  warning: '154 91 31',
  danger: '168 58 34',
  'code-bg': '239 236 228',
  'code-border': '214 208 196',
  'hl-keyword': '138 59 42',
  'hl-string': '79 107 58',
  'hl-number': '138 106 59',
  'hl-comment': '154 146 132',
  'hl-function': '107 78 46',
  'hl-type': '62 93 102',
  'hl-attr': '122 75 54',
}

/** 与 `src/index.css` `html.dark` 保持一致的 Ink（深色）RGB 三元组 */
const INK_TOKENS: Readonly<ThemeTokens> = {
  surface: '20 19 17',
  panel: '26 24 21',
  raised: '32 29 25',
  sunken: '34 31 27',
  hover: '43 39 34',
  active: '52 47 41',
  line: '237 231 220',
  ink: '237 231 220',
  'ink-muted': '168 160 147',
  'ink-subtle': '115 108 96',
  'ink-inverted': '20 19 17',
  accent: '143 199 180',
  'accent-hover': '169 216 200',
  'accent-fg': '20 19 17',
  success: '168 191 122',
  warning: '214 178 110',
  danger: '224 106 74',
  'code-bg': '34 31 27',
  'code-border': '61 56 48',
  'hl-keyword': '224 138 114',
  'hl-string': '157 191 138',
  'hl-number': '214 178 110',
  'hl-comment': '124 116 102',
  'hl-function': '222 196 158',
  'hl-type': '143 196 207',
  'hl-attr': '200 168 138',
}

/** 未加载 CSS 变量时的纸面面板首帧底色回退（供辅助窗口 about:blank 传参） */
export const PAPER_PANEL_FALLBACK_HEX = '#f4f1ea'
/** PDF 扫描页离屏渲染底色（必须纯白，避免透明区域落成 PNG 黑底） */
export const PDF_PAGE_BACKGROUND_HEX = '#ffffff'

export function readThemeTokens(dark: boolean): ThemeTokens {
  return { ...(dark ? INK_TOKENS : PAPER_TOKENS) }
}

/** 把 "r g b" token 转成带可选 alpha 的 #RRGGBB[AA] */
export function tokenHex(tokens: ThemeTokens, name: ThemeToken, alpha?: number): string {
  const parts = tokens[name]
    .split(/\s+/)
    .slice(0, 3)
    .map((part) => Number(part))
  const channels = parts.length === 3 && parts.every((value) => Number.isFinite(value))
    ? parts
    : [0, 0, 0]
  const hex = channels
    .map((value) => Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0'))
    .join('')
  if (alpha === undefined) return `#${hex}`
  const alphaHex = Math.min(255, Math.max(0, Math.round(alpha)))
    .toString(16)
    .padStart(2, '0')
  return `#${hex}${alphaHex}`
}
