// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffViewer } from '../../src/components/editor/DiffViewer'
import { useChatAttachments } from '../../src/hooks/useChatAttachments'
import { diffStoreFor, resetDiffStores } from '../../src/store/diffStore'
import { editorStoreFor, resetEditorStores } from '../../src/store/editorStore'
import { useI18nStore } from '../../src/store/i18nStore'
import { useThemeStore } from '../../src/store/themeStore'
import { translations } from '../../src/i18n/translations'
import { resetSymbolParsersForTest } from '../../src/utils/symbols'

interface FakeModel {
  value: string
  language: string
  disposed: boolean
  isDisposed: () => boolean
  dispose: ReturnType<typeof vi.fn>
}

interface FakeDiffEditor {
  setModel: ReturnType<typeof vi.fn>
  updateOptions: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  currentModel: { original: FakeModel; modified: FakeModel } | null
}

const monacoMocks = vi.hoisted(() => ({
  createDiffEditor: vi.fn(),
  createModel: vi.fn(),
  defineTheme: vi.fn(),
  setTheme: vi.fn(),
  events: [] as string[],
}))

vi.mock('../../src/monacoEnvironment', () => ({}))

vi.mock('monaco-editor', () => ({
  editor: {
    createDiffEditor: (container: HTMLElement, options: unknown) =>
      monacoMocks.createDiffEditor(container, options),
    createModel: (value: string, language?: string) => monacoMocks.createModel(value, language),
    defineTheme: (name: string, data: unknown) => monacoMocks.defineTheme(name, data),
    setTheme: (name: string) => monacoMocks.setTheme(name),
  },
}))

vi.mock('../../src/hooks/useRevertEdits', () => ({
  useRevertEdits: () => ({
    busy: false,
    handleRevert: vi.fn(),
    handleRevertAll: vi.fn(),
  }),
}))

let modelSeq = 0

function makeFakeModel(value: string, language = 'plaintext'): FakeModel {
  const id = ++modelSeq
  const model: FakeModel = {
    value,
    language,
    disposed: false,
    isDisposed: () => model.disposed,
    dispose: vi.fn(() => {
      model.disposed = true
      monacoMocks.events.push(`disposeModel:${id}`)
    }),
  }
  return model
}

function makeFakeDiffEditor(): FakeDiffEditor {
  const instance: FakeDiffEditor = {
    currentModel: null,
    setModel: vi.fn((next: { original: FakeModel; modified: FakeModel } | null) => {
      instance.currentModel = next
      monacoMocks.events.push(next === null ? 'setModel:null' : 'setModel:pair')
    }),
    updateOptions: vi.fn(),
    dispose: vi.fn(() => {
      monacoMocks.events.push('disposeEditor')
    }),
  }
  return instance
}

beforeEach(() => {
  modelSeq = 0
  monacoMocks.events.length = 0
  monacoMocks.createDiffEditor.mockReset()
  monacoMocks.createModel.mockReset()
  monacoMocks.defineTheme.mockReset()
  monacoMocks.setTheme.mockReset()
  monacoMocks.createModel.mockImplementation((value: string, language?: string) =>
    makeFakeModel(value, language)
  )
  monacoMocks.createDiffEditor.mockImplementation(() => makeFakeDiffEditor())
  resetDiffStores()
  resetEditorStores()
  resetSymbolParsersForTest()
  useI18nStore.getState().setLanguage('zh')
  useThemeStore.getState().setMode('light')
})

afterEach(() => {
  cleanup()
})

