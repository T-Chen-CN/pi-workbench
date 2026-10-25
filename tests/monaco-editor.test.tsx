// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MonacoEditor } from '../src/components/MonacoEditor'
import { editorStoreFor, resetEditorStores } from '../src/store/editorStore'
import { useSelectionStore } from '../src/store/selectionStore'
import { useWorkspaceStore } from '../src/store/workspaceStore'
import { api } from '../src/api'

interface FakeModel {
  uri?: { path?: string }
  getValue: () => string
  setValue: (next: string) => void
  getValueInRange: () => string
  dispose: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  setModelLanguage: vi.fn(),
  setTheme: vi.fn(),
  defineTheme: vi.fn(),
  createModel: vi.fn(),
  getModel: vi.fn(),
}))

vi.mock('monaco-editor', () => ({
  Uri: {
    file: (filePath: string) => ({ path: filePath, toString: () => `file://${filePath}` }),
  },
  editor: {
    create: (element: HTMLElement, options: unknown) => mocks.create(element, options),
    setModelLanguage: mocks.setModelLanguage,
    setTheme: mocks.setTheme,
    defineTheme: mocks.defineTheme,
    createModel: mocks.createModel,
    getModel: mocks.getModel,
  },
}))

function createFakeModel(initialValue: string, uri?: { path?: string }): FakeModel {
  let value = initialValue
  return {
    uri,
    getValue: () => value,
    setValue: (next: string) => {
      value = next
    },
    getValueInRange: () => value,
    dispose: vi.fn(),
  }
}

function createFakeEditor(initialModel: FakeModel) {
  let model = initialModel
  let listener: (() => void) | null = null
  let selectionListener: (() => void) | null = null

  return {
    getModel: () => model,
    setModel: vi.fn((next: FakeModel) => {
      model = next
    }),
    getValue: () => model.getValue(),
    setValue: vi.fn((next: string) => model.setValue(next)),
    getSelection: vi.fn(() => ({
      startLineNumber: 2,
      endLineNumber: 3,
      startColumn: 1,
      endColumn: 4,
    })),
    saveViewState: vi.fn(() => ({ scrollTop: 0 })),
    restoreViewState: vi.fn(),
    onDidChangeModelContent: vi.fn((callback: () => void) => {
      listener = callback
      return { dispose: vi.fn() }
    }),
    onDidChangeCursorSelection: vi.fn((callback: () => void) => {
      selectionListener = callback
      return { dispose: vi.fn() }
    }),
    layout: vi.fn(),
    updateOptions: vi.fn(),
    dispose: vi.fn(),
    emitChange(next?: string) {
      if (next !== undefined) model.setValue(next)
      listener?.()
    },
    emitSelection() {
      selectionListener?.()
    },
  }
}

function makeFile(path: string, content: string) {
  return {
    path,
    name: path.split('/').pop() ?? path,
    content,
    isDirty: false,
    isSaving: false,
  }
}

