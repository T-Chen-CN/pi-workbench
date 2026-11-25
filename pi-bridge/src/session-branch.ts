/** 会话树的分支分组与叶子查找（R-03） */

import type { SessionManager, SessionTreeNode } from '@earendil-works/pi-coding-agent'
import type { ConversationBranchGroup } from './types.js'
import { messageText } from './text-utils.js'

export function sessionTreeNodes(tree: SessionTreeNode[]): Map<string, SessionTreeNode> {
  const nodes = new Map<string, SessionTreeNode>()
  const stack: SessionTreeNode[] = [...tree]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (nodes.has(node.entry.id)) continue
    nodes.set(node.entry.id, node)
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      stack.push(node.children[i])
    }
  }
  return nodes
}

export function buildBranchGroups(manager: SessionManager): ConversationBranchGroup[] {
  const branch = manager.getBranch()
  const branchIds = new Set(branch.map((entry) => entry.id))
  const nodes = sessionTreeNodes(manager.getTree())
  const groups: ConversationBranchGroup[] = []

  for (const entry of branch) {
    if (entry.type !== 'message' || entry.message.role !== 'user') continue
    const node = nodes.get(entry.id)
    if (!node) continue
    const replies = node.children.filter(
      (child) => child.entry.type === 'message' && child.entry.message.role === 'assistant'
    )
    if (replies.length < 2) continue
    const activeIndex = replies.findIndex((child) => branchIds.has(child.entry.id))
    const timestamp = (entry.message as { timestamp?: unknown }).timestamp
    groups.push({
      userTimestamp:
        typeof timestamp === 'number' ? timestamp : Date.parse(entry.timestamp) || Date.now(),
      activeIndex: activeIndex >= 0 ? activeIndex : 0,
      branches: replies.map((child) => ({
        entryId: child.entry.id,
        preview:
          child.entry.type === 'message'
            ? messageText(child.entry.message).replace(/\s+/g, ' ').trim().slice(0, 80)
            : '',
      })),
    })
  }
  return groups
}

/** entryId 是否为 targetId 的祖先（含自身） */
export function isAncestorOrSelf(
  manager: SessionManager,
  entryId: string,
  targetId: string
): boolean {
  let current = manager.getEntry(targetId)
  let guard = 0
  while (current && guard < 10_000) {
    if (current.id === entryId) return true
    current = current.parentId ? manager.getEntry(current.parentId) : undefined
    guard += 1
  }
  return false
}

export function deepestLeaf(node: SessionTreeNode | undefined): string | undefined {
  if (!node) return undefined
  // 迭代后序计算每个子树深度（记忆化 + 环路保护），避免深树 O(N^2) 或递归爆栈
  const depths = new Map<string, number>()
  const order: SessionTreeNode[] = []
  const seen = new Set<string>()
  const stack: SessionTreeNode[] = [node]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (seen.has(cur.entry.id)) continue
    seen.add(cur.entry.id)
    order.push(cur)
    for (const child of cur.children) {
      if (!seen.has(child.entry.id)) stack.push(child)
    }
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const cur = order[i]
    let maxChild = -1
    for (const child of cur.children) {
      const d = depths.get(child.entry.id) ?? 0
      if (d > maxChild) maxChild = d
    }
    depths.set(cur.entry.id, maxChild + 1)
  }

  let current = node
  const walked = new Set<string>([current.entry.id])
  while (current.children.length > 0) {
    let best: SessionTreeNode | null = null
    let bestDepth = -1
    for (const child of current.children) {
      if (walked.has(child.entry.id)) continue
      const depth = depths.get(child.entry.id) ?? 0
      if (depth >= bestDepth) {
        best = child
        bestDepth = depth
      }
    }
    if (!best) break
    walked.add(best.entry.id)
    current = best
  }
  return current.entry.id
}
