import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { AgentManager, type AgentConfig } from '../pi-bridge/src/agent-manager'

const sdk = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  modelRuntimeCreate: vi.fn(),
  continueRecent: vi.fn(),
  sessionCreate: vi.fn(),
  sessionOpen: vi.fn(),
  sessionFindById: vi.fn(),
  sessionList: vi.fn(),
  loaders: [] as Array<{ options: any }>,
}))

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: sdk.createAgentSession,
  ModelRuntime: { create: sdk.modelRuntimeCreate },
  DefaultResourceLoader: class {
    options: any
    constructor(options: any) {
      this.options = options
      sdk.loaders.push(this)
    }
    async reload() {}
  },
  SettingsManager: { create: () => ({}) },
  SessionManager: {
    continueRecent: sdk.continueRecent,
    create: sdk.sessionCreate,
    open: sdk.sessionOpen,
    findById: sdk.sessionFindById,
    list: sdk.sessionList,
  },
}))

type SessionEvent = Record<string, unknown>

interface FakeSession {
  messages: Array<Record<string, unknown>>
  disposed: boolean
  subscribe: (listener: (event: SessionEvent) => void) => () => void
  prompt: (message: string) => Promise<void>
  lastPromptOptions?: { streamingBehavior?: string }
  abort: () => Promise<void>
  dispose: () => void
  emit: (event: SessionEvent) => void
  activeTools: string[]
  getActiveToolNames: () => string[]
  setActiveToolsByName: (names: string[]) => void
  getAllTools: () => Array<{ name: string }>
}

function createFakeSession(
  onPrompt?: (session: FakeSession, message: string) => Promise<void>
): FakeSession {
  const listeners = new Set<(event: SessionEvent) => void>()
  const session: FakeSession = {
    messages: [],
    disposed: false,
    activeTools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    getActiveToolNames: () => [...session.activeTools],
    setActiveToolsByName: (names) => {
      session.activeTools = [...names]
    },
    getAllTools: () => session.activeTools.map((name) => ({ name })),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    prompt: async (message, options?: { streamingBehavior?: string }) => {
      session.lastPromptOptions = options
      await onPrompt?.(session, message)
    },
    abort: async () => {},
    dispose: () => {
      session.disposed = true
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
  }
  return session
}

function createFakeSessionManager(id = 'session-1') {
  let name: string | undefined
  let persisted = false
  return {
    getSessionId: () => id,
    getSessionFile: () => (persisted ? `/tmp/${id}.jsonl` : null),
    getHeader: () => ({
      type: 'session',
      id,
      timestamp: new Date().toISOString(),
      cwd: workspaceDir,
    }),
    getSessionName: () => name,
    appendSessionInfo: (value: string) => {
      name = value
      persisted = true
      return 'entry-1'
    },
    isPersisted: () => persisted,
  }
}

function primeSdk(
  session: FakeSession,
  model: Record<string, unknown> | null = { provider: 'pi-workbench', id: 'test-model' }
): void {
  sdk.modelRuntimeCreate.mockResolvedValue({
    getModel: vi.fn(() => model),
  })
  sdk.continueRecent.mockImplementation(() => createFakeSessionManager())
  sdk.sessionCreate.mockImplementation(() => createFakeSessionManager('session-new'))
  sdk.sessionFindById.mockImplementation(
    (_cwd: string, id: string) => `/tmp/${id}.jsonl`
  )
  sdk.sessionOpen.mockImplementation((file: string) =>
    createFakeSessionManager(path.basename(file, '.jsonl'))
  )
  sdk.sessionList.mockResolvedValue([])
  sdk.createAgentSession.mockResolvedValue({ session })
}

let tmpRoot: string
let workspaceDir: string
let agentDir: string
let manager: AgentManager

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    workspaceDir,
    agentDir,
    apiConfig: {
      provider: 'openai',
      apiUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-secret',
      selectedModel: 'test-model',
    },
    ...overrides,
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  sdk.loaders.length = 0
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-test-'))
  workspaceDir = path.join(tmpRoot, 'workspace')
  agentDir = path.join(tmpRoot, 'agent')
  await fs.mkdir(workspaceDir, { recursive: true })
  manager = new AgentManager()
})

afterEach(async () => {
  await manager.dispose()
  await fs.rm(tmpRoot, { recursive: true, force: true })
  delete process.env.PI_WORKBENCH_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  vi.unstubAllGlobals()
})

