// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MonacoEditor } from '../src/components/MonacoEditor'
import { useEditorStore } from '../src/store/editorStore'
import { api } from '../src/api'

interface FakeModel {
  uri?: { path?: string }
  getValue: () => string
  setValue: (next: string) => void
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
    dispose: vi.fn(),
  }
}

function createFakeEditor(initialModel: FakeModel) {
  let model = initialModel
  let listener: (() => void) | null = null

  return {
    getModel: () => model,
    setModel: vi.fn((next: FakeModel) => {
      model = next
    }),
    getValue: () => model.getValue(),
    setValue: vi.fn((next: string) => model.setValue(next)),
    saveViewState: vi.fn(() => ({ scrollTop: 0 })),
    restoreViewState: vi.fn(),
    onDidChangeModelContent: vi.fn((callback: () => void) => {
      listener = callback
      return { dispose: vi.fn() }
    }),
    layout: vi.fn(),
    dispose: vi.fn(),
    emitChange(next?: string) {
      if (next !== undefined) model.setValue(next)
      listener?.()
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
  useEditorStore.getState().reset()
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
    render(<MonacoEditor />)

    expect(mocks.create).not.toHaveBeenCalled()

    act(() => {
      useEditorStore.getState().addOpenFile(makeFile('/tmp/a.ts', 'const a = 1'))
    })

    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(useEditorStore.getState().currentFile?.path).toBe('/tmp/a.ts')
  })

  it('disposes the editor when the last file is closed', () => {
    render(<MonacoEditor />)
    act(() => {
      useEditorStore.getState().addOpenFile(makeFile('/tmp/a.ts', 'a'))
    })
    const editor = mocks.create.mock.results[0].value

    act(() => {
      useEditorStore.getState().removeOpenFile('/tmp/a.ts')
    })

    expect(editor.dispose).toHaveBeenCalled()
  })

  it('keeps a separate model per file when switching tabs', () => {
    render(<MonacoEditor />)
    act(() => {
      useEditorStore.getState().addOpenFile(makeFile('/tmp/a.ts', 'a'))
    })
    act(() => {
      useEditorStore.getState().addOpenFile(makeFile('/tmp/b.ts', 'b'))
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

    render(<MonacoEditor />)
    act(() => {
      useEditorStore.getState().addOpenFile(makeFile('/tmp/a.ts', 'a'))
    })
    const editor = mocks.create.mock.results[0].value

    act(() => {
      editor.emitChange('changed')
    })
    expect(useEditorStore.getState().currentFile?.isDirty).toBe(true)

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(writeSpy).toHaveBeenCalledWith('/tmp/a.ts', 'changed')
  })

  it('keeps a pending auto-save when switching files', async () => {
    vi.useFakeTimers()
    const writeSpy = vi.spyOn(api, 'writeFile').mockResolvedValue({ success: true })

    render(<MonacoEditor />)
    act(() => {
      useEditorStore.getState().addOpenFile(makeFile('/tmp/a.ts', 'a'))
    })
    const editor = mocks.create.mock.results[0].value

    act(() => {
      editor.emitChange('changed')
    })
    act(() => {
      useEditorStore.getState().addOpenFile(makeFile('/tmp/b.ts', 'b'))
    })

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(writeSpy).toHaveBeenCalledWith('/tmp/a.ts', 'changed')
  })
})
