// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MonacoEditor } from '../src/components/MonacoEditor'
import { useEditorStore } from '../src/store/editorStore'
import { api } from '../src/api'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  setModelLanguage: vi.fn(),
  createModel: vi.fn(() => ({})),
}))

vi.mock('monaco-editor', () => ({
  editor: {
    create: (element: HTMLElement, options: { value?: string }) =>
      mocks.create(element, options),
    setModelLanguage: mocks.setModelLanguage,
    createModel: mocks.createModel,
  },
}))

function createFakeEditor(initialValue: string) {
  let value = initialValue
  let listener: (() => void) | null = null
  const model = { getValue: () => value }

  return {
    getModel: () => model,
    getValue: () => value,
    setValue: vi.fn((next: string) => {
      value = next
    }),
    onDidChangeModelContent: vi.fn((callback: () => void) => {
      listener = callback
      return { dispose: vi.fn() }
    }),
    layout: vi.fn(),
    dispose: vi.fn(),
    emitChange(next?: string) {
      if (next !== undefined) value = next
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
  mocks.create.mockImplementation(
    (_element: HTMLElement, options: { value?: string }) =>
      createFakeEditor(options?.value ?? '')
  )
})

afterEach(() => {
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
