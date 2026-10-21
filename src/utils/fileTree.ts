export interface TreeLike {
  path: string
  isDirectory?: boolean
  isExpanded?: boolean
  children?: TreeLike[]
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
