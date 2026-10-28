import { describe, expect, it } from 'vitest'
import {
  buildHtmlExport,
  buildMarkdownExport,
  type ExportTurn,
} from '../pi-bridge/src/session-export'

const turnsWithCompaction: ExportTurn[] = [
  {
    user: { text: 'Fix the build', timestamp: 1000 },
    parts: [
      { type: 'text', text: 'before compaction' },
      { type: 'compaction', timestamp: 1500, tokensBefore: 128_000 },
      { type: 'text', text: 'after compaction' },
    ],
  },
]

describe('buildMarkdownExport', () => {
  it('keeps pre-compaction history and marks the compaction point', () => {
    const { content } = buildMarkdownExport('Build fix', turnsWithCompaction, 'zh')

    expect(content).toContain('before compaction')
    expect(content).toContain('after compaction')
    expect(content).toContain('---')
    expect(content).toContain('> 上下文已压缩 · 压缩前 128,000 tokens')
    expect(content.indexOf('before compaction')).toBeLessThan(
      content.indexOf('上下文已压缩')
    )
    expect(content.indexOf('上下文已压缩')).toBeLessThan(
      content.indexOf('after compaction')
    )
  })

  it('omits the token count when it is unknown', () => {
    const { content } = buildMarkdownExport(
      'Build fix',
      [
        {
          user: { text: 'hi', timestamp: 1000 },
          parts: [{ type: 'compaction', timestamp: 1500 }],
        },
      ],
      'zh'
    )

    expect(content).toContain('> 上下文已压缩')
    expect(content).not.toContain('压缩前')
  })

  it('localizes the divider for English exports', () => {
    const { content } = buildMarkdownExport('Build fix', turnsWithCompaction, 'en')

    expect(content).toContain('> Context compacted · 128,000 tokens before')
  })

  it('writes no divider when nothing was compacted', () => {
    const { content } = buildMarkdownExport(
      'Build fix',
      [{ user: { text: 'hi', timestamp: 1000 }, parts: [{ type: 'text', text: 'hello' }] }],
      'zh'
    )

    expect(content).not.toContain('---')
    expect(content).not.toContain('上下文已压缩')
    expect(content).toContain('hello')
  })
})

describe('buildHtmlExport', () => {
  it('renders the compaction point between the surrounding text', () => {
    const { content } = buildHtmlExport('Build fix', turnsWithCompaction, 'zh')

    expect(content).toContain('before compaction')
    expect(content).toContain('after compaction')
    expect(content).toContain('<hr />')
    expect(content).toContain('<p class="compacted">上下文已压缩 · 压缩前 128,000 tokens</p>')
    expect(content.indexOf('before compaction')).toBeLessThan(
      content.indexOf('<p class="compacted">')
    )
    expect(content.indexOf('<p class="compacted">')).toBeLessThan(
      content.indexOf('after compaction')
    )
  })

  it('localizes the divider for English exports', () => {
    const { content } = buildHtmlExport('Build fix', turnsWithCompaction, 'en')

    expect(content).toContain('Context compacted · 128,000 tokens before')
  })
})
