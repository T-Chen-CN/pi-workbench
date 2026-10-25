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
  reload: vi.fn(),
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
    async reload() {
      sdk.reload()
    }
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
  lastPromptOptions?: {
    streamingBehavior?: string
    images?: Array<{ type: 'image'; data: string; mimeType: string }>
  }
  abort: () => Promise<void>
  dispose: () => void
  emit: (event: SessionEvent) => void
  activeTools: string[]
  registeredTools: string[]
  getActiveToolNames: () => string[]
  setActiveToolsByName: (names: string[]) => void
  getAllTools: () => Array<{ name: string; exposure: string }>
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined
  getContextUsage: () => {
    tokens: number | null
    contextWindow: number
    percent: number | null
  } | undefined
  compact: () => Promise<{
    summary: string
    firstKeptEntryId: string
    tokensBefore: number
    estimatedTokensAfter?: number
  }>
  navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{
    cancelled: boolean
  }>
  getSessionStats: () => {
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
    cost: number
    toolCalls: number
    totalMessages: number
  }
  getUserMessagesForForking: () => Array<{ entryId: string; text: string }>
  model: { provider: string; id: string } | undefined
  thinkingLevel: string
  setModel: (model: { provider: string; id: string }) => Promise<void>
  setThinkingLevel: (level: string) => void
}

