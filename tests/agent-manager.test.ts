import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { AgentManager, type AgentConfig } from '../pi-bridge/src/agent-manager'
import {
  ABORT_GRACE_MS,
  APPROVAL_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
} from '../pi-bridge/src/agent-manager'
import type {
  ApprovalDecision,
  ApprovalRequestPayload,
} from '../pi-bridge/src/approval-policy'
import type { StallWatchdog } from '../pi-bridge/src/stall-watchdog'
import { buildContextPrompt } from '../src/api/chatContext'

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
  // 内置 read 定义由本仓库扩展（文档能力），测试里给个最小替身
  createReadToolDefinition: () => ({
    name: 'read',
    label: 'read',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    promptGuidelines: [],
    execute: async () => ({ content: [{ type: 'text', text: '' }] }),
  }),
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
  lastPrompt?: string
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
      session.lastPrompt = message
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

function createFakeSessionManager(
  id = 'session-1',
  source?: { messages: Array<Record<string, unknown>> },
  /** 跨实例共享的标题状态：模拟重新打开同一个会话文件 */
  titleState?: { name?: string; persisted?: boolean }
) {
  let name: string | undefined = titleState?.name
  let persisted = titleState?.persisted ?? false
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
  // 真实 SDK 的 entry 链就是会话消息的来源；假管理器按 session.messages 同步派生
  const deriveEntries = () => {
    if (!source || source.messages.length === 0) return entries
    return source.messages.map((message, index) => {
      const timestamp = (message as { timestamp?: unknown }).timestamp
      return {
        id: `m-${index + 1}`,
        parentId: index === 0 ? null : `m-${index}`,
        type: 'message',
        timestamp: new Date(
          typeof timestamp === 'number' ? timestamp : 1000 + index
        ).toISOString(),
        message,
      }
    })
  }
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
    getEntry: (entryId: string) => deriveEntries().find((entry) => entry.id === entryId),
    getBranch: () => deriveEntries(),
    getEntries: () => deriveEntries(),
    getTree: () => [{ entry: entries[0], children: [{ entry: entries[1], children: [] }] }],
    branch: () => {},
    appendSessionInfo: (value: string) => {
      name = value
      persisted = true
      if (titleState) {
        titleState.name = value
        titleState.persisted = true
      }
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
    getEntries: () => entries,
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
  sdk.continueRecent.mockImplementation(() => createFakeSessionManager('session-1', session))
  sdk.sessionCreate.mockImplementation(() =>
    createFakeSessionManager('session-new', session)
  )
  sdk.sessionFindById.mockImplementation(
    (_cwd: string, id: string) => `/tmp/${id}.jsonl`
  )
  sdk.sessionOpen.mockImplementation((file: string) =>
    createFakeSessionManager(path.basename(file, '.jsonl'), session)
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

/** 读运行时里的看门狗，用于验证工具 / 审批期间确实挂起了计时 */
function watchdogOf(target: AgentManager, sessionId = 'session-1'): StallWatchdog | null {
  return (
    target as unknown as {
      runtimes: Map<string, { watchdog: StallWatchdog | null }>
    }
  ).runtimes.get(sessionId)?.watchdog ?? null
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
      models: [{ id: 'test-model', contextWindow: 128_000, maxTokens: 8_192, input: ['text'] }],
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

  it('adds a placeholder text only for Anthropic image-only messages', async () => {
    const run = async (provider: string, language: 'zh' | 'en'): Promise<string> => {
      const session = createFakeSession(async (s, message) => {
        s.messages.push({ role: 'user', content: message })
        s.messages.push({ role: 'assistant', content: 'ok' })
      })
      primeSdk(session)
      const config = makeConfig({ getLanguage: () => language })
      config.apiConfig.provider = provider
      await manager.initialize(config)
      await manager.chat('', { images: [{ data: 'AAAA', mimeType: 'image/png' }] })
      const prompt = session.lastPrompt ?? ''
      await manager.dispose()
      return prompt
    }

    // Anthropic 拒绝空 text 块，补占位文本；OpenAI 兼容端点保持空文本
    await expect(run('anthropic', 'zh')).resolves.toBe('请看这些图片。')
    await expect(run('anthropic', 'en')).resolves.toBe(
      'Please look at the attached image(s).'
    )
    await expect(run('openai', 'zh')).resolves.toBe('')
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

  it('aborts and reports a stall when the model stays silent', async () => {
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
      const pending = manager.chat('hi')
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS)
      const result = await pending

      expect(session.abort).toHaveBeenCalled()
      expect(result.success).toBe(false)
      expect(result.error).toContain('stalled')
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

  it('keeps the reply when auto-compaction rebuilds the message array', async () => {
    const session = createFakeSession(async (fake) => {
      // 模拟 SDK 的 _refreshFinalizedContext()：自动压缩后用会话投影整体替换 messages，
      // 旧前缀折叠成摘要，数组长度比本轮开始时更短
      fake.messages = [
        { role: 'user', content: 'Summary of earlier conversation', timestamp: Date.now() - 3_600_000 },
        { role: 'user', content: 'hi', timestamp: Date.now() },
      ]
      fake.messages.push({ role: 'assistant', content: 'compacted reply', timestamp: Date.now() })
    })
    session.messages.push(
      ...Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `old-${index}`,
        timestamp: Date.now() - 600_000,
      }))
    )
    primeSdk(session)
    await manager.initialize(makeConfig())

    const result = await manager.chat('hi')

    expect(result.success).toBe(true)
    expect(result.response).toBe('compacted reply')
  })

  it('does not treat a previous reply as this run after compaction', async () => {
    const stale = Date.now() - 600_000
    const session = createFakeSession(async (fake) => {
      // 压缩重建数组后，剩下的 assistant 消息全部属于历史轮次
      fake.messages = [
        { role: 'user', content: 'Summary of earlier conversation', timestamp: stale },
        { role: 'assistant', content: 'previous reply', timestamp: stale },
        { role: 'user', content: 'hi', timestamp: Date.now() },
      ]
    })
    session.messages.push(
      ...Array.from({ length: 40 }, () => ({
        role: 'assistant',
        content: 'old',
        timestamp: stale,
      }))
    )
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
      const pending = manager.chat('hi')
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS)
      await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS)
      const result = await pending

      expect(session.abort).toHaveBeenCalled()
      expect(result.success).toBe(false)
      expect(result.error).toContain('stalled')
      // 硬停是唯一会销毁并重建运行时的路径
      expect(session.disposed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not stall while the model keeps streaming', async () => {
    const control: { resolvePrompt?: () => void } = {}
    const session = createFakeSession(
      () =>
        new Promise<void>((resolve) => {
          control.resolvePrompt = resolve
        })
    )
    session.abort = vi.fn(async () => {
      control.resolvePrompt?.()
    })
    primeSdk(session)
    await manager.initialize(makeConfig())

    vi.useFakeTimers()
    try {
      const pending = manager.chat('hi')
      // 50 分钟的长轮次，每 60s 一个增量
      for (let index = 0; index < 50; index += 1) {
        await vi.advanceTimersByTimeAsync(60_000)
        session.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'x' },
        })
      }
      expect(session.abort).not.toHaveBeenCalled()

      session.messages.push({ role: 'assistant', content: 'done' })
      control.resolvePrompt?.()
      const result = await pending
      expect(result.success).toBe(true)
      expect(result.response).toBe('done')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not stall while a tool is running', async () => {
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
      const pending = manager.chat('hi')
      session.emit({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { command: 'npm test' },
      })

      // 静默 20 分钟：命令可能一直不输出
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(watchdogOf(manager)?.isArmed).toBe(false)
      expect(session.abort).not.toHaveBeenCalled()

      session.emit({
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'bash',
        isError: false,
        result: 'ok',
        durationMs: 20 * 60_000,
      })
      expect(watchdogOf(manager)?.isArmed).toBe(true)
      // 工具结束后重新按空闲计时
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS)
      expect(session.abort).toHaveBeenCalled()

      const result = await pending
      expect(result.success).toBe(false)
      expect(result.error).toContain('stalled')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not stall while a tool approval is pending', async () => {
    const control: {
      resolvePrompt?: () => void
      resolveApproval?: (decision: ApprovalDecision) => void
    } = {}
    const session = createFakeSession(
      () =>
        new Promise<void>((resolve) => {
          control.resolvePrompt = resolve
        })
    )
    session.abort = vi.fn(async () => {
      control.resolvePrompt?.()
    })
    primeSdk(session)
    await manager.initialize(
      makeConfig({
        requestApproval: () =>
          new Promise<ApprovalDecision>((resolve) => {
            control.resolveApproval = resolve
          }),
      })
    )

    const requestApproval = (
      manager as unknown as {
        requestToolApproval: (
          request: ApprovalRequestPayload
        ) => Promise<ApprovalDecision>
      }
    ).requestToolApproval.bind(manager)

    vi.useFakeTimers()
    try {
      const pending = manager.chat('hi')
      // 审批是 tool_call 钩子，先于 tool_execution_start：事件流期间完全静默
      const approval = requestApproval({
        requestId: 'approval-1',
        workspaceDir,
        sessionId: 'session-1',
        toolCallId: 'tool-1',
        toolName: 'bash',
        category: 'command',
        summary: 'npm test',
        details: { command: 'npm test' },
        createdAt: Date.now(),
        expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
      })

      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS - 1)
      expect(watchdogOf(manager)?.isArmed).toBe(false)
      expect(session.abort).not.toHaveBeenCalled()

      control.resolveApproval?.({ action: 'allow-once' })
      await expect(approval).resolves.toEqual({ action: 'allow-once' })
      expect(watchdogOf(manager)?.isArmed).toBe(true)

      session.abort = vi.fn(async () => {
        control.resolvePrompt?.()
      })
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS)
      const result = await pending
      expect(result.error).toContain('stalled')
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

  it('switches the session worktree root when idle', async () => {
    const first = createFakeSession()
    primeSdk(first)
    const baseManager = createFakeSessionManager('session-switch')
    const sessionFile = path.join(tmpRoot, 'session-switch.jsonl')
    await fs.writeFile(sessionFile, '{}\n', 'utf-8')
    const persistedManager = {
      ...baseManager,
      getCwd: () => workspaceDir,
      getSessionFile: () => sessionFile,
      isPersisted: () => true,
    }
    sdk.continueRecent.mockReturnValue(persistedManager)
    sdk.sessionOpen.mockImplementation(
      (_file: string, _dir: string, root: string) => ({
        ...persistedManager,
        getCwd: () => root,
      })
    )
    await manager.initialize(makeConfig())

    sdk.createAgentSession.mockResolvedValue({ session: createFakeSession() })
    const newRoot = path.join(workspaceDir, 'worktrees', 'switch-target')
    await fs.mkdir(newRoot, { recursive: true })

    const switched = await manager.requestSessionRoot('session-switch', newRoot)
    expect(switched.success).toBe(true)
    expect(sdk.createAgentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: newRoot })
    )
  })

  it('keeps the session id when switching a worktree before the session is persisted', async () => {
    const first = createFakeSession()
    primeSdk(first)
    // 新会话：SDK 已分配文件路径，但第一条消息前文件还没写出来
    const placeholder = path.join(tmpRoot, 'sessions', 'placeholder.jsonl')
    const freshManager = {
      ...createFakeSessionManager('session-fresh'),
      getSessionFile: () => placeholder,
      isPersisted: () => false,
    }
    sdk.continueRecent.mockReturnValue(freshManager)
    const roots: Array<[string, string]> = []
    await manager.initialize(
      makeConfig({ onSessionRootChanged: (id, root) => roots.push([id, root]) })
    )

    const newRoot = path.join(workspaceDir, 'worktrees', 'fresh-target')
    await fs.mkdir(newRoot, { recursive: true })
    const created: Array<{ cwd: string; options?: { id?: string } }> = []
    sdk.sessionCreate.mockImplementation(
      (cwd: string, _dir: string, options?: { id?: string }) => {
        created.push({ cwd, options })
        return { ...createFakeSessionManager(options?.id ?? 'generated'), getCwd: () => cwd }
      }
    )
    sdk.createAgentSession.mockResolvedValue({ session: createFakeSession() })

    const switched = await manager.requestSessionRoot('session-fresh', newRoot)

    // 直接用不存在的文件 open 会让 SDK 生成新 id；必须按原 id 重建
    expect(switched).toEqual({ success: true })
    expect(sdk.sessionOpen).not.toHaveBeenCalled()
    expect(created).toEqual([{ cwd: newRoot, options: { id: 'session-fresh' } }])
    expect(roots[roots.length - 1]).toEqual(['session-fresh', newRoot])
    expect(manager.getCurrentSessionId()).toBe('session-fresh')
  })

  it('restores the previous worktree when the rebuilt session changes id', async () => {
    const first = createFakeSession()
    primeSdk(first)
    const sessionFile = path.join(tmpRoot, 'session-rollback.jsonl')
    await fs.writeFile(sessionFile, '{}\n', 'utf-8')
    const original = {
      ...createFakeSessionManager('session-rollback'),
      getCwd: () => workspaceDir,
      getSessionFile: () => sessionFile,
      isPersisted: () => true,
    }
    sdk.continueRecent.mockReturnValue(original)
    const roots: Array<[string, string]> = []
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    await manager.initialize(
      makeConfig({ logger, onSessionRootChanged: (id, root) => roots.push([id, root]) })
    )

    const newRoot = path.join(workspaceDir, 'worktrees', 'bad-target')
    await fs.mkdir(newRoot, { recursive: true })
    sdk.sessionOpen
      .mockImplementationOnce(() => ({
        ...createFakeSessionManager('regenerated-id'),
        getCwd: () => newRoot,
      }))
      .mockImplementation((_file: string, _dir: string, root: string) => ({
        ...original,
        getCwd: () => root,
      }))
    sdk.createAgentSession.mockResolvedValue({ session: createFakeSession() })

    const switched = await manager.requestSessionRoot('session-rollback', newRoot)

    expect(switched.success).toBe(false)
    expect(roots[roots.length - 1]).toEqual(['session-rollback', workspaceDir])
    expect(logger.error).toHaveBeenCalledWith(
      '[Agent Manager] Failed to apply worktree switch:',
      expect.any(Error)
    )
  })

  it('opens an existing session by id', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig())

    const reopened = createFakeSession()
    reopened.messages.push({ role: 'user', content: 'restored' })
    reopened.messages.push({ role: 'assistant', content: 'hello again' })
    sdk.createAgentSession.mockResolvedValue({ session: reopened })
    primeSdk(reopened)
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
    primeSdk(second)
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

  it('titles an image-only session without calling the model', async () => {
    const session = createFakeSession(async (fake) => {
      fake.messages.push({
        role: 'user',
        content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      })
      fake.messages.push({ role: 'assistant', content: 'A red square.' })
    })
    primeSdk(session)
    const onSessionTitle = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await manager.initialize(makeConfig({ onSessionTitle, getLanguage: () => 'zh' }))
    await expect(
      manager.chat('', { images: [{ data: 'AAAA', mimeType: 'image/png' }] })
    ).resolves.toMatchObject({ success: true })

    await until(() => onSessionTitle.mock.calls.length > 0)
    expect(onSessionTitle).toHaveBeenCalledWith('session-1', '图片对话')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names a session from the first text reply even when it starts with a tool call', async () => {
    const session = createFakeSession(async (fake) => {
      fake.messages.push({ role: 'user', content: 'Fix the login redirect loop' })
      fake.messages.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }],
      })
      fake.messages.push({ role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] })
      fake.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'I updated the auth guard.' }] })
    })
    primeSdk(session)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Fix login redirect' } }] }),
      })
    )
    const onSessionTitle = vi.fn()

    await manager.initialize(makeConfig({ onSessionTitle }))
    await manager.chat('Fix the login redirect loop')

    await until(() => onSessionTitle.mock.calls.length > 0)
    expect(onSessionTitle).toHaveBeenCalledWith('session-1', 'Fix login redirect')
  })

  it('waits for a text reply before spending the single title attempt', async () => {
    const session = createFakeSession(async (fake, message) => {
      if (message === 'first') {
        fake.messages.push({ role: 'user', content: 'first' })
        fake.messages.push({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }],
        })
        return
      }
      fake.messages.push({ role: 'user', content: 'second' })
      fake.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'All done.' }] })
    })
    primeSdk(session)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Workspace cleanup' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const onSessionTitle = vi.fn()

    await manager.initialize(makeConfig({ onSessionTitle }))
    await manager.chat('first')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).not.toHaveBeenCalled()

    await manager.chat('second')
    await until(() => onSessionTitle.mock.calls.length > 0)
    expect(onSessionTitle).toHaveBeenCalledWith('session-1', 'Workspace cleanup')
  })

  it('retries the title on the next turn when the model reply is unusable', async () => {
    const session = createFakeSession(async (fake, message) => {
      fake.messages.push({ role: 'user', content: message })
      fake.messages.push({ role: 'assistant', content: `reply to ${message}` })
    })
    primeSdk(session)
    // 推理型模型把 token 预算花在 reasoning 上时，content 是空字符串
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Workspace cleanup' } }] }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const onSessionTitle = vi.fn()

    await manager.initialize(makeConfig({ onSessionTitle }))
    await manager.chat('first')
    await until(() => fetchMock.mock.calls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onSessionTitle).not.toHaveBeenCalled()

    // 标题很短，但推理型模型需要多留 reasoning 预算，否则拿不到 content
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.max_tokens).toBeGreaterThanOrEqual(400)

    await manager.chat('second')
    await until(() => onSessionTitle.mock.calls.length > 0)
    expect(onSessionTitle).toHaveBeenCalledWith('session-1', 'Workspace cleanup')
  })

  it('stops retrying the title after repeated unusable replies', async () => {
    const session = createFakeSession(async (fake, message) => {
      fake.messages.push({ role: 'user', content: message })
      fake.messages.push({ role: 'assistant', content: `reply to ${message}` })
    })
    primeSdk(session)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '   ' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const onSessionTitle = vi.fn()

    await manager.initialize(makeConfig({ onSessionTitle }))
    for (const message of ['a', 'b', 'c', 'd']) await manager.chat(message)
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(onSessionTitle).not.toHaveBeenCalled()
  })

  it('names the topic instead of the environment notes in the reply', async () => {
    // 真实形状：用户只问一句，助手回复前半段是环境说明（工作目录 / 规矩 / 工作树状态）
    const session = createFakeSession(async (fake) => {
      fake.messages.push({ role: 'user', content: '你是谁？' })
      fake.messages.push({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: [
              '我是 pi 里的编码智能体（AI 编程助手），可以读写文件、跑命令。',
              '',
              '具体到当前环境：',
              '',
              '- **工作目录**：`F:\\DSH\\DSH二次开发-2`，这是 DSH 最小核心后端。',
              '- **工作树状态**：主工作树、分支 `main`，有 35 处未提交改动。',
            ].join('\n'),
          },
        ],
      })
    })
    primeSdk(session)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"title": "助手自我介绍"}' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const onSessionTitle = vi.fn()

    await manager.initialize(makeConfig({ onSessionTitle }))
    await manager.chat('你是谁？')
    await until(() => onSessionTitle.mock.calls.length > 0)

    const prompt = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).messages[0].content as string
    expect(prompt).toContain('我是 pi 里的编码智能体')
    expect(prompt).not.toContain('工作目录')
    expect(prompt).not.toContain('DSH')
    expect(onSessionTitle).toHaveBeenCalledWith('session-1', '助手自我介绍')
  })

  it('rejects a title that just repeats the user message', async () => {
    const session = createFakeSession(async (fake, message) => {
      fake.messages.push({ role: 'user', content: message })
      fake.messages.push({ role: 'assistant', content: `reply to ${message}` })
    })
    primeSdk(session)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"title": "你是谁？"}' } }] }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"title": "助手自我介绍"}' } }] }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const onSessionTitle = vi.fn()

    await manager.initialize(makeConfig({ onSessionTitle }))
    await manager.chat('你是谁？')
    await until(() => fetchMock.mock.calls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 复述原话等于回退标题，不算确定，也不耗完机会
    expect(onSessionTitle).not.toHaveBeenCalled()

    await manager.chat('再说一次')
    await until(() => onSessionTitle.mock.calls.length > 0)
    expect(onSessionTitle).toHaveBeenCalledWith('session-1', '助手自我介绍')
  })

  it('reads the title source from the session record instead of the compacted context', async () => {
    const session = createFakeSession(async (fake) => {
      fake.messages.push({ role: 'user', content: 'next message' })
      fake.messages.push({ role: 'assistant', content: 'next answer' })
    })
    // 压缩后的模型上下文：首条消息已经不在其中
    session.messages.push({ role: 'user', content: 'Unrelated later question' })
    session.messages.push({ role: 'assistant', content: 'Unrelated later answer' })

    primeSdk(session)
    const record = [
      {
        id: 'u1',
        parentId: null,
        type: 'message',
        timestamp: new Date(1000).toISOString(),
        message: { role: 'user', content: 'Original question about auth' },
      },
      {
        id: 'a1',
        parentId: 'u1',
        type: 'message',
        timestamp: new Date(2000).toISOString(),
        message: { role: 'assistant', content: 'Original answer about auth' },
      },
    ]
    sdk.continueRecent.mockImplementation(() => ({
      ...createFakeSessionManager('session-1', session),
      getEntries: () => record,
      getBranch: () => record,
    }))

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Auth guard' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const onSessionTitle = vi.fn()

    await manager.initialize(makeConfig({ onSessionTitle }))
    await manager.chat('next message')

    await until(() => onSessionTitle.mock.calls.length > 0)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.messages[0].content).toContain('Original question about auth')
    expect(body.messages[0].content).toContain('Original answer about auth')
    expect(body.messages[0].content).not.toContain('Unrelated')
  })

  it('never rewrites a title that is already recorded', async () => {
    const session = createFakeSession(async (fake) => {
      fake.messages.push({ role: 'user', content: 'second question' })
      fake.messages.push({ role: 'assistant', content: 'second answer' })
    })
    primeSdk(session)
    const titleState = { name: 'Manual title', persisted: true }
    sdk.continueRecent.mockImplementation(() =>
      createFakeSessionManager('session-1', session, titleState)
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const onSessionTitle = vi.fn()

    await manager.initialize(makeConfig({ onSessionTitle }))
    const opened = await manager.openSession('session-1')
    expect(opened.session?.title).toBe('Manual title')

    await manager.chat('second question')
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(onSessionTitle).not.toHaveBeenCalled()
    expect((await manager.listSessions())[0]?.title).toBe('Manual title')
  })

  it('opens a session once when several requests arrive together', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())
    sdk.sessionOpen.mockClear()
    sdk.createAgentSession.mockClear()

    // 打开会话 / 读分支 / 读计划 同时进来：只能建一个运行时，否则同一个会话会有
    // 两个 SessionManager，后写者看不到先写者写入的标题
    const [opened, branches, plan] = await Promise.all([
      manager.openSession('session-2'),
      manager.listBranches('session-2'),
      manager.getPlan('session-2'),
    ])

    expect(opened.success).toBe(true)
    expect(branches.success).toBe(true)
    expect(plan.success).toBe(true)
    expect(sdk.sessionOpen).toHaveBeenCalledTimes(1)
    expect(sdk.createAgentSession).toHaveBeenCalledTimes(1)
  })

  it('restores a title from the sidecar when the record lost it', async () => {
    const session = createFakeSession()
    primeSdk(session)
    const titleState: { name?: string; persisted?: boolean } = { persisted: true }
    // 会话文件已落盘，但里面的 session_info 丢了（分支裁剪 / 迁移）
    const sessionFile = path.join(tmpRoot, 'session-1.jsonl')
    await fs.writeFile(sessionFile, '{"type":"session"}\n', 'utf-8')
    sdk.continueRecent.mockImplementation(() => ({
      ...createFakeSessionManager('session-1', session, titleState),
      getSessionFile: () => sessionFile,
    }))

    // 记录（JSONL）里的 session_info 因分支裁剪或迁移丢了，sidecar 仍持有快照
    await fs.mkdir(path.join(agentDir, 'session-extras'), { recursive: true })
    await fs.writeFile(
      path.join(agentDir, 'session-extras', 'session-1.json'),
      JSON.stringify({ version: 1, thinkingDurations: {}, title: 'Original title' }),
      'utf-8'
    )

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const onSessionTitle = vi.fn()

    await manager.initialize(makeConfig({ onSessionTitle }))
    const opened = await manager.openSession('session-1')

    expect(opened.session?.title).toBe('Original title')
    // 补写回会话记录，且不重新调用模型
    expect(titleState.name).toBe('Original title')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('drops a generated title when the session was deleted meanwhile', async () => {
    const session = createFakeSession(async (fake) => {
      fake.messages.push({ role: 'user', content: 'hello there' })
      fake.messages.push({ role: 'assistant', content: 'hello back' })
    })
    primeSdk(session)
    const titleState: { name?: string; persisted?: boolean } = { persisted: true }
    const sessionFile = path.join(agentDir, 'sessions', 'session-1.jsonl')
    await fs.mkdir(path.join(agentDir, 'sessions'), { recursive: true })
    await fs.writeFile(sessionFile, '{"type":"session"}\n', 'utf-8')
    sdk.sessionFindById.mockImplementation(() => sessionFile)
    sdk.sessionOpen.mockImplementation(() => ({
      ...createFakeSessionManager('session-1', session, titleState),
      getSessionFile: () => sessionFile,
    }))

    let release: ((value: unknown) => void) | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
    )
    const onSessionTitle = vi.fn()

    await manager.initialize(makeConfig({ onSessionTitle }))
    await manager.chat('hello there')
    await until(() => release !== null)

    await manager.deleteSession('session-1')
    release!({ ok: true, json: async () => ({ choices: [{ message: { content: 'Greeting' } }] }) })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(titleState.name).toBeUndefined()
    expect(onSessionTitle).not.toHaveBeenCalled()
    await expect(
      fs.access(path.join(agentDir, 'session-extras', 'session-1.json'))
    ).rejects.toThrow()
  })

  it('persists a generated title even when the session is closed while the request is in flight', async () => {
    const session = createFakeSession(async (fake) => {
      fake.messages.push({ role: 'user', content: 'hello there' })
      fake.messages.push({ role: 'assistant', content: 'hello back' })
    })
    primeSdk(session)
    const titleState: { name?: string; persisted?: boolean } = { persisted: true }
    sdk.sessionOpen.mockImplementation((file: string) =>
      createFakeSessionManager(path.basename(file, '.jsonl'), session, titleState)
    )

    let release: ((value: unknown) => void) | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )
    )
    const onSessionTitle = vi.fn()

    await manager.initialize(makeConfig({ onSessionTitle }))
    await manager.chat('hello there')
    await until(() => release !== null)

    await manager.closeSession('session-1')
    release!({ ok: true, json: async () => ({ choices: [{ message: { content: 'Greeting' } }] }) })

    await until(() => titleState.name === 'Greeting')
    expect(titleState.name).toBe('Greeting')
    expect(onSessionTitle).toHaveBeenCalledWith('session-1', 'Greeting')
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

  it('steers an image-only message with image content blocks', async () => {
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

    const images = [{ data: 'AAAA', mimeType: 'image/png' }]
    await expect(manager.steer('session-1', '', images)).resolves.toEqual({ success: true })
    expect(session.lastPromptOptions).toEqual({
      streamingBehavior: 'steer',
      images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    })

    release()
    await pendingChat
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

  it('returns the quote context of the rewound message and strips it from the text', async () => {
    const session = createFakeSession()
    const prompt = buildContextPrompt('看这段', [
      { kind: 'quote', label: '对话引用', content: '被引用的原文' },
    ])
    const record = [
      {
        id: 'u1',
        parentId: null,
        type: 'message' as const,
        timestamp: new Date(1000).toISOString(),
        message: { role: 'user' as const, content: prompt, timestamp: 1000 },
      },
    ]
    sdk.continueRecent.mockImplementation(() => ({
      ...createFakeSessionManager('session-1', session),
      getEntries: () => record,
      getBranch: () => record,
    }))
    await manager.initialize(makeConfig())

    const result = await manager.rewindToLastUser('session-1')
    expect(result.text).toBe('看这段')
    expect(result.context).toEqual({ quotes: [{ content: '被引用的原文', label: '对话引用' }], files: [] })
  })

  it('exposes the quote context on restored history messages', async () => {
    const session = createFakeSession()
    const prompt = buildContextPrompt('看这段', [
      { kind: 'quote', label: '对话引用', content: '被引用的原文' },
    ])
    const record = [
      {
        id: 'u1',
        parentId: null,
        type: 'message' as const,
        timestamp: new Date(1000).toISOString(),
        message: { role: 'user' as const, content: prompt, timestamp: 1000 },
      },
    ]
    sdk.continueRecent.mockImplementation(() => ({
      ...createFakeSessionManager('session-1', session),
      getEntries: () => record,
      getBranch: () => record,
    }))
    await manager.initialize(makeConfig())

    const history = manager.getSessionMessages('session-1')
    expect(history[0].content).toBe('看这段')
    expect(history[0].context?.quotes).toEqual([
      { content: '被引用的原文', label: '对话引用' },
    ])
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
  it('reports user-set context windows and marks unavailable models', async () => {
    const session = createFakeSession()
    const models: Record<string, Record<string, unknown>> = {
      'deepseek-flash': {
        provider: 'pi-workbench',
        id: 'deepseek-flash',
        reasoning: true,
        input: ['text'],
        contextWindow: 64_000,
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
          models: [
            { id: 'deepseek-flash', contextWindow: 128_000, image: true },
            { id: 'deepseek-v4-pro', contextWindow: 256_000, image: false },
          ],
        },
      })
    )

    const result = await manager.getModelCapabilities()

    expect(result.success).toBe(true)
    // 容量以用户设置为准，不采用 catalog / SDK 里的值
    expect(result.models?.[0]).toMatchObject({
      id: 'deepseek-flash',
      available: true,
      contextWindow: 128_000,
      reasoning: true,
      vision: true,
    })
    expect(result.models?.[0].thinkingLevels).not.toContain('high')
    expect(result.models?.[1]).toMatchObject({
      id: 'deepseek-v4-pro',
      available: false,
      contextWindow: 256_000,
      vision: false,
    })

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
    expect(entries.find((model: { id: string }) => model.id === 'deepseek-flash').contextWindow).toBe(
      128_000
    )
    expect(entries.find((model: { id: string }) => model.id === 'deepseek-v4-pro').input).toEqual([
      'text',
    ])
  })

  it('keeps catalog maxTokens as an upper bound and follows user image flags', async () => {
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
          models: [
            { id: 'deepseek-flash', contextWindow: 1_000_000, image: false },
            { id: 'custom-vision-model', contextWindow: 64_000, image: true },
          ],
        },
      })
    )

    const capabilities = await manager.getModelCapabilities()
    expect(capabilities.models?.find((model) => model.id === 'deepseek-flash')?.vision).toBe(false)
    expect(capabilities.models?.find((model) => model.id === 'custom-vision-model')?.vision).toBe(
      true
    )

    const modelsJson = JSON.parse(
      await fs.readFile(path.join(agentDir, 'models.json'), 'utf-8')
    )
    const entries = modelsJson.providers['pi-workbench'].models
    const flash = entries.find((model: { id: string }) => model.id === 'deepseek-flash')
    const vision = entries.find((model: { id: string }) => model.id === 'custom-vision-model')

    expect(flash.input).toEqual(['text'])
    expect(vision.input).toEqual(['text', 'image'])
    // 1M 档位配套 16384，但 catalog 只有 8192：只缩不放大
    expect(flash).toMatchObject({ contextWindow: 1_000_000, maxTokens: 8_192 })
    // 未登记的模型没有 catalog 上限，按档位配套值写入
    expect(vision).toMatchObject({ contextWindow: 64_000, maxTokens: 8_192 })
  })

  it('lists running sessions and clears them once the turn finishes', async () => {
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

    expect(manager.hasRunningSessions()).toEqual([])

    const pending = manager.chat('hi')
    expect(manager.hasRunningSessions()).toEqual(['session-1'])

    releasePrompt()
    await pending
    expect(manager.hasRunningSessions()).toEqual([])
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

describe('compacted session history and export', () => {
  /** 已压缩的会话：投影只剩压缩后的消息，entry 链仍含压缩前历史与压缩点 */
  function primeCompactedSession() {
    const session = createFakeSession()
    primeSdk(session)
    const branch = [
      {
        id: 'm-1',
        parentId: null,
        type: 'message',
        timestamp: new Date(1000).toISOString(),
        message: { role: 'user', content: 'long task', timestamp: 1000 },
      },
      {
        id: 'm-2',
        parentId: 'm-1',
        type: 'message',
        timestamp: new Date(1100).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'pre-compaction output' }],
          timestamp: 1100,
        },
      },
      {
        id: 'c-1',
        parentId: 'm-2',
        type: 'compaction',
        timestamp: new Date(1200).toISOString(),
        summary: 'summary',
        firstKeptEntryId: 'm-2',
        tokensBefore: 128_000,
      },
      {
        id: 'm-3',
        parentId: 'c-1',
        type: 'message',
        timestamp: new Date(1300).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'post-compaction output' }],
          timestamp: 1300,
        },
      },
    ]
    const base = createFakeSessionManager('session-1', session)
    sdk.continueRecent.mockImplementation(() => ({
      ...base,
      getBranch: () => branch,
      getEntries: () => branch,
    }))
    // 模型上下文（投影）已经不含压缩前的那条助手消息
    session.messages = [
      { role: 'user', content: 'long task', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'post-compaction output' }],
        timestamp: 1300,
      },
    ]
    return session
  }

  it('restores pre-compaction messages with the compaction point in order', async () => {
    primeCompactedSession()
    await manager.initialize(makeConfig())

    const history = manager.getSessionMessages('session-1')

    expect(history.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(history[1].content).toBe('pre-compaction output\npost-compaction output')
    expect(history[1].parts?.map((part) => part.type)).toEqual([
      'text',
      'compaction',
      'text',
    ])
    expect(history[1].parts?.[1]).toMatchObject({
      type: 'compaction',
      id: 'compaction-c-1',
      entryId: 'c-1',
      tokensBefore: 128_000,
    })
  })

  it('exports markdown and html with the full history and compaction marker', async () => {
    primeCompactedSession()
    await manager.initialize(makeConfig())

    const markdown = await manager.exportSessionMarkdown('session-1', 'zh')
    expect(markdown.success).toBe(true)
    expect(markdown.content).toContain('pre-compaction output')
    expect(markdown.content).toContain('post-compaction output')
    expect(markdown.content).toContain('上下文已压缩 · 压缩前 128,000 tokens')

    const html = await manager.exportSessionHtml('session-1', 'zh')
    expect(html.success).toBe(true)
    expect(html.content).toContain('pre-compaction output')
    expect(html.content).toContain('<p class="compacted">上下文已压缩 · 压缩前 128,000 tokens</p>')
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
