// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../src/components/ChatPanel'
import { FileExplorer } from '../src/components/FileExplorer'
import { MonacoEditor } from '../src/components/MonacoEditor'
import { WelcomeScreen } from '../src/components/WelcomeScreen'
import { useChatStore, conversationKey } from '../src/store/chatStore'
import { useEditorStore } from '../src/store/editorStore'
import { useSelectionStore } from '../src/store/selectionStore'
import { useSessionStore } from '../src/store/sessionStore'
import type { AgentStreamEvent, SessionSummary } from '../src/types/electron'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'
import { api } from '../src/api'
import { piAgentAPI } from '../src/api/piAgentAPI'
import type { ApiConfig } from '../src/types/electron'

vi.mock('../src/api', () => ({
  api: {
    apiConfigGet: vi.fn(),
    readFile: vi.fn(),
    listDirectory: vi.fn(),
    writeFile: vi.fn(),
    deletePath: vi.fn(),
    renamePath: vi.fn(),
    exists: vi.fn(),
    stat: vi.fn(),
    onFsChanged: vi.fn(() => () => {}),
    fleetList: vi.fn(),
    onFleetTaskUpdated: vi.fn(() => () => {}),
  },
}))

vi.mock('../src/api/piAgentAPI', () => ({
  piAgentAPI: {
    initialize: vi.fn(),
    getHistory: vi.fn(),
    chat: vi.fn(),
    abort: vi.fn(),
    dispose: vi.fn(),
    isInitialized: vi.fn(),
    onSessionTitle: vi.fn(() => () => {}),
    sessionsList: vi.fn(),
    sessionsOpen: vi.fn(),
    sessionsCreate: vi.fn(),
    sessionsClose: vi.fn(),
    sessionsRename: vi.fn(),
    sessionsDelete: vi.fn(),
    sessionsGetTabs: vi.fn(),
    sessionsSetTabs: vi.fn(),
    sessionsSetMode: vi.fn(),
    steer: vi.fn(),
    getContextUsage: vi.fn(),
    compactContext: vi.fn(),
    getSessionSettings: vi.fn(),
    setSessionModel: vi.fn(),
    setSessionThinking: vi.fn(),
    rewindLastUser: vi.fn(),
    listCheckpoints: vi.fn(),
    restoreCheckpoint: vi.fn(),
    onApprovalRequest: vi.fn(() => () => {}),
    respondApproval: vi.fn(),
    onNotifyClick: vi.fn(() => () => {}),
  },
}))

vi.mock('monaco-editor', () => {
  const createModel = (initialValue: string) => {
    let value = initialValue
    return {
      getValue: () => value,
      setValue: (next: string) => {
        value = next
      },
      getValueInRange: () => value,
      dispose: () => {},
    }
  }
  return {
    Uri: {
      file: (filePath: string) => ({ path: filePath, toString: () => `file://${filePath}` }),
    },
    editor: {
      create: () => {
        let model = createModel('')
        return {
          getModel: () => model,
          setModel: (next: typeof model) => {
            model = next
          },
          getValue: () => model.getValue(),
          setValue: (next: string) => model.setValue(next),
          saveViewState: () => null,
          restoreViewState: () => {},
          onDidChangeModelContent: () => ({ dispose: () => {} }),
          onDidChangeCursorSelection: () => ({ dispose: () => {} }),
          getSelection: () => null,
          layout: () => {},
          updateOptions: () => {},
          dispose: () => {},
        }
      },
      getModel: () => null,
      setModelLanguage: vi.fn(),
      setTheme: vi.fn(),
      defineTheme: vi.fn(),
      createModel: vi.fn((value: string) => createModel(value)),
    },
  }
})

const configWithKey: ApiConfig = {
  provider: 'anthropic',
  apiUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  availableModels: ['test-model'],
  selectedModel: 'test-model',
}

const session: SessionSummary = {
  id: 's1',
  title: 'Session 1',
  messageCount: 0,
  createdAt: 1,
  updatedAt: 2,
}
const sessionKey = conversationKey('/ws', 's1')

