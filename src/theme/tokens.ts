/**
 * 从 Paper & Ink 的 CSS 变量读取颜色，供 Monaco / xterm 等无法直接使用 CSS 变量的
 * 第三方渲染器使用。读取时临时切换 <html class="dark"> 以取得对应主题的 token，
 * 同步操作在同一帧内恢复，不会产生可见闪烁。
 */
const TOKEN_NAMES = [
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

export function readThemeTokens(dark: boolean): ThemeTokens {
  const fallback = Object.fromEntries(TOKEN_NAMES.map((name) => [name, '0 0 0'])) as ThemeTokens
  if (typeof document === 'undefined') return fallback

  const root = document.documentElement
  const hadDark = root.classList.contains('dark')
  root.classList.toggle('dark', dark)

  try {
    const styles = getComputedStyle(root)
    const tokens = { ...fallback }
    for (const name of TOKEN_NAMES) {
      const value = styles.getPropertyValue(`--${name}`).trim()
      if (value) tokens[name] = value
    }
    return tokens
  } finally {
    root.classList.toggle('dark', hadDark)
  }
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
