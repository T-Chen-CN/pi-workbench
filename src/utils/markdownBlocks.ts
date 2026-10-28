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

export interface MarkdownBlockRange {
  /** 该块在原文中的原始文本（可逐字回写） */
  text: string
  start: number
  /** 不含结束位置的下标，替换时用 `slice(0, start) + next + slice(end)` */
  end: number
  /** YAML frontmatter：渲染为元数据块，不当作正文 */
  frontmatter?: boolean
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/

/**
 * 把 Markdown 拆成「可在阅读视图里就地编辑」的块，并保留每块在原文中的偏移。
 * 与 `splitMarkdownBlocks` 共用同一套 remark/GFM 语法，区别是这里需要位置信息。
 * 块之间的空行不属于任何块，替换时自然保留。
 */
export function splitMarkdownBlockRanges(content: string): MarkdownBlockRange[] {
  if (!content) return []
  const ranges: MarkdownBlockRange[] = []

  let bodyStart = 0
  const frontmatter = FRONTMATTER.exec(content)
  if (frontmatter) {
    ranges.push({
      text: frontmatter[0],
      start: 0,
      end: frontmatter[0].length,
      frontmatter: true,
    })
    bodyStart = frontmatter[0].length
  }

  const rest = content.slice(bodyStart)
  if (rest.length > 0) {
    try {
      const tree = parser.parse(rest)
      tree.children.forEach((node, index) => {
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (typeof start !== 'number' || typeof end !== 'number') return
        // 最后一个块的尾随换行留在块外，替换后文件末尾换行不会丢
        let blockEnd = index === tree.children.length - 1 ? rest.length : end
        while (
          blockEnd > start &&
          (rest[blockEnd - 1] === '\n' || rest[blockEnd - 1] === '\r')
        ) {
          blockEnd -= 1
        }
        const text = rest.slice(start, blockEnd)
        if (!text.trim()) return
        ranges.push({ text, start: bodyStart + start, end: bodyStart + blockEnd })
      })
    } catch {
      if (rest.trim()) ranges.push({ text: rest, start: bodyStart, end: content.length })
    }
  }

  if (ranges.length === 0) {
    return [{ text: content, start: 0, end: content.length }]
  }
  return ranges
}
