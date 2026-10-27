/**
 * 用页面真实的 `type-caption` 角色实测文本宽度。
 *
 * 字体栈与字号只存在于 `src/index.css` 的语义角色里，所以这里不写 font 字符串，
 * 而是把隐藏探针挂在 `type-caption` 类名下量 DOM —— 既跟随设计 token，也不会
 * 在测试环境（无 canvas 字体度量）里假装量到了宽度：量不到时返回 0，调用方回退到计数折叠。
 */

const HOST_STYLE =
  'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;pointer-events:none'

const cache = new Map<string, number>()

let probe: HTMLSpanElement | null = null

function ensureProbe(): HTMLSpanElement | null {
  if (probe) return probe
  if (typeof document === 'undefined' || !document.body) return null
  const host = document.createElement('span')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = HOST_STYLE
  probe = document.createElement('span')
  probe.className = 'type-caption'
  host.appendChild(probe)
  document.body.appendChild(host)
  return probe
}

/** 单个文本在 `type-caption` 下的宽度（px）；环境量不到时返回 0 */
export function measureCaptionWidth(text: string): number {
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  const node = ensureProbe()
  if (!node) return 0
  node.textContent = text
  const width = node.getBoundingClientRect().width
  cache.set(text, width)
  return width
}

/** 字体加载完成或字号相关 token 变化后调用，丢掉预热期的错误度量 */
export function clearCaptionWidthCache(): void {
  cache.clear()
}
