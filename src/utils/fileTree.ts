export interface TreeLike {
  path: string
  name?: string
  isDirectory?: boolean
  isExpanded?: boolean
  children?: TreeLike[]
}

export type ExplorerSortBy = 'name' | 'type'

export interface SortTreeOptions {
  by: ExplorerSortBy
  foldersFirst: boolean
  reverse: boolean
}

export const DEFAULT_SORT_OPTIONS: SortTreeOptions = {
  by: 'name',
  foldersFirst: true,
  reverse: false,
}

export function isExplorerSortBy(value: unknown): value is ExplorerSortBy {
  return value === 'name' || value === 'type'
}

/** 固定 locale：不同机器的默认 collation 会让文件树顺序不一致；中文按拼音排 */
const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

function compareNames(a: string, b: string): number {
  const result = nameCollator.compare(a, b)
  if (result !== 0) return result
  // base 权重会忽略大小写，用原串兜底，保证每次排序结果一致
  return a < b ? -1 : a > b ? 1 : 0
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

function compareEntries(
  a: { name: string; isDirectory?: boolean },
  b: { name: string; isDirectory?: boolean },
  by: ExplorerSortBy
): number {
  if (by === 'type' && !a.isDirectory && !b.isDirectory) {
    const extA = extensionOf(a.name)
    const extB = extensionOf(b.name)
    if (extA !== extB) {
      if (!extA) return 1
      if (!extB) return -1
      return compareNames(extA, extB)
    }
  }
  return compareNames(a.name, b.name)
}

/** 目录优先、名称/类型排序；reverse 只在组内翻转，文件夹仍置顶 */
export function sortTreeEntries<T extends { name: string; isDirectory?: boolean }>(
  items: T[],
  options: SortTreeOptions = DEFAULT_SORT_OPTIONS
): T[] {
  return [...items].sort((a, b) => {
    if (options.foldersFirst && Boolean(a.isDirectory) !== Boolean(b.isDirectory)) {
      return a.isDirectory ? -1 : 1
    }
    const result = compareEntries(a, b, options.by)
    return options.reverse ? -result : result
  })
}

/** 递归重排已加载的树，切换排序时不必重新读取磁盘 */
export function sortTreeNodes<T extends TreeLike & { name: string }>(
  nodes: T[],
  options: SortTreeOptions = DEFAULT_SORT_OPTIONS
): T[] {
  return sortTreeEntries(nodes, options).map((node) =>
    node.children?.length
      ? { ...node, children: sortTreeNodes(node.children as T[], options) }
      : node
  )
}

export interface FlatTreeRow<T extends TreeLike> {
  node: T
  depth: number
}

/**
 * 把展开状态下的树拍平成可见行（前序），供虚拟列表按索引渲染。
 * 折叠目录的子节点不会进入结果；深度上限防止异常数据递归过深。
 */
export function flattenVisibleTree<T extends TreeLike>(
  nodes: T[],
  depth = 0,
  visited = new Set<string>()
): Array<FlatTreeRow<T>> {
  const rows: Array<FlatTreeRow<T>> = []
  if (depth > 20) return rows

  for (const node of nodes) {
    if (visited.has(node.path)) continue
    const nextVisited = new Set(visited)
    nextVisited.add(node.path)
    rows.push({ node, depth })
    if (node.isDirectory && node.isExpanded && node.children?.length) {
      rows.push(...flattenVisibleTree(node.children as T[], depth + 1, nextVisited))
    }
  }
  return rows
}
