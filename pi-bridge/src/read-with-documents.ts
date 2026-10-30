/**
 * `read` 工具的文档增强版。
 *
 * 设计要点（见 docs/reports/design-office-documents-2026-10-30.md）：
 * - **不新增工具**。Gemini CLI / Claude Code 都是「一个 read 工具 + 可选参数」，
 *   模型只需要知道 read 能读一切。多一个 `read_document` 会让模型在两者之间犹豫。
 * - 注册同名 `read` 覆盖内置定义：SDK 的 `_refreshToolRegistry` 先放内置再放
 *   customTools，后者按名字覆盖，因此工具表里仍然只有一个 `read`，
 *   `tool-policy.ts` 的只读白名单也不需要改。
 * - 只有扩展名像文档时才问主进程要内容；其余情况**原样委托**内置 `read`，
 *   文本行号、截断、图片缩放的行为与今天逐字节一致。
 * - 内容抽取在主进程（`electron/documents/`），这里只依赖注入的回调，
 *   保证 pi-bridge 不引入任何新依赖。
 */

import * as path from 'path'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  createReadToolDefinition,
  truncateHead,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'

export interface DocumentReadRequest {
  /** 已解析为绝对路径 */
  path: string
  /** PDF 页码范围：`3`、`1-5`、`1,3,5` */
  pages?: string
  /** xlsx 工作表名 */
  sheet?: string
  /** pptx 页码范围（放映顺序）：`2`、`2-4` */
  slide?: string
}

export interface DocumentReadContent {
  text: string
  /** 扫描页渲染结果（base64 PNG） */
  images: { data: string; mimeType: string }[]
  /** true 表示没有内容可给模型（旧格式、损坏、加密） */
  rejected?: boolean
  format?: string
}

/**
 * 主进程实现的抽取回调。
 * 返回 `null` 表示「扩展名像文档但其实不是」（例如被改名的文本文件），
 * 此时交回内置 `read` 按文本处理。
 */
export type DocumentReadHook = (request: DocumentReadRequest) => Promise<DocumentReadContent | null>

export interface ReadDocumentToolDetails {
  document?: {
    format?: string
    pages?: string
    sheet?: string
    slide?: string
  }
  truncation?: ReturnType<typeof truncateHead>
}

/** 会走文档管线的扩展名；与 electron/documents/detect.ts 保持同一份清单 */
const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'docm',
  'dotx',
  'xlsx',
  'xlsm',
  'xltx',
  'pptx',
  'pptm',
  'potx',
  'odt',
  'ott',
  'ods',
  'ots',
  'odp',
  'otp',
  'epub',
  'doc',
  'dot',
  'xls',
  'xlt',
  'xla',
  'ppt',
  'pot',
  'pps',
  'wps',
  'et',
  'dps',
])

export function isDocumentPath(targetPath: string): boolean {
  const name = path.basename(targetPath).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 && DOCUMENT_EXTENSIONS.has(name.slice(dot + 1))
}

const DOCUMENT_DESCRIPTION_SUFFIX =
  ' Also extracts text from PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), ' +
  'OpenDocument (odt/ods/odp) and EPUB files by path. For PDFs use pages="1-5"; ' +
  'for spreadsheets use sheet="Sheet name"; for slides use slide="2-4". ' +
  'Scanned PDF pages without a text layer are returned as page images.'

const DOCUMENT_GUIDELINE =
  'read also handles pdf / docx / xlsx / pptx / odt / ods / odp / epub: pass the file path directly, ' +
  'and narrow large files with pages, sheet or slide.'

export interface CreateReadWithDocumentsOptions {
  cwd: string
  /** 未注入时直接返回内置定义（Web 预览、未接线环境零影响） */
  readDocument?: DocumentReadHook
}

export interface ReadWithDocumentsArgs {
  path: string
  offset?: number
  limit?: number
  pages?: string
  sheet?: string
  slide?: string
}

