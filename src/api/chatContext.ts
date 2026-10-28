/**
 * 把用户选中的文件作为上下文注入对话。
 *
 * 注入块带固定标记，便于 AgentManager 在恢复会话历史时把它剥离，
 * 避免聊天面板重新展示整段文件内容。
 */
export const CONTEXT_BLOCK_START = '<pi-workbench-context>'
export const CONTEXT_BLOCK_END = '</pi-workbench-context>'

export interface ContextFile {
  /** 文件路径；对话划词引用没有路径，留空 */
  path: string
  content: string
  /** 片段起止行；省略表示整文件 */
  startLine?: number
  endLine?: number
  /** 引用块标题（没有路径时用它说明来源） */
  label?: string
}

export function buildContextPrompt(message: string, files: ContextFile[]): string {
  if (files.length === 0) return message

  const blocks = files
    .map((file) => {
      const range =
        file.startLine !== undefined && file.endLine !== undefined ? ` (lines ${file.startLine}-${file.endLine})` : ''
      const title = file.path || file.label || 'quote'
      return `--- ${title}${range} ---\n${file.content}`
    })
    .join('\n\n')

  return `${CONTEXT_BLOCK_START}\n${blocks}\n${CONTEXT_BLOCK_END}\n\n${message}`
}
