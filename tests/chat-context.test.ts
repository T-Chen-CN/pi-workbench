import { describe, expect, it } from 'vitest'
import {
  buildContextPrompt,
  CONTEXT_BLOCK_END,
  CONTEXT_BLOCK_START,
} from '../src/api/chatContext'

describe('buildContextPrompt', () => {
  it('returns the message unchanged when no files are attached', () => {
    expect(buildContextPrompt('hello', [])).toBe('hello')
  })

  it('wraps files in a marked block before the message', () => {
    const prompt = buildContextPrompt('explain this', [
      { path: '/tmp/a.ts', content: 'const a = 1' },
    ])

    expect(prompt.startsWith(CONTEXT_BLOCK_START)).toBe(true)
    expect(prompt).toContain('--- /tmp/a.ts ---')
    expect(prompt).toContain('const a = 1')
    expect(prompt).toContain(CONTEXT_BLOCK_END)
    expect(prompt.endsWith('explain this')).toBe(true)
  })

  it('includes every attached file', () => {
    const prompt = buildContextPrompt('review', [
      { path: '/tmp/a.ts', content: 'a' },
      { path: '/tmp/b.ts', content: 'b' },
    ])

    expect(prompt).toContain('--- /tmp/a.ts ---\na')
    expect(prompt).toContain('--- /tmp/b.ts ---\nb')
  })

  it('labels snippet ranges in the block header', () => {
    const prompt = buildContextPrompt('explain', [
      { path: '/tmp/a.ts', content: 'const a = 1', startLine: 12, endLine: 14 },
    ])

    expect(prompt).toContain('--- /tmp/a.ts (lines 12-14) ---')
    expect(prompt).toContain('const a = 1')
  })
})
