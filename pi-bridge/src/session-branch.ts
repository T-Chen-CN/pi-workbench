/** 会话树的分支分组与叶子查找（R-03） */

import type { SessionManager, SessionTreeNode } from '@earendil-works/pi-coding-agent'
import type { ConversationBranchGroup } from './types.js'
import { messageText } from './text-utils.js'

export function sessionTreeNodes(tree: SessionTreeNode[]): Map<string, SessionTreeNode> {
  const nodes = new Map<string, SessionTreeNode>()
  const visit = (list: SessionTreeNode[]) => {
    for (const node of list) {
      nodes.set(node.entry.id, node)
      visit(node.children)
    }
  }
  visit(tree)
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
  let current = node
  while (current.children.length > 0) {
    let best = current.children[0]
    let bestDepth = -1
    for (const child of current.children) {
      const depth = treeDepth(child)
      if (depth >= bestDepth) {
        best = child
        bestDepth = depth
      }
    }
    current = best
  }
  return current.entry.id
}

function treeDepth(node: SessionTreeNode): number {
  if (node.children.length === 0) return 0
  return 1 + Math.max(...node.children.map((child) => treeDepth(child)))
}
