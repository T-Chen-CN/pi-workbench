import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

const parser = unified().use(remarkParse).use(remarkGfm)

/**
 * 流式渲染用：按顶层块拆分 Markdown，稳定的块可以跳过重新解析。
 * 与渲染层共用 remark/GFM 语法，避免两套解析器给出不同的块边界。
 * 引用式链接等跨块定义在流式阶段可能不完整，结束时整体重渲染即可恢复。
 */
export function splitMarkdownBlocks(content: string): string[] {
  if (!content) return []
  try {
    const tree = parser.parse(content)
    const blocks: string[] = []
    tree.children.forEach((node, index) => {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (typeof start !== 'number' || typeof end !== 'number') return
      // 最后一个块保留原文尾部的换行，避免流式结束后对比整段内容时出现差异
      const blockEnd = index === tree.children.length - 1 ? content.length : end
      const block = content.slice(start, blockEnd)
      if (block.trim().length > 0) blocks.push(block)
    })
    return blocks
  } catch {
    return [content]
  }
}
