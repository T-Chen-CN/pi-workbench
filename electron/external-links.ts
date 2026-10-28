/**
 * 外部链接的唯一出口。
 *
 * 渲染层跑在 `pw-app://` 自定义协议上（打包后）或 Vite 的 localhost 上，
 * 主窗口的 `setWindowOpenHandler` 只放行辅助窗口的 `about:blank`，
 * 所以 `<a target="_blank">` 与 `window.open()` 都会被静默拒绝。
 * 外部链接一律走这里：先在渲染层由链接组件接管，再由主进程校验协议后交给系统浏览器。
 */

export const EXTERNAL_PROTOCOLS = ['https:', 'http:', 'mailto:'] as const

/** 判断 URL 是否属于可以交给系统处理的外部链接 */
export function isExternalUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return false
  try {
    const url = new URL(raw)
    return (EXTERNAL_PROTOCOLS as readonly string[]).includes(url.protocol)
  } catch {
    return false
  }
}
