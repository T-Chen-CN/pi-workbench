// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { resolveMarkdownLink } from '../src/workspace/linkTarget'

describe('resolveMarkdownLink', () => {
  it('treats http / https / mailto as external links', () => {
    expect(resolveMarkdownLink('https://example.com/a?b=1')).toEqual({
      kind: 'external',
      url: 'https://example.com/a?b=1'
    })
    expect(resolveMarkdownLink('mailto:someone@example.com')).toEqual({
      kind: 'external',
      url: 'mailto:someone@example.com'
    })
  })

  it('keeps in-document anchors as scroll targets', () => {
    expect(resolveMarkdownLink('#安装')).toEqual({ kind: 'anchor', hash: '安装' })
    expect(resolveMarkdownLink('#')).toBeNull()
    expect(resolveMarkdownLink('')).toBeNull()
    expect(resolveMarkdownLink(null)).toBeNull()
  })

  it('resolves relative paths against the document directory', () => {
    expect(resolveMarkdownLink('./guide/intro.md', { docDir: 'C:\\repo\\docs' })).toEqual({
      kind: 'file',
      path: 'C:\\repo\\docs\\guide\\intro.md',
      line: undefined
    })
  })

  it('carries #L12 line hints', () => {
    expect(resolveMarkdownLink('src/index.ts#L42', { workspaceDir: '/repo' })).toEqual({
      kind: 'file',
      path: '/repo/src/index.ts',
      line: 42
    })
  })

  it('keeps absolute paths and decodes percent escapes', () => {
    // 以 `/` 开头按仓库根解析，而不是文档目录
    expect(resolveMarkdownLink('/docs/a%20b.md', { docDir: '/repo/docs', workspaceDir: '/repo' })).toEqual({
      kind: 'file',
      path: '/repo/docs/a b.md',
      line: undefined
    })
    expect(resolveMarkdownLink('C:/repo/x.md')).toEqual({
      kind: 'file',
      path: 'C:/repo/x.md',
      line: undefined
    })
  })

  it('falls back to the workspace root when no document is known', () => {
    expect(resolveMarkdownLink('docs/a.md', { workspaceDir: '/repo' })).toEqual({
      kind: 'file',
      path: '/repo/docs/a.md',
      line: undefined
    })
  })

  it('rejects paths that would escape the repository root', () => {
    // 上跳路径仍交给编辑器入口的信任校验，这里只保证不被当成外链
    const target = resolveMarkdownLink('../../etc/passwd', { workspaceDir: '/repo' })
    expect(target?.kind).toBe('file')
  })
})
