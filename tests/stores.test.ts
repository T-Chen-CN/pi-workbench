import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from '../src/store/editorStore'
import { useChatStore } from '../src/store/chatStore'
import { useToastStore, toast } from '../src/store/toastStore'
import { useWorkspaceStore } from '../src/store/workspaceStore'

beforeEach(() => {
  useEditorStore.getState().reset()
  useChatStore.getState().reset()
  useToastStore.setState({ messages: [] })
  useWorkspaceStore.setState({ workspacePath: null, recentWorkspaces: [] })
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
})
