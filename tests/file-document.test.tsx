// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editorStoreFor, resetEditorStores } from '../src/store/editorStore'
import { useSettingsStore } from '../src/store/settingsStore'
import { useFileDocument } from '../src/workspace/useFileDocument'
import { api } from '../src/api'

vi.mock('../src/api', () => ({
  api: {
    writeFile: vi.fn(),
    readFile: vi.fn(),
    exists: vi.fn(),
    draftSave: vi.fn(),
    draftDelete: vi.fn(),
    onFsChanged: vi.fn(() => () => {}),
  },
}))

/** 只挂载文档层：保存 / 草稿 / 外部同步都由它承担，与视图形态无关 */
const Harness: React.FC<{
  workspacePath: string
  root?: string
  active?: boolean
}> = ({ workspacePath, root, active }) => {
  useFileDocument({ workspacePath, root: root ?? workspacePath, active })
  return null
}

const file = (path: string, content: string) => ({
  path,
  name: path.split('/').pop() ?? path,
  content,
  isDirty: false,
  isSaving: false,
})

/** 模拟阅读视图里的修改：只改 store，不经过 Monaco */
function editFile(path: string, content: string) {
  act(() => {
    const store = editorStoreFor('/ws')
    store.getState().updateOpenFile(path, { content })
    store.getState().markDirty(path)
  })
}

