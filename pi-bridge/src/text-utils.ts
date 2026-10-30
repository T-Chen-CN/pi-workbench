/**
 * 会话文本处理：上下文/计划块、消息摘要与工具调用预览。
 * 这些函数不依赖 Agent 运行时，便于单独测试与复用。
 */

import type { MessageContext, MessageContextFile, MessageContextQuote } from './types.js'

/** 与 src/api/chatContext.ts 的标记保持一致 */
export const CONTEXT_BLOCK_START = '<pi-workbench-context>'
export const CONTEXT_BLOCK_END = '</pi-workbench-context>'
/**
 * 上下文块内部分节标记（v2）：渲染层按这套结构写，恢复历史时按同一套解析，
 * 因此「发出去的引用」能被原样还原成引用块。
 */
export const CONTEXT_FILES_START = '<!--pi:files-->'
export const CONTEXT_FILES_END = '<!--/pi:files-->'
export const CONTEXT_QUOTES_START = '<!--pi:quotes-->'
export const CONTEXT_QUOTES_END = '<!--/pi:quotes-->'
/** 单条引用：`<!--pi:quote {json}-->` + 正文 + `<!--/pi:quote-->` */
export const CONTEXT_QUOTE_START = '<!--pi:quote '
export const CONTEXT_QUOTE_END = '<!--/pi:quote-->'
/** v1 块的引用段标题：没有分节标记的老记录按它兜底解析 */
const V1_QUOTES_HEADING = 'Quoted excerpts (inlined):'
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

/**
 * 恢复历史时去掉附件上下文块与 Plan 模式提示块，避免聊天面板展示内部指令。
 *
 * 必须**循环剥完所有块**：一条用户消息可能同时带工作树上下文块（AgentManager 加的）
 * 与渲染层的附件块（含引用正文），只剥第一个会让第二块原文露在对话里。
 */
export function stripContextBlock(content: string): string {
  let text = content
  let planStripped = false
  let contextStripped = false

  for (;;) {
    const start = text.indexOf(PLAN_BLOCK_START)
    const end = text.indexOf(PLAN_BLOCK_END)
    if (start === -1 || end <= start) break
    text = joinSurroundings(text.slice(0, start), text.slice(end + PLAN_BLOCK_END.length))
    planStripped = true
  }

  for (;;) {
    const start = text.indexOf(CONTEXT_BLOCK_START)
    if (start === -1) break
    const end = findContextBlockEnd(text, start + CONTEXT_BLOCK_START.length)
    if (end === -1) break
    text = joinSurroundings(text.slice(0, start), text.slice(end + CONTEXT_BLOCK_END.length))
    contextStripped = true
  }

  if (!contextStripped && !planStripped) return text
  if (contextStripped && !text.trim()) return '(attached files)'
  return text
}

function joinSurroundings(before: string, after: string): string {
  return [before.trim(), after.trim()].filter(Boolean).join('\n\n')
}

/**
 * 找块结束标记。优先取「独占一行」的结束标记：引用正文里可能内联出现
 * `</pi-workbench-context>`（例如在讨论这套格式），不应被当成块结束。
 */
function findContextBlockEnd(content: string, from: number): number {
  const anchored = content.indexOf(`\n${CONTEXT_BLOCK_END}`, from)
  if (anchored !== -1) return anchored + 1
  return content.indexOf(CONTEXT_BLOCK_END, from)
}

/** 会话记录里可能连续出现多个上下文块（工作树块 + 渲染层块），按顺序取出块内文本 */
export function contextBlockBodies(content: string): string[] {
  const bodies: string[] = []
  let index = 0
  for (;;) {
    const start = content.indexOf(CONTEXT_BLOCK_START, index)
    if (start === -1) break
    const bodyStart = start + CONTEXT_BLOCK_START.length
    const end = findContextBlockEnd(content, bodyStart)
    if (end === -1) break
    bodies.push(content.slice(bodyStart, end))
    index = end + CONTEXT_BLOCK_END.length
  }
  return bodies
}

/**
 * 从会话记录里还原用户消息随行的引用与附件。
 *
 * v2 块（带 `<!--pi:*-->` 分节标记）精确解析；v1 老记录靠标题行与 `---` 分隔兜底，
 * 只要有一处分不清就整段放弃——宁可少显示，也不显示错内容。
 */
export function parseContextBlock(content: string): MessageContext | null {
  if (!content) return null
  const quotes: MessageContextQuote[] = []
  const files: MessageContextFile[] = []

  for (const body of contextBlockBodies(content)) {
    const v2 = parseContextBodyV2(body)
    if (v2) {
      quotes.push(...v2.quotes)
      files.push(...v2.files)
      continue
    }
    const v1 = parseContextBodyV1(body)
    if (v1) {
      quotes.push(...v1.quotes)
      files.push(...v1.files)
    }
  }

  if (quotes.length === 0 && files.length === 0) return null
  return { quotes, files }
}

function parseContextBodyV2(body: string): MessageContext | null {
  const filesStart = body.indexOf(CONTEXT_FILES_START)
  const quotesStart = body.indexOf(CONTEXT_QUOTES_START)
  if (filesStart === -1 && quotesStart === -1) return null

  const files: MessageContextFile[] = []
  if (filesStart !== -1) {
    const end = body.indexOf(CONTEXT_FILES_END, filesStart)
    const section = body.slice(filesStart + CONTEXT_FILES_START.length, end === -1 ? undefined : end)
    for (const line of section.split('\n')) {
      const file = parseFileLine(line)
      if (file) files.push(file)
    }
  }

  const quotes: MessageContextQuote[] = []
  if (quotesStart !== -1) {
    const end = body.indexOf(CONTEXT_QUOTES_END, quotesStart)
    const section = body.slice(
      quotesStart + CONTEXT_QUOTES_START.length,
      end === -1 ? undefined : end
    )
    quotes.push(...parseQuoteFences(section))
  }

  return { quotes, files }
}