beforeEach(() => {
  useChatStore.getState().reset()
  useEditorStore.getState().reset()
  useSelectionStore.getState().clearSelection()
  useSessionStore.getState().reset()
  useI18nStore.getState().setLanguage('zh')
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
  vi.mocked(api.apiConfigGet).mockResolvedValue({
    success: true,
    config: configWithKey,
  })
  vi.mocked(piAgentAPI.initialize).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.getHistory).mockResolvedValue({ success: true, history: [] })
  vi.mocked(piAgentAPI.isInitialized).mockResolvedValue({ success: true, initialized: false })
  vi.mocked(piAgentAPI.sessionsList).mockResolvedValue({
    success: true,
    sessions: [session],
    currentId: session.id,
  })
  vi.mocked(piAgentAPI.sessionsGetTabs).mockResolvedValue({
    success: true,
    tabs: { open: [session.id], active: session.id },
  })
  vi.mocked(piAgentAPI.sessionsOpen).mockResolvedValue({
    success: true,
    session,
    history: [],
  })
  vi.mocked(piAgentAPI.sessionsCreate).mockResolvedValue({
    success: true,
    session,
    history: [],
  })
  vi.mocked(piAgentAPI.sessionsSetTabs).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.sessionsSetMode).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.getContextUsage).mockResolvedValue({ success: true, usage: undefined })
  vi.mocked(piAgentAPI.compactContext).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.getSessionSettings).mockResolvedValue({
    success: true,
    modelId: 'test-model',
    thinkingLevel: 'medium',
  })
  vi.mocked(piAgentAPI.listCheckpoints).mockResolvedValue({ success: true, checkpoints: [] })
  vi.mocked(piAgentAPI.steer).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.respondApproval).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.sessionsClose).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.sessionsRename).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.sessionsDelete).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.onSessionTitle).mockReturnValue(() => {})
  vi.mocked(api.stat).mockResolvedValue({ success: true, isFile: true, isDirectory: false, size: 0 })
  vi.mocked(api.onFsChanged).mockReturnValue(() => {})
  vi.mocked(api.fleetList).mockResolvedValue({ success: true, tasks: [] })
  vi.mocked(api.onFleetTaskUpdated).mockReturnValue(() => {})
})

afterEach(() => {
  cleanup()
})

