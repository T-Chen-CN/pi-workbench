import { afterEach, describe, expect, it, vi } from 'vitest'
import { editorStoreFor, resetEditorStores } from '../src/store/editorStore'
import { api } from '../src/api'
import { openFileInEditor } from '../src/workspace/openFileInEditor'

vi.mock('../src/api', () => ({
  api: {
    stat: vi.fn(async () => ({ success: true, isDirectory: false, size: 1024 })),
    readFile: vi.fn(async () => ({ success: true, binary: false, content: '# hi\n' })),
  },
}))

const statMock = api.stat as unknown as ReturnType<typeof vi.fn>
const readMock = api.readFile as unknown as ReturnType<typeof vi.fn>

afterEach(() => {
  resetEditorStores()
  vi.clearAllMocks()
  statMock.mockResolvedValue({ success: true, isDirectory: false, size: 1024 })
  readMock.mockResolvedValue({ success: true, binary: false, content: '# hi\n' })
})

describe('openFileInEditor', () => {
  it('opens markdown straight into the reading view', async () => {
    const outcome = await openFileInEditor('/ws', '/ws/doc.md')

    expect(outcome).toEqual({ status: 'opened', kind: 'markdown' })
    const file = editorStoreFor('/ws').getState().currentFile
    expect(file).toMatchObject({ kind: 'markdown', view: 'reading', content: '# hi\n' })
  })

  it('opens plain text in the source view', async () => {
    readMock.mockResolvedValue({ success: true, binary: false, content: 'const a = 1' })
    await openFileInEditor('/ws', '/ws/a.ts')

    expect(editorStoreFor('/ws').getState().currentFile).toMatchObject({
      kind: 'text',
      view: 'source',
    })
  })

  it('does not read media files as text', async () => {
    statMock.mockResolvedValue({ success: true, isDirectory: false, size: 90 * 1024 * 1024 })
    const outcome = await openFileInEditor('/ws', '/ws/clip.mp4')

    expect(outcome).toEqual({ status: 'opened', kind: 'video' })
    expect(readMock).not.toHaveBeenCalled()
    expect(editorStoreFor('/ws').getState().currentFile).toMatchObject({
      kind: 'video',
      content: '',
    })
  })

  it('downgrades a binary file to the unsupported view', async () => {
    readMock.mockResolvedValue({ success: true, binary: true })
    const outcome = await openFileInEditor('/ws', '/ws/unknown.dat')

    expect(outcome).toEqual({ status: 'opened', kind: 'binary' })
    expect(editorStoreFor('/ws').getState().currentFile).toMatchObject({
      kind: 'binary',
      view: 'source',
    })
  })

  it('asks before opening a large text file and honours a refusal', async () => {
    statMock.mockResolvedValue({ success: true, isDirectory: false, size: 8 * 1024 * 1024 })
    const confirmLargeFile = vi.fn(async () => false)

    const outcome = await openFileInEditor('/ws', '/ws/huge.md', { confirmLargeFile })

    expect(outcome).toEqual({ status: 'skipped', reason: 'declined' })
    expect(confirmLargeFile).toHaveBeenCalledWith({ name: 'huge.md', size: 8 * 1024 * 1024 })
    expect(readMock).not.toHaveBeenCalled()
  })

  it('skips the confirmation for large media and for restored tabs', async () => {
    statMock.mockResolvedValue({ success: true, isDirectory: false, size: 8 * 1024 * 1024 })
    const confirmLargeFile = vi.fn(async () => true)

    await openFileInEditor('/ws', '/ws/huge.md', { skipLargeConfirm: true })
    await openFileInEditor('/ws', '/ws/film.webm', { confirmLargeFile })

    expect(confirmLargeFile).not.toHaveBeenCalled()
  })

  it('reports missing files and directories without opening a tab', async () => {
    statMock.mockResolvedValue({ success: false, error: 'ENOENT' })
    expect(await openFileInEditor('/ws', '/ws/gone.md')).toMatchObject({
      status: 'skipped',
      reason: 'missing',
    })

    statMock.mockResolvedValue({ success: true, isDirectory: true, size: 0 })
    expect(await openFileInEditor('/ws', '/ws/dir')).toMatchObject({
      status: 'skipped',
      reason: 'directory',
    })
    expect(editorStoreFor('/ws').getState().openFiles).toHaveLength(0)
  })

  it('reactivates an existing tab instead of re-reading the file', async () => {
    await openFileInEditor('/ws', '/ws/doc.md')
    readMock.mockClear()

    const outcome = await openFileInEditor('/ws', '/ws/doc.md', { revealLine: 3 })

    expect(outcome).toEqual({ status: 'opened', kind: 'markdown' })
    expect(readMock).not.toHaveBeenCalled()
    expect(editorStoreFor('/ws').getState().pendingReveal).toMatchObject({
      path: '/ws/doc.md',
      line: 3,
    })
  })
})
