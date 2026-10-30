/** 会话导出（R-10）：Markdown 与自带样式的离线 HTML */

import type { MessageContext } from './types.js'

/** 会话导出（R-10）的结构标签 */
const EXPORT_LABELS = {
  zh: {
    you: '你',
    assistant: 'Pi',
    thinking: '思考过程',
    tool: '工具调用',
    args: '参数',
    result: '完整结果',
    image: '图片',
    exportedAt: '导出时间',
    compacted: '上下文已压缩',
    compactedTokens: '上下文已压缩 · 压缩前 {tokens} tokens',
    quotes: '引用',
    quoteLines: '第 {lines} 行',
    attachments: '附件',
  },
  en: {
    you: 'You',
    assistant: 'Pi',
    thinking: 'Thinking',
    tool: 'Tool call',
    args: 'Arguments',
    result: 'Full result',
    image: 'Image',
    exportedAt: 'Exported',
    compacted: 'Context compacted',
    compactedTokens: 'Context compacted · {tokens} tokens before',
    quotes: 'Quotes',
    quoteLines: 'lines {lines}',
    attachments: 'Attachments',
  },
} as const

export type ExportLanguage = 'zh' | 'en'

export type ExportToolPart = {
  type: 'tool'
  name: string
  args: string
  result: string
  isError: boolean
  images: Array<{ data: string; mimeType: string }>
}

export type ExportPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | ExportToolPart
  | { type: 'compaction'; timestamp: number; tokensBefore?: number }