function createFakeSession(
  onPrompt?: (session: FakeSession, message: string) => Promise<void>
): FakeSession {
  const listeners = new Set<(event: SessionEvent) => void>()
  const session: FakeSession = {
    messages: [],
    disposed: false,
    activeTools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
    registeredTools: [
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      'submit_plan',
      'update_plan_step',
    ],
    getActiveToolNames: () => [...session.activeTools],
    setActiveToolsByName: (names) => {
      session.activeTools = [...names]
    },
    getAllTools: () =>
      session.registeredTools.map((name) => ({ name, exposure: 'direct' })),
    contextUsage: { tokens: 12_000, contextWindow: 96_000, percent: 12.5 },
    getContextUsage: () => session.contextUsage,
    compact: async () => ({
      summary: 'summary',
      firstKeptEntryId: 'entry-1',
      tokensBefore: 12_000,
      estimatedTokensAfter: 3_000,
    }),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    getSessionStats: () => ({
      tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
      cost: 0.42,
      toolCalls: 3,
      totalMessages: 8,
    }),
    getUserMessagesForForking: () => [
      { entryId: 'u1', text: 'first question' },
      { entryId: 'u2', text: 'second question' },
    ],
    model: { provider: 'pi-workbench', id: 'test-model' },
    thinkingLevel: 'medium',
    setModel: async (model) => {
      session.model = model
    },
    setThinkingLevel: (level) => {
      session.thinkingLevel = level
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    prompt: async (
      message,
      options?: {
        streamingBehavior?: string
        images?: Array<{ type: 'image'; data: string; mimeType: string }>
      }
    ) => {
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
  const entries = [
    {
      id: 'u1',
      parentId: null,
      type: 'message',
      message: { role: 'user', content: 'first question', timestamp: 1000 },
      timestamp: new Date(1000).toISOString(),
    },
    {
      id: 'u2',
      parentId: 'u1',
      type: 'message',
      message: { role: 'user', content: 'second question', timestamp: 2000 },
      timestamp: new Date(2000).toISOString(),
    },
  ]
  return {
    getSessionId: () => id,
    getCwd: () => workspaceDir,
    getSessionFile: () => (persisted ? `/tmp/${id}.jsonl` : null),
    getHeader: () => ({
      type: 'session',
      id,
      timestamp: new Date().toISOString(),
      cwd: workspaceDir,
    }),
    getSessionName: () => name,
    getLeafId: () => 'leaf-1',
    getEntry: (entryId: string) => entries.find((entry) => entry.id === entryId),
    getBranch: () => entries,
    getTree: () => [{ entry: entries[0], children: [{ entry: entries[1], children: [] }] }],
    branch: () => {},
    appendSessionInfo: (value: string) => {
      name = value
      persisted = true
      return 'entry-1'
    },
    isPersisted: () => persisted,
  }
}

type FakeTreeEntry = {
  id: string
  parentId: string | null
  type: 'message'
  message: { role: 'user' | 'assistant'; content: string; timestamp: number }
  timestamp: string
}

function treeEntry(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  content: string,
  timestamp: number
): FakeTreeEntry {
  return {
    id,
    parentId,
    type: 'message',
    message: { role, content, timestamp },
    timestamp: new Date(timestamp).toISOString(),
  }
}

/** 可切换分支的会话管理器：u1 下有两个助手回复 a1 / a2 */
function createTreeSessionManager(id: string, entries: FakeTreeEntry[], leafId: string) {
  const base = createFakeSessionManager(id)
  let leaf = leafId
  return {
    ...base,
    getLeafId: () => leaf,
    getEntry: (entryId: string) => entries.find((entry) => entry.id === entryId),
    getBranch: (fromId?: string) => {
      const pathEntries: FakeTreeEntry[] = []
      let current = entries.find((entry) => entry.id === (fromId ?? leaf))
      let guard = 0
      while (current && guard < 1000) {
        pathEntries.unshift(current)
        const parentId: string | null = current.parentId
        current = parentId ? entries.find((entry) => entry.id === parentId) : undefined
        guard += 1
      }
      return pathEntries
    },
    getTree: () => {
      const nodes = entries.map((entry) => ({ entry, children: [] as unknown[] }))
      const byId = new Map(nodes.map((node) => [node.entry.id, node]))
      for (const node of nodes) {
        if (node.entry.parentId) {
          const parent = byId.get(node.entry.parentId)
          if (parent) (parent.children as unknown[]).push(node)
        }
      }
      return nodes.filter((node) => !node.entry.parentId)
    },
    branch: (entryId: string) => {
      leaf = entryId
    },
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
  // Windows 上 extras 的异步落盘可能与清理竞争，稍等后重试
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true })
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
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
      models: [{ id: 'test-model', input: ['text'] }],
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

  it('passes image attachments to the session prompt', async () => {
    const session = createFakeSession(async (s, message) => {
      s.messages.push({ role: 'user', content: message })
      s.messages.push({ role: 'assistant', content: 'seen' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const image = { data: 'aGVsbG8=', mimeType: 'image/png' }
    await manager.chat('describe', { images: [image] })

    expect(session.lastPromptOptions?.images).toEqual([{ type: 'image', ...image }])
  })

  it('omits images when none are valid', async () => {
    const session = createFakeSession(async (s, message) => {
      s.messages.push({ role: 'user', content: message })
      s.messages.push({ role: 'assistant', content: 'ok' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    await manager.chat('hi', { images: [{ data: '', mimeType: 'image/png' }] })

    expect(session.lastPromptOptions).toBeUndefined()
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

  it('rejects session ids that could escape the sidecar directory', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig())

    const result = await manager.deleteSession('../../../config/settings')
    expect(result.success).toBe(false)
    expect(result.error).toBe('Invalid session id.')
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
    expect(factories.length).toBeGreaterThanOrEqual(1)
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

  it('remembers always-allow within the session', async () => {
    primeSdk(createFakeSession())
    const requestApproval = vi.fn().mockResolvedValue({ action: 'allow-always' })
    await manager.initialize(makeConfig({ requestApproval }))

    const handler = toolCallHandler()
    await expect(handler(writeCall)).resolves.toBeUndefined()
    await expect(handler({ ...writeCall, toolCallId: 'c-write-2' })).resolves.toBeUndefined()
    expect(requestApproval).toHaveBeenCalledTimes(1)
  })

  it('persists always-allow into the session permission', async () => {
    primeSdk(createFakeSession())
    const requestApproval = vi.fn().mockResolvedValue({ action: 'allow-always' })
    await manager.initialize(makeConfig({ requestApproval }))

    await expect(toolCallHandler()(writeCall)).resolves.toBeUndefined()
    const settings = await manager.getSessionSettings('session-1')
    expect(settings.success).toBe(true)
    expect(settings.permission).toEqual({ mode: 'ask', grants: ['write'] })
  })

  it('fails closed when no approval channel is available', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig())

    const result = await toolCallHandler()(writeCall)
    expect(result).toMatchObject({ block: true })
    expect(result.reason).toContain('No approval channel')
  })

  it('honours a read-only default without asking', async () => {
    primeSdk(createFakeSession())
    const requestApproval = vi.fn()
    await manager.initialize(
      makeConfig({
        requestApproval,
        getDefaultPermissionLevel: () => 'readonly',
      })
    )

    const result = await toolCallHandler()(writeCall)
    expect(result).toMatchObject({ block: true })
    expect(result.reason).toContain('blocked by the current permission policy')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('seeds the session permission from the default level', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig({ getDefaultPermissionLevel: () => 'auto' }))

    const settings = await manager.getSessionSettings('session-1')
    expect(settings.permission).toEqual({ mode: 'auto', grants: [] })
  })

  it('applies permission changes to the next tool call', async () => {
    primeSdk(createFakeSession())
    const requestApproval = vi.fn()
    await manager.initialize(
      makeConfig({
        requestApproval,
        getDefaultPermissionLevel: () => 'readonly',
      })
    )

    const handler = toolCallHandler()
    await expect(handler(writeCall)).resolves.toMatchObject({ block: true })

    const changed = await manager.setSessionPermission('session-1', {
      mode: 'ask',
      grants: ['write'],
    })
    expect(changed).toMatchObject({
      success: true,
      permission: { mode: 'ask', grants: ['write'] },
    })

    await expect(handler({ ...writeCall, toolCallId: 'c-write-2' })).resolves.toBeUndefined()
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

  it('switches the tool set with the session mode', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    // 执行模式使用所有已注册工具，但排除 plan-only 的 submit_plan
    const askTools = [
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      'update_plan_step',
    ]
    expect(session.activeTools).toEqual(askTools)

    await manager.setSessionPermission('session-1', { mode: 'plan', grants: [] })
    expect(session.activeTools).toEqual(['read', 'grep', 'find', 'ls', 'submit_plan'])

    await manager.setSessionPermission('session-1', { mode: 'readonly', grants: [] })
    expect(session.activeTools).toEqual(['read', 'grep', 'find', 'ls'])

    await manager.setSessionPermission('session-1', { mode: 'ask', grants: [] })
    expect(session.activeTools).toEqual(askTools)
  })

  it('blocks non-read tools while in plan mode', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())
    await manager.setSessionPermission('session-1', { mode: 'plan', grants: [] })

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
    await manager.setSessionPermission('session-1', { mode: 'plan', grants: [] })

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

describe('context usage and compaction', () => {
  it('returns the current context usage', async () => {
    const session = createFakeSession()
    session.contextUsage = { tokens: 40_000, contextWindow: 96_000, percent: 41.7 }
    primeSdk(session)
    await manager.initialize(makeConfig())

    await expect(manager.getContextUsage('session-1')).resolves.toEqual({
      success: true,
      usage: { tokens: 40_000, contextWindow: 96_000, percent: 41.7 },
    })
  })

  it('compacts an idle session and reports token counts', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    await expect(manager.compactContext('session-1')).resolves.toEqual({
      success: true,
      tokensBefore: 12_000,
      estimatedTokensAfter: 3_000,
    })
  })

  it('refuses to compact while a turn is running', async () => {
    let release = () => {}
    const session = createFakeSession(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    primeSdk(session)
    await manager.initialize(makeConfig())

    const pendingChat = manager.chat('start')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const result = await manager.compactContext('session-1')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Session is running')

    release()
    await pendingChat
  })
})


describe('retry and edit-resend', () => {
  it('rewinds to the last user message and returns its text', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    await expect(manager.rewindToLastUser('session-1')).resolves.toEqual({
      success: true,
      text: 'second question',
    })
    expect(session.navigateTree).toHaveBeenCalledWith('u2', { summarize: false })
  })

  it('uses the edited text when provided', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    await expect(manager.rewindToLastUser('session-1', 'edited question')).resolves.toEqual({
      success: true,
      text: 'edited question',
    })
  })

  it('refuses to rewind while the session is running', async () => {
    let release = () => {}
    const session = createFakeSession(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    primeSdk(session)
    await manager.initialize(makeConfig())

    const pendingChat = manager.chat('start')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const result = await manager.rewindToLastUser('session-1')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Session is running')

    release()
    await pendingChat
  })
})

describe('agent trace events', () => {
  it('forwards nested tool calls with their parent tool call id', async () => {
    const session = createFakeSession(async (s) => {
      s.messages.push({ role: 'user', content: 'hi' })
      s.emit({
        type: 'tool_execution_start',
        toolCallId: 'parent-call',
        toolName: 'read',
        args: { path: 'a.ts' },
      })
      s.emit({
        type: 'tool_execution_start',
        toolCallId: 'child-call',
        toolName: 'grep',
        args: { pattern: 'x' },
        parentToolCallId: 'parent-call',
      })
      s.emit({
        type: 'tool_execution_end',
        toolCallId: 'child-call',
        toolName: 'grep',
        isError: false,
        result: { content: 'ok' },
        durationMs: 5,
        parentToolCallId: 'parent-call',
      })
      s.messages.push({ role: 'assistant', content: 'done' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const events: Array<Record<string, unknown>> = []
    await manager.chat('hi', { onTrace: (event) => events.push(event) })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_start',
        toolCallId: 'child-call',
        parentToolCallId: 'parent-call',
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_end',
        toolCallId: 'child-call',
        parentToolCallId: 'parent-call',
      })
    )
  })
})

describe('conversation branches', () => {
  const entries = [
    treeEntry('u1', null, 'user', 'first question', 1000),
    treeEntry('a1', 'u1', 'assistant', 'first answer', 1100),
    treeEntry('a2', 'u1', 'assistant', 'second answer', 1200),
  ]

  function setupBranchSession(leafId = 'a2') {
    const session = createFakeSession()
    const treeManager = createTreeSessionManager('session-1', entries, leafId)
    primeSdk(session)
    sdk.continueRecent.mockImplementation(() => treeManager)
    return { session, treeManager }
  }

  it('lists reply branches for the current branch', async () => {
    const { session } = setupBranchSession()
    session.messages = [
      { role: 'user', content: 'first question', timestamp: 1000 },
      { role: 'assistant', content: 'second answer', timestamp: 1200 },
    ]
    await manager.initialize(makeConfig())

    const result = await manager.listBranches('session-1')

    expect(result.success).toBe(true)
    expect(result.groups).toEqual([
      {
        userTimestamp: 1000,
        activeIndex: 1,
        branches: [
          { entryId: 'a1', preview: 'first answer' },
          { entryId: 'a2', preview: 'second answer' },
        ],
      },
    ])
  })

  it('switches to the selected reply and returns its history', async () => {
    const { session, treeManager } = setupBranchSession()
    session.messages = [
      { role: 'user', content: 'first question', timestamp: 1000 },
      { role: 'assistant', content: 'second answer', timestamp: 1200 },
    ]
    vi.mocked(session.navigateTree).mockImplementation(async (entryId: string) => {
      treeManager.branch(entryId)
      session.messages = [
        { role: 'user', content: 'first question', timestamp: 1000 },
        { role: 'assistant', content: 'first answer', timestamp: 1100 },
      ]
      return { cancelled: false }
    })
    await manager.initialize(makeConfig())

    const result = await manager.switchBranch('session-1', 'a1')

    expect(session.navigateTree).toHaveBeenCalledWith('a1')
    expect(result.success).toBe(true)
    expect(result.history?.map((message) => message.content)).toEqual([
      'first question',
      'first answer',
    ])
    expect(treeManager.getLeafId()).toBe('a1')
  })

  it('refuses to switch while the session is running', async () => {
    let release = () => {}
    const session = createFakeSession(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const treeManager = createTreeSessionManager('session-1', entries, 'a2')
    primeSdk(session)
    sdk.continueRecent.mockImplementation(() => treeManager)
    await manager.initialize(makeConfig())

    const pendingChat = manager.chat('start')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const result = await manager.switchBranch('session-1', 'a1')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Session is running')

    release()
    await pendingChat
  })
})

describe('model capabilities', () => {
  it('reports catalog metadata and marks unavailable models', async () => {
    const session = createFakeSession()
    const models: Record<string, Record<string, unknown>> = {
      'deepseek-flash': {
        provider: 'pi-workbench',
        id: 'deepseek-flash',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 128_000,
        maxTokens: 8_192,
        thinkingLevelMap: { high: null },
      },
    }
    sdk.modelRuntimeCreate.mockResolvedValue({
      getModel: vi.fn((_provider: string, id: string) => models[id]),
    })
    sdk.continueRecent.mockImplementation(() => createFakeSessionManager())
    sdk.createAgentSession.mockResolvedValue({ session })

    await manager.initialize(
      makeConfig({
        apiConfig: {
          provider: 'openai',
          apiUrl: 'https://api.example.com/v1/',
          apiKey: 'sk-secret',
          selectedModel: 'deepseek-flash',
          availableModels: ['deepseek-flash', 'deepseek-v4-pro'],
        },
      })
    )

    const result = await manager.getModelCapabilities()

    expect(result.success).toBe(true)
    expect(result.models?.[0]).toMatchObject({
      id: 'deepseek-flash',
      available: true,
      source: 'catalog',
      contextWindow: 128_000,
      reasoning: true,
      vision: true,
    })
    expect(result.models?.[0].thinkingLevels).not.toContain('high')
    expect(result.models?.[1]).toMatchObject({ id: 'deepseek-v4-pro', available: false })

    const modelsJson = JSON.parse(
      await fs.readFile(path.join(agentDir, 'models.json'), 'utf-8')
    )
    const entries = modelsJson.providers['pi-workbench'].models
    expect(entries.map((model: { id: string }) => model.id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ])
    expect(entries.find((model: { id: string }) => model.id === 'deepseek-flash').input).toEqual([
      'text',
      'image',
    ])
    expect(entries.find((model: { id: string }) => model.id === 'deepseek-v4-pro').input).toEqual([
      'text',
    ])
  })

  it('follows the user image checkboxes in models.json', async () => {
    const session = createFakeSession()
    const models: Record<string, Record<string, unknown>> = {
      'deepseek-flash': {
        provider: 'pi-workbench',
        id: 'deepseek-flash',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      'custom-vision-model': {
        provider: 'pi-workbench',
        id: 'custom-vision-model',
        reasoning: false,
        input: ['text', 'image'],
        contextWindow: 64_000,
        maxTokens: 4_096,
      },
    }
    sdk.modelRuntimeCreate.mockResolvedValue({
      getModel: vi.fn((_provider: string, id: string) => models[id]),
    })
    sdk.continueRecent.mockImplementation(() => createFakeSessionManager())
    sdk.createAgentSession.mockResolvedValue({ session })

    await manager.initialize(
      makeConfig({
        apiConfig: {
          provider: 'openai',
          apiUrl: 'https://api.example.com/v1/',
          apiKey: 'sk-secret',
          selectedModel: 'custom-vision-model',
          availableModels: ['deepseek-flash', 'custom-vision-model'],
          imageModels: ['custom-vision-model'],
        },
      })
    )

    const capabilities = await manager.getModelCapabilities()
    expect(
      capabilities.models?.find((model) => model.id === 'deepseek-flash')?.vision
    ).toBe(false)
    expect(
      capabilities.models?.find((model) => model.id === 'custom-vision-model')?.vision
    ).toBe(true)

    const modelsJson = JSON.parse(
      await fs.readFile(path.join(agentDir, 'models.json'), 'utf-8')
    )
    const entries = modelsJson.providers['pi-workbench'].models
    expect(entries.find((model: { id: string }) => model.id === 'deepseek-flash').input).toEqual([
      'text',
    ])
    expect(
      entries.find((model: { id: string }) => model.id === 'custom-vision-model').input
    ).toEqual(['text', 'image'])
  })
})

describe('image attachment validation', () => {
  it('keeps user images in session history', async () => {
    const session = createFakeSession()
    session.messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
        timestamp: 1,
      },
    ]
    primeSdk(session)
    await manager.initialize(makeConfig())

    const history = manager.getSessionMessages('session-1')
    expect(history[0]).toMatchObject({
      role: 'user',
      content: 'look at this',
      images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
    })
  })

  it('rejects too many or unsupported images before sending', async () => {
    const tooMany = Array.from({ length: 21 }, () => ({
      data: 'aGVsbG8=',
      mimeType: 'image/png',
    }))
    await expect(manager.chat('hi', { images: tooMany })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('At most'),
    })

    await expect(
      manager.chat('hi', { images: [{ data: 'aGVsbG8=', mimeType: 'image/tiff' }] })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Unsupported'),
    })
  })

  it('lets valid images through to the normal initialization check', async () => {
    await expect(
      manager.chat('hi', { images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }] })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('not initialized'),
    })
  })
})

describe('prompt resources', () => {
  it('reloads and lists prompt templates and skills', async () => {
    const session = createFakeSession()
    ;(session as unknown as { promptTemplates: unknown[] }).promptTemplates = [
      {
        name: 'review',
        description: 'Review changes',
        argumentHint: '<path>',
        sourceInfo: { scope: 'project' },
      },
    ]
    primeSdk(session)
    await manager.initialize(makeConfig())

    const result = await manager.listPromptResources('session-1')

    expect(result.success).toBe(true)
    expect(result.templates).toEqual([
      {
        name: 'review',
        description: 'Review changes',
        argumentHint: '<path>',
        scope: 'project',
      },
    ])
    expect(result.skills).toEqual([])
    expect(sdk.reload).toHaveBeenCalled()
  })
})

describe('structured plans', () => {
  const plan = {
    id: 'plan-1',
    summary: 'Ship the feature',
    status: 'proposed' as const,
    createdAt: 1,
    updatedAt: 1,
    steps: [
      { id: 'step-1', title: 'First', files: ['src/a.ts'], status: 'pending' as const },
      { id: 'step-2', title: 'Second', files: [], status: 'pending' as const },
    ],
  }

  async function setupPlanSession() {
    await fs.mkdir(path.join(agentDir, 'session-extras'), { recursive: true })
    await fs.writeFile(
      path.join(agentDir, 'session-extras', 'session-1.json'),
      JSON.stringify({
        version: 1,
        thinkingDurations: {},
        branchLeaves: {},
        plan,
      }),
      'utf-8'
    )
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())
    return session
  }

  it('returns the persisted plan', async () => {
    await setupPlanSession()

    const result = await manager.getPlan('session-1')

    expect(result.success).toBe(true)
    expect(result.plan?.id).toBe('plan-1')
    expect(result.plan?.status).toBe('proposed')
  })

  it('approves the plan and starts its first step', async () => {
    await setupPlanSession()

    const result = await manager.approvePlan('session-1', 'plan-1', 'ask')

    expect(result.success).toBe(true)
    expect(result.plan?.status).toBe('approved')
    expect(result.plan?.steps[0].status).toBe('in_progress')
    expect(result.plan?.steps[1].status).toBe('pending')
    expect(result.permission).toEqual({ mode: 'ask', grants: [] })
  })

  it('moves the session into the chosen execution mode when approving', async () => {
    const session = await setupPlanSession()

    const result = await manager.approvePlan('session-1', 'plan-1', 'auto')
    expect(result.permission).toEqual({ mode: 'auto', grants: [] })

    const settings = await manager.getSessionSettings('session-1')
    expect(settings.permission).toEqual({ mode: 'auto', grants: [] })
    expect(session.activeTools).toContain('update_plan_step')
    expect(session.activeTools).not.toContain('submit_plan')
  })

  it('rejects a proposed plan and refuses a second decision', async () => {
    await setupPlanSession()

    const rejected = await manager.rejectPlan('session-1', 'plan-1')
    expect(rejected.success).toBe(true)
    expect(rejected.plan?.status).toBe('rejected')

    await expect(manager.approvePlan('session-1', 'plan-1', 'ask')).resolves.toMatchObject({
      success: false,
    })
  })
})

describe('session model and thinking controls', () => {
  it('reports and updates the model and thinking level', async () => {
    const session = createFakeSession()
    primeSdk(session)
    sdk.modelRuntimeCreate.mockResolvedValue({
      getModel: vi.fn((_provider: string, id: string) => ({ provider: 'pi-workbench', id })),
    })
    await manager.initialize(makeConfig())

    await expect(manager.getSessionSettings('session-1')).resolves.toEqual({
      success: true,
      modelId: 'test-model',
      thinkingLevel: 'medium',
      permission: { mode: 'ask', grants: [] },
    })

    await expect(manager.setSessionModel('session-1', 'other-model')).resolves.toEqual({
      success: true,
    })
    expect(session.model?.id).toBe('other-model')

    await expect(manager.setSessionThinking('session-1', 'high')).resolves.toEqual({
      success: true,
    })
    expect(session.thinkingLevel).toBe('high')
  })

  it('rejects unknown thinking levels', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    const result = await manager.setSessionThinking('session-1', 'turbo')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown thinking level')
  })
})

describe('provider retry events', () => {
  it('forwards auto-retry starts and ends to the renderer', async () => {
    const traces: Array<Record<string, unknown>> = []
    const session = createFakeSession(async (fake) => {
      fake.emit({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: '429 Too Many Requests',
      })
      fake.emit({ type: 'auto_retry_end', success: true })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    await manager.chat('hi', { onTrace: (event) => traces.push(event) })

    expect(traces).toContainEqual({
      type: 'retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      message: '429 Too Many Requests',
    })
    expect(traces).toContainEqual({ type: 'retry_end', success: true })
  })
})

describe('tool streaming', () => {
  it('forwards partial tool output as tool_update events', async () => {
    const traces: Array<Record<string, unknown>> = []
    const session = createFakeSession(async (fake) => {
      fake.emit({
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'npm test' },
      })
      fake.emit({
        type: 'tool_execution_update',
        toolCallId: 'c1',
        toolName: 'bash',
        partialResult: { content: [{ type: 'text', text: 'running tests...' }] },
      })
      fake.emit({
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'bash',
        isError: false,
        durationMs: 10,
        result: { content: [{ type: 'text', text: 'all passed' }] },
      })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    await manager.chat('run tests', { onTrace: (event) => traces.push(event) })

    expect(traces).toContainEqual({
      type: 'tool_update',
      toolCallId: 'c1',
      resultPreview: 'running tests...',
    })
  })
})

describe('tool results', () => {
  const text = 'line-1\nline-2\nline-3'

  it('reports metadata and pages through long text', async () => {
    const session = createFakeSession()
    session.messages = [
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'bash',
        content: [{ type: 'text', text }],
        isError: false,
        timestamp: 1,
      },
    ]
    primeSdk(session)
    await manager.initialize(makeConfig())

    const meta = await manager.getToolResultMeta('session-1', 'call-1')
    expect(meta.success).toBe(true)
    expect(meta.meta).toMatchObject({
      toolName: 'bash',
      kind: 'text',
      chars: text.length,
      lines: 3,
      imageCount: 0,
    })

    const first = await manager.readToolResultChunk('session-1', 'call-1', 0, 5)
    expect(first.success).toBe(true)
    expect(first.text).toBe('line-')
    expect(first.done).toBe(false)

    const rest = await manager.readToolResultChunk(
      'session-1',
      'call-1',
      first.nextOffset ?? 0,
      1_000
    )
    expect(rest.done).toBe(true)
    expect(`${first.text ?? ''}${rest.text ?? ''}`).toBe(text)

    const full = await manager.getToolResultText('session-1', 'call-1')
    expect(full.text).toBe(text)
  })

  it('reports image results and returns their data', async () => {
    const session = createFakeSession()
    session.messages = [
      {
        role: 'toolResult',
        toolCallId: 'call-image',
        toolName: 'screenshot',
        content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
        isError: false,
        timestamp: 2,
      },
    ]
    primeSdk(session)
    await manager.initialize(makeConfig())

    const meta = await manager.getToolResultMeta('session-1', 'call-image')
    expect(meta.meta).toMatchObject({ kind: 'image', imageCount: 1, chars: 0, lines: 0 })

    const image = await manager.getToolResultImage('session-1', 'call-image', 0)
    expect(image).toMatchObject({ success: true, data: 'aGVsbG8=', mimeType: 'image/png' })
  })

  it('reports an error for unknown tool calls', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    await expect(manager.getToolResultMeta('session-1', 'missing')).resolves.toMatchObject({
      success: false,
    })
  })
})

describe('compaction events', () => {
  it('forwards compaction start and end as trace events', async () => {
    const session = createFakeSession(async (s) => {
      s.messages.push({ role: 'user', content: 'hello' })
      s.emit({ type: 'compaction_start', reason: 'threshold' })
      s.emit({
        type: 'compaction_end',
        reason: 'threshold',
        result: { tokensBefore: 5_000 },
        aborted: false,
        willRetry: false,
      })
      s.messages.push({ role: 'assistant', content: 'done' })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    const events: Array<Record<string, unknown>> = []
    await manager.chat('hi', { onTrace: (event) => events.push(event) })

    expect(events).toContainEqual({ type: 'compaction_start', reason: 'threshold' })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'compaction_end',
        reason: 'threshold',
        tokensBefore: 5_000,
      })
    )
  })
})

describe('session export', () => {
  async function setupExportSession() {
    const session = createFakeSession()
    const longResult = 'x'.repeat(5_000)
    session.messages = [
      { role: 'user', content: 'Fix the build', timestamp: 1000 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'inspect logs' },
          { type: 'text', text: 'Running the build' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'npm test' } },
        ],
        timestamp: 1100,
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'bash',
        content: [{ type: 'text', text: longResult }],
        isError: false,
        timestamp: 1200,
      },
    ]
    primeSdk(session)
    await manager.initialize(makeConfig())
    return longResult
  }

  it('exports markdown with full tool output in collapsed details', async () => {
    const longResult = await setupExportSession()

    const result = await manager.exportSessionMarkdown('session-1')

    expect(result.success).toBe(true)
    expect(result.title).toBe('Fix the build')
    expect(result.content).toContain('Fix the build')
    expect(result.content).toContain('Running the build')
    expect(result.content).toContain('<details>')
    expect(result.content).toContain('工具调用 · bash')
    expect(result.content).toContain(longResult)
  })

  it('exports a standalone HTML document', async () => {
    const longResult = await setupExportSession()

    const result = await manager.exportSessionHtml('session-1', 'en')

    expect(result.success).toBe(true)
    expect(result.content).toContain('<!doctype html>')
    expect(result.content).toContain('Tool call · bash')
    expect(result.content).toContain('inspect logs')
    expect(result.content).toContain(longResult)
  })

  it('reports an error when the session has no JSONL file yet', async () => {
    await setupExportSession()

    await expect(manager.getSessionJsonlPath('session-1')).resolves.toMatchObject({
      success: false,
    })
  })
})

describe('session stats', () => {
  it('reports cumulative tokens, cost and tool calls', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())

    await expect(manager.getSessionStats('session-1')).resolves.toEqual({
      success: true,
      stats: {
        tokens: 1500,
        input: 1000,
        output: 500,
        cost: 0.42,
        toolCalls: 3,
        messages: 8,
      },
    })
  })
})

