import { describe, expect, it } from 'vitest'
import {
  buildContextPrompt,
  CONTEXT_BLOCK_END,
  CONTEXT_BLOCK_START,
} from '../src/api/chatContext'

describe('buildContextPrompt', () => {
  it('returns the message unchanged when nothing is attached', () => {
    expect(buildContextPrompt('hello', [])).toBe('hello')
  })

  it('passes file paths without inlining contents', () => {
    const prompt = buildContextPrompt('explain this', [
      { kind: 'file', path: '/tmp/a.ts', size: 2048, mime: 'text/typescript' },
    ])

    expect(prompt.startsWith(CONTEXT_BLOCK_START)).toBe(true)
    expect(prompt).toContain('- /tmp/a.ts (2.0 KB, text/typescript)')
    expect(prompt).toContain('read them yourself')
    expect(prompt).toContain(CONTEXT_BLOCK_END)
    expect(prompt.endsWith('explain this')).toBe(true)
  })

  it('lists every attached file', () => {
    const prompt = buildContextPrompt('review', [
      { kind: 'file', path: '/tmp/a.ts' },
      { kind: 'file', path: '/tmp/b.pdf' },
    ])

    expect(prompt).toContain('- /tmp/a.ts')
    expect(prompt).toContain('- /tmp/b.pdf')
  })

  it('marks files outside the workspace', () => {
    const prompt = buildContextPrompt('read it', [
      { kind: 'file', path: 'D:\\notes\\a.md', external: true, mtime: Date.UTC(2026, 9, 30, 6, 5) },
    ])

    expect(prompt).toContain('D:\\notes\\a.md')
    expect(prompt).toContain('outside workspace')
  })

  it('inlines quoted excerpts with their line range', () => {
    const prompt = buildContextPrompt('explain', [
      { kind: 'quote', path: '/tmp/a.ts', content: 'const a = 1', startLine: 12, endLine: 14 },
    ])

    expect(prompt).toContain('--- /tmp/a.ts (lines 12-14) ---')
    expect(prompt).toContain('const a = 1')
  })

  it('keeps quotes when both kinds are attached', () => {
    const prompt = buildContextPrompt('compare', [
      { kind: 'file', path: '/tmp/a.ts' },
      { kind: 'quote', label: 'Agent reply', content: 'snapshot' },
    ])

    expect(prompt).toContain('- /tmp/a.ts')
    expect(prompt).toContain('--- Agent reply ---\nsnapshot')
  })
})
