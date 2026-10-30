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
 * 结构（v2）：块内用 `<!--pi:*-->` 分节，每条引用带一行 JSON 元数据，
 * 便于 `parseContextBlock()` 精确还原成界面上的引用块 / 附件 chip。
 * 标记与解析在 `pi-bridge/src/text-utils.ts`，两边必须逐字一致。
 */

export const CONTEXT_BLOCK_START = '<pi-workbench-context>'
export const CONTEXT_BLOCK_END = '</pi-workbench-context>'
export const CONTEXT_FILES_START = '<!--pi:files-->'
export const CONTEXT_FILES_END = '<!--/pi:files-->'
export const CONTEXT_QUOTES_START = '<!--pi:quotes-->'
export const CONTEXT_QUOTES_END = '<!--/pi:quotes-->'
export const CONTEXT_QUOTE_START = '<!--pi:quote '
export const CONTEXT_QUOTE_END = '<!--/pi:quote-->'

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

/** 路径放进反引号代码段；路径本身带反引号时退回纯文本（解析侧有兜底） */
function codePath(targetPath: string): string {
  return targetPath.includes('`') ? targetPath : `\`${targetPath}\``
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
  return `- ${codePath(file.path)}${nameSuffix}${fileMeta(file)}`
}

/** 单条引用的元数据行：只放结构化字段，正文留在围栏里（可含空行与 `---`） */
function quoteMeta(quote: ContextQuoteRef): string {
  const meta: Record<string, string | number> = {}
  if (quote.label) meta.label = quote.label
  if (quote.path) meta.path = quote.path
  if (quote.startLine !== undefined) meta.startLine = quote.startLine
  if (quote.endLine !== undefined) meta.endLine = quote.endLine
  return `${CONTEXT_QUOTE_START}${JSON.stringify(meta)}-->`
}

export function buildContextPrompt(message: string, entries: ContextEntry[]): string {
  if (entries.length === 0) return message

  const files = entries.filter((entry): entry is ContextFileRef => entry.kind === 'file')
  const quotes = entries.filter((entry): entry is ContextQuoteRef => entry.kind === 'quote')

  const sections: string[] = []
  if (files.length > 0) {
    sections.push(
      [
        CONTEXT_FILES_START,
        'Attached files. Their contents are NOT inlined: read them yourself with the read / grep tools using these absolute paths.',
        'PDF / Word / Excel / PowerPoint / OpenDocument / EPUB attachments are read straight through: call read with the path and it returns the extracted text (scanned PDF pages come back as images for you to look at). Use pages="1-20", sheet="<name>" or slide="1-10" to narrow large files. Old formats (.doc/.xls/.ppt) cannot be decoded — tell the user to save them as .docx/.xlsx/.pptx.',
        ...files.map(fileLine),
        CONTEXT_FILES_END,
      ].join('\n')
    )
  }
  if (quotes.length > 0) {
    sections.push(
      [
        CONTEXT_QUOTES_START,
        'Quoted excerpts from the conversation or from files the user is reading (inlined):',
        ...quotes.map((quote) => [quoteMeta(quote), quote.content, CONTEXT_QUOTE_END].join('\n')),
        CONTEXT_QUOTES_END,
      ].join('\n')
    )
  }

  return `${CONTEXT_BLOCK_START}\n${sections.join('\n')}\n${CONTEXT_BLOCK_END}\n\n${message}`
}