describe('session extras', () => {
  it('records thinking duration and attaches it to history', async () => {
    const session = createFakeSession()
    session.messages.push({
      role: 'assistant',
      timestamp: 111,
      content: [
        { type: 'thinking', thinking: 'pondering' },
        { type: 'text', text: 'done' },
      ],
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    session.emit({ type: 'message_start', message: { role: 'assistant' } })
    session.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    session.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'pondering' },
    })
    session.emit({ type: 'message_end', message: { role: 'assistant', timestamp: 111 } })

    const history = manager.getSessionMessages('session-1')
    const thinking = history[0]?.parts?.find((part) => part.type === 'thinking')
    expect(thinking).toMatchObject({ type: 'thinking' })
    expect((thinking as { durationMs?: number }).durationMs ?? 0).toBeGreaterThan(0)
  })

  it('does not persist tool edit contents in session extras', async () => {
    const filePath = path.join(workspaceDir, 'hist.txt')
    const session = createFakeSession(async (fake) => {
      fake.emit({
        type: 'tool_execution_start',
        toolCallId: 'hist-1',
        toolName: 'write',
        args: { path: filePath, content: 'new' },
      })
      await fs.writeFile(filePath, 'new', 'utf-8')
      fake.emit({
        type: 'tool_execution_end',
        toolCallId: 'hist-1',
        toolName: 'write',
        isError: false,
        durationMs: 2,
        result: {},
      })
    })
    primeSdk(session)
    await manager.initialize(makeConfig())
    await manager.chat('write')

    const extrasPath = path.join(agentDir, 'session-extras', 'session-1.json')
    const raw = await fs.readFile(extrasPath, 'utf-8').catch(() => null)
    if (raw) {
      expect(JSON.parse(raw)).not.toHaveProperty('toolEdits')
    }
  })
})