describe('ChatPanel', () => {
  it('leaves the API key prompt after a configuration is saved', async () => {
    vi.mocked(api.apiConfigGet).mockResolvedValue({
      success: true,
      config: { ...configWithKey, apiKey: '' },
    })

    render(<ChatPanel workspacePath="/ws" />)
    await screen.findByText(translations.zh.apiConfigRequired)

    vi.mocked(api.apiConfigGet).mockResolvedValue({
      success: true,
      config: configWithKey,
    })

    act(() => {
      window.dispatchEvent(new CustomEvent('api-config-saved'))
    })

    await waitFor(() => {
      expect(screen.queryByText(translations.zh.apiConfigRequired)).toBeNull()
    })
    expect(
      screen.getByRole('heading', { name: translations.zh.agentChatTitle })
    ).toBeTruthy()
  })

  it('renders assistant markdown with highlighted code blocks', async () => {
    vi.mocked(piAgentAPI.sessionsOpen).mockResolvedValue({
      success: true,
      session,
      history: [
        {
          role: 'assistant',
          content: 'Example:\n\n```ts\nconst answer = 42\n```',
          timestamp: Date.now(),
        },
      ],
    })

    render(<ChatPanel workspacePath="/ws" />)

    await waitFor(() => {
      const code = document.querySelector('.chat-markdown pre code')
      expect(code?.textContent).toContain('const answer = 42')
    })
    expect(screen.getByLabelText(translations.zh.copyCode)).toBeTruthy()
  })

  it('batches streamed deltas and keeps the streamed parts at completion', async () => {
    let emitTrace: ((event: AgentStreamEvent) => void) | null = null
    let resolveChat: ((value: { success: boolean; response?: string }) => void) | null = null
    vi.mocked(piAgentAPI.chat).mockImplementation(
      (_message, handlers) =>
        new Promise((resolve) => {
          emitTrace =
            typeof handlers === 'object' && handlers ? handlers.onTrace ?? null : null
          resolveChat = resolve
        })
    )

    render(<ChatPanel workspacePath="/ws" />)
    const input = (await screen.findByPlaceholderText(
      translations.zh.inputPlaceholder
    )) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))

    fireEvent.change(input, { target: { value: 'stream please' } })
    fireEvent.click(screen.getByText(translations.zh.send))
    await waitFor(() => {
      expect(useSessionStore.getState().streaming[sessionKey]).toBe(true)
    })

    act(() => {
      emitTrace?.({ type: 'text_delta', delta: 'Hello ' })
      emitTrace?.({ type: 'text_delta', delta: 'world' })
    })

    // 增量按 50ms 窗口合并后才写入 store
    await waitFor(() => expect(screen.getByText(/Hello world/)).toBeTruthy())

    act(() => {
      resolveChat?.({ success: true, response: 'Hello world!' })
    })
    await waitFor(() => {
      const message = useChatStore
        .getState()
        .conversations[sessionKey].messages.find((item) => item.role === 'assistant')
      expect(message?.parts?.filter((part) => part.type === 'text')).toHaveLength(1)
    })
    expect(screen.getByText(/Hello world/)).toBeTruthy()
  })

  it('renders a collapsed process group and expands thinking on demand', async () => {
    useSessionStore.getState().setSessions('/ws', [session])
    useSessionStore.getState().setOpen('/ws', [session.id], session.id)
    useChatStore.getState().setMessages(sessionKey, [
      { role: 'user', content: 'inspect', timestamp: 1 },
      {
        role: 'assistant',
        content: 'final answer',
        timestamp: 2,
        parts: [
          { type: 'thinking', id: 'thinking-1', text: 'private reasoning' },
          {
            type: 'tool',
            id: 'call-1',
            toolCallId: 'call-1',
            toolName: 'read',
            argsSummary: 'a.ts',
            status: 'success',
            durationMs: 12,
            resultPreview: 'file body',
          },
          { type: 'text', id: 'text-1', text: 'final answer' },
        ],
      },
    ])

    render(<ChatPanel workspacePath="/ws" />)

    await waitFor(() => expect(screen.getByText('final answer')).toBeTruthy())
    expect(screen.queryByText('private reasoning')).toBeNull()

    const trigger = screen.getByRole('button', { name: /过程/ })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)

    await waitFor(() => {
      expect(screen.getByText('private reasoning')).toBeTruthy()
      expect(screen.getByText('读取')).toBeTruthy()
      expect(screen.getByText('a.ts')).toBeTruthy()
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    expect(screen.queryByText('file body')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /读取/ }))
    await waitFor(() => expect(screen.getByText('file body')).toBeTruthy())
  })

  it('keeps a manually expanded process group open when text keeps streaming', async () => {
    useSessionStore.getState().setSessions('/ws', [session])
    useSessionStore.getState().setOpen('/ws', [session.id], session.id)
    useChatStore.getState().setMessages(sessionKey, [
      {
        role: 'assistant',
        content: '',
        timestamp: 1,
        isStreaming: true,
        parts: [{ type: 'thinking', id: 'thinking-1', text: 'live thinking' }],
      },
    ])

    render(<ChatPanel workspacePath="/ws" />)

    const trigger = await screen.findByRole('button', {
      name: new RegExp(translations.zh.thinkingInProgress),
    })
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByText('live thinking')).toBeTruthy())

    const messageId = useChatStore.getState().conversations[sessionKey].messages[0].id
    act(() => {
      useChatStore.getState().appendTextPart(sessionKey, messageId, 'answer')
    })

    await waitFor(() => {
      expect(screen.getByText('live thinking')).toBeTruthy()
      expect(screen.getByText('answer')).toBeTruthy()
    })
    expect(
      screen.getByRole('button', { name: /过程/ }).getAttribute('aria-expanded')
    ).toBe('true')
  })

  it('attaches the current editor selection as a snippet', async () => {
    render(<ChatPanel workspacePath="/ws" />)
    useSelectionStore.getState().setSelection({
      path: '/tmp/a.ts',
      name: 'a.ts',
      startLine: 3,
      endLine: 5,
      text: 'b\nc\nd',
    })

    const attachButton = (await screen.findByLabelText(
      translations.zh.attachContext
    )) as HTMLButtonElement
    await waitFor(() => expect(attachButton.disabled).toBe(false))
    fireEvent.click(attachButton)
    fireEvent.click(screen.getByText(translations.zh.attachSelection))

    expect(useChatStore.getState().conversations[sessionKey].attachments[0]).toMatchObject({
      kind: 'snippet',
      path: '/tmp/a.ts',
      startLine: 3,
      endLine: 5,
    })
    expect(screen.getByText('a.ts:3–5')).toBeTruthy()
  })

  it('virtualizes long transcripts instead of rendering every message', async () => {
    const messages = Array.from({ length: 200 }, (_, index) => ({
      role: 'assistant' as const,
      content: `message ${index}`,
      timestamp: index + 1,
    }))
    useSessionStore.getState().setSessions('/ws', [session])
    useSessionStore.getState().setOpen('/ws', [session.id], session.id)
    useChatStore.getState().setMessages(sessionKey, messages)

    render(<ChatPanel workspacePath="/ws" />)

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="chat-message"]').length).toBeGreaterThan(0)
    })
    expect(document.querySelectorAll('[data-testid="chat-message"]').length).toBeLessThan(60)
    expect(screen.queryByText('message 199')).toBeNull()
  })

  it('creates a new session and switches between tabs', async () => {
    const second: SessionSummary = {
      id: 's2',
      title: 'Second session',
      messageCount: 1,
      createdAt: 2,
      updatedAt: 3,
    }
    vi.mocked(piAgentAPI.sessionsList).mockResolvedValue({
      success: true,
      sessions: [session, second],
      currentId: session.id,
    })
    vi.mocked(piAgentAPI.sessionsCreate).mockResolvedValue({
      success: true,
      session: second,
      history: [],
    })
    vi.mocked(piAgentAPI.sessionsOpen).mockImplementation(
      async (_workspace: string, sessionId?: string) =>
        sessionId === second.id
          ? {
              success: true,
              session: second,
              history: [{ role: 'assistant', content: 'second history', timestamp: 5 }],
            }
          : { success: true, session, history: [] }
    )

    render(<ChatPanel workspacePath="/ws" />)

    const newButton = await screen.findByLabelText(translations.zh.newSession)
    await waitFor(() => expect(newButton).toBeTruthy())
    fireEvent.click(newButton)

    await waitFor(() => {
      expect(piAgentAPI.sessionsCreate).toHaveBeenCalledWith('/ws')
    })
    const firstTab = await screen.findByRole('tab', { name: /Session 1/ })
    fireEvent.click(firstTab)
    const secondTab = await screen.findByRole('tab', { name: /Second session/ })
    fireEvent.click(secondTab)

    await waitFor(() => {
      expect(screen.getByText('second history')).toBeTruthy()
    })
    expect(
      useSessionStore.getState().byWorkspace['/ws'].open
    ).toEqual(expect.arrayContaining([session.id, second.id]))
  })

  it('marks a failed request as error and clears it on the next successful send', async () => {
    vi.mocked(piAgentAPI.chat).mockResolvedValue({ success: false, error: 'provider down' })
    render(<ChatPanel workspacePath="/ws" />)

    const input = (await screen.findByPlaceholderText(
      translations.zh.inputPlaceholder
    )) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))

    fireEvent.change(input, { target: { value: 'first try' } })
    fireEvent.click(screen.getByText(translations.zh.send))

    await waitFor(() => {
      expect(useSessionStore.getState().errors[sessionKey]).toBe('provider down')
    })
    expect(screen.getByRole('tab', { name: /Session 1/ }).getAttribute('aria-label')).toContain(
      translations.zh.sessionError
    )

    vi.mocked(piAgentAPI.chat).mockResolvedValue({ success: true, response: 'ok' })
    fireEvent.change(input, { target: { value: 'second try' } })
    fireEvent.click(screen.getByText(translations.zh.send))

    await waitFor(() => {
      expect(useSessionStore.getState().errors[sessionKey]).toBeUndefined()
    })
  })

  it('does not mark an error when the user stops the request', async () => {
    const captured: {
      resolve: ((value: { success: boolean; error?: string }) => void) | null
    } = { resolve: null }
    vi.mocked(piAgentAPI.chat).mockImplementation(
      () =>
        new Promise((resolve) => {
          captured.resolve = resolve
        })
    )
    vi.mocked(piAgentAPI.abort).mockImplementation(async () => {
      captured.resolve?.({ success: false, error: 'aborted' })
      return { success: true }
    })

    render(<ChatPanel workspacePath="/ws" />)
    const input = (await screen.findByPlaceholderText(
      translations.zh.inputPlaceholder
    )) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))

    fireEvent.change(input, { target: { value: 'stop me' } })
    fireEvent.click(screen.getByText(translations.zh.send))
    await waitFor(() => {
      expect(useSessionStore.getState().streaming[sessionKey]).toBe(true)
    })

    fireEvent.click(screen.getByText(translations.zh.stop))

    await waitFor(() => {
      expect(useSessionStore.getState().streaming[sessionKey]).toBeUndefined()
    })
    expect(useSessionStore.getState().errors[sessionKey]).toBeUndefined()
  })

  it('marks a background completion as unread and clears it when the tab is activated', async () => {
    const second: SessionSummary = {
      id: 's2',
      title: 'Second session',
      messageCount: 0,
      createdAt: 2,
      updatedAt: 3,
    }
    vi.mocked(piAgentAPI.sessionsList).mockResolvedValue({
      success: true,
      sessions: [session, second],
      currentId: session.id,
    })
    vi.mocked(piAgentAPI.sessionsGetTabs).mockResolvedValue({
      success: true,
      tabs: { open: [session.id], active: session.id },
    })
    vi.mocked(piAgentAPI.sessionsOpen).mockImplementation(
      async (_workspace: string, sessionId?: string) =>
        sessionId === second.id
          ? { success: true, session: second, history: [] }
          : { success: true, session, history: [] }
    )
    vi.mocked(piAgentAPI.sessionsCreate).mockResolvedValue({
      success: true,
      session: second,
      history: [],
    })

    const captured: {
      resolve: ((value: { success: boolean; response?: string }) => void) | null
    } = { resolve: null }
    vi.mocked(piAgentAPI.chat).mockImplementation(
      () =>
        new Promise((resolve) => {
          captured.resolve = resolve
        })
    )

    render(<ChatPanel workspacePath="/ws" />)
    const input = (await screen.findByPlaceholderText(
      translations.zh.inputPlaceholder
    )) as HTMLTextAreaElement
    await waitFor(() => expect(input.disabled).toBe(false))

    fireEvent.change(input, { target: { value: 'run in background' } })
    fireEvent.click(screen.getByText(translations.zh.send))
    await waitFor(() => {
      expect(useSessionStore.getState().streaming[sessionKey]).toBe(true)
    })

    // 切到第二个会话，A 在后台继续运行
    fireEvent.click(screen.getByLabelText(translations.zh.newSession))
    await waitFor(() => {
      expect(useSessionStore.getState().byWorkspace['/ws'].active).toBe('s2')
    })

    captured.resolve?.({ success: true, response: 'done in background' })

    await waitFor(() => {
      expect(useSessionStore.getState().streaming[sessionKey]).toBeUndefined()
      expect(useSessionStore.getState().unread[sessionKey]).toBe(true)
    })
    expect(screen.getByRole('tab', { name: /Session 1/ }).getAttribute('aria-label')).toContain(
      translations.zh.sessionUnread
    )

    fireEvent.click(screen.getByRole('tab', { name: /Session 1/ }))
    await waitFor(() => {
      expect(useSessionStore.getState().unread[sessionKey]).toBeUndefined()
    })
  })

  it('closes a session tab and falls back to another tab', async () => {
    const second: SessionSummary = {
      id: 's2',
      title: 'Second session',
      messageCount: 0,
      createdAt: 2,
      updatedAt: 3,
    }
    vi.mocked(piAgentAPI.sessionsList).mockResolvedValue({
      success: true,
      sessions: [session, second],
      currentId: session.id,
    })
    vi.mocked(piAgentAPI.sessionsGetTabs).mockResolvedValue({
      success: true,
      tabs: { open: ['s1', 's2'], active: 's1' },
    })

    render(<ChatPanel workspacePath="/ws" />)
    const closeButtons = await screen.findAllByLabelText(translations.zh.closeSessionTab)
    fireEvent.click(closeButtons[0])

    await waitFor(() => {
      expect(piAgentAPI.sessionsClose).toHaveBeenCalledWith('/ws', 's1')
    })
    expect(useSessionStore.getState().byWorkspace['/ws'].active).toBe('s2')
  })
})

