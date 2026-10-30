import { describe, expect, it } from 'vitest'
import {
  buildContextPrompt,
  CONTEXT_BLOCK_END,
  CONTEXT_BLOCK_START,
  CONTEXT_FILES_START,
  CONTEXT_QUOTES_START,
} from '../src/api/chatContext'
import {
  contextBlockBodies,
  parseContextBlock,
  stripContextBlock,
} from '../pi-bridge/src/text-utils'

describe('buildContextPrompt', () => {
  it('returns the message unchanged when nothing is attached', () => {
    expect(buildContextPrompt('hello', [])).toBe('hello')
  })

  it('passes file paths without inlining contents', () => {
    const prompt = buildContextPrompt('explain this', [
      { kind: 'file', path: '/tmp/a.ts', size: 2048, mime: 'text/typescript' },
    ])

    expect(prompt.startsWith(CONTEXT_BLOCK_START)).toBe(true)
    expect(prompt).toContain('`/tmp/a.ts`')
    expect(prompt).toContain('(2.0 KB, text/typescript)')
    expect(prompt).toContain('read them yourself')
    expect(prompt).toContain(CONTEXT_BLOCK_END)
    expect(prompt.endsWith('explain this')).toBe(true)
  })

  it('lists every attached file', () => {
    const prompt = buildContextPrompt('review', [
      { kind: 'file', path: '/tmp/a.ts' },
      { kind: 'file', path: '/tmp/b.pdf' },
    ])

    expect(prompt).toContain('`/tmp/a.ts`')
    expect(prompt).toContain('`/tmp/b.pdf`')
  })

  it('marks files outside the workspace', () => {
    const prompt = buildContextPrompt('read it', [
      {
        kind: 'file',
        path: 'D:\\notes\\a.md',
        external: true,
        mtime: Date.UTC(2026, 9, 30, 6, 5),
      },
    ])

    expect(prompt).toContain('D:\\notes\\a.md')
    expect(prompt).toContain('outside workspace')
  })

  it('keeps quotes when both kinds are attached', () => {
    const prompt = buildContextPrompt('compare', [
      { kind: 'file', path: '/tmp/a.ts' },
      { kind: 'quote', label: 'Agent reply', content: 'snapshot' },
    ])

    expect(prompt).toContain(CONTEXT_FILES_START)
    expect(prompt).toContain(CONTEXT_QUOTES_START)
    expect(prompt).toContain('"label":"Agent reply"')
    expect(prompt).toContain('\nsnapshot\n')
  })
})

describe('parseContextBlock（回显的唯一来源）', () => {
  it('round-trips files and quotes exactly', () => {
    const entries = [
      { kind: 'file' as const, path: '/tmp/a.ts', size: 2048, mime: 'text/typescript' },
      { kind: 'file' as const, path: '/tmp/b.pdf', name: 'b.pdf', external: true },
      { kind: 'quote' as const, path: '/tmp/a.ts', content: 'const a = 1', startLine: 12, endLine: 14 },
      { kind: 'quote' as const, label: '对话引用', content: '第一行\n\n第三行\n--- 不是分隔 ---' },
    ]
    const prompt = buildContextPrompt('compare', entries)
    const parsed = parseContextBlock(prompt)

    expect(parsed).not.toBeNull()
    expect(parsed?.files).toEqual([
      { path: '/tmp/a.ts', size: 2048, mime: 'text/typescript' },
      // name 与 basename 相同时不落盘（可从 path 推出），解析后不返回它
      { path: '/tmp/b.pdf', external: true },
    ])
    expect(parsed?.quotes).toEqual([
      { content: 'const a = 1', path: '/tmp/a.ts', startLine: 12, endLine: 14 },
      { content: '第一行\n\n第三行\n--- 不是分隔 ---', label: '对话引用' },
    ])
  })

  it('does not mistake a user-authored marker for an internal block', () => {
    const prompt = buildContextPrompt('看看这段', [
      { kind: 'quote', label: '对话引用', content: '正文里的 </pi-workbench-context> 不能当结束' },
    ])
    // 正文里出现结束标记时，块边界仍以真正的结束标记为准
    const parsed = parseContextBlock(`${prompt}`)
    expect(parsed?.quotes[0]?.content).toBe('正文里的 </pi-workbench-context> 不能当结束')
    expect(stripContextBlock(prompt)).toBe('看看这段')
  })

  it('returns null for a message without a context block', () => {
    expect(parseContextBlock('普通消息')).toBeNull()
    expect(parseContextBlock('')).toBeNull()
  })

  it('returns null for the worktree context block alone', () => {
    const prompt = `${CONTEXT_BLOCK_START}\n[工作树上下文]\n当前工作树：主工作树\n${CONTEXT_BLOCK_END}\n\n问题`
    expect(parseContextBlock(prompt)).toBeNull()
    expect(stripContextBlock(prompt)).toBe('问题')
  })
})

