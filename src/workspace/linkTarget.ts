/**
 * Markdown 链接的解析与打开。
 *
 * 聊天回复与文档阅读视图里的链接有三种去处：
 * - 外部链接（http / https / mailto）→ 系统浏览器（经主进程，`target=_blank` 会被拦掉）；
 * - 纯锚点（`#section`）→ 在当前滚动容器里滚到对应标题；
 * - 其余一律按仓库内路径处理，在编辑器里打开（带 `#L12` 时定位到行）。
 *
 * 相对路径优先按「所在文档的目录」解析，文档未知时按工作区根解析。
 */

import { api } from '../api'
import { openFileInEditor } from './openFileInEditor'
import { joinPath } from '../utils/filePath'

export type MarkdownLinkTarget =
  { kind: 'external'; url: string } | { kind: 'anchor'; hash: string } | { kind: 'file'; path: string; line?: number }

export interface LinkResolveOptions {
  /** 所在文档的目录（绝对路径）；null 时相对路径按工作区根解析 */
  docDir?: string | null
  /** 工作区根，用于 `/path` 这类以仓库根为基准的链接 */
  workspaceDir?: string | null
}

const EXTERNAL_PATTERN = /^(?:https?|mailto):/i

export function resolveMarkdownLink(
  href: string | null | undefined,
  options: LinkResolveOptions = {}
): MarkdownLinkTarget | null {
  const raw = (href ?? '').trim()
  if (!raw) return null
  if (EXTERNAL_PATTERN.test(raw)) return { kind: 'external', url: raw }
  if (raw.startsWith('#')) {
    const hash = raw.slice(1)
    return hash ? { kind: 'anchor', hash } : null
  }
  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      let pathname = url.pathname
      // Windows 的 file:///F:/x 会带上前导斜杠
      if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
      return { kind: 'file', path: decodeURIComponent(pathname) }
    } catch {
      return null
    }
  }

  const hashIndex = raw.indexOf('#')
  let target = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
  let line: number | undefined
  if (hashIndex >= 0) {
    const fragment = raw.slice(hashIndex + 1)
    const match = /^L(\d+)$/i.exec(fragment)
    if (match) line = Number(match[1])
  }
  target = target.split('?')[0]
  if (!target) return null
  try {
    target = decodeURIComponent(target)
  } catch {
    // 保留原样：非法百分号编码不该让整个链接失效
  }

  const absolute = /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('\\\\')
  if (absolute) return { kind: 'file', path: target.replace(/\\/g, '/'), line }

  // 以 `/` 开头的是仓库根相对路径；其余相对路径以所在文档的目录为基准
  const fromRepoRoot = target.startsWith('/')
  const relative = target.replace(/^\.\//, '').replace(/^\/+/, '')
  if (!relative) return null
  const base = (fromRepoRoot ? options.workspaceDir : options.docDir) || options.docDir || options.workspaceDir
  return { kind: 'file', path: base ? joinPath(base, relative) : relative, line }
}

/** 标题 / 锚点比较：忽略大小写、空白与标点，中文标题也能对上 */
function normalizeAnchor(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\-_]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function scrollableAncestor(element: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = element
  while (node) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node)
    const overflowY = style?.overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return null
}

/** 在当前滚动容器里滚到 `#hash` 指向的标题 */
export function scrollToAnchor(from: HTMLElement | null, hash: string, doc?: Document): boolean {
  if (!from) return false
  const owner = doc ?? from.ownerDocument
  let decoded = hash
  try {
    decoded = decodeURIComponent(hash)
  } catch {
    // 保留原样
  }
  const scroller = scrollableAncestor(from) ?? (owner?.scrollingElement as HTMLElement | null)
  const scope: ParentNode = scroller ?? owner

  const byId = scope.querySelector<HTMLElement>(`[id="${CSS.escape(decoded)}"]`)
  if (byId) {
    byId.scrollIntoView({ block: 'start' })
    return true
  }

  const wanted = normalizeAnchor(decoded)
  if (!wanted) return false
  const headings = scope.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')
  for (const heading of headings) {
    if (normalizeAnchor(heading.textContent ?? '') === wanted) {
      heading.scrollIntoView({ block: 'start' })
      return true
    }
  }
  return false
}

export interface OpenLinkOptions extends LinkResolveOptions {
  /** 点击发生的元素，用于确定锚点滚动容器 */
  anchorElement?: HTMLElement | null
  /** 文档文字（编辑器所在工作区）；没有工作区时文件链接会被忽略 */
  openRoot?: string | null
}

/** 打开解析结果；返回是否真的处理了这次点击 */
export async function openMarkdownLink(
  target: MarkdownLinkTarget | null,
  options: OpenLinkOptions = {}
): Promise<boolean> {
  if (!target) return false
  if (target.kind === 'external') {
    const result = await api.openExternalUrl(target.url)
    return result.success
  }
  if (target.kind === 'anchor') {
    return scrollToAnchor(options.anchorElement ?? null, target.hash)
  }
  const root = options.openRoot ?? options.workspaceDir ?? null
  if (!root) return false
  const outcome = await openFileInEditor(root, target.path, {
    revealLine: target.line
  })
  return outcome.status === 'opened'
}
