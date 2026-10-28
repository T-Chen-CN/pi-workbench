import { describe, expect, it } from 'vitest'
import { splitMarkdownBlockRanges } from '../src/utils/markdownBlocks'

const replace = (content: string, index: number, next: string) => {
  const blocks = splitMarkdownBlockRanges(content)
  const block = blocks[index]
  return content.slice(0, block.start) + next + content.slice(block.end)
}

describe('splitMarkdownBlockRanges', () => {
  it('returns no blocks for empty content', () => {
    expect(splitMarkdownBlockRanges('')).toEqual([])
  })

  it('covers every block with exact offsets', () => {
    const content = '# Title\n\nFirst paragraph.\n\n- a\n- b\n'
    const blocks = splitMarkdownBlockRanges(content)

    expect(blocks.map((block) => block.text.trim())).toEqual([
      '# Title',
      'First paragraph.',
      '- a\n- b',
    ])
    for (const block of blocks) {
      expect(content.slice(block.start, block.end)).toBe(block.text)
    }
  })

  it('leaves the trailing newline outside the last block', () => {
    const content = 'a\n\nb\n'
    const blocks = splitMarkdownBlockRanges(content)
    const last = blocks[blocks.length - 1]
    expect(last.text).toBe('b')
    expect(content.slice(last.end)).toBe('\n')
  })

  it('splits yaml frontmatter into its own block', () => {
    const content = '---\ntitle: Demo\n---\n\n# Heading\n'
    const blocks = splitMarkdownBlockRanges(content)

    expect(blocks[0]).toMatchObject({ frontmatter: true, start: 0 })
    expect(blocks[0].text).toBe('---\ntitle: Demo\n---\n')
    expect(blocks[1].text.trim()).toBe('# Heading')
    expect(content.slice(blocks[1].start, blocks[1].end)).toBe(blocks[1].text)
  })

  it('includes fenced code blocks as a single block', () => {
    const content = 'text\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n'
    const blocks = splitMarkdownBlockRanges(content)
    expect(blocks).toHaveLength(2)
    expect(blocks[1].text).toContain('const b = 2')
  })

  it('replaces only the edited block and preserves the rest byte for byte', () => {
    const content = '# Title\n\nkeep me\n\nlast\n'
    const next = replace(content, 1, 'edited paragraph')

    expect(next).toBe('# Title\n\nedited paragraph\n\nlast\n')
  })

  it('keeps surrounding blank lines when replacing a block', () => {
    const content = 'a\n\n\n\nb\n'
    const next = replace(content, 0, 'A')
    expect(next).toBe('A\n\n\n\nb\n')
  })

  it('falls back to a single block when parsing fails', () => {
    const content = 'text with `unclosed fence\n'
    const blocks = splitMarkdownBlockRanges(content)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks[0].start).toBe(0)
  })
})
