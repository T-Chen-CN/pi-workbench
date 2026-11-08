/**
 * 云端会话导出：把时间线片段（`CloudTracePart`）渲染成 Markdown / HTML / JSON。
 *
 * 与本地导出（走 SDK 的会话记录）不同，云端没有 `session.jsonl`，唯一真相是
 * `GET /api/sessions/{id}/messages` 拉回来的片段集合。这里只做纯函数变换，
 * 落盘与选路径交给 IPC，方便单测。
 */

import type { CloudTracePart } from './types.js'
import type { CloudExportFormat } from './types.js'

export interface CloudExportMeta {
  sessionId: string
  title: string
  /** 导出时刻（毫秒）。空就写当前时间 */
  exportedAt?: number
  model?: string | null
}

const TOOL_RESULT_MAX_CHARS = 2000
const THINKING_MAX_CHARS = 4000

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（已截断 ${text.length - max} 字符）`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 片段在导出里的角色名（Markdown 与 HTML 共用，避免两处文案漂移） */
function partRoleLabel(part: CloudTracePart, language: 'zh' | 'en'): string {
  const zh = language !== 'en'
  switch (part.type) {
    case 'text':
      return part.role === 'user' ? (zh ? '用户' : 'User') : zh ? '助手' : 'Assistant'
    case 'thinking':
      return zh ? '思考' : 'Thinking'
    case 'tool':
      return zh ? '工具' : 'Tool'
    case 'approval':
      return zh ? '审批' : 'Approval'
    case 'clarify':
      return zh ? '澄清' : 'Clarify'
    case 'interjection':
      return zh ? '插话' : 'Steer'
    case 'subagent':
      return zh ? '子代理' : 'Subagent'
    default:
      return zh ? '分隔' : 'Divider'
  }
}

/** 审批的结果一句话：没决定、超时、已决定 */
function approvalOutcome(part: Extract<CloudTracePart, { type: 'approval' }>, zh: boolean): string {
  if (part.decision === 'deny') return zh ? '已拒绝' : 'Denied'
  if (part.decision === 'once') return zh ? '本次允许' : 'Allowed once'
  if (part.decision === 'session') return zh ? '本会话允许' : 'Allowed for session'
  if (part.expiresAt !== undefined && part.settled) return zh ? '已结束' : 'Settled'
  if (part.settled) return zh ? '已结束' : 'Settled'
  return zh ? '未处理' : 'Unhandled'
}

function partToMarkdown(part: CloudTracePart, language: 'zh' | 'en'): string {
  const zh = language !== 'en'
  switch (part.type) {
    case 'text':
      return `### ${partRoleLabel(part, language)}\n\n${part.text.trim()}\n`
    case 'thinking':
      return `> **${partRoleLabel(part, language)}**\n>\n> ${clip(part.text, THINKING_MAX_CHARS)
        .split('\n')
        .join('\n> ')}\n`
    case 'tool': {
      const status = part.status === 'error' ? (zh ? '失败' : 'failed') : part.status
      const head = `- **${part.toolName || 'tool'}** · ${status}`
      const args = part.argsSummary.trim() ? `\n  \`${part.argsSummary.trim()}\`` : ''
      const result = part.resultPreview?.trim()
        ? `\n\n\`\`\`\n${clip(part.resultPreview.trim(), TOOL_RESULT_MAX_CHARS)}\n\`\`\`\n`
        : '\n'
      return `${head}${args}${result}`
    }
    case 'approval':
      return `- **${partRoleLabel(part, language)}** · ${approvalOutcome(part, zh)}\n  \`${
        part.command
      }\`\n`
    case 'clarify':
      return `- **${partRoleLabel(part, language)}** · ${part.question}\n  → ${
        part.answer ?? (zh ? '未回答' : 'unanswered')
      }\n`
    case 'interjection':
      return `- **${partRoleLabel(part, language)}** · ${part.text}\n`
    case 'subagent':
      return `- **${partRoleLabel(part, language)}** · ${part.goal} (${part.status})\n`
    case 'divider':
      return ''
    default:
      return ''
  }
}