export function createReadWithDocumentsDefinition(
  options: CreateReadWithDocumentsOptions
): ToolDefinition<any, any> {
  const builtin = createReadToolDefinition(options.cwd)
  const hook = options.readDocument
  if (!hook) return builtin

  const builtinProperties = (builtin.parameters as { properties?: Record<string, unknown> })
    .properties ?? {}

  // 在 JSON Schema 上直接扩展：不引 typebox（pi-bridge 不新增依赖），
  // 内置的 required: ['path'] 与 additionalProperties 约束原样保留。
  const parameters = {
    ...builtin.parameters,
    properties: {
      ...builtinProperties,
      pages: {
        type: 'string',
        description: 'PDF page range to read, for example "1-5", "3" or "1,3,7" (1-indexed)',
      },
      sheet: {
        type: 'string',
        description: 'Worksheet name to read from a spreadsheet (default: all sheets)',
      },
      slide: {
        type: 'string',
        description: 'Slide range to read from a presentation, for example "2-4" (1-indexed)',
      },
    },
  } as unknown as typeof builtin.parameters

  const definition = {
    ...builtin,
    description: `${builtin.description}${DOCUMENT_DESCRIPTION_SUFFIX}`,
    promptGuidelines: [...(builtin.promptGuidelines ?? []), DOCUMENT_GUIDELINE],
    parameters,
    async execute(
      toolCallId: string,
      args: ReadWithDocumentsArgs,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof builtin.execute>[3],
      ctx: Parameters<typeof builtin.execute>[4]
    ) {
      const rawPath = typeof args?.path === 'string' ? args.path : ''
      // 非文档一律原样委托：内置行为（行号、截断、图片缩放）保持不变
      if (!rawPath || !isDocumentPath(rawPath)) {
        return builtin.execute(toolCallId, args, signal, onUpdate, ctx)
      }
      if (signal?.aborted) throw new Error('Operation aborted')

      const cwd = ctx?.cwd || options.cwd
      const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath)
      let document: DocumentReadContent | null
      try {
        document = await hook({
          path: absolutePath,
          pages: typeof args.pages === 'string' ? args.pages : undefined,
          sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
          slide: typeof args.slide === 'string' ? args.slide : undefined,
        })
      } catch (error) {
        if (signal?.aborted) throw new Error('Operation aborted')
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to read document ${rawPath}: ${message}`)
      }
      // 扩展名像文档但内容不是（改名的文本文件 / 未知容器）：交回内置 read
      if (!document) return builtin.execute(toolCallId, args, signal, onUpdate, ctx)
      if (signal?.aborted) throw new Error('Operation aborted')

      const details: ReadDocumentToolDetails = {
        document: {
          format: document.format,
          pages: typeof args.pages === 'string' ? args.pages : undefined,
          sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
          slide: typeof args.slide === 'string' ? args.slide : undefined,
        },
      }

      // 与内置 read 相同的行数 / 字节上限，避免文档把上下文一次吃满
      const truncation = truncateHead(document.text)
      let text = truncation.content
      if (truncation.truncated && !document.rejected) {
        text +=
          `\n\n[Document truncated at ${DEFAULT_MAX_LINES} lines or ` +
          `${DEFAULT_MAX_BYTES / 1024}KB. Narrow the read with ` +
          `pages="1-20", sheet="<name>" or slide="1-10".]`
        details.truncation = truncation
      }

      type ContentBlock =
        | { type: 'text'; text: string }
        | { type: 'image'; data: string; mimeType: string }
      const content: ContentBlock[] = [{ type: 'text', text }]
      for (const image of document.images) {
        content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
      }

      return {
        content,
        details,
        isError: document.rejected === true ? true : undefined,
        structuredContent: document.images.length
          ? {
              type: 'image' as const,
              data: document.images[0].data,
              mimeType: document.images[0].mimeType,
              note: text,
            }
          : text,
      }
    },
  }
  return definition as unknown as ToolDefinition<any, any>
}