describe('WelcomeScreen', () => {
  const recent = ['/work/alpha', '/work/beta', '/work/gamma']

  const renderWelcome = () => {
    const props = {
      recentWorkspaces: recent,
      onOpenProject: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onOpenSettings: vi.fn(),
      onRefreshRecent: vi.fn(),
    }
    render(<WelcomeScreen {...props} />)
    return props
  }

  beforeEach(() => {
    vi.mocked(api.apiConfigGet).mockResolvedValue({
      success: true,
      config: configWithKey,
    })
  })

  it('shows every recent workspace and filters it by search', async () => {
    const props = renderWelcome()
    const list = within(screen.getByTestId('welcome-recent-list'))

    expect(await list.findByText('alpha')).toBeTruthy()
    expect(list.getByText('beta')).toBeTruthy()
    expect(list.getByText('gamma')).toBeTruthy()
    expect(screen.getByText('共 3 个项目')).toBeTruthy()

    fireEvent.change(screen.getByLabelText(translations.zh.welcomeSearch), {
      target: { value: 'beta' },
    })

    expect(list.queryByText('alpha')).toBeNull()
    expect(list.getByText('beta')).toBeTruthy()
    expect(screen.getByText('共 1 个项目')).toBeTruthy()

    fireEvent.click(list.getByText('beta'))
    expect(props.onOpenWorkspace).toHaveBeenCalledWith('/work/beta')
  })

  it('mirrors the eyebrow and headline when the language changes', async () => {
    useI18nStore.getState().setLanguage('en')
    renderWelcome()

    expect(await screen.findByText('Pi Workbench —')).toBeTruthy()
    expect(screen.getByText('Pi 工作台 —— 安静的地方，响亮的主意')).toBeTruthy()
    expect(screen.getByText('Loud Ideas')).toBeTruthy()
  })
})

