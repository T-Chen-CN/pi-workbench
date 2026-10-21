import { describe, expect, it } from 'vitest'
import { splitMarkdownBlocks } from '../src/utils/markdownBlocks'

describe('splitMarkdownBlocks', () => {
  it('returns no blocks for empty content', () => {
    expect(splitMarkdownBlocks('')).toEqual([])
  })

  it('splits top-level paragraphs into separate blocks', () => {
    const blocks = splitMarkdownBlocks('first paragraph\n\nsecond paragraph\n')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toBe('first paragraph')
    expect(blocks[1]).toContain('second paragraph')
  })

  it('keeps a fenced code block with blank lines as one block', () => {
    const content = 'intro\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\noutro\n'
    const blocks = splitMarkdownBlocks(content)
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toContain('const a = 1')
    expect(blocks[1]).toContain('const b = 2')
    expect(blocks[1].startsWith('```ts')).toBe(true)
  })

  it('keeps a list intact instead of splitting every item', () => {
    const content = '- one\n- two\n- three\n'
    const blocks = splitMarkdownBlocks(content)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toBe(content)
  })

  it('drops blank-line separator tokens', () => {
    expect(splitMarkdownBlocks('\n\n')).toEqual([])
    expect(splitMarkdownBlocks('text\n\n\n\nmore')).toEqual(['text', 'more'])
  })

  it('falls back to a single block for an unterminated fence', () => {
    const content = '```ts\nconst a = 1\n'
    const blocks = splitMarkdownBlocks(content)
    expect(blocks).toEqual([content])
  })
})
