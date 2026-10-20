import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { AgentManager, type AgentConfig } from '../pi-bridge/src/agent-manager'

const sdk = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  modelRuntimeCreate: vi.fn(),
  continueRecent: vi.fn(),
}))

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: sdk.createAgentSession,
  ModelRuntime: { create: sdk.modelRuntimeCreate },
  SessionManager: { continueRecent: sdk.continueRecent },
}))

type SessionEvent = Record<string, unknown>

interface FakeSession {
  messages: Array<Record<string, unknown>>
  disposed: boolean
  subscribe: (listener: (event: SessionEvent) => void) => () => void
  prompt: (message: string) => Promise<void>
  abort: () => Promise<void>
  dispose: () => void
  emit: (event: SessionEvent) => void
}

function createFakeSession(
  onPrompt?: (session: FakeSession, message: string) => Promise<void>
): FakeSession {
  const listeners = new Set<(event: SessionEvent) => void>()
  const session: FakeSession = {
    messages: [],
    disposed: false,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    prompt: async (message) => {
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

function primeSdk(
  session: FakeSession,
  model: Record<string, unknown> | null = { provider: 'pi-workbench', id: 'test-model' }
): void {
  sdk.modelRuntimeCreate.mockResolvedValue({
    getModel: vi.fn(() => model),
  })
  sdk.continueRecent.mockReturnValue({ getSessionFile: () => null })
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
})

describe('AgentManager initialization', () => {
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
      { path: target, oldContent: '', newContent: 'new content' },
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
      { role: 'assistant', content: 'part one\npart two', timestamp: 5 },
    ])
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