describe('FileExplorer', () => {
  it('opens a file whose content is an empty string', async () => {
    vi.mocked(api.listDirectory).mockResolvedValue({
      success: true,
      items: [{ name: 'empty.txt', path: '/ws/empty.txt', isDirectory: false }],
    })
    vi.mocked(api.readFile).mockResolvedValue({ success: true, content: '' })

    render(<FileExplorer workspacePath="/ws" />)
    const fileLabel = await screen.findByText('empty.txt')
    fireEvent.click(fileLabel)

    await waitFor(() => {
      expect(
        useEditorStore.getState().openFiles.some((file) => file.path === '/ws/empty.txt')
      ).toBe(true)
    })
    expect(useEditorStore.getState().currentFile?.content).toBe('')
  })
})

describe('MonacoEditor', () => {
  it('syncs external changes for files open in background tabs', async () => {
    let fsChanged: ((payload: { type: string; path: string }) => void) | null = null
    vi.mocked(api.onFsChanged).mockImplementation((callback) => {
      fsChanged = callback
      return () => {}
    })
    vi.mocked(api.exists).mockResolvedValue({ success: true, exists: true })
    vi.mocked(api.readFile).mockResolvedValue({ success: true, content: 'updated-a' })

    render(<MonacoEditor />)
    act(() => {
      useEditorStore.getState().addOpenFile({
        path: '/ws/a.ts',
        name: 'a.ts',
        content: 'old-a',
        isDirty: false,
        isSaving: false,
      })
      useEditorStore.getState().addOpenFile({
        path: '/ws/b.ts',
        name: 'b.ts',
        content: 'b',
        isDirty: false,
        isSaving: false,
      })
    })

    // 当前文件是 b.ts，外部修改的是后台标签页 a.ts
    act(() => {
      fsChanged?.({ type: 'change', path: '/ws/a.ts' })
    })

    await waitFor(() => {
      const file = useEditorStore.getState().openFiles.find((item) => item.path === '/ws/a.ts')
      expect(file?.content).toBe('updated-a')
    })
  })
})