export type ExportTurn = {
  user: { text: string; timestamp: number; context?: MessageContext }
  parts: ExportPart[]
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 生成不会与内容冲突的 Markdown 代码围栏 */
function markdownFence(text: string): string {
  const runs = text.match(/`{3,}/g) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** 压缩分隔线文案（导出与界面共用同一口径，不区分手动/自动） */
function compactionLabel(
  labels: (typeof EXPORT_LABELS)[ExportLanguage],
  tokensBefore?: number
): string {
  if (typeof tokensBefore === 'number') {
    return labels.compactedTokens.replace('{tokens}', tokensBefore.toLocaleString())
  }
  return labels.compacted
}

/** 引用来源行：路径或标题 + 行号 */
function quoteSourceLabel(
  labels: (typeof EXPORT_LABELS)[ExportLanguage],
  quote: MessageContext['quotes'][number]
): string {
  const name = quote.path || quote.label || 'quote'
  const range =
    quote.startLine !== undefined && quote.endLine !== undefined
      ? ` · ${labels.quoteLines.replace('{lines}', `${quote.startLine}-${quote.endLine}`)}`
      : ''
  return `${name}${range}`
}

function exportFileSize(bytes: number | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fileLineForExport(file: MessageContext['files'][number]): string {
  const size = exportFileSize(file.size)
  const name = file.name ? ` [${file.name}]` : ''
  return `- ${file.path}${name}${size ? ` (${size})` : ''}`
}

export function buildMarkdownExport(
  title: string,
  turns: ExportTurn[],
  language: ExportLanguage
): { title: string; content: string } {
  const labels = EXPORT_LABELS[language]
  const lines: string[] = [
    `# ${title}`,
    '',
    `> ${labels.exportedAt}: ${new Date().toISOString()}`,
    '',
  ]

  for (const turn of turns) {
    const context = turn.user.context
    if (turn.user.text || context) {
      lines.push(`## ${labels.you}`, '')
    }
    if (context) {
      for (const quote of context.quotes) {
        const fence = markdownFence(quote.content)
        lines.push(
          `**${labels.quotes}** · ${quoteSourceLabel(labels, quote)}`,
          '',
          `${fence}text`,
          quote.content,
          fence,
          ''
        )
      }
      if (context.files.length > 0) {
        lines.push(`**${labels.attachments}**`, '', ...context.files.map(fileLineForExport), '')
      }
    }
    if (turn.user.text) lines.push(turn.user.text, '')
    lines.push(`## ${labels.assistant}`, '')
    for (const part of turn.parts) {
      if (part.type === 'text') {
        lines.push(part.text, '')
        continue
      }
      if (part.type === 'compaction') {
        lines.push('---', '', `> ${compactionLabel(labels, part.tokensBefore)}`, '')
        continue
      }
      if (part.type === 'thinking') {
        lines.push(
          '<details>',
          `<summary>${labels.thinking}</summary>`,
          '',
          part.text,
          '',
          '</details>',
          ''
        )
        continue
      }
      const fence = markdownFence(`${part.args}\n${part.result}`)
      lines.push(
        '<details>',
        `<summary>${labels.tool} · ${part.name}${part.isError ? ' ✗' : ''}</summary>`,
        '',
        `**${labels.args}**`,
        '',
        `${fence}json`,
        part.args,
        fence,
        '',
        `**${labels.result}**`,
        '',
        `${fence}text`,
        part.result,
        fence
      )
      for (const image of part.images) {
        lines.push('', `![${labels.image}](data:${image.mimeType};base64,${image.data})`)
      }
      lines.push('', '</details>', '')
    }
  }

  return { title, content: lines.join('\n') }
}

export function buildHtmlExport(
  title: string,
  turns: ExportTurn[],
  language: ExportLanguage
): { title: string; content: string } {
  const labels = EXPORT_LABELS[language]
  const body: string[] = [
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="meta">${labels.exportedAt}: ${escapeHtml(new Date().toISOString())}</p>`,
  ]

  for (const turn of turns) {
    body.push('<section class="turn">')
    const context = turn.user.context
    if (turn.user.text || context) {
      body.push(`<h2>${labels.you}</h2>`)
    }
    if (context) {
      for (const quote of context.quotes) {
        body.push(
          '<blockquote>',
          `<p class="quote-src">${escapeHtml(labels.quotes)} · ${escapeHtml(
            quoteSourceLabel(labels, quote)
          )}</p>`,
          `<pre class="text">${escapeHtml(quote.content)}</pre>`,
          '</blockquote>'
        )
      }
      if (context.files.length > 0) {
        body.push(
          `<p class="quote-src">${escapeHtml(labels.attachments)}</p>`,
          '<ul class="files">',
          ...context.files.map((file) => `<li>${escapeHtml(fileLineForExport(file).slice(2))}</li>`),
          '</ul>'
        )
      }
    }
    if (turn.user.text) {
      body.push(`<pre class="text">${escapeHtml(turn.user.text)}</pre>`)
    }
    body.push(`<h2>${labels.assistant}</h2>`)
    for (const part of turn.parts) {
      if (part.type === 'text') {
        body.push(`<pre class="text">${escapeHtml(part.text)}</pre>`)
        continue
      }
      if (part.type === 'compaction') {
        body.push(
          '<hr />',
          `<p class="compacted">${escapeHtml(compactionLabel(labels, part.tokensBefore))}</p>`
        )
        continue
      }
      if (part.type === 'thinking') {
        body.push(
          '<details>',
          `<summary>${labels.thinking}</summary>`,
          `<pre>${escapeHtml(part.text)}</pre>`,
          '</details>'
        )
        continue
      }
      body.push(
        '<details>',
        `<summary>${labels.tool} · ${escapeHtml(part.name)}${part.isError ? ' ✗' : ''}</summary>`,
        `<h3>${labels.args}</h3>`,
        `<pre>${escapeHtml(part.args)}</pre>`,
        `<h3>${labels.result}</h3>`,
        `<pre>${escapeHtml(part.result)}</pre>`
      )
      for (const image of part.images) {
        body.push(
          `<img alt="${labels.image}" src="data:${image.mimeType};base64,${image.data}" />`
        )
      }
      body.push('</details>')
    }
    body.push('</section>')
  }

  const content = `<!doctype html>
<html lang="${language === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light; }
body { margin: 0; background: #f7f5ef; color: #26251f; font: 15px/1.7 -apple-system, "Segoe UI", "Noto Sans SC", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 48px 24px; }
h1 { font: 400 32px/1.2 Georgia, "Noto Serif SC", serif; margin: 0 0 8px; }
h2 { font: 400 24px/1.3 Georgia, "Noto Serif SC", serif; margin: 36px 0 12px; border-bottom: 1px solid #ddd8c8; padding-bottom: 6px; }
h3 { font-size: 13px; color: #7a766a; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: .04em; }
.meta { color: #7a766a; font-size: 12px; margin: 0 0 32px; }
pre { white-space: pre-wrap; word-break: break-word; background: #efece2; border: 1px solid #ddd8c8; padding: 10px 12px; font: 12.5px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; overflow: auto; }
pre.text { background: transparent; border: 0; padding: 0; font: inherit; }
details { border-left: 2px solid #ddd8c8; padding-left: 12px; margin: 12px 0; }
summary { cursor: pointer; color: #4f6b5a; font-size: 13px; }
img { max-width: 100%; height: auto; border: 1px solid #ddd8c8; margin: 8px 0; }
hr { border: 0; border-top: 1px solid #ddd8c8; margin: 24px 0 0; }
.compacted { color: #7a766a; font-size: 12px; margin: 8px 0 20px; }
blockquote { margin: 12px 0; padding-left: 12px; border-left: 2px solid #ddd8c8; }
.quote-src { color: #7a766a; font-size: 12px; margin: 0 0 6px; }
ul.files { color: #7a766a; font-size: 12px; margin: 4px 0 12px 18px; padding: 0; }
</style>
</head>
<body>
<main>
${body.join('\n')}
</main>
</body>
</html>
`
  return { title, content }
}