describe('AgentManager initialization', () => {
  it('routes logs to the injected logger', async () => {
    primeSdk(createFakeSession())
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }

    const result = await manager.initialize(makeConfig({ logger }))

    expect(result.success).toBe(true)
    expect(logger.info).toHaveBeenCalledWith('[Agent Manager] Initializing agent...')
    expect(logger.info).toHaveBeenCalledWith(
      '[Agent Manager] Agent initialized successfully'
    )
  })

  it('writes models.json for an OpenAI-compatible endpoint without the key on disk', async () => {
    primeSdk(createFakeSession())

    const result = await manager.initialize(makeConfig())

    expect(result.success).toBe(true)
    expect(manager.isInitialized()).toBe(true)

    const modelsPath = path.join(agentDir, 'models.json')
    const raw = await fs.readFile(modelsPath, 'utf-8')
    const parsed = JSON.parse(raw)

    expect(parsed.providers['pi-workbench']).toEqual({
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      apiKey: '$PI_WORKBENCH_API_KEY',
      models: [{ id: 'test-model' }],
    })
    expect(raw).not.toContain('sk-secret')
    expect(process.env.PI_WORKBENCH_API_KEY).toBe('sk-secret')
    expect(process.env.OPENAI_API_KEY).toBe('sk-secret')
  })

  it('uses the anthropic-messages API for Anthropic providers', async () => {
    primeSdk(createFakeSession())

    await manager.initialize(
      makeConfig({
        apiConfig: {
          provider: 'anthropic',
          apiUrl: 'https://api.anthropic.com/v1/',
          apiKey: 'sk-ant',
          selectedModel: 'claude-model',
        },
      })
    )

    const parsed = JSON.parse(await fs.readFile(path.join(agentDir, 'models.json'), 'utf-8'))
    expect(parsed.providers['pi-workbench'].api).toBe('anthropic-messages')
    expect(parsed.providers['pi-workbench'].baseUrl).toBe('https://api.anthropic.com/v1')
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant')
  })

  it('defaults agentDir to the workspace .pi-workbench directory', async () => {
    primeSdk(createFakeSession())

    const config = makeConfig()
    delete config.agentDir
    await manager.initialize(config)

    const modelsPath = path.join(workspaceDir, '.pi-workbench', 'agent', 'models.json')
    await expect(fs.readFile(modelsPath, 'utf-8')).resolves.toContain('pi-workbench')
  })

  it('fails when the selected model is not available', async () => {
    primeSdk(createFakeSession(), null)

    const result = await manager.initialize(makeConfig())

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
    expect(manager.isInitialized()).toBe(false)
    expect(sdk.createAgentSession).not.toHaveBeenCalled()
  })

  it('disposes the previous session when re-initialized', async () => {
    const first = createFakeSession()
    primeSdk(first)
    await manager.initialize(makeConfig())

    const second = createFakeSession()
    primeSdk(second)
    const secondAgentDir = path.join(tmpRoot, 'agent-2')
    await manager.initialize(makeConfig({ agentDir: secondAgentDir }))

    expect(first.disposed).toBe(true)
    expect(second.disposed).toBe(false)
    expect(manager.getConfig()?.agentDir).toBe(secondAgentDir)
  })
})

