import { marked } from 'marked'

/**
 * 流式渲染用：按顶层块拆分 Markdown，稳定的块可以跳过重新解析。
 * 引用式链接等跨块定义在流式阶段可能不完整，结束时整体重渲染即可恢复。
 */
export function splitMarkdownBlocks(content: string): string[] {
  if (!content) return []
  try {
    return marked
      .lexer(content)
      .map((token) => token.raw)
      .filter((block) => block.trim().length > 0)
  } catch {
    return [content]
  }
}
