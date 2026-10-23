import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from '../src/store/editorStore'
import { useChatStore } from '../src/store/chatStore'
import { useToastStore, toast } from '../src/store/toastStore'
import { useWorkspaceStore } from '../src/store/workspaceStore'
import { useDiffStore } from '../src/store/diffStore'
import { useSessionStore } from '../src/store/sessionStore'

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
  const KEY = '/ws\u0000session-1'

  it('appends messages with generated ids and timestamps', () => {
    useChatStore.getState().addMessage(KEY, { role: 'user', content: 'hi' })
    const message = useChatStore.getState().conversations[KEY].messages[0]
    expect(message.content).toBe('hi')
    expect(message.id).toBeTruthy()
    expect(typeof message.timestamp).toBe('number')
  })

  it('restores a persisted history', () => {
    useChatStore.getState().setMessages(KEY, [
      { role: 'user', content: 'q', timestamp: 1 },
      { role: 'assistant', content: 'a', timestamp: 2 },
    ])
    expect(
      useChatStore.getState().conversations[KEY].messages.map((m) => m.content)
    ).toEqual(['q', 'a'])
  })

  it('keeps conversations separate by workspace and session', () => {
    const other = '/ws\u0000session-2'
    useChatStore.getState().addMessage(KEY, { role: 'user', content: 'a' })
    useChatStore.getState().addMessage(other, { role: 'user', content: 'b' })

    expect(useChatStore.getState().conversations[KEY].messages[0].content).toBe('a')
    expect(useChatStore.getState().conversations[other].messages[0].content).toBe('b')
  })

  it('resets state', () => {
    useChatStore.getState().addMessage(KEY, { role: 'user', content: 'hi' })
    useChatStore.getState().setPendingDraft('draft')
    useChatStore.getState().reset()
    expect(useChatStore.getState().conversations).toEqual({})
    expect(useChatStore.getState().pendingDraft).toBe('')
  })
})

