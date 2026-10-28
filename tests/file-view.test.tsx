// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editorStoreFor, resetEditorStores } from '../src/store/editorStore'
import { useSettingsStore } from '../src/store/settingsStore'
import { translations } from '../src/i18n/translations'
import { api } from '../src/api'

vi.mock('../src/api', () => ({
  api: {
    writeFile: vi.fn(async () => ({ success: true })),
    readFile: vi.fn(async () => ({ success: true, binary: false, content: '' })),
    exists: vi.fn(async () => ({ success: true, exists: true })),
    stat: vi.fn(async () => ({ success: true, isDirectory: false, size: 10 })),
    draftSave: vi.fn(async () => ({ success: true })),
    draftDelete: vi.fn(async () => ({ success: true })),
    onFsChanged: vi.fn(() => () => {}),
    openPathExternally: vi.fn(async () => ({ success: true })),
  },
}))

// Monaco 在 jsdom 里无法真实渲染：这里只关心「何时挂载源码视图」
vi.mock('../src/components/MonacoEditor', () => ({
  MonacoEditor: () => <div data-testid="monaco-editor" />,
}))

const { FileView } = await import('../src/components/FileView')
const { MarkdownReadingView } = await import('../src/components/MarkdownReadingView')
const { HtmlPreview } = await import('../src/components/HtmlPreview')

const zh = translations.zh

const open = (overrides: Record<string, unknown>) => {
  act(() => {
    editorStoreFor('/ws').getState().addOpenFile({
      path: '/ws/doc.md',
      name: 'doc.md',
      content: '',
      isDirty: false,
      isSaving: false,
      ...overrides,
    })
  })
}

beforeEach(() => {
  resetEditorStores()
  vi.clearAllMocks()
  useSettingsStore.setState({ autoSave: true, autoSaveDelay: 2000 })
  // 源码视图通过 lazy 加载，需要等一次微任务
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('FileView view dispatch', () => {
  it('opens markdown in the reading view without mounting Monaco', async () => {
    render(<FileView workspacePath="/ws" />)
    open({ content: '# Title\n\nBody\n' })

    expect(await screen.findByTestId('markdown-reading-view')).toBeTruthy()
    expect(screen.queryByTestId('monaco-editor')).toBeNull()
    expect(screen.getByText('Title')).toBeTruthy()
  })

  it('toggles markdown between reading and source views', async () => {
    render(<FileView workspacePath="/ws" />)
    open({ content: '# Title\n' })

    fireEvent.click(await screen.findByRole('button', { name: zh.viewSource }))
    expect(await screen.findByTestId('monaco-editor')).toBeTruthy()
    expect(screen.queryByTestId('markdown-reading-view')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: zh.viewReading }))
    expect(await screen.findByTestId('markdown-reading-view')).toBeTruthy()
  })

  it('keeps plain text files in the source view', async () => {
    render(<FileView workspacePath="/ws" />)
    open({ path: '/ws/a.ts', name: 'a.ts', content: 'const a = 1' })

    expect(await screen.findByTestId('monaco-editor')).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh.viewSource })).toBeNull()
  })

  it('renders images through the read-only protocol and hides the toggle', async () => {
    render(<FileView workspacePath="/ws" />)
    open({ path: '/ws/pic.png', name: 'pic.png', content: '' })

    const image = (await screen.findByRole('img')) as HTMLImageElement
    expect(image.getAttribute('src')).toBe('pw-file://local/ws/pic.png')
    expect(screen.queryByTestId('monaco-editor')).toBeNull()
    expect(screen.queryByRole('button', { name: zh.viewSource })).toBeNull()
  })

  it('offers the system app for binary files', async () => {
    render(<FileView workspacePath="/ws" />)
    open({ path: '/ws/app.exe', name: 'app.exe', content: '', kind: 'binary', view: 'source' })

    expect(await screen.findByText(new RegExp(zh.previewUnavailableTitle))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.openExternally }))
    await waitFor(() => expect(api.openPathExternally).toHaveBeenCalledWith('/ws/app.exe'))
  })

  it('shows the empty state when no file is open', () => {
    render(<FileView workspacePath="/ws" />)
    expect(screen.getByText(zh.noFileOpen)).toBeTruthy()
  })
})

describe('MarkdownReadingView', () => {
  it('edits a single block and keeps the rest of the document byte-identical', async () => {
    const content = '# Title\n\nfirst paragraph\n\nsecond paragraph\n'
    render(<FileView workspacePath="/ws" />)
    open({ content })

    const paragraph = await screen.findByText('first paragraph')
    const block = paragraph.closest('[data-block-index]') as HTMLElement
    fireEvent.click(block.querySelector('button') as HTMLElement)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('first paragraph')

    fireEvent.change(textarea, { target: { value: 'edited paragraph' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))

    await waitFor(() => {
      const file = editorStoreFor('/ws').getState().currentFile
      expect(file?.content).toBe('# Title\n\nedited paragraph\n\nsecond paragraph\n')
      expect(file?.isDirty).toBe(true)
    })
  })

  it('cancels an edit without touching the document', async () => {
    const content = 'para\n'
    render(<FileView workspacePath="/ws" />)
    open({ content })

    const paragraph = await screen.findByText('para')
    fireEvent.click(
      (paragraph.closest('[data-block-index]') as HTMLElement).querySelector('button') as HTMLElement
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByRole('button', { name: zh.cancel }))

    expect(editorStoreFor('/ws').getState().currentFile?.content).toBe(content)
  })

  it('commits on Ctrl+Enter', async () => {
    render(<FileView workspacePath="/ws" />)
    open({ content: 'para\n' })

    const paragraph = await screen.findByText('para')
    fireEvent.click(
      (paragraph.closest('[data-block-index]') as HTMLElement).querySelector('button') as HTMLElement
    )
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'next' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })

    await waitFor(() =>
      expect(editorStoreFor('/ws').getState().currentFile?.content).toBe('next\n')
    )
  })

  it('shows frontmatter as a metadata block', async () => {
    const file = {
      path: '/ws/doc.md',
      name: 'doc.md',
      kind: 'markdown' as const,
      view: 'reading' as const,
      version: 0,
      content: '---\ntitle: Demo\n---\n\nbody\n',
      isDirty: false,
      isSaving: false,
    }
    render(<MarkdownReadingView root="/ws" file={file} />)
    expect(await screen.findByText(/title: Demo/)).toBeTruthy()
  })
})

describe('HtmlPreview', () => {
  const file = {
    path: '/ws/page.html',
    name: 'page.html',
    kind: 'html' as const,
    view: 'reading' as const,
    version: 0,
    content: '<h1>hi</h1>',
    isDirty: false,
    isSaving: false,
  }

  it('sandboxes scripts without granting same-origin access', () => {
    render(<HtmlPreview file={file} />)
    const frame = screen.getByTitle('page.html') as HTMLIFrameElement
    const sandbox = frame.getAttribute('sandbox') ?? ''

    expect(frame.getAttribute('src')).toBe('pw-file://local/ws/page.html')
    expect(sandbox).toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
    expect(sandbox).not.toContain('allow-top-navigation')
  })

  it('reloads the preview after the source changes', async () => {
    vi.useFakeTimers()
    const { rerender } = render(<HtmlPreview file={file} />)
    rerender(<HtmlPreview file={{ ...file, content: '<h1>changed</h1>' }} />)

    act(() => {
      vi.advanceTimersByTime(600)
    })

    const frame = screen.getByTitle('page.html') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('pw-file://local/ws/page.html?v=1')
  })
})
