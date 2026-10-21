import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from '../src/store/editorStore'
import { useChatStore } from '../src/store/chatStore'
import { useToastStore, toast } from '../src/store/toastStore'
import { useWorkspaceStore } from '../src/store/workspaceStore'
import { useDiffStore } from '../src/store/diffStore'

beforeEach(() => {
  useEditorStore.getState().reset()
  useChatStore.getState().reset()
  useToastStore.setState({ messages: [] })
  useWorkspaceStore.setState({ workspacePath: null, openWorkspaces: [], recentWorkspaces: [] })
  useDiffStore.getState().clearDiff()
})

describe('editorStore', () => {
  const file = {
    path: '/tmp/a.ts',
    name: 'a.ts',
    content: 'const a = 1',
    isDirty: false,
    isSaving: false,
  }

  it('opens files and selects the latest one', () => {
    useEditorStore.getState().addOpenFile(file)
    expect(useEditorStore.getState().openFiles).toHaveLength(1)
    expect(useEditorStore.getState().currentFile?.path).toBe(file.path)
  })

  it('updates content immutably and tracks dirty state', () => {
    useEditorStore.getState().addOpenFile(file)
    useEditorStore.getState().updateOpenFile(file.path, { content: 'changed' })
    useEditorStore.getState().markDirty(file.path)

    const state = useEditorStore.getState()
    expect(state.currentFile?.content).toBe('changed')
    expect(state.currentFile?.isDirty).toBe(true)
    expect(state.hasDirtyFiles()).toBe(true)

    state.markClean(file.path)
    expect(useEditorStore.getState().hasDirtyFiles()).toBe(false)
  })

  it('switches the current file when the active tab is closed', () => {
    useEditorStore.getState().addOpenFile(file)
    useEditorStore.getState().addOpenFile({ ...file, path: '/tmp/b.ts', name: 'b.ts' })
    useEditorStore.getState().removeOpenFile('/tmp/b.ts')
    expect(useEditorStore.getState().currentFile?.path).toBe('/tmp/a.ts')
  })

  it('clears dirty tracking when a dirty file is closed', () => {
    useEditorStore.getState().addOpenFile(file)
    useEditorStore.getState().markDirty(file.path)

    useEditorStore.getState().removeOpenFile(file.path)

    expect(useEditorStore.getState().hasDirtyFiles()).toBe(false)
    expect(useEditorStore.getState().unsavedChanges.has(file.path)).toBe(false)
  })

  it('clears stale dirty tracking when reopening a file from disk', () => {
    useEditorStore.setState({ unsavedChanges: new Set([file.path]) })

    useEditorStore.getState().addOpenFile(file)

    expect(useEditorStore.getState().unsavedChanges.has(file.path)).toBe(false)
  })
})

describe('chatStore', () => {
  it('appends messages with generated ids and timestamps', () => {
    useChatStore.getState().addMessage({ role: 'user', content: 'hi' })
    const message = useChatStore.getState().messages[0]
    expect(message.content).toBe('hi')
    expect(message.id).toBeTruthy()
    expect(typeof message.timestamp).toBe('number')
  })

  it('restores a persisted history', () => {
    useChatStore.getState().setMessages([
      { role: 'user', content: 'q', timestamp: 1 },
      { role: 'assistant', content: 'a', timestamp: 2 },
    ])
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['q', 'a'])
  })

  it('resets state', () => {
    useChatStore.getState().addMessage({ role: 'user', content: 'hi' })
    useChatStore.getState().reset()
    expect(useChatStore.getState().messages).toEqual([])
    expect(useChatStore.getState().error).toBeNull()
  })
})

describe('chatStore attachments', () => {
  const fileA = { kind: 'file' as const, path: '/tmp/a.ts', name: 'a.ts' }
  const fileB = { kind: 'file' as const, path: '/tmp/b.ts', name: 'b.ts' }

  it('adds attachments without duplicating the same path', () => {
    useChatStore.getState().addAttachment(fileA)
    useChatStore.getState().addAttachment(fileA)
    useChatStore.getState().addAttachment(fileB)

    expect(useChatStore.getState().attachments).toEqual([
      { ...fileA, id: 'file:/tmp/a.ts' },
      { ...fileB, id: 'file:/tmp/b.ts' },
    ])
  })

  it('deduplicates snippets by path and range', () => {
    const snippet = {
      kind: 'snippet' as const,
      path: '/tmp/a.ts',
      name: 'a.ts',
      startLine: 2,
      endLine: 4,
      content: 'b\nc\nd',
    }
    useChatStore.getState().addAttachment(snippet)
    useChatStore.getState().addAttachment({ ...snippet })
    useChatStore.getState().addAttachment({ ...snippet, startLine: 6, endLine: 8 })

    expect(useChatStore.getState().attachments).toHaveLength(2)
    expect(useChatStore.getState().attachments[0].id).toBe('snippet:/tmp/a.ts:2-4')
  })

  it('removes and clears attachments', () => {
    useChatStore.getState().addAttachment(fileA)
    useChatStore.getState().addAttachment(fileB)

    useChatStore.getState().removeAttachment('file:/tmp/a.ts')
    expect(useChatStore.getState().attachments).toEqual([
      { ...fileB, id: 'file:/tmp/b.ts' },
    ])

    useChatStore.getState().clearAttachments()
    expect(useChatStore.getState().attachments).toEqual([])
  })

  it('clears attachments on reset', () => {
    useChatStore.getState().addAttachment({ kind: 'file', path: '/tmp/a.ts', name: 'a.ts' })
    useChatStore.getState().reset()
    expect(useChatStore.getState().attachments).toEqual([])
  })
})

