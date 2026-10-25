/**
 * 会话文本处理：上下文/计划块、消息摘要与工具调用预览。
 * 这些函数不依赖 Agent 运行时，便于单独测试与复用。
 */

/** 与 src/api/chatContext.ts 的标记保持一致 */
export const CONTEXT_BLOCK_START = '<pi-workbench-context>'
export const CONTEXT_BLOCK_END = '</pi-workbench-context>'
/** Plan 模式的提示块；历史恢复时整块剥离，不展示给用户 */
export const PLAN_BLOCK_START = '<pi-workbench-plan-mode>'
export const PLAN_BLOCK_END = '</pi-workbench-plan-mode>'
export const PLAN_MODE_INSTRUCTION = [
  'You are in Plan mode. Only read-only tools (read, grep, find, ls) and submit_plan are available;',
  'you cannot modify files or run commands.',
  'Explore the repository as needed, then call submit_plan exactly once with a concise structured plan:',
  'each step needs a short title, the files it will touch, and a risk note where relevant.',
  'Do not write the plan as free-form text and do not claim that changes were made.',
  'After submit_plan succeeds, reply with one short sentence.',
].join(' ')

export function wrapPlanPrompt(message: string): string {
  return `${PLAN_BLOCK_START}\n${PLAN_MODE_INSTRUCTION}\n${PLAN_BLOCK_END}\n\n${message}`
}

/** 恢复历史时去掉附件上下文块与 Plan 模式提示块，避免聊天面板展示内部指令 */
export function stripContextBlock(content: string): string {
  let text = content
  const planStart = text.indexOf(PLAN_BLOCK_START)
  const planEnd = text.indexOf(PLAN_BLOCK_END)
  if (planStart !== -1 && planEnd > planStart) {
    const before = text.slice(0, planStart).trim()
    const after = text.slice(planEnd + PLAN_BLOCK_END.length).trim()
    text = [before, after].filter(Boolean).join('\n\n')
  }

  const start = text.indexOf(CONTEXT_BLOCK_START)
  const end = text.indexOf(CONTEXT_BLOCK_END)
  if (start === -1 || end <= start) return text

  const before = text.slice(0, start).trim()
  const after = text.slice(end + CONTEXT_BLOCK_END.length).trim()
  return [before, after].filter(Boolean).join('\n\n') || '(attached files)'
}

/** 提取消息文本；内容可能是字符串或文本块数组 */
export function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        Boolean(part) &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
    )
    .map((part) => part.text)
    .join('\n')
}

/** 工具步骤展示限额；完整结果仍保留在 Pi JSONL 中 */
const TOOL_ARGS_LIMIT = 1_000
const TOOL_RESULT_LIMIT = 2_000

export function truncateText(text: string, max: number, preferTail = false): string {
  if (text.length <= max) return text
  return preferTail ? `…${text.slice(-max)}` : `${text.slice(0, max)}…`
}

function stringifyToolArgs(args: unknown): string {
  try {
    return truncateText(JSON.stringify(args ?? {}), 500)
  } catch {
    return ''
  }
}

/** 生成不包含大字段（尤其 write.content）的参数摘要 */
export function summarizeToolArgs(toolName: string, args: any): string {
  const value = args ?? {}
  switch (toolName) {
    case 'read':
    case 'ls':
      return typeof value.path === 'string' ? value.path : stringifyToolArgs(value)
    case 'write': {
      const size = typeof value.content === 'string' ? value.content.length : 0
      return `${value.path ?? ''}${size > 0 ? ` · ${size} 字符` : ''}`
    }
    case 'edit': {
      const count = Array.isArray(value.edits) ? value.edits.length : 0
      return `${value.path ?? ''}${count > 0 ? ` · ${count} 处` : ''}`
    }
    case 'bash':
    case 'powershell':
      return truncateText(String(value.command ?? ''), TOOL_ARGS_LIMIT)
    case 'grep':
    case 'find':
      return [value.pattern, value.path ?? value.glob]
        .filter((part) => typeof part === 'string' && part.length > 0)
        .join(' · ')
    default:
      return stringifyToolArgs(value)
  }
}

/** 从工具结果中提取可展示的文本预览，图片只显示占位 */
export function summarizeToolResult(result: any, preferTail = false): string {
  if (!result) return ''
  if (typeof result === 'string') {
    return truncateText(result, TOOL_RESULT_LIMIT, preferTail)
  }
  const content = Array.isArray(result.content) ? result.content : []
  const text = content
    .map((part: any) => {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text
      if (part?.type === 'image') return '[图片]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
  if (text) return truncateText(text, TOOL_RESULT_LIMIT, preferTail)
  if (result.details != null) {
    try {
      return truncateText(JSON.stringify(result.details), TOOL_RESULT_LIMIT, preferTail)
    } catch {
      return ''
    }
  }
  return ''
}
