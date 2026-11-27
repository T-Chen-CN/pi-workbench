import type { Plugin } from 'vite'

/** 过滤 @fontsource 中非中/英字体子集（西里尔/天城文/希腊/越南语），减少桌面与云端产物冗余字体 */
const DROP_FONT_SUBSETS = /(?:cyrillic|devanagari|greek|vietnamese)/i

export function fontSubsetFilter(): Plugin {
  return {
    name: 'pi-workbench-font-subset-filter',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@fontsource') || !id.endsWith('.css')) return null
      const filtered = code.replace(
        /(?:\/\*[^*]*\*\/\s*)?@font-face\s*\{[^}]*\}\s*/g,
        (block) => (DROP_FONT_SUBSETS.test(block) ? '' : block)
      )
      return filtered === code ? null : { code: filtered, map: null }
    },
  }
}