describe('AgentManager chat', () => {
  it('returns an error before initialization', async () => {
    const result = await manager.chat('hello')

    expect(result.success).toBe(false)
    expect(result.error).toContain('not initialized')
  })

  it('returns the last assistant message and records history', async () => {
    const session = createFakeSession(async (s, message) => {
      s.messages.push({ role: 'user', content: message })
      s.messages.push({ role: 'assistant', content: 'Hello from the agent' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const result = await manager.chat('hi')

    expect(result.success).toBe(true)
    expect(result.response).toBe('Hello from the agent')
    expect(manager.getMessageHistory().map((m) => m.content)).toEqual([
      'hi',
      'Hello from the agent',
    ])
  })

  it('joins text parts of array-content responses', async () => {
    const session = createFakeSession(async (s) => {
      s.messages.push({
        role: 'assistant',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'tool_use', id: 't' },
          { type: 'text', text: 'part two' },
        ],
      })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const result = await manager.chat('hi')

    expect(result.response).toBe('part one\npart two')
  })

  it('surfaces provider errors carried in stopReason', async () => {
    const session = createFakeSession(async (s) => {
      s.messages.push({
        role: 'assistant',
        content: '',
        stopReason: 'error',
        errorMessage: '401 Unauthorized',
      })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const result = await manager.chat('hi')

    expect(result.success).toBe(false)
    expect(result.error).toBe('401 Unauthorized')
  })

  it('reports aborted requests', async () => {
    const session = createFakeSession(async (s) => {
      s.messages.push({ role: 'assistant', content: '', stopReason: 'aborted' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const result = await manager.chat('hi')

    expect(result.success).toBe(false)
    expect(result.error).toContain('aborted')
  })

  it('aborts and reports an error when the request times out', async () => {
    let resolvePrompt: (() => void) | null = null
    const session = createFakeSession(
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve
        })
    )
    session.abort = vi.fn(async () => {
      resolvePrompt?.()
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    vi.useFakeTimers()
    try {
      const pending = manager.chat('hi', { timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(1000)
      const result = await pending

      expect(session.abort).toHaveBeenCalled()
      expect(result.success).toBe(false)
      expect(result.error).toContain('timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports when the agent produced no response', async () => {
    const session = createFakeSession(async () => {
      // 不产生 assistant 消息
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const result = await manager.chat('hi')

    expect(result.success).toBe(false)
    expect(result.error).toContain('did not produce')
  })

  it('does not return an assistant message from a previous round', async () => {
    const session = createFakeSession(async () => {
      // 本轮失败，没有新的 assistant 消息
    })
    session.messages.push({ role: 'assistant', content: 'previous reply' })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const result = await manager.chat('hi')

    expect(result.success).toBe(false)
    expect(result.response).toBeUndefined()
    expect(result.error).toContain('did not produce')
  })

  it('hard-stops a request whose abort never settles', async () => {
    const session = createFakeSession(() => new Promise<void>(() => {}))
    session.abort = vi.fn(async () => {
      // SDK 没有响应 abort
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    vi.useFakeTimers()
    try {
      const pending = manager.chat('hi', { timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending

      expect(session.abort).toHaveBeenCalled()
      expect(result.success).toBe(false)
      expect(result.error).toContain('timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards text deltas while the agent streams', async () => {
    const session = createFakeSession(async (s) => {
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hel' },
      })
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'lo' },
      })
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'hidden' },
      })
      s.messages.push({ role: 'assistant', content: 'Hello' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const chunks: string[] = []
    const result = await manager.chat('hi', { onTextDelta: (delta) => chunks.push(delta) })

    expect(chunks).toEqual(['Hel', 'lo'])
    expect(result.response).toBe('Hello')
  })

  it('stops forwarding deltas after the run completes', async () => {
    const session = createFakeSession(async (s) => {
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'a' },
      })
      s.messages.push({ role: 'assistant', content: 'a' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const chunks: string[] = []
    await manager.chat('hi', { onTextDelta: (delta) => chunks.push(delta) })

    session.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'late' },
    })

    expect(chunks).toEqual(['a'])
  })

  it('forwards ordered thinking, text and tool trace events', async () => {
    const session = createFakeSession(async (s) => {
      s.emit({ type: 'message_start', message: { role: 'assistant' } })
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'plan' },
      })
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'answer' },
      })
      s.emit({
        type: 'tool_execution_start',
        toolName: 'read',
        toolCallId: 'call-1',
        args: { path: 'a.ts' },
      })
      s.emit({
        type: 'tool_execution_end',
        toolName: 'read',
        toolCallId: 'call-1',
        result: { content: [{ type: 'text', text: 'file body' }] },
        isError: false,
        durationMs: 12,
      })
      s.messages.push({ role: 'assistant', content: 'answer' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const events: Array<Record<string, unknown>> = []
    await manager.chat('go', { onTrace: (event) => events.push(event) })

    expect(events.map((event) => event.type)).toEqual([
      'thinking_delta',
      'text_delta',
      'tool_start',
      'tool_end',
    ])
    expect(events[2]).toMatchObject({
      type: 'tool_start',
      toolCallId: 'call-1',
      toolName: 'read',
      argsSummary: 'a.ts',
    })
    expect(events[3]).toMatchObject({
      type: 'tool_end',
      toolCallId: 'call-1',
      status: 'success',
      durationMs: 12,
      resultPreview: 'file body',
    })
  })

  it('falls back to thinking_end content and marks empty thinking as redacted', async () => {
    const session = createFakeSession(async (s) => {
      s.emit({ type: 'message_start', message: { role: 'assistant' } })
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
      })
      s.emit({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex: 0,
          content: 'only at end',
        },
      })
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_start', contentIndex: 1 },
      })
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_end', contentIndex: 1, content: '' },
      })
      s.messages.push({ role: 'assistant', content: 'done' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const events: Array<Record<string, unknown>> = []
    await manager.chat('go', { onTrace: (event) => events.push(event) })

    expect(events).toEqual([
      { type: 'thinking_delta', delta: 'only at end' },
      { type: 'thinking_redacted' },
    ])
  })

  it('rejects concurrent requests while one is in flight', async () => {
    let releasePrompt: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const session = createFakeSession(async (s) => {
      await gate
      s.messages.push({ role: 'assistant', content: 'done' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const first = manager.chat('first')
    const second = await manager.chat('second')

    expect(second.success).toBe(false)
    expect(second.error).toContain('processing')

    releasePrompt()
    await expect(first).resolves.toMatchObject({ success: true, response: 'done' })
  })
})

describe('AgentManager edit capture', () => {
  it('captures write/edit tool changes with before and after content', async () => {
    const target = path.join(workspaceDir, 'notes.txt')
    const session = createFakeSession(async (s) => {
      s.emit({
        type: 'tool_execution_start',
        toolName: 'write',
        toolCallId: 'call-1',
        args: { path: 'notes.txt' },
      })
      await fs.writeFile(target, 'new content', 'utf-8')
      s.emit({ type: 'tool_execution_end', toolCallId: 'call-1' })
      s.messages.push({ role: 'assistant', content: 'Updated notes' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const result = await manager.chat('update notes')

    expect(result.edits).toEqual([
      {
        path: target,
        oldContent: '',
        newContent: 'new content',
        toolCallId: 'call-1',
      },
    ])
  })

  it('does not report edits when the file content is unchanged', async () => {
    const target = path.join(workspaceDir, 'same.txt')
    await fs.writeFile(target, 'same', 'utf-8')

    const session = createFakeSession(async (s) => {
      s.emit({
        type: 'tool_execution_start',
        toolName: 'write',
        toolCallId: 'call-2',
        args: { path: target },
      })
      await fs.writeFile(target, 'same', 'utf-8')
      s.emit({ type: 'tool_execution_end', toolCallId: 'call-2' })
      s.messages.push({ role: 'assistant', content: 'no-op' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const result = await manager.chat('no-op')

    expect(result.edits).toEqual([])
  })

  it('ignores non-writing tools', async () => {
    const session = createFakeSession(async (s) => {
      s.emit({
        type: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: 'call-3',
        args: { command: 'ls' },
      })
      s.emit({ type: 'tool_execution_end', toolCallId: 'call-3' })
      s.messages.push({ role: 'assistant', content: 'listed' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const result = await manager.chat('list files')

    expect(result.edits).toEqual([])
  })
})

describe('AgentManager session history', () => {
  it('normalizes persisted session messages for display', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    session.messages.push(
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'tool_use', id: 't' },
          { type: 'text', text: 'part two' },
        ],
        timestamp: 5,
      },
      { role: 'tool', content: 'tool result' },
      { role: 'assistant', content: [], timestamp: 6 }
    )

    expect(manager.getSessionMessages()).toEqual([
      { role: 'user', content: 'question', timestamp: expect.any(Number) },
      {
        role: 'assistant',
        content: 'part one\npart two',
        parts: [
          { type: 'text', id: 'text-1', text: 'part one' },
          { type: 'text', id: 'text-2', text: 'part two' },
        ],
        timestamp: 5,
      },
    ])
  })

  it('aggregates thinking, text and tool calls into one ordered assistant turn', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    session.messages.push(
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'before' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
        ],
        timestamp: 5,
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file body' }],
        isError: false,
        timestamp: 6,
        durationMs: 9,
      },
      { role: 'assistant', content: [{ type: 'text', text: 'after' }], timestamp: 7 }
    )

    const history = manager.getSessionMessages()
    const assistant = history.find((message) => message.role === 'assistant')
    expect(assistant?.content).toBe('before\nafter')
    expect(assistant?.parts?.map((part) => part.type)).toEqual([
      'thinking',
      'text',
      'tool',
      'text',
    ])
    expect(assistant?.parts?.[2]).toMatchObject({
      type: 'tool',
      toolCallId: 'call-1',
      toolName: 'read',
      status: 'success',
      durationMs: 9,
      resultPreview: 'file body',
    })
  })

  it('strips attached context blocks from restored user messages', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    session.messages.push({
      role: 'user',
      content:
        '<pi-workbench-context>\n--- /tmp/a.ts ---\nconst a = 1\n</pi-workbench-context>\n\nexplain this',
    })

    expect(manager.getSessionMessages()).toEqual([
      { role: 'user', content: 'explain this', timestamp: expect.any(Number) },
    ])
  })

  it('returns an empty list before initialization', () => {
    expect(manager.getSessionMessages()).toEqual([])
  })
})

describe('AgentManager sessions', () => {
  async function until(check: () => boolean, timeoutMs = 1000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (check()) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('Timed out waiting for condition')
  }

  it('creates, renames and closes independent sessions', async () => {
    const first = createFakeSession()
    primeSdk(first)
    await manager.initialize(makeConfig())

    const second = createFakeSession()
    sdk.createAgentSession.mockResolvedValue({ session: second })

    const created = await manager.createSession()
    expect(created.success).toBe(true)
    expect(created.session?.id).toBe('session-new')
    expect(manager.getCurrentSessionId()).toBe('session-new')

    const renamed = await manager.renameSession('session-new', 'Release checklist')
    expect(renamed.success).toBe(true)

    sdk.sessionList.mockResolvedValue([
      {
        id: 'session-old',
        cwd: workspaceDir,
        name: 'Older session',
        created: new Date(1),
        modified: new Date(2),
        messageCount: 4,
        firstMessage: 'old',
        allMessagesText: '',
        path: '/tmp/session-old.jsonl',
      },
    ])
    const sessions = await manager.listSessions()
    expect(sessions.find((session) => session.id === 'session-new')?.title).toBe(
      'Release checklist'
    )
    expect(sessions.find((session) => session.id === 'session-old')?.messageCount).toBe(4)

    await manager.closeSession('session-new')
    expect(second.disposed).toBe(true)
    expect(manager.getCurrentSessionId()).toBeNull()
  })

  it('opens an existing session by id', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig())

    const reopened = createFakeSession()
    reopened.messages.push({ role: 'user', content: 'restored' })
    reopened.messages.push({ role: 'assistant', content: 'hello again' })
    sdk.createAgentSession.mockResolvedValue({ session: reopened })
    sdk.sessionFindById.mockReturnValue('/tmp/other-session.jsonl')

    const opened = await manager.openSession('other-session')
    expect(opened.success).toBe(true)
    expect(opened.session?.id).toBe('other-session')
    expect(opened.history).toEqual([
      { role: 'user', content: 'restored', timestamp: expect.any(Number) },
      {
        role: 'assistant',
        content: 'hello again',
        parts: [{ type: 'text', id: 'text-1', text: 'hello again' }],
        timestamp: expect.any(Number),
      },
    ])
  })

  it('refuses to delete a session outside the session directory', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig())
    sdk.sessionFindById.mockReturnValue('/tmp/outside.jsonl')

    const result = await manager.deleteSession('outside')
    expect(result.success).toBe(false)
    expect(result.error).toContain('outside the session directory')
  })

  it('runs two sessions concurrently without blocking each other', async () => {
    const first = createFakeSession(async (session) => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      session.messages.push({ role: 'user', content: 'first prompt' })
      session.messages.push({ role: 'assistant', content: 'first answer' })
    })
    primeSdk(first)
    await manager.initialize(makeConfig())

    const second = createFakeSession(async (session) => {
      session.messages.push({ role: 'user', content: 'second prompt' })
      session.messages.push({ role: 'assistant', content: 'second answer' })
    })
    sdk.createAgentSession.mockResolvedValue({ session: second })
    const created = await manager.createSession()
    expect(created.success).toBe(true)

    const [firstResult, secondResult] = await Promise.all([
      manager.chat('session-1', 'first prompt'),
      manager.chat('session-new', 'second prompt'),
    ])

    expect(firstResult).toMatchObject({ success: true, response: 'first answer' })
    expect(secondResult).toMatchObject({ success: true, response: 'second answer' })
    expect(manager.getSessionMessages('session-1')[0]?.content).toBe('first prompt')
    expect(manager.getSessionMessages('session-new')[0]?.content).toBe('second prompt')
  })

  it('generates a model title after the first assistant turn', async () => {
    const session = createFakeSession(async (fake) => {
      fake.messages.push({ role: 'user', content: 'Fix the login redirect loop' })
      fake.messages.push({ role: 'assistant', content: 'I updated the auth guard.' })
    })
    primeSdk(session)
    const onSessionTitle = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Fix login redirect' } }] }),
      })
    )

    await manager.initialize(makeConfig({ onSessionTitle }))
    const result = await manager.chat('Fix the login redirect loop')
    expect(result.success).toBe(true)

    await until(() => onSessionTitle.mock.calls.length > 0)
    expect(onSessionTitle).toHaveBeenCalledWith('session-1', 'Fix login redirect')
  })
})

describe('AgentManager dispose', () => {
  it('releases the session and clears configuration', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    await manager.dispose()

    expect(session.disposed).toBe(true)
    expect(manager.isInitialized()).toBe(false)
    expect(manager.getConfig()).toBeNull()
    expect(manager.getMessageHistory()).toEqual([])
  })

  it('aborts an in-flight request before disposing', async () => {
    let release: () => void = () => {}
    const session = createFakeSession(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    session.abort = vi.fn(async () => release())
    primeSdk(session)
    await manager.initialize(makeConfig())

    const pending = manager.chat('hi')
    await manager.dispose()

    expect(session.abort).toHaveBeenCalled()
    await expect(pending).resolves.toMatchObject({ success: false })
    expect(session.disposed).toBe(true)
  })

  it('restores provider environment variables after the last instance is disposed', async () => {
    process.env.OPENAI_API_KEY = 'previous-key'
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    expect(process.env.OPENAI_API_KEY).toBe('sk-secret')
    expect(process.env.PI_WORKBENCH_API_KEY).toBe('sk-secret')

    await manager.dispose()

    expect(process.env.OPENAI_API_KEY).toBe('previous-key')
    expect(process.env.PI_WORKBENCH_API_KEY).toBeUndefined()
  })
})

describe('tool approvals', () => {
  function toolCallHandler(): (event: any) => Promise<any> {
    const loader = sdk.loaders[sdk.loaders.length - 1]
    const factories = loader?.options?.extensionFactories ?? []
    expect(factories).toHaveLength(1)
    let handler: ((event: any) => Promise<any>) | null = null
    factories[0]({
      on: (event: string, fn: (payload: any) => Promise<any>) => {
        if (event === 'tool_call') handler = fn
      },
    })
    if (!handler) throw new Error('tool_call handler was not registered')
    return handler
  }

  const readCall = { toolName: 'read', input: { path: 'a.ts' }, toolCallId: 'c-read' }
  const writeCall = {
    toolName: 'write',
    input: { path: 'a.ts', content: 'hello' },
    toolCallId: 'c-write',
  }

  it('lets read-only tools through with the default policy', async () => {
    primeSdk(createFakeSession())
    const requestApproval = vi.fn()
    await manager.initialize(makeConfig({ requestApproval }))

    await expect(toolCallHandler()(readCall)).resolves.toBeUndefined()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('asks before writing and passes the denial reason back to the model', async () => {
    primeSdk(createFakeSession())
    const requestApproval = vi.fn().mockResolvedValue({ action: 'deny', reason: 'not now' })
    await manager.initialize(makeConfig({ requestApproval }))

    const result = await toolCallHandler()(writeCall)

    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(requestApproval.mock.calls[0][0]).toMatchObject({
      toolName: 'write',
      category: 'write',
      sessionId: 'session-1',
      summary: expect.stringContaining('a.ts'),
    })
    expect(result).toMatchObject({ block: true })
    expect(result.reason).toContain('not now')
  })

  it('remembers allow-for-session decisions', async () => {
    primeSdk(createFakeSession())
    const requestApproval = vi
      .fn()
      .mockResolvedValueOnce({ action: 'allow-session' })
      .mockResolvedValue({ action: 'deny' })
    await manager.initialize(makeConfig({ requestApproval }))

    const handler = toolCallHandler()
    await expect(handler(writeCall)).resolves.toBeUndefined()
    await expect(handler({ ...writeCall, toolCallId: 'c-write-2' })).resolves.toBeUndefined()
    expect(requestApproval).toHaveBeenCalledTimes(1)
  })

  it('persists always-allow decisions through the host callback', async () => {
    primeSdk(createFakeSession())
    const requestApproval = vi.fn().mockResolvedValue({ action: 'allow-always' })
    const onPermissionAlwaysAllow = vi.fn()
    await manager.initialize(makeConfig({ requestApproval, onPermissionAlwaysAllow }))

    await expect(toolCallHandler()(writeCall)).resolves.toBeUndefined()
    expect(onPermissionAlwaysAllow).toHaveBeenCalledWith('write')
  })

  it('fails closed when no approval channel is available', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig())

    const result = await toolCallHandler()(writeCall)
    expect(result).toMatchObject({ block: true })
    expect(result.reason).toContain('No approval channel')
  })

  it('honours a deny policy without asking', async () => {
    primeSdk(createFakeSession())
    const requestApproval = vi.fn()
    await manager.initialize(
      makeConfig({
        requestApproval,
        getPermissionPolicy: () => ({ read: 'allow', write: 'deny', command: 'deny', other: 'deny' }),
      })
    )

    const result = await toolCallHandler()(writeCall)
    expect(result).toMatchObject({ block: true })
    expect(result.reason).toContain('blocked by the current permission policy')
    expect(requestApproval).not.toHaveBeenCalled()
  })
})

describe('plan mode', () => {
  function toolCallHandler(): (event: any) => Promise<any> {
    const loader = sdk.loaders[sdk.loaders.length - 1]
    const factories = loader?.options?.extensionFactories ?? []
    let handler: ((event: any) => Promise<any>) | null = null
    factories[0]({
      on: (event: string, fn: (payload: any) => Promise<any>) => {
        if (event === 'tool_call') handler = fn
      },
    })
    if (!handler) throw new Error('tool_call handler was not registered')
    return handler
  }

  it('restricts the tool set in plan mode and restores it in act mode', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    await manager.setSessionMode('session-1', 'plan')
    expect(session.activeTools).toEqual(['read', 'grep', 'find', 'ls'])

    await manager.setSessionMode('session-1', 'act')
    expect(session.activeTools).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
  })

  it('blocks non-read tools while in plan mode', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())
    await manager.setSessionMode('session-1', 'plan')

    const handler = toolCallHandler()
    const blocked = await handler({
      toolName: 'write',
      input: { path: 'a.ts', content: 'x' },
      toolCallId: 'c1',
    })
    expect(blocked).toMatchObject({ block: true })
    expect(blocked.reason).toContain('Plan mode is read-only')

    await expect(
      handler({ toolName: 'read', input: { path: 'a.ts' }, toolCallId: 'c2' })
    ).resolves.toBeUndefined()
  })

  it('wraps prompts with the plan instruction and strips it from history', async () => {
    const prompts: string[] = []
    const session = createFakeSession(async (_session, message) => {
      prompts.push(message)
    })
    primeSdk(session)
    await manager.initialize(makeConfig())
    await manager.setSessionMode('session-1', 'plan')

    await manager.chat('add a feature')

    expect(prompts[0]).toContain('<pi-workbench-plan-mode>')
    expect(prompts[0]).toContain('Plan mode')
    expect(prompts[0]).toContain('add a feature')
    const history = manager.getMessageHistory('session-1') as Array<{ content: string }>
    expect(history.some((message) => message.content.includes('pi-workbench-plan-mode'))).toBe(false)
  })
})

describe('running-turn steering', () => {
  it('injects a message into the current turn with streamingBehavior steer', async () => {
    let release = () => {}
    let calls = 0
    const session = createFakeSession(() => {
      calls++
      if (calls > 1) return Promise.resolve()
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const pendingChat = manager.chat('start')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const result = await manager.steer('session-1', 'also fix the tests')
    expect(result).toEqual({ success: true })
    expect(session.lastPromptOptions).toEqual({ streamingBehavior: 'steer' })

    release()
    await pendingChat
  })

  it('rejects steering when the session is idle', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig())
    await expect(manager.steer('session-1', 'hi')).resolves.toEqual({
      success: false,
      error: 'Session is not running.',
    })
  })

  it('rejects empty steering messages', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig())
    await expect(manager.steer('session-1', '   ')).resolves.toEqual({
      success: false,
      error: 'Message is empty.',
    })
  })
})
