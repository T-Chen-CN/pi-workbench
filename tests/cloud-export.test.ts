import { describe, expect, it } from 'vitest'
import {
  cloudExportFileName,
  renderCloudExport,
  renderCloudHtml,
  renderCloudJson,
  renderCloudMarkdown,
} from '../electron/cloud/export'
import type { CloudTracePart } from '../electron/cloud/types'

const META = {
  sessionId: 'sess_1',
  title: '部署排查',
  model: 'deepseek-chat',
  exportedAt: Date.UTC(2026, 10, 8, 6, 30),
}

const PARTS: CloudTracePart[] = [
  { type: 'text', id: 'h:1', role: 'user', text: '服务为什么挂了？' },
  { type: 'thinking', id: 'h:2', text: '先看日志' },
  {
    type: 'tool',
    id: 't:3',
    toolCallId: 'call_1',
    toolName: 'terminal',
    argsSummary: 'journalctl -u caddy -n 50',
    status: 'success',
    resultPreview: 'caddy[1]: listening on :443',
  },
  {
    type: 'approval',
    id: 'ap:4',
    requestId: 'req_1',
    command: 'systemctl restart caddy',
    patternKeys: ['systemctl'],
    choices: ['once', 'deny'],
    decision: 'once',
  },
  { type: 'clarify', id: 'cl:5', promptId: 'p_1', question: '重启哪个服务？', answer: 'caddy' } as never,
  { type: 'interjection', id: 'i:6', text: '顺便看下证书', delivered: true },
  { type: 'divider', id: 'd:7', kind: 'disconnect' },
  { type: 'text', id: 'h:8', role: 'assistant', text: '证书 11 月 30 日到期。' },
]

describe('cloud session export', () => {
  it('renders markdown with roles, tools, approvals and answers', () => {
    const md = renderCloudMarkdown(PARTS, META, 'zh')
    expect(md.startsWith('# 部署排查 · deepseek-chat')).toBe(true)
    expect(md).toContain('### 用户')
    expect(md).toContain('服务为什么挂了？')
    expect(md).toContain('### 助手')
    expect(md).toContain('**terminal** · success')
    expect(md).toContain('journalctl -u caddy -n 50')
    expect(md).not.toContain('已拒绝')
    expect(md).toContain('本次允许')
    expect(md).toContain('→ caddy')
    expect(md).toContain('**插话**')
    // 分隔线只是渲染用的，不进文档
    expect(md).not.toContain('分隔')
  })

  it('escapes html so a command cannot break the document', () => {
    const html = renderCloudHtml(
      [
        {
          type: 'approval',
          id: 'ap:1',
          requestId: 'req_x',
          command: 'echo "<script>alert(1)</script>"',
          patternKeys: [],
          choices: ['deny'],
        },
      ],
      META,
      'zh'
    )
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('<!doctype html>')
  })

  it('keeps the raw parts in the json export', () => {
    const raw = JSON.parse(renderCloudJson(PARTS, META)) as {
      session: { id: string; model: string; exportedAt: string }
      parts: CloudTracePart[]
    }
    expect(raw.session.id).toBe('sess_1')
    expect(raw.session.model).toBe('deepseek-chat')
    expect(raw.session.exportedAt).toBe('2026-11-08T06:30:00.000Z')
    expect(raw.parts).toHaveLength(PARTS.length)
  })

  it('dispatches by format and defaults to markdown', () => {
    expect(renderCloudExport(PARTS, META, 'html')).toContain('<!doctype html>')
    expect(renderCloudExport(PARTS, META, 'json').trim().startsWith('{')).toBe(true)
    expect(renderCloudExport(PARTS, META, 'md')).toContain('# 部署排查')
  })

  it('writes an English header when the app is in English', () => {
    const md = renderCloudMarkdown(PARTS, META, 'en')
    expect(md).toContain('### User')
    expect(md).toContain('### Assistant')
    expect(md).toContain('Exported')
  })

  it('builds a file name that no filesystem rejects', () => {
    expect(cloudExportFileName('a/b:c*d?', 'sess_1', 'md')).toBe('a_b_c_d_.md')
    expect(cloudExportFileName('', 'sess_1', 'html')).toBe('sess_1.html')
    expect(cloudExportFileName('x'.repeat(200), 'sess_1', 'json')).toHaveLength(80 + '.json'.length)
  })
})
