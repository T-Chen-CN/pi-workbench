import { describe, expect, it } from 'vitest'
import {
  attachmentsToContextEntries,
  attachmentsToMessageContext,
  contextToAttachments,
  hasMessageContext,
} from '../src/workspace/chatAttachments'
import { buildContextPrompt } from '../src/api/chatContext'
import type { ChatAttachment } from '../src/store/chatStore'

const quote: ChatAttachment = {
  id: 'quote:1',
  kind: 'snippet',
  path: '',
  name: '对话引用',
  label: '对话引用',
  content: '被引用的原文',
}

const docQuote: ChatAttachment = {
  id: 'quote:2',
  kind: 'snippet',
  path: '/w/README.md',
  name: 'README.md',
  startLine: 3,
  endLine: 4,
  content: '文档原文',
}

const file: ChatAttachment = {
  id: 'file:1',
  kind: 'file',
  path: '/w/a.pdf',
  name: 'a.pdf',
  size: 2048,
  external: true,
}

describe('attachmentsToContextEntries', () => {
  it('keeps quotes inline and files path-only', () => {
    const entries = attachmentsToContextEntries([quote, docQuote, file])
    expect(entries).toEqual([
      { kind: 'quote', content: '被引用的原文', label: '对话引用' },
      {
        kind: 'quote',
        content: '文档原文',
        path: '/w/README.md',
        label: 'README.md',
        startLine: 3,
        endLine: 4,
      },
      {
        kind: 'file',
        path: '/w/a.pdf',
        name: 'a.pdf',
        size: 2048,
        mime: undefined,
        mtime: undefined,
        external: true,
      },
    ])
  })

  it('skips images and empty snippets', () => {
    const entries = attachmentsToContextEntries([
      { id: 'image:1', kind: 'image', path: '', name: 'x.png', data: 'AA', mimeType: 'image/png' },
      { id: 'quote:3', kind: 'snippet', path: '', name: 'empty', content: '' },
    ])
    expect(entries).toEqual([])
  })

  it('puts the quoted body into the prompt (steer path regression)', () => {
    const prompt = buildContextPrompt('解释一下', attachmentsToContextEntries([quote]))
    expect(prompt).toContain('被引用的原文')
    // 引用没有路径，不能被写成一条空路径文件
    expect(prompt).not.toContain('- ``')
  })
})

describe('contextToAttachments', () => {
  it('restores snippets and files for edit / retry resend', () => {
    const restored = contextToAttachments({
      quotes: [
        { content: '被引用的原文', label: '对话引用' },
        { content: '文档原文', path: '/w/README.md', label: 'README.md', startLine: 3, endLine: 4 },
      ],
      files: [{ path: '/w/a.pdf', size: 2048, external: true }],
    })

    expect(restored.map((item) => item.kind)).toEqual(['snippet', 'snippet', 'file'])
    expect(restored[0]).toMatchObject({ path: '', name: '对话引用', content: '被引用的原文' })
    expect(restored[1]).toMatchObject({ path: '/w/README.md', startLine: 3, endLine: 4 })
    expect(restored[2]).toMatchObject({ path: '/w/a.pdf', name: 'a.pdf', size: 2048, external: true })
    // 每次还原都换新 id，避免与输入框里同内容的 chip 去重
    expect(new Set(restored.map((item) => item.id)).size).toBe(3)
  })

  it('round-trips through the prompt without loss', () => {
    const context = attachmentsToMessageContext([quote, docQuote, file])
    expect(context).toBeDefined()
    const restored = contextToAttachments(context!)
    const prompt = buildContextPrompt('再看一遍', attachmentsToContextEntries(restored))
    expect(prompt).toContain('被引用的原文')
    expect(prompt).toContain('文档原文')
    expect(prompt).toContain('`/w/a.pdf`')
  })
})

describe('attachmentsToMessageContext', () => {
  it('returns undefined when only images are attached', () => {
    expect(
      attachmentsToMessageContext([
        { id: 'image:1', kind: 'image', path: '', name: 'x.png', data: 'AA', mimeType: 'image/png' },
      ])
    ).toBeUndefined()
    expect(hasMessageContext([quote])).toBe(true)
    expect(
      hasMessageContext([
        { id: 'image:1', kind: 'image', path: '', name: 'x.png', data: 'AA', mimeType: 'image/png' },
      ])
    ).toBe(false)
  })

  it('appends the quoted current document as a file entry', () => {
    const context = attachmentsToMessageContext([quote], [{ path: '/w/a.md', name: 'a.md' }])
    expect(context?.files).toEqual([{ path: '/w/a.md', name: 'a.md' }])
    expect(context?.quotes).toHaveLength(1)
  })
})
