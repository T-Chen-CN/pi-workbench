// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationKey, useChatStore } from '../src/store/chatStore'
import { useSessionStore } from '../src/store/sessionStore'
import { useWorkspaceStore } from '../src/store/workspaceStore'
import { MAX_QUOTE_CHARS, addChatQuote, activeConversationKey } from '../src/workspace/quoteSelection'

const workspacePath = '/ws'
const sessionId = 's1'
const key = conversationKey(workspacePath, sessionId)

function attachments() {
  return useChatStore.getState().conversations[key]?.attachments ?? []
}

beforeEach(() => {
  useChatStore.setState({ conversations: {} })
  useSessionStore.setState({ byWorkspace: {} })
  useWorkspaceStore.setState({ workspacePath })
  vi.clearAllMocks()
})

describe('addChatQuote', () => {
  it('reports a missing session instead of silently dropping the quote', () => {
    expect(activeConversationKey()).toBeNull()
    expect(addChatQuote({ text: 'quote me', title: 'README.md' })).toBe('no-session')
  })

  it('adds a snippet attachment carrying the quote label', () => {
    useSessionStore.setState({
      byWorkspace: { [workspacePath]: { sessions: [], open: [sessionId], active: sessionId, panelOpen: true } }
    })

    expect(addChatQuote({ text: '  选中一段文字  ', title: '对话引用' })).toBe('ok')

    const [attachment] = attachments()
    expect(attachment?.kind).toBe('snippet')
    expect(attachment?.content).toBe('选中一段文字')
    // 对话引用没有文件路径，标题写在 label 上，由 chatContext 拼进上下文块
    expect(attachment?.path).toBe('')
    expect(attachment?.label).toBe('对话引用')
  })

  it('keeps two quotes from the same source apart', () => {
    useSessionStore.setState({
      byWorkspace: { [workspacePath]: { sessions: [], open: [sessionId], active: sessionId, panelOpen: true } }
    })
    addChatQuote({ text: 'first', title: 'README.md', sourcePath: '/ws/README.md' })
    addChatQuote({ text: 'second', title: 'README.md', sourcePath: '/ws/README.md' })

    const ids = attachments().map((attachment) => attachment.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('rejects empty and oversized selections', () => {
    useSessionStore.setState({
      byWorkspace: { [workspacePath]: { sessions: [], open: [sessionId], active: sessionId, panelOpen: true } }
    })
    expect(addChatQuote({ text: '   ', title: 'README.md' })).toBe('empty')
    expect(addChatQuote({ text: 'x'.repeat(MAX_QUOTE_CHARS + 1), title: 'README.md' })).toBe('too-long')
    expect(attachments()).toHaveLength(0)
  })
})