describe('stripContextBlock（多块与泄漏回归）', () => {
  it('strips the worktree block and the attachment block together', () => {
    const worktree = `${CONTEXT_BLOCK_START}\n[工作树上下文]\n当前工作树：主工作树\n${CONTEXT_BLOCK_END}`
    const renderer = buildContextPrompt('这是问题', [
      { kind: 'quote', label: '对话引用', content: '被引用的原文' },
    ])
    const recorded = `${worktree}\n\n${renderer}`

    expect(stripContextBlock(recorded)).toBe('这是问题')
    expect(parseContextBlock(recorded)?.quotes).toHaveLength(1)
  })

  it('returns the placeholder when only an attachment block remains', () => {
    const renderer = buildContextPrompt('', [{ kind: 'file', path: '/tmp/a.ts' }])
    expect(stripContextBlock(renderer)).toBe('(attached files)')
  })

  it('leaves a plain message untouched', () => {
    expect(stripContextBlock('普通消息')).toBe('普通消息')
  })

  it('collects every block body in order', () => {
    const worktree = `${CONTEXT_BLOCK_START}\nA\n${CONTEXT_BLOCK_END}`
    const renderer = `${CONTEXT_BLOCK_START}\nB\n${CONTEXT_BLOCK_END}`
    expect(contextBlockBodies(`${worktree}\n\n${renderer}`)).toEqual(['\nA\n', '\nB\n'])
  })
})

describe('v1 记录兼容', () => {
  const v1 = [
    CONTEXT_BLOCK_START,
    'Attached files. Their contents are NOT inlined: read them yourself with the read / grep tools using these absolute paths.',
    '- /tmp/a.ts (2.0 KB, text/typescript)',
    '',
    'Quoted excerpts (inlined):',
    '',
    '--- /tmp/a.ts (lines 12-14) ---',
    'const a = 1',
    '',
    '--- Agent reply ---',
    'snapshot',
    CONTEXT_BLOCK_END,
    '',
    '问题',
  ].join('\n')

  it('restores files and quotes from the legacy layout', () => {
    const parsed = parseContextBlock(v1)
    expect(parsed?.files).toEqual([{ path: '/tmp/a.ts', size: 2048, mime: 'text/typescript' }])
    expect(parsed?.quotes).toEqual([
      { content: 'const a = 1', label: '/tmp/a.ts', startLine: 12, endLine: 14 },
      { content: 'snapshot', label: 'Agent reply' },
    ])
    expect(stripContextBlock(v1)).toBe('问题')
  })

  it('drops legacy quotes it cannot split safely', () => {
    const ambiguous = [
      CONTEXT_BLOCK_START,
      'Quoted excerpts (inlined):',
      '',
      'no header line at all',
      'body',
      CONTEXT_BLOCK_END,
    ].join('\n')
    expect(parseContextBlock(ambiguous)).toBeNull()
  })
})