describe('chatStore streaming', () => {
  it('creates, appends to and finalizes a streaming message', () => {
    const id = useChatStore.getState().startStreamingMessage()

    let message = useChatStore.getState().messages.find((m) => m.id === id)
    expect(message?.isStreaming).toBe(true)
    expect(message?.content).toBe('')

    useChatStore.getState().appendToMessage(id, 'Hel')
    useChatStore.getState().appendToMessage(id, 'lo')

    message = useChatStore.getState().messages.find((m) => m.id === id)
    expect(message?.content).toBe('Hello')
    expect(message?.isStreaming).toBe(true)

    useChatStore.getState().finishStreamingMessage(id, 'Hello!')

    message = useChatStore.getState().messages.find((m) => m.id === id)
    expect(message?.content).toBe('Hello!')
    expect(message?.isStreaming).toBe(false)
  })

  it('ignores appends to unknown message ids', () => {
    useChatStore.getState().addMessage({ role: 'user', content: 'q' })
    useChatStore.getState().startStreamingMessage()

    useChatStore.getState().appendToMessage('missing-id', 'x')

    const messages = useChatStore.getState().messages
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('q')
    expect(messages[1].content).toBe('')
  })
})

describe('toastStore', () => {
  it('shows and removes toasts', () => {
    toast.success('saved')
    expect(useToastStore.getState().messages).toHaveLength(1)
    const id = useToastStore.getState().messages[0].id
    useToastStore.getState().remove(id)
    expect(useToastStore.getState().messages).toEqual([])
  })
})

describe('workspaceStore', () => {
  it('tracks the open workspace and recents', () => {
    useWorkspaceStore.getState().setWorkspace('/tmp/project')
    useWorkspaceStore.getState().setRecentWorkspaces(['/tmp/project'])
    expect(useWorkspaceStore.getState().workspacePath).toBe('/tmp/project')
    expect(useWorkspaceStore.getState().recentWorkspaces).toEqual(['/tmp/project'])
  })

  it('opens multiple workspaces without duplicating entries', () => {
    useWorkspaceStore.getState().openWorkspace('/tmp/a')
    useWorkspaceStore.getState().openWorkspace('/tmp/b')
    useWorkspaceStore.getState().openWorkspace('/tmp/a')

    expect(useWorkspaceStore.getState().openWorkspaces).toEqual(['/tmp/a', '/tmp/b'])
    expect(useWorkspaceStore.getState().workspacePath).toBe('/tmp/a')
  })

  it('switches back to the previous workspace when the current tab closes', () => {
    useWorkspaceStore.getState().openWorkspace('/tmp/a')
    useWorkspaceStore.getState().openWorkspace('/tmp/b')

    expect(useWorkspaceStore.getState().closeWorkspace('/tmp/b')).toBe('/tmp/a')
    expect(useWorkspaceStore.getState().workspacePath).toBe('/tmp/a')
    expect(useWorkspaceStore.getState().openWorkspaces).toEqual(['/tmp/a'])

    expect(useWorkspaceStore.getState().closeWorkspace('/tmp/a')).toBeNull()
    expect(useWorkspaceStore.getState().workspacePath).toBeNull()
    expect(useWorkspaceStore.getState().openWorkspaces).toEqual([])
  })

  it('keeps the current workspace when another tab closes', () => {
    useWorkspaceStore.getState().openWorkspace('/tmp/a')
    useWorkspaceStore.getState().openWorkspace('/tmp/b')

    expect(useWorkspaceStore.getState().closeWorkspace('/tmp/a')).toBe('/tmp/b')
    expect(useWorkspaceStore.getState().workspacePath).toBe('/tmp/b')
  })
})

describe('diffStore review queue', () => {
  const edits = [
    { path: '/tmp/a.ts', oldContent: 'a0', newContent: 'a1' },
    { path: '/tmp/b.ts', oldContent: 'b0', newContent: 'b1' },
  ]

  it('opens a merged review queue', () => {
    useDiffStore.getState().openEdits([
      ...edits,
      { path: '/tmp/a.ts', oldContent: 'a1', newContent: 'a2' },
    ])

    const state = useDiffStore.getState()
    expect(state.isOpen).toBe(true)
    expect(state.currentIndex).toBe(0)
    expect(state.edits).toEqual([
      { path: '/tmp/a.ts', oldContent: 'a0', newContent: 'a2' },
      { path: '/tmp/b.ts', oldContent: 'b0', newContent: 'b1' },
    ])
  })

  it('clamps navigation to the queue bounds', () => {
    useDiffStore.getState().openEdits(edits)
    useDiffStore.getState().setCurrentIndex(5)
    expect(useDiffStore.getState().currentIndex).toBe(1)
    useDiffStore.getState().setCurrentIndex(-3)
    expect(useDiffStore.getState().currentIndex).toBe(0)
  })

  it('removes edits and closes when the queue is empty', () => {
    useDiffStore.getState().openEdits(edits)
    useDiffStore.getState().setCurrentIndex(1)

    useDiffStore.getState().removeEdit('/tmp/b.ts')
    expect(useDiffStore.getState().edits).toHaveLength(1)
    expect(useDiffStore.getState().currentIndex).toBe(0)

    useDiffStore.getState().removeEdit('/tmp/a.ts')
    expect(useDiffStore.getState().edits).toEqual([])
    expect(useDiffStore.getState().isOpen).toBe(false)
  })

  it('does not open an empty review queue', () => {
    useDiffStore.getState().openEdits([])
    expect(useDiffStore.getState().isOpen).toBe(false)
  })
})
