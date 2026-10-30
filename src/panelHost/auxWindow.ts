/**
 * 辅助窗口的文档准备。
 *
 * 主窗口用 `window.open('about:blank', 'pi-panel:<id>')` 打开子窗口，两个文档同源，
 * 主窗口的 JS 可以直接构造子文档的 DOM —— React 通过 portal 渲染进去。
 * 这里负责把子文档变成「能承载应用 UI 的空壳」：样式、主题属性、CSP、背景色。
 *
 * 规则（与 VS Code auxiliary window 一致）：
 * - 元素一律用主文档 `document.createElement` 创建，保证 instanceof / class 一致；
 * - 子文档永远不执行脚本：注入 `script-src 'none'` 的 CSP；
 * - 相对 URL 必须绝对化：子文档地址是 about:blank，`<base>` 只作为兜底。
 */

import { frameNameOf } from './types'

export interface AuxWindowRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AuxWindowHandle {
  id: string
  window: Window
  document: Document
  container: HTMLDivElement
  close: () => void
  dispose: () => void
}

/**
 * 窗口是否已关闭。
 *
 * 窗口销毁后 WindowProxy 上的大多数读取都不再可信（`document` 可能是 undefined），
 * 但 `closed` 仍然可靠，且不会抛；保守起见仍包一层 try。
 */
export function isWindowClosed(win: Window | null | undefined): boolean {
  if (!win) return true
  try {
    return win.closed
  } catch {
    return true
  }
}

/** 子文档 CSP：只允许样式与字体，禁止任何脚本执行 */
const AUX_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ')

/** `--panel` 是 RGB 三元组；窗口首帧背景色需要 #rrggbb */
export function panelBackgroundColor(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim()
  const match = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/.exec(value)
  if (!match) return '#f4f1ea'
  const toHex = (part: string) => Math.min(255, Number(part)).toString(16).padStart(2, '0')
  return `#${toHex(match[1])}${toHex(match[2])}${toHex(match[3])}`
}

/** 把主文档 head 里的样式表与主题相关元信息搬到子文档 */
export function cloneDocumentHead(source: Document, target: Document): void {
  const base = target.createElement('base')
  base.setAttribute('href', source.baseURI)
  target.head.appendChild(base)

  const csp = target.createElement('meta')
  csp.setAttribute('http-equiv', 'Content-Security-Policy')
  csp.setAttribute('content', AUX_CONTENT_SECURITY_POLICY)
  target.head.appendChild(csp)

  for (const node of Array.from(source.head.querySelectorAll('link[rel="stylesheet"], style'))) {
    const clone = node.cloneNode(true) as HTMLElement
    if (clone.tagName === 'LINK') {
      const href = clone.getAttribute('href')
      if (href) clone.setAttribute('href', new URL(href, source.baseURI).href)
    }
    target.head.appendChild(clone)
  }
}

/**
 * 镜像主题属性（`html.dark`、语言、方向）。
 * 主题切换时子窗口必须跟着变，所以用 MutationObserver 而不是一次性拷贝。
 */
export function mirrorDocumentAttributes(source: Document, target: Document): () => void {
  const apply = () => {
    const sourceRoot = source.documentElement
    const targetRoot = target.documentElement
    targetRoot.className = sourceRoot.className
    const lang = sourceRoot.getAttribute('lang')
    if (lang) targetRoot.setAttribute('lang', lang)
    else targetRoot.removeAttribute('lang')
    const dir = sourceRoot.getAttribute('dir')
    if (dir) targetRoot.setAttribute('dir', dir)
    else targetRoot.removeAttribute('dir')
    const dataLang = sourceRoot.getAttribute('data-lang')
    if (dataLang) targetRoot.setAttribute('data-lang', dataLang)
    else targetRoot.removeAttribute('data-lang')
    if (source.body && target.body) {
      target.body.className = source.body.className
      target.body.style.backgroundColor = panelBackgroundColor()
    }
  }

  apply()
  const observer = new MutationObserver(apply)
  observer.observe(source.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'lang', 'dir', 'data-lang']
  })
  if (source.body) {
    observer.observe(source.body, { attributes: true, attributeFilter: ['class'] })
  }
  return () => observer.disconnect()
}

/** 初始 about:blank 在个别时机还没有 body；等一拍再取 */
export async function resolveChildDocument(win: Window): Promise<Document> {
  const doc = win.document
  if (doc.body && doc.documentElement) return doc
  await new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      doc.removeEventListener('DOMContentLoaded', done)
      win.removeEventListener('load', done)
      resolve()
    }
    doc.addEventListener('DOMContentLoaded', done)
    win.addEventListener('load', done)
    setTimeout(done, 300)
  })
  return win.document
}

/**
 * 打开一个面板辅助窗口。
 * 失败（弹窗被拦、窗口被系统拒绝）时抛错，由调用方提示用户。
 */
export async function openPanelWindow(options: {
  id: string
  title: string
  rect: AuxWindowRect
  background?: string
}): Promise<AuxWindowHandle> {
  const background = options.background ?? panelBackgroundColor()
  const features = [
    'popup=yes',
    `left=${Math.round(options.rect.x)}`,
    `top=${Math.round(options.rect.y)}`,
    `width=${Math.round(options.rect.width)}`,
    `height=${Math.round(options.rect.height)}`,
    `bg=${encodeURIComponent(background)}`
  ].join(',')

  const win = window.open('about:blank', frameNameOf(options.id), features)
  if (!win) throw new Error('aux-window-blocked')

  const doc = await resolveChildDocument(win)
  if (!doc.body || !doc.documentElement) {
    win.close()
    throw new Error('aux-window-document-unavailable')
  }

  doc.title = options.title
  cloneDocumentHead(document, doc)
  doc.body.style.margin = '0'
  doc.body.style.overflow = 'hidden'
  doc.body.style.backgroundColor = background

  // 容器用主文档创建：保持与主窗口一致的 class / instanceof
  const container = document.createElement('div')
  container.id = `panel-root-${options.id}`
  container.className = 'flex h-full w-full flex-col overflow-hidden bg-panel text-ink'
  doc.body.appendChild(container)

  const stopMirroring = mirrorDocumentAttributes(document, doc)

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    stopMirroring()
    // 用户直接关窗（自绘 X / 系统关闭）时文档已随窗口销毁：
    // 这时再去 remove 节点、再 close 一次只会碰到已销毁的 DOM，没有意义也不安全。
    // 主动回收（面板还原）才需要真的拆掉容器并关窗。
    if (isWindowClosed(win)) return
    container.remove()
    try {
      win.close()
    } catch {
      // 窗口可能刚被系统关掉：忽略
    }
  }

  return {
    id: options.id,
    window: win,
    document: doc,
    container,
    close: () => win.close(),
    dispose
  }
}