describe('chatStore attachments', () => {
  const KEY = '/ws\u0000session-1'
  const fileA = { kind: 'file' as const, path: '/tmp/a.ts', name: 'a.ts' }
  const fileB = { kind: 'file' as const, path: '/tmp/b.ts', name: 'b.ts' }

  beforeEach(() => {
    useChatStore.getState().ensureConversation(KEY)
  })

  it('adds attachments without duplicating the same path', () => {
    useChatStore.getState().addAttachment(KEY, fileA)
    useChatStore.getState().addAttachment(KEY, fileA)
    useChatStore.getState().addAttachment(KEY, fileB)

    expect(useChatStore.getState().conversations[KEY].attachments).toEqual([
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
    useChatStore.getState().addAttachment(KEY, snippet)
    useChatStore.getState().addAttachment(KEY, { ...snippet })
    useChatStore.getState().addAttachment(KEY, { ...snippet, startLine: 6, endLine: 8 })

    expect(useChatStore.getState().conversations[KEY].attachments).toHaveLength(2)
    expect(useChatStore.getState().conversations[KEY].attachments[0].id).toBe(
      'snippet:/tmp/a.ts:2-4'
    )
  })

  it('removes and clears attachments', () => {
    useChatStore.getState().addAttachment(KEY, fileA)
    useChatStore.getState().addAttachment(KEY, fileB)

    useChatStore.getState().removeAttachment(KEY, 'file:/tmp/a.ts')
    expect(useChatStore.getState().conversations[KEY].attachments).toEqual([
      { ...fileB, id: 'file:/tmp/b.ts' },
    ])

    useChatStore.getState().clearAttachments(KEY)
    expect(useChatStore.getState().conversations[KEY].attachments).toEqual([])
  })

  it('clears attachments on reset', () => {
    useChatStore.getState().addAttachment(KEY, fileA)
    useChatStore.getState().reset()
    expect(useChatStore.getState().conversations[KEY]).toBeUndefined()
  })
})

describe('chatStore streaming', () => {
  const KEY = '/ws\u0000session-1'

  it('creates, appends to and finalizes a streaming message', () => {
    const id = useChatStore.getState().startStreamingMessage(KEY)

    let message = useChatStore.getState().conversations[KEY].messages.find((m) => m.id === id)
    expect(message?.isStreaming).toBe(true)
    expect(message?.content).toBe('')

    useChatStore.getState().appendToMessage(KEY, id, 'Hel')
    useChatStore.getState().appendToMessage(KEY, id, 'lo')

    message = useChatStore.getState().conversations[KEY].messages.find((m) => m.id === id)
    expect(message?.content).toBe('Hello')
    expect(message?.isStreaming).toBe(true)

    useChatStore.getState().finishStreamingMessage(KEY, id, 'Hello!')

    message = useChatStore.getState().conversations[KEY].messages.find((m) => m.id === id)
    expect(message?.content).toBe('Hello')
    expect(message?.parts).toEqual([{ type: 'text', id: 'text-1', text: 'Hello' }])
    expect(message?.isStreaming).toBe(false)
  })

  it('keeps interleaved text, tool and thinking parts in order', () => {
    const id = useChatStore.getState().startStreamingMessage(KEY)

    useChatStore.getState().appendTextPart(KEY, id, 'before')
    useChatStore.getState().startToolPart(KEY, id, {
      type: 'tool_start',
      toolCallId: 'call-1',
      toolName: 'read',
      argsSummary: 'a.ts',
      startedAt: 1,
    })
    useChatStore.getState().endToolPart(KEY, id, {
      type: 'tool_end',
      toolCallId: 'call-1',
      toolName: 'read',
      status: 'success',
      durationMs: 12,
      resultPreview: 'contents',
    })
    useChatStore.getState().appendTextPart(KEY, id, 'after')
    useChatStore.getState().appendThinkingPart(KEY, id, 'hmm')
    useChatStore.getState().finishStreamingMessage(KEY, id)

    const message = useChatStore
      .getState()
      .conversations[KEY].messages.find((item) => item.id === id)
    expect(message?.parts?.map((part) => part.type)).toEqual([
      'text',
      'tool',
      'text',
      'thinking',
    ])
    expect(message?.content).toBe('before\nafter')
    expect(message?.parts?.[1]).toMatchObject({
      type: 'tool',
      status: 'success',
      durationMs: 12,
      resultPreview: 'contents',
    })
  })

  it('marks unfinished tools as error when the stream ends', () => {
    const id = useChatStore.getState().startStreamingMessage(KEY)
    useChatStore.getState().startToolPart(KEY, id, {
      type: 'tool_start',
      toolCallId: 'call-2',
      toolName: 'bash',
      argsSummary: 'npm test',
      startedAt: 1,
    })

    useChatStore.getState().finishStreamingMessage(KEY, id)

    const message = useChatStore
      .getState()
      .conversations[KEY].messages.find((item) => item.id === id)
    expect(message?.parts?.[0]).toMatchObject({ type: 'tool', status: 'error', isError: true })
  })

  it('restores history parts and falls back to a text part for legacy messages', () => {
    useChatStore.getState().setMessages(KEY, [
      { role: 'user', content: 'q', timestamp: 1 },
      {
        role: 'assistant',
        content: 'answer',
        timestamp: 2,
        parts: [
          { type: 'thinking', id: 'thinking-1', text: 'plan' },
          { type: 'text', id: 'text-1', text: 'answer' },
        ],
      },
      { role: 'assistant', content: 'legacy', timestamp: 3 },
    ])

    const messages = useChatStore.getState().conversations[KEY].messages
    expect(messages[1].parts?.map((part) => part.type)).toEqual(['thinking', 'text'])
    expect(messages[2].parts).toEqual([{ type: 'text', id: 'text-3', text: 'legacy' }])
  })

  it('ignores appends to unknown message ids', () => {
    useChatStore.getState().addMessage(KEY, { role: 'user', content: 'q' })
    useChatStore.getState().startStreamingMessage(KEY)

    useChatStore.getState().appendToMessage(KEY, 'missing-id', 'x')

    const messages = useChatStore.getState().conversations[KEY].messages
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

describe('chatStore session mode', () => {
  it('defaults to act and updates per conversation', () => {
    useChatStore.getState().ensureConversation('mode-key')
    expect(useChatStore.getState().conversations['mode-key'].mode).toBe('act')

    useChatStore.getState().setMode('mode-key', 'plan')
    expect(useChatStore.getState().conversations['mode-key'].mode).toBe('plan')

    // 不存在的会话不会被创建
    useChatStore.getState().setMode('missing-key', 'plan')
    expect(useChatStore.getState().conversations['missing-key']).toBeUndefined()
  })
})

describe('sessionStore pending activation', () => {
  it('stores and clears the session requested by a notification click', () => {
    useSessionStore.getState().requestActivation('F:/work', 'session-2')
    expect(useSessionStore.getState().pendingActivation).toEqual({
      workspaceDir: 'F:/work',
      sessionId: 'session-2',
    })
    useSessionStore.getState().clearPendingActivation()
    expect(useSessionStore.getState().pendingActivation).toBeNull()
  })
})

describe('chatStore pending messages', () => {
  it('queues, updates and removes pending messages', () => {
    useChatStore.getState().ensureConversation('pending-key')
    const first = useChatStore.getState().addPending('pending-key', 'first', 'queue')
    const second = useChatStore.getState().addPending('pending-key', 'second', 'steer')

    expect(useChatStore.getState().conversations['pending-key'].pending).toHaveLength(2)

    useChatStore.getState().setPendingBehavior('pending-key', first.id, 'steer')
    expect(
      useChatStore.getState().conversations['pending-key'].pending.find((item) => item.id === first.id)
        ?.behavior
    ).toBe('steer')

    useChatStore.getState().removePending('pending-key', second.id)
    expect(useChatStore.getState().conversations['pending-key'].pending).toHaveLength(1)
  })
})
