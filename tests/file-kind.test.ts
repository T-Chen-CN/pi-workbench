import { describe, expect, it, vi } from 'vitest'
import {
  detectFileKind,
  defaultViewFor,
  filePreviewUrl,
  hasReadingView,
  isEditableKind,
  isStreamedKind,
  supportsSourceView,
} from '../src/utils/fileKind'

describe('detectFileKind', () => {
  it('maps reading-view types by extension, case-insensitively', () => {
    expect(detectFileKind('README.md')).toBe('markdown')
    expect(detectFileKind('/ws/docs/guide.MARKDOWN')).toBe('markdown')
    expect(detectFileKind('index.html')).toBe('html')
    expect(detectFileKind('E:\\ws\\index.HTM')).toBe('html')
    expect(detectFileKind('logo.PNG')).toBe('image')
    expect(detectFileKind('/ws/clip.webm')).toBe('video')
    expect(detectFileKind('/ws/track.flac')).toBe('audio')
    expect(detectFileKind('/ws/spec.pdf')).toBe('pdf')
  })

  it('treats unknown or extensionless files as text candidates', () => {
    expect(detectFileKind('/ws/main.ts')).toBe('text')
    expect(detectFileKind('/ws/Makefile')).toBe('text')
    expect(detectFileKind('/ws/.gitignore')).toBe('text')
    expect(detectFileKind('/ws/archive.tar.gz')).toBe('text')
  })
})

describe('view preferences', () => {
  it('opens markdown and html in the reading view', () => {
    expect(defaultViewFor('markdown')).toBe('reading')
    expect(defaultViewFor('html')).toBe('reading')
    expect(defaultViewFor('text')).toBe('source')
    expect(defaultViewFor('image')).toBe('source')
  })

  it('only offers a source toggle for text-like kinds', () => {
    expect(supportsSourceView('text')).toBe(true)
    expect(supportsSourceView('markdown')).toBe(true)
    expect(supportsSourceView('html')).toBe(true)
    expect(supportsSourceView('image')).toBe(false)
    expect(supportsSourceView('video')).toBe(false)
    expect(supportsSourceView('audio')).toBe(false)
    expect(supportsSourceView('pdf')).toBe(false)
    expect(supportsSourceView('binary')).toBe(false)
  })

  it('only renders a reading view for markdown and html', () => {
    expect(hasReadingView('markdown')).toBe(true)
    expect(hasReadingView('html')).toBe(true)
    expect(hasReadingView('text')).toBe(false)
    expect(hasReadingView('pdf')).toBe(false)
  })

  it('streams media through the protocol instead of reading text', () => {
    expect(isStreamedKind('image')).toBe(true)
    expect(isStreamedKind('video')).toBe(true)
    expect(isStreamedKind('audio')).toBe(true)
    expect(isStreamedKind('pdf')).toBe(true)
    expect(isStreamedKind('markdown')).toBe(false)
    // 二进制无法经协议渲染，需要占位视图
    expect(isStreamedKind('binary')).toBe(false)
  })

  it('keeps media and binaries read-only', () => {
    expect(isEditableKind('text')).toBe(true)
    expect(isEditableKind('markdown')).toBe(true)
    expect(isEditableKind('html')).toBe(true)
    expect(isEditableKind('image')).toBe(false)
    expect(isEditableKind('binary')).toBe(false)
  })
})

describe('filePreviewUrl', () => {
  it('encodes each path segment and keeps the directory structure', () => {
    expect(filePreviewUrl('/ws/my docs/a b.png')).toBe(
      'pw-file://local/ws/my%20docs/a%20b.png'
    )
  })

  it('normalizes Windows separators and keeps the drive letter', () => {
    expect(filePreviewUrl('E:\\ws\\a.png')).toBe('pw-file://local/E%3A/ws/a.png')
  })

  it('adds a cache-busting version only when needed', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0)
    expect(filePreviewUrl('/ws/a.png')).toBe('pw-file://local/ws/a.png')
    expect(filePreviewUrl('/ws/a.png', 3)).toBe('pw-file://local/ws/a.png?v=3')
    vi.restoreAllMocks()
  })

  it('round-trips with the main-process decoder', () => {
    const url = filePreviewUrl('E:\\ws\\图片.png', 1)
    expect(new URL(url).searchParams.get('v')).toBe('1')
    expect(decodeURIComponent(new URL(url).pathname)).toBe('/E:/ws/图片.png')
  })
})
