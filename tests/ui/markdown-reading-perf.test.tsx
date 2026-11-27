// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '../../src/types'

/**
 * 零 WASM Shiki JS 高亮器必须是全局单例：多次渲染和切换代码块不能重复初始化引擎，
 * 否则每次重渲染都要交一次冷启动开销。
 */
const { MarkdownBody } = await import('../../src/components/chat/AgentMarkdown')
const { getShikiInitCount, piShikiCodePlugin } = await import('../../src/utils/shikiHighlighter')

afterEach(() => {
  vi.clearAllMocks()
})

describe('MarkdownBody', () => {
  it('initializes the Shiki JS highlighter singleton once across renders', async () => {
    const view = render(
      <>
        <MarkdownBody content={'```js\nconst a = 1\n```'} highlight />
        <MarkdownBody content={'```ts\nconst b = 2\n```'} highlight />
      </>
    )
    view.rerender(
      <>
        <MarkdownBody content={'```py\nx = 1\n```'} highlight />
        <MarkdownBody content={'```json\n{"a": 1}\n```'} highlight />
      </>
    )

    // 多次渲染与多次高亮触发最多初始化一次 Shiki JS 单例
    piShikiCodePlugin.highlight({ code: 'const x = 1', language: 'ts', themes: piShikiCodePlugin.getThemes() }, () => {})
    piShikiCodePlugin.highlight({ code: 'x = 2', language: 'py', themes: piShikiCodePlugin.getThemes() }, () => {})
    expect(getShikiInitCount()).toBeLessThanOrEqual(1)
  })

  it('still renders markdown content', () => {
    const view = render(<MarkdownBody content={'# 标题\n\n正文'} highlight={false} />)
    expect(view.container.textContent).toContain('标题')
    expect(view.container.textContent).toContain('正文')
  })
})

const markdownFile = (overrides: Partial<OpenFile> = {}): OpenFile => ({
  path: '/ws/doc.md',
  name: 'doc.md',
  kind: 'markdown',
  view: 'reading',
  version: 0,
  content: 'alpha\n\nbeta\n',
  isDirty: false,
  isSaving: false,
  ...overrides,
})

describe('MarkdownReadingView 身份与冻结', () => {
  it('keeps block DOM identity when text shifts the following blocks', async () => {
    const { MarkdownReadingView } = await import('../../src/components/editor/MarkdownReadingView')
    const file = markdownFile({ content: 'alpha\n\nbeta\n\ngamma\n' })
    const view = render(<MarkdownReadingView root="/ws" file={file} />)

    const before = Array.from(view.container.querySelectorAll('[data-block-index]'))
    expect(before.length).toBe(3)

    // 在第一个块前面插一个字：所有块的字符偏移都变了，旧实现按下标外的偏移做 key，
    // 会把整篇块卸载重挂（每块重新 parse + 重新注册高亮语法）
    act(() => {
      view.rerender(<MarkdownReadingView root="/ws" file={{ ...file, content: 'zalpha\n\nbeta\n\ngamma\n' }} />)
    })

    const after = Array.from(view.container.querySelectorAll('[data-block-index]'))
    expect(after.length).toBe(3)
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(before[2])
  })

  it('freezes the rendered output while the view is inactive, then catches up', async () => {
    const { MarkdownReadingView } = await import('../../src/components/editor/MarkdownReadingView')
    const file = markdownFile({ content: 'alpha\n' })
    const view = render(<MarkdownReadingView root="/ws" file={file} active={false} />)
    expect(view.container.textContent).toContain('alpha')

    // 源码视图在打字：隐藏着的阅读视图不该跟着重排（否则每个按键都要解析整篇）
    act(() => {
      view.rerender(
        <MarkdownReadingView root="/ws" file={{ ...file, content: 'beta\n' }} active={false} />
      )
    })
    expect(view.container.textContent).toContain('alpha')
    expect(view.container.textContent).not.toContain('beta')

    // 切回阅读视图：按最新内容排版
    act(() => {
      view.rerender(<MarkdownReadingView root="/ws" file={{ ...file, content: 'beta\n' }} active />)
    })
    expect(view.container.textContent).toContain('beta')
  })
})