describe('DiffViewer (Monaco DiffEditor)', () => {
  it('mounts Monaco createDiffEditor, switches split/unified, updates theme, and detaches models before disposal', async () => {
    diffStoreFor('/ws').getState().openEdits([
      { path: '/ws/src/app.ts', oldContent: 'const a = 1\n', newContent: 'const a = 2\n' },
      { path: '/ws/script.py', oldContent: 'def f():\n  pass\n', newContent: 'def f():\n  return 1\n' },
    ])

    const { unmount } = render(<DiffViewer workspacePath="/ws" />)

    await waitFor(() => expect(monacoMocks.createDiffEditor).toHaveBeenCalledTimes(1))
    const [, options] = monacoMocks.createDiffEditor.mock.calls[0]
    expect(options).toMatchObject({
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderIndicators: true,
      theme: 'pi-paper',
    })

    const editor = monacoMocks.createDiffEditor.mock.results[0].value as FakeDiffEditor
    await waitFor(() => expect(monacoMocks.createModel).toHaveBeenCalledTimes(2))
    expect(monacoMocks.createModel).toHaveBeenNthCalledWith(1, 'const a = 1\n', 'typescript')
    expect(monacoMocks.createModel).toHaveBeenNthCalledWith(2, 'const a = 2\n', 'typescript')
    expect(editor.setModel).toHaveBeenCalledWith({
      original: monacoMocks.createModel.mock.results[0].value,
      modified: monacoMocks.createModel.mock.results[1].value,
    })

    // 切换到内联视图与并排视图：同步 renderSideBySide
    fireEvent.click(screen.getByRole('button', { name: translations.zh.unifiedView }))
    await waitFor(() =>
      expect(editor.updateOptions).toHaveBeenCalledWith({ renderSideBySide: false })
    )
    fireEvent.click(screen.getByRole('button', { name: translations.zh.splitView }))
    await waitFor(() =>
      expect(editor.updateOptions).toHaveBeenCalledWith({ renderSideBySide: true })
    )

    // 切换主题：重定义并同步 pi-ink
    act(() => {
      useThemeStore.getState().setMode('dark')
    })
    await waitFor(() => expect(monacoMocks.setTheme).toHaveBeenCalledWith('pi-ink'))

    // 切换到下一个文件：必须先 setModel(null) 再 dispose 旧的 2 个 model，再创建新 model
    monacoMocks.events.length = 0
    fireEvent.click(screen.getByRole('button', { name: translations.zh.nextFile }))
    await waitFor(() => expect(monacoMocks.createModel).toHaveBeenCalledTimes(4))
    expect(monacoMocks.createModel).toHaveBeenNthCalledWith(3, 'def f():\n  pass\n', 'python')
    expect(monacoMocks.createModel).toHaveBeenNthCalledWith(4, 'def f():\n  return 1\n', 'python')
    expect(monacoMocks.events).toEqual([
      'setModel:null',
      'disposeModel:1',
      'disposeModel:2',
      'setModel:pair',
    ])

    // 卸载时同样先 setModel(null)，再 dispose model，最后 dispose editor
    monacoMocks.events.length = 0
    unmount()
    expect(monacoMocks.events).toEqual([
      'setModel:null',
      'disposeModel:3',
      'disposeModel:4',
      'disposeEditor',
    ])
  })

  it('renders a lightweight Paper & Ink fallback view when Monaco fails to initialize', async () => {
    monacoMocks.createDiffEditor.mockImplementation(() => {
      throw new Error('monaco unavailable')
    })
    diffStoreFor('/ws').getState().openEdits([
      { path: '/ws/a.ts', oldContent: 'oldLine\n', newContent: 'newLine\n' },
    ])

    render(<DiffViewer workspacePath="/ws" />)

    const fallback = await screen.findByTestId('diff-fallback-view')
    expect(fallback.textContent).toContain('oldLine')
    expect(fallback.textContent).toContain('newLine')
  })
})

describe('useChatAttachments (async web-tree-sitter symbols)', () => {
  function SymbolProbe({ symbolsActive }: { symbolsActive: boolean }) {
    const { currentSymbols } = useChatAttachments({
      workspacePath: '/ws',
      editorRoot: '/ws',
      activeKey: 'k1',
      imagesAllowed: false,
      symbolsActive,
      t: (key) => String(key),
      setShowAttachMenu: () => {},
      setAttachMode: () => {},
    })
    return (
      <div data-testid="symbols-json">
        {JSON.stringify(currentSymbols.map((s) => `${s.kind}:${s.name}:${s.startLine}-${s.endLine}`))}
      </div>
    )
  }

  it('upgrades open symbol picker to AST symbols that exclude commented/string fake declarations', async () => {
    editorStoreFor('/ws').getState().addOpenFile({
      path: '/ws/demo.ts',
      name: 'demo.ts',
      content: [
        '/*',
        'export function fakeCommented() {}',
        '*/',
        'const tpl = `export class FakeTemplate {}`',
        'export function realHandler() {',
        '  return 1',
        '}',
      ].join('\n'),
      isDirty: false,
      isSaving: false,
    })

    const { rerender } = render(<SymbolProbe symbolsActive={false} />)
    expect(screen.getByTestId('symbols-json').textContent).toBe('[]')

    rerender(<SymbolProbe symbolsActive={true} />)

    await waitFor(() => {
      expect(screen.getByTestId('symbols-json').textContent).toBe(
        JSON.stringify(['function:realHandler:5-7'])
      )
    })
  })
})