beforeEach(() => {
  resetEditorStores()
  useSelectionStore.getState().clearSelection()
  mocks.create.mockReset()
  mocks.createModel.mockReset()
  mocks.getModel.mockReset()
  mocks.getModel.mockReturnValue(null)
  mocks.createModel.mockImplementation(
    (value: string, _language: string, uri?: { path?: string }) => createFakeModel(value, uri)
  )
  mocks.create.mockImplementation((_element: HTMLElement, options: { model?: FakeModel }) =>
    createFakeEditor(options?.model ?? createFakeModel(''))
  )
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('MonacoEditor', () => {
  it('creates the editor once a file is opened', () => {
    render(<MonacoEditor workspacePath="/ws" />)

    expect(mocks.create).not.toHaveBeenCalled()

    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(makeFile('/tmp/a.ts', 'const a = 1'))
    })

    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(editorStoreFor('/ws').getState().currentFile?.path).toBe('/tmp/a.ts')
  })

  it('publishes the current editor selection for snippet attachments', () => {
    render(<MonacoEditor workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(makeFile('/tmp/a.ts', 'a\nb\nc'))
    })

    const editor = mocks.create.mock.results[0].value
    act(() => editor.emitSelection())

    expect(useSelectionStore.getState().selection).toMatchObject({
      path: '/tmp/a.ts',
      name: 'a.ts',
      startLine: 2,
      endLine: 3,
      text: 'a\nb\nc',
    })
  })

  it('enters large-file mode for files above 2MB', async () => {
    render(<MonacoEditor workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(
        makeFile('/tmp/big.ts', 'x'.repeat(2 * 1024 * 1024 + 1))
      )
    })

    const editor = mocks.create.mock.results[0].value
    expect(await screen.findByText(/大文件模式/)).toBeTruthy()
    expect(editor.updateOptions).toHaveBeenCalledWith(
      expect.objectContaining({ wordWrap: 'off', folding: false })
    )
  })

  it('disposes the editor when the last file is closed', () => {    render(<MonacoEditor workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(makeFile('/tmp/a.ts', 'a'))
    })
    const editor = mocks.create.mock.results[0].value

    act(() => {
      editorStoreFor('/ws').getState().removeOpenFile('/tmp/a.ts')
    })

    expect(editor.dispose).toHaveBeenCalled()
  })

  it('keeps a separate model per file when switching tabs', () => {
    render(<MonacoEditor workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(makeFile('/tmp/a.ts', 'a'))
    })
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(makeFile('/tmp/b.ts', 'b'))
    })

    const editor = mocks.create.mock.results[0].value
    expect(mocks.createModel).toHaveBeenCalledTimes(2)
    expect(editor.setModel).toHaveBeenCalled()
    expect(mocks.setModelLanguage).toHaveBeenLastCalledWith(
      expect.objectContaining({ uri: expect.objectContaining({ path: '/tmp/b.ts' }) }),
      'typescript'
    )
  })

  it('auto-saves two seconds after the last edit', async () => {
    vi.useFakeTimers()
    const writeSpy = vi.spyOn(api, 'writeFile').mockResolvedValue({ success: true })

    render(<MonacoEditor workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(makeFile('/tmp/a.ts', 'a'))
    })
    const editor = mocks.create.mock.results[0].value

    act(() => {
      editor.emitChange('changed')
    })
    expect(editorStoreFor('/ws').getState().currentFile?.isDirty).toBe(true)

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(writeSpy).toHaveBeenCalledWith('/tmp/a.ts', 'changed')
  })

  it('keeps a pending auto-save when switching files', async () => {
    vi.useFakeTimers()
    const writeSpy = vi.spyOn(api, 'writeFile').mockResolvedValue({ success: true })

    render(<MonacoEditor workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(makeFile('/tmp/a.ts', 'a'))
    })
    const editor = mocks.create.mock.results[0].value

    act(() => {
      editor.emitChange('changed')
    })
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(makeFile('/tmp/b.ts', 'b'))
    })

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(writeSpy).toHaveBeenCalledWith('/tmp/a.ts', 'changed')
  })

  it('keeps auto-save timers independent for each file', async () => {
    vi.useFakeTimers()
    const writeSpy = vi.spyOn(api, 'writeFile').mockResolvedValue({ success: true })

    render(<MonacoEditor workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(makeFile('/tmp/a.ts', 'a'))
    })
    const editor = mocks.create.mock.results[0].value
    act(() => {
      editor.emitChange('a-changed')
    })
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(makeFile('/tmp/b.ts', 'b'))
    })
    act(() => {
      editor.emitChange('b-changed')
    })

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(writeSpy).toHaveBeenCalledWith('/tmp/a.ts', 'a-changed')
    expect(writeSpy).toHaveBeenCalledWith('/tmp/b.ts', 'b-changed')
  })

  it('keeps the file dirty when it changes while a save is in flight', async () => {
    vi.useFakeTimers()
    useWorkspaceStore.setState({ workspacePath: '/ws' })

    let resolveWrite: (value: { success: boolean }) => void = () => {}
    vi.spyOn(api, 'writeFile').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve
        })
    )
    const draftSpy = vi.spyOn(api, 'draftSave').mockResolvedValue({ success: true })

    render(<MonacoEditor workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(makeFile('/tmp/a.ts', 'a'))
    })
    const editor = mocks.create.mock.results[0].value

    act(() => {
      editor.emitChange('first')
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    // 保存请求还在飞行时用户继续输入
    act(() => {
      editor.emitChange('second')
    })
    await act(async () => {
      resolveWrite({ success: true })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(editorStoreFor('/ws').getState().currentFile?.isDirty).toBe(true)
    expect(draftSpy).toHaveBeenCalledWith('/ws', '/tmp/a.ts', 'second')

    useWorkspaceStore.setState({ workspacePath: null })
  })
})
