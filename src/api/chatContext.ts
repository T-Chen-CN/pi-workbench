/**
 * 把用户附加的文件与引用片段组织成对话上下文。
 *
 * 2026-10-30 需求变更：文件附件不再内联内容，只把绝对路径与元信息交给模型，
 * 由 Agent 用自己的 read / grep 工具按需读取。这样做的原因：
 * - 任意位置、任意格式、任意大小的文件都能附加，不被上下文窗口与文本解码限制；
 * - 会话记录里不再堆积整文件内容（会话 JSONL 体积可控）；
 * - 二进制文件（PDF / Office / 归档）不会被当成 UTF-8 读成乱码。
 *
 * 选区与划词引用仍然内联快照：它们没有可交给 Agent 的文件语义
 * （Agent 回复里的引用块连路径都没有）。
 *
 * 注入块带固定标记，便于 AgentManager 在恢复会话历史时把它剥离，
 * 避免聊天面板重新展示整段内部指令。
 */

export const CONTEXT_BLOCK_START = '<pi-workbench-context>'
export const CONTEXT_BLOCK_END = '</pi-workbench-context>'

/** 文件附件：只描述，不内联内容 */
export interface ContextFileRef {
  kind: 'file'
  path: string
  /** 展示用文件名；缺省取路径最后一段 */
  name?: string
  /** 字节数 */
  size?: number
  mime?: string
  /** 最后修改时间（ms） */
  mtime?: number
  /** 位于工作区之外 */
  external?: boolean
}

/** 选区 / 划词引用：内联内容快照 */
export interface ContextQuoteRef {
  kind: 'quote'
  content: string
  path?: string
  label?: string
  startLine?: number
  endLine?: number
}

export type ContextEntry = ContextFileRef | ContextQuoteRef

function basenameOf(targetPath: string): string {
  return targetPath.split(/[\\/]/).filter(Boolean).pop() ?? targetPath
}

function formatSize(bytes: number | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatMtime(mtime: number | undefined): string | null {
  if (typeof mtime !== 'number' || !Number.isFinite(mtime) || mtime <= 0) return null
  const date = new Date(mtime)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

/** 文件条目的元信息括号内容：大小 · 类型 · 修改时间 · 工作区外 */
function fileMeta(file: ContextFileRef): string {
  const parts = [
    formatSize(file.size),
    file.mime,
    formatMtime(file.mtime),
    file.external ? 'outside workspace' : null,
  ].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

function fileLine(file: ContextFileRef): string {
  const name = file.name ?? basenameOf(file.path)
  const nameSuffix = name && name !== basenameOf(file.path) ? ` [${name}]` : ''
  return `- ${file.path}${nameSuffix}${fileMeta(file)}`
}

function quoteBlock(quote: ContextQuoteRef): string {
  const range =
    quote.startLine !== undefined && quote.endLine !== undefined
      ? ` (lines ${quote.startLine}-${quote.endLine})`
      : ''
  const title = quote.path || quote.label || 'quote'
  return `--- ${title}${range} ---\n${quote.content}`
}

export function buildContextPrompt(message: string, entries: ContextEntry[]): string {
  if (entries.length === 0) return message

  const files = entries.filter((entry): entry is ContextFileRef => entry.kind === 'file')
  const quotes = entries.filter((entry): entry is ContextQuoteRef => entry.kind === 'quote')

  const sections: string[] = []
  if (files.length > 0) {
    sections.push(
      [
        'Attached files. Their contents are NOT inlined: read them yourself with the read / grep tools using these absolute paths.',
        ...files.map(fileLine),
      ].join('\n')
    )
  }
  if (quotes.length > 0) {
    sections.push(['Quoted excerpts (inlined):', ...quotes.map(quoteBlock)].join('\n\n'))
  }

  return `${CONTEXT_BLOCK_START}\n${sections.join('\n\n')}\n${CONTEXT_BLOCK_END}\n\n${message}`
}
