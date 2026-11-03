// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '../src/types'

/**
 * `rehype-highlight` 每被调用一次就会 `createLowlight(common)`，现场注册整套语法
 * （单次约 20ms）。这里统计它被调用的次数：Markdown 每次重渲染都会走一遍插件，
 * 必须只构建一次变换、之后复用。
 */
const rehypeHighlight = vi.fn(() => () => {})
vi.mock('rehype-highlight', () => ({ default: rehypeHighlight }))

const { MarkdownBody } = await import('../src/components/AgentMarkdown')

afterEach(() => {
  rehypeHighlight.mockClear()
})

describe('MarkdownBody', () => {
  it('builds the highlight transform once and reuses it across renders', () => {
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

    // 4 次渲染（含一次重渲染）只应该注册一遍语法
    expect(rehypeHighlight).toHaveBeenCalledTimes(1)
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
    const { MarkdownReadingView } = await import('../src/components/MarkdownReadingView')
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
    const { MarkdownReadingView } = await import('../src/components/MarkdownReadingView')
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
