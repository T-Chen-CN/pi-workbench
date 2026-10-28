import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { editorStoreFor, resetEditorStores } from '../src/store/editorStore'
import {
  readEditorTabs,
  restoreEditorTabs,
  saveEditorTabs,
  subscribeEditorTabs,
} from '../src/workspace/editorTabs'
import { api } from '../src/api'

vi.mock('../src/api', () => ({
  api: {
    editorTabsGet: vi.fn(),
    editorTabsSet: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
  },
}))

const file = (workspace: string, name: string) => ({
  path: `${workspace}/${name}`,
  name,
  kind: 'text' as const,
  view: 'source' as const,
  version: 0,
  content: `// ${name}`,
  isDirty: false,
  isSaving: false,
})

beforeEach(() => {
  resetEditorStores()
  vi.clearAllMocks()
  vi.mocked(api.editorTabsSet).mockResolvedValue({ success: true })
  vi.mocked(api.stat).mockResolvedValue({
    success: true,
    isFile: true,
    isDirectory: false,
    size: 10,
  })
  vi.mocked(api.readFile).mockImplementation(async (target: string) => ({
    success: true,
    content: `// ${target}`,
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('per-workspace editor state', () => {
  it('keeps open files isolated between workspaces', () => {
    editorStoreFor('/a').getState().addOpenFile(file('/a', 'one.ts'))
    editorStoreFor('/b').getState().addOpenFile(file('/b', 'two.ts'))

    expect(editorStoreFor('/a').getState().openFiles.map((item) => item.path)).toEqual([
      '/a/one.ts',
    ])
    expect(editorStoreFor('/b').getState().openFiles.map((item) => item.path)).toEqual([
      '/b/two.ts',
    ])
    expect(editorStoreFor('/a').getState().currentFile?.path).toBe('/a/one.ts')
    expect(editorStoreFor('/b').getState().currentFile?.path).toBe('/b/two.ts')
  })

  it('reads the tab snapshot from the workspace store', () => {
    editorStoreFor('/ws').getState().addOpenFile(file('/ws', 'a.ts'))
    editorStoreFor('/ws').getState().addOpenFile(file('/ws', 'b.ts'))
    editorStoreFor('/ws').getState().setCurrentFile(file('/ws', 'a.ts'))

    expect(readEditorTabs('/ws')).toEqual({
      open: ['/ws/a.ts', '/ws/b.ts'],
      active: '/ws/a.ts',
    })
  })
})

describe('editor tab persistence', () => {
  it('restores open files and the active tab', async () => {
    vi.mocked(api.editorTabsGet).mockResolvedValue({
      success: true,
      tabs: { open: ['/ws/a.ts', '/ws/b.ts'], active: '/ws/b.ts' },
    })

    await expect(restoreEditorTabs('/ws')).resolves.toEqual({ restored: 2, skipped: 0 })

    const state = editorStoreFor('/ws').getState()
    expect(state.openFiles.map((item) => item.path)).toEqual(['/ws/a.ts', '/ws/b.ts'])
    expect(state.currentFile?.path).toBe('/ws/b.ts')
  })

  it('skips missing, directory and oversized files', async () => {
    vi.mocked(api.editorTabsGet).mockResolvedValue({
      success: true,
      tabs: {
        open: ['/ws/missing.ts', '/ws/dir', '/ws/big.ts', '/ws/ok.ts'],
        active: '/ws/ok.ts',
      },
    })
    vi.mocked(api.stat).mockImplementation(async (target: string) => {
      if (target.endsWith('missing.ts')) return { success: false }
      if (target.endsWith('/dir')) {
        return { success: true, isFile: false, isDirectory: true, size: 0 }
      }
      if (target.endsWith('big.ts')) {
        return { success: true, isFile: true, isDirectory: false, size: 20 * 1024 * 1024 }
      }
      return { success: true, isFile: true, isDirectory: false, size: 10 }
    })

    await expect(restoreEditorTabs('/ws')).resolves.toEqual({ restored: 1, skipped: 3 })
    expect(editorStoreFor('/ws').getState().openFiles.map((item) => item.path)).toEqual([
      '/ws/ok.ts',
    ])
  })

  it('restores media tabs without reading them and binaries as placeholders', async () => {
    vi.mocked(api.editorTabsGet).mockResolvedValue({
      success: true,
      tabs: { open: ['/ws/doc.md', '/ws/clip.mp4', '/ws/blob.dat'], active: '/ws/doc.md' },
    })
    vi.mocked(api.readFile).mockImplementation(async (target: string) => {
      if (target.endsWith('doc.md')) return { success: true, binary: false, content: '# hi' }
      return { success: true, binary: true }
    })

    await expect(restoreEditorTabs('/ws')).resolves.toEqual({ restored: 3, skipped: 0 })

    const state = editorStoreFor('/ws').getState()
    expect(state.openFiles.map((item) => [item.name, item.kind, item.view])).toEqual([
      ['doc.md', 'markdown', 'reading'],
      ['clip.mp4', 'video', 'source'],
      ['blob.dat', 'binary', 'source'],
    ])
    // 媒体只登记标签，不把二进制当文本读
    expect(api.readFile).not.toHaveBeenCalledWith('/ws/clip.mp4')
  })

  it('tolerates a missing preload API', async () => {
    vi.mocked(api.editorTabsGet).mockRejectedValue(new Error('editorTabsGet is not a function'))

    await expect(restoreEditorTabs('/ws')).resolves.toEqual({ restored: 0, skipped: 0 })
  })

  it('writes on tab changes but ignores content edits', async () => {
    vi.useFakeTimers()
    const unsubscribe = subscribeEditorTabs('/ws')

    editorStoreFor('/ws').getState().addOpenFile(file('/ws', 'a.ts'))
    await vi.advanceTimersByTimeAsync(300)
    expect(api.editorTabsSet).toHaveBeenCalledWith('/ws', {
      open: ['/ws/a.ts'],
      active: '/ws/a.ts',
    })

    vi.mocked(api.editorTabsSet).mockClear()
    editorStoreFor('/ws').getState().updateOpenFile('/ws/a.ts', { content: 'changed' })
    await vi.advanceTimersByTimeAsync(300)
    expect(api.editorTabsSet).not.toHaveBeenCalled()

    unsubscribe()
  })

  it('writes the current snapshot on demand', async () => {
    editorStoreFor('/ws').getState().addOpenFile(file('/ws', 'a.ts'))
    await saveEditorTabs('/ws')
    expect(api.editorTabsSet).toHaveBeenCalledWith('/ws', {
      open: ['/ws/a.ts'],
      active: '/ws/a.ts',
    })
  })
})