function partToHtml(part: CloudTracePart, language: 'zh' | 'en'): string {
  const zh = language !== 'en'
  const label = escapeHtml(partRoleLabel(part, language))
  switch (part.type) {
    case 'text': {
      const cls = part.role === 'user' ? 'turn user' : 'turn assistant'
      return `<section class="${cls}"><h3>${label}</h3><pre>${escapeHtml(
        part.text.trim()
      )}</pre></section>`
    }
    case 'thinking':
      return `<section class="turn thinking"><h3>${label}</h3><pre>${escapeHtml(
        clip(part.text, THINKING_MAX_CHARS)
      )}</pre></section>`
    case 'tool': {
      const status = part.status === 'error' ? (zh ? '失败' : 'failed') : part.status
      const args = part.argsSummary.trim()
        ? `<code>${escapeHtml(part.argsSummary.trim())}</code>`
        : ''
      const result = part.resultPreview?.trim()
        ? `<pre class="result">${escapeHtml(clip(part.resultPreview.trim(), TOOL_RESULT_MAX_CHARS))}</pre>`
        : ''
      return `<section class="turn tool"><h3>${label} · ${escapeHtml(
        part.toolName || 'tool'
      )} <span class="status">${escapeHtml(status)}</span></h3>${args}${result}</section>`
    }
    case 'approval':
      return `<section class="turn approval"><h3>${label} · ${escapeHtml(
        approvalOutcome(part, zh)
      )}</h3><pre>${escapeHtml(part.command)}</pre></section>`
    case 'clarify':
      return `<section class="turn clarify"><h3>${label}</h3><pre>${escapeHtml(
        part.question
      )}</pre><p>→ ${escapeHtml(part.answer ?? (zh ? '未回答' : 'unanswered'))}</p></section>`
    case 'interjection':
      return `<section class="turn steer"><h3>${label}</h3><pre>${escapeHtml(part.text)}</pre></section>`
    case 'subagent':
      return `<section class="turn subagent"><h3>${label}</h3><pre>${escapeHtml(
        `${part.goal} (${part.status})`
      )}</pre></section>`
    default:
      return ''
  }
}

function header(meta: CloudExportMeta, language: 'zh' | 'en'): string {
  const zh = language !== 'en'
  const at = new Date(meta.exportedAt ?? Date.now())
  const model = meta.model ? ` · ${meta.model}` : ''
  return zh
    ? `${meta.title || meta.sessionId}${model}\n\n导出于 ${at.toLocaleString('zh-CN')} · 会话 ${meta.sessionId}`
    : `${meta.title || meta.sessionId}${model}\n\nExported ${at.toISOString()} · session ${meta.sessionId}`
}

export function renderCloudMarkdown(
  parts: CloudTracePart[],
  meta: CloudExportMeta,
  language: 'zh' | 'en' = 'zh'
): string {
  const body = parts
    .map((part) => partToMarkdown(part, language))
    .filter((chunk) => chunk.trim())
    .join('\n')
  return `# ${header(meta, language)}\n\n${body}`
}

export function renderCloudHtml(
  parts: CloudTracePart[],
  meta: CloudExportMeta,
  language: 'zh' | 'en' = 'zh'
): string {
  const body = parts
    .map((part) => partToHtml(part, language))
    .filter((chunk) => chunk.trim())
    .join('\n')
  const firstLine = header(meta, language).split('\n')[0]
  return `<!doctype html>
<html lang="${language === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(firstLine)}</title>
<style>
  body { margin: 0; padding: 32px 20px; background: #faf9f7; color: #1f1d1a;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1.6; }
  main { max-width: 780px; margin: 0 auto; }
  header { border-bottom: 1px solid #e3e0da; padding-bottom: 12px; margin-bottom: 24px; }
  header h1 { font-size: 18px; margin: 0 0 6px; }
  header p { margin: 0; font-size: 12px; color: #6b6660; }
  section.turn { margin: 0 0 18px; padding-left: 12px; border-left: 2px solid #e3e0da; }
  section.turn.user { border-left-color: #b9b2a6; }
  section.turn.thinking { border-left-color: #cfc8bb; color: #55504a; }
  section.turn.tool { border-left-color: #b7c2c9; }
  section.turn.approval, section.turn.clarify { border-left-color: #c9b79b; }
  section.turn h3 { font-size: 12px; margin: 0 0 6px; color: #6b6660;
    font-weight: 600; letter-spacing: 0.02em; }
  section.turn h3 .status { font-weight: 400; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word;
    font-family: "SFMono-Regular", Consolas, monospace; font-size: 12.5px; }
  pre.result { color: #43403b; background: #f2f0ec; padding: 8px 10px; margin-top: 6px;
    border-radius: 3px; }
  code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; color: #43403b; }
  p { margin: 6px 0 0; }
</style>
</head>
<body>
<main>
<header><h1>${escapeHtml(firstLine)}</h1><p>${escapeHtml(
    header(meta, language).split('\n').slice(2).join(' ')
  )}</p></header>
${body}
</main>
</body>
</html>
`
}

export function renderCloudJson(parts: CloudTracePart[], meta: CloudExportMeta): string {
  return JSON.stringify(
    {
      session: {
        id: meta.sessionId,
        title: meta.title,
        model: meta.model ?? null,
        exportedAt: new Date(meta.exportedAt ?? Date.now()).toISOString(),
      },
      parts,
    },
    null,
    2
  )
}

export function renderCloudExport(
  parts: CloudTracePart[],
  meta: CloudExportMeta,
  format: CloudExportFormat,
  language: 'zh' | 'en' = 'zh'
): string {
  if (format === 'html') return renderCloudHtml(parts, meta, language)
  if (format === 'json') return renderCloudJson(parts, meta)
  return renderCloudMarkdown(parts, meta, language)
}

/** 文件名：去掉路径分隔符与保留字符，标题为空时退回会话 id */
export function cloudExportFileName(title: string, sessionId: string, format: CloudExportFormat): string {
  const base = (title || sessionId).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'session'
  return `${base}.${format}`
}