function parseQuoteFences(section: string): MessageContextQuote[] {
  const quotes: MessageContextQuote[] = []
  let index = 0
  for (;;) {
    const start = section.indexOf(CONTEXT_QUOTE_START, index)
    if (start === -1) break
    const headerEnd = section.indexOf('-->', start)
    if (headerEnd === -1) break
    const end = section.indexOf(CONTEXT_QUOTE_END, headerEnd)
    if (end === -1) break
    const meta = parseJsonObject(section.slice(start + CONTEXT_QUOTE_START.length, headerEnd))
    const content = section
      .slice(headerEnd + 3, end)
      .replace(/^\r?\n/, '')
      .replace(/\r?\n$/, '')
    const quote: MessageContextQuote = { content }
    const label = stringField(meta, 'label')
    const path = stringField(meta, 'path')
    const startLine = numberField(meta, 'startLine')
    const endLine = numberField(meta, 'endLine')
    if (label) quote.label = label
    if (path) quote.path = path
    if (startLine !== undefined) quote.startLine = startLine
    if (endLine !== undefined) quote.endLine = endLine
    quotes.push(quote)
    index = end + CONTEXT_QUOTE_END.length
  }
  return quotes
}

function parseContextBodyV1(body: string): MessageContext | null {
  const heading = body.indexOf(V1_QUOTES_HEADING)
  const filesSection = heading === -1 ? body : body.slice(0, heading)
  const files: MessageContextFile[] = []
  for (const line of filesSection.split('\n')) {
    const file = parseFileLine(line)
    if (file) files.push(file)
  }

  const quotes: MessageContextQuote[] = []
  if (heading !== -1) {
    const section = body.slice(heading + V1_QUOTES_HEADING.length).trim()
    if (section) {
      // 每条以 `--- <标题> (lines a-b) ---` 开头，用空行 + `--- ` 切分
      for (const chunk of section.split(/\n\s*\n(?=--- )/)) {
        const parsed = parseV1Quote(chunk)
        // 有一处分不清就整段放弃：错误还原比不还原更糟
        if (!parsed) return { quotes: [], files }
        quotes.push(parsed)
      }
    }
  }

  if (quotes.length === 0 && files.length === 0) return null
  return { quotes, files }
}

function parseV1Quote(chunk: string): MessageContextQuote | null {
  const match = chunk
    .trim()
    .match(/^---\s+([\s\S]+?)(?:\s+\(lines\s+(\d+)-(\d+)\))?\s+---\r?\n?([\s\S]*)$/)
  if (!match) return null
  const quote: MessageContextQuote = { content: match[4].replace(/\r?\n$/, '') }
  const label = match[1].trim()
  if (label) quote.label = label
  const startLine = match[2] ? Number(match[2]) : undefined
  const endLine = match[3] ? Number(match[3]) : undefined
  if (startLine !== undefined && endLine !== undefined) {
    quote.startLine = startLine
    quote.endLine = endLine
  }
  return quote
}

/** 文件行：``- `/abs/path` [name] (1.2 KB, text/markdown, 2026-01-02 03:04, outside workspace)`` */
function parseFileLine(line: string): MessageContextFile | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('- ')) return null
  const body = trimmed.slice(2)
  const code = body.match(/^`([^`]+)`/)
  const rawPath = code ? code[1] : body.split(' [')[0].split(' (')[0]
  const path = rawPath.trim()
  if (!path) return null

  const rest = code ? body.slice(code[0].length) : body.slice(rawPath.length)
  const file: MessageContextFile = { path }
  const name = rest.match(/\[([^\]]+)\]/)?.[1]
  if (name && name !== basenameOf(path)) file.name = name
  const meta = rest.match(/\(([^)]*)\)/)?.[1]
  if (meta) {
    for (const part of meta.split(',').map((item) => item.trim())) {
      if (part === 'outside workspace') {
        file.external = true
        continue
      }
      const size = parseSize(part)
      if (size !== undefined) {
        file.size = size
        continue
      }
      const mtime = parseMtime(part)
      if (mtime !== undefined) {
        file.mtime = mtime
        continue
      }
      if (/^[\w.+-]+\/[\w.+-]+$/.test(part)) file.mime = part
    }
  }
  return file
}

function basenameOf(targetPath: string): string {
  return targetPath.split(/[\\/]/).filter(Boolean).pop() ?? targetPath
}

const SIZE_UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }

function parseSize(text: string): number | undefined {
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/)
  if (!match) return undefined
  return Math.round(Number(match[1]) * SIZE_UNITS[match[2]])
}

/** 与渲染层 `formatMtime` 同格式（本地时间 `YYYY-MM-DD HH:mm`） */
function parseMtime(text: string): number | undefined {
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/)
  if (!match) return undefined
  const value = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  ).getTime()
  return Number.isFinite(value) ? value : undefined
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text.trim())
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function stringField(source: Record<string, unknown> | null, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' && value ? value : undefined
}

function numberField(source: Record<string, unknown> | null, key: string): number | undefined {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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