beforeEach(() => {
  resetEditorStores()
  vi.clearAllMocks()
  vi.mocked(api.writeFile).mockResolvedValue({ success: true })
  vi.mocked(api.draftSave).mockResolvedValue({ success: true })
  vi.mocked(api.draftDelete).mockResolvedValue({ success: true })
  vi.mocked(api.exists).mockResolvedValue({ success: true, exists: true })
  useSettingsStore.setState({ autoSave: true, autoSaveDelay: 2000 })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useFileDocument', () => {
  it('auto-saves two seconds after the last edit', async () => {
    vi.useFakeTimers()
    render(<Harness workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(file('/tmp/a.ts', 'a'))
    })

    editFile('/tmp/a.ts', 'changed')

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(api.writeFile).toHaveBeenCalledWith('/tmp/a.ts', 'changed')
  })

  it('keeps a pending auto-save when switching files', async () => {
    vi.useFakeTimers()
    render(<Harness workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(file('/tmp/a.ts', 'a'))
    })

    editFile('/tmp/a.ts', 'changed')
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(file('/tmp/b.ts', 'b'))
    })

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(api.writeFile).toHaveBeenCalledWith('/tmp/a.ts', 'changed')
  })

  it('keeps auto-save timers independent for each file', async () => {
    vi.useFakeTimers()
    render(<Harness workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(file('/tmp/a.ts', 'a'))
      editorStoreFor('/ws').getState().addOpenFile(file('/tmp/b.ts', 'b'))
    })

    editFile('/tmp/a.ts', 'a-changed')
    editFile('/tmp/b.ts', 'b-changed')

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(api.writeFile).toHaveBeenCalledWith('/tmp/a.ts', 'a-changed')
    expect(api.writeFile).toHaveBeenCalledWith('/tmp/b.ts', 'b-changed')
  })

  it('keeps the file dirty when it changes while a save is in flight', async () => {
    vi.useFakeTimers()
    render(<Harness workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(file('/tmp/a.ts', 'a'))
    })

    let resolveWrite: (value: { success: boolean }) => void = () => {}
    vi.mocked(api.writeFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve
        })
    )

    editFile('/tmp/a.ts', 'first')
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    editFile('/tmp/a.ts', 'second')
    await act(async () => {
      resolveWrite({ success: true })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(editorStoreFor('/ws').getState().currentFile?.isDirty).toBe(true)
    expect(api.draftSave).toHaveBeenCalledWith('/ws', '/tmp/a.ts', 'second')
  })

  it('saves immediately on Ctrl+S', async () => {
    render(<Harness workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(file('/tmp/a.ts', 'a'))
    })

    editFile('/tmp/a.ts', 'manual')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
      await Promise.resolve()
    })

    expect(api.writeFile).toHaveBeenCalledWith('/tmp/a.ts', 'manual')
  })

  it('ignores Ctrl+S when the workspace is not visible', async () => {
    render(<Harness workspacePath="/ws" active={false} />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(file('/tmp/a.ts', 'a'))
    })

    editFile('/tmp/a.ts', 'manual')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
      await Promise.resolve()
    })

    expect(api.writeFile).not.toHaveBeenCalled()
  })

  it('syncs external changes for files open in background tabs', async () => {
    let fsChanged: ((payload: { type: string; path: string }) => void) | null = null
    vi.mocked(api.onFsChanged).mockImplementation((callback) => {
      fsChanged = callback
      return () => {}
    })
    vi.mocked(api.readFile).mockResolvedValue({ success: true, binary: false, content: 'updated-a' })

    render(<Harness workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(file('/ws/a.ts', 'old-a'))
      editorStoreFor('/ws').getState().addOpenFile(file('/ws/b.ts', 'b'))
    })

    await act(async () => {
      fsChanged?.({ type: 'change', path: '/ws/a.ts' })
      await Promise.resolve()
    })

    const updated = editorStoreFor('/ws')
      .getState()
      .openFiles.find((item) => item.path === '/ws/a.ts')
    expect(updated?.content).toBe('updated-a')
  })

  it('does not overwrite a dirty buffer from disk', async () => {
    let fsChanged: ((payload: { type: string; path: string }) => void) | null = null
    vi.mocked(api.onFsChanged).mockImplementation((callback) => {
      fsChanged = callback
      return () => {}
    })
    vi.mocked(api.readFile).mockResolvedValue({ success: true, binary: false, content: 'disk' })

    render(<Harness workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(file('/ws/a.ts', 'local'))
    })
    editFile('/ws/a.ts', 'local-edit')

    await act(async () => {
      fsChanged?.({ type: 'change', path: '/ws/a.ts' })
      await Promise.resolve()
    })

    const current = editorStoreFor('/ws')
      .getState()
      .openFiles.find((item) => item.path === '/ws/a.ts')
    expect(current?.content).toBe('local-edit')
    expect(api.readFile).not.toHaveBeenCalled()
  })

  it('closes the tab when the file disappears from disk', async () => {
    let fsChanged: ((payload: { type: string; path: string }) => void) | null = null
    vi.mocked(api.onFsChanged).mockImplementation((callback) => {
      fsChanged = callback
      return () => {}
    })
    vi.mocked(api.exists).mockResolvedValue({ success: true, exists: false })

    render(<Harness workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile(file('/ws/a.ts', 'a'))
    })

    await act(async () => {
      fsChanged?.({ type: 'unlink', path: '/ws/a.ts' })
      await Promise.resolve()
    })

    expect(editorStoreFor('/ws').getState().openFiles).toHaveLength(0)
    expect(api.draftDelete).toHaveBeenCalledWith('/ws', '/ws/a.ts')
  })

  it('refreshes media through the version counter instead of reading text', async () => {
    let fsChanged: ((payload: { type: string; path: string }) => void) | null = null
    vi.mocked(api.onFsChanged).mockImplementation((callback) => {
      fsChanged = callback
      return () => {}
    })

    render(<Harness workspacePath="/ws" />)
    act(() => {
      editorStoreFor('/ws').getState().addOpenFile({
        ...file('/ws/pic.png', ''),
        kind: 'image',
        view: 'reading',
      })
    })

    await act(async () => {
      fsChanged?.({ type: 'change', path: '/ws/pic.png' })
      await Promise.resolve()
    })

    const media = editorStoreFor('/ws')
      .getState()
      .openFiles.find((item) => item.path === '/ws/pic.png')
    expect(media?.version).toBe(1)
    expect(api.readFile).not.toHaveBeenCalled()
  })
})
