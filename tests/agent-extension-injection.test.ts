/**
 * 内核改造（G1/G2/G3 + 常驻 trace + 补导出）的回归用例。
 *
 * 这些能力供云端 / 工单会话注入使用，验收点是「缺省行为不变 + 显式配置生效」。
 */

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
  sessionListAll: vi.fn(),
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
    listAll: sdk.sessionListAll,
  },
}))

type SessionEvent = Record<string, unknown>

interface FakeSession {
  messages: Array<Record<string, unknown>>
  activeTools: string[]
  subscribed: boolean
  subscribe: (listener: (event: SessionEvent) => void) => () => void
  prompt: (message: string) => Promise<void>
  sendCustomMessage: (message: unknown, options?: unknown) => Promise<void>
  customMessages: Array<{ message: any; options: any }>
  abort: () => Promise<void>
  dispose: () => void
  emit: (event: SessionEvent) => void
  getActiveToolNames: () => string[]
  setActiveToolsByName: (names: string[]) => void
  getAllTools: () => Array<{ name: string; exposure: string }>
}

const REGISTERED_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']

function createFakeSession(): FakeSession {
  const listeners = new Set<(event: SessionEvent) => void>()
  const session: FakeSession = {
    messages: [],
    activeTools: [...REGISTERED_TOOLS],
    subscribed: false,
    subscribe: (listener) => {
      session.subscribed = true
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    prompt: async () => {},
    sendCustomMessage: async (message, options) => {
      session.customMessages.push({ message, options })
    },
    customMessages: [],
    abort: async () => {},
    dispose: () => {},
    emit: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
    getActiveToolNames: () => [...session.activeTools],
    setActiveToolsByName: (names) => {
      session.activeTools = [...names]
    },
    getAllTools: () =>
      REGISTERED_TOOLS.map((name) => ({ name, exposure: 'direct' })),
  }
  return session
}

function createFakeSessionManager(id: string) {
  return {
    getSessionId: () => id,
    getCwd: () => workspaceDir,
    getSessionFile: () => null,
    getHeader: () => ({
      type: 'session',
      id,
      timestamp: new Date().toISOString(),
      cwd: workspaceDir,
    }),
    getSessionName: () => undefined,
    getLeafId: () => null,
    getEntry: () => undefined,
    getBranch: () => [],
    getEntries: () => [],
    getTree: () => [],
    branch: () => {},
    appendSessionInfo: () => 'entry-1',
    isPersisted: () => false,
  }
}

/** 扩展工厂拿到的 pi 对象只用到 on / registerTool 两个方法 */
function createFakePi() {
  const handlers = new Map<string, (event: unknown) => unknown>()
  const tools: string[] = []
  return {
    handlers,
    tools,
    api: {
      on: (name: string, handler: (event: unknown) => unknown) => {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
      registerTool: (definition: { name: string }) => {
        tools.push(definition.name)
      },
    },
  }
}

let tmpRoot: string
let workspaceDir: string
let agentDir: string
let manager: AgentManager
let sessionCounter: number

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    workspaceDir,
    agentDir,
    apiConfig: { providerId: 'deepseek', modelId: 'test-model' },
    ...overrides,
  }
}

function lastFactoryList(): any[] {
  const loader = sdk.loaders[sdk.loaders.length - 1]
  return loader?.options?.extensionFactories ?? []
}

/** 把工厂跑一遍，返回它们注册的工具与事件 */
function mountAll(factories: any[]) {
  const fakePi = createFakePi()
  for (const factory of factories) factory(fakePi.api)
  return { tools: fakePi.tools, handlers: fakePi.handlers }
}

async function readExtrasFile(sessionId: string): Promise<any> {
  const file = path.join(agentDir, 'session-extras', `${sessionId}.json`)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf-8'))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`extras file not written: ${file}`)
}

beforeEach(async () => {
  vi.clearAllMocks()
  sdk.loaders.length = 0
  sessionCounter = 0
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-cloud-test-'))
  workspaceDir = path.join(tmpRoot, 'workspace')
  agentDir = path.join(tmpRoot, 'agent')
  await fs.mkdir(workspaceDir, { recursive: true })
  manager = new AgentManager()
})

afterEach(async () => {
  await manager.dispose()
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
})

function primeSdk(session: FakeSession): void {
  sdk.modelRuntimeCreate.mockResolvedValue({
    getModel: vi.fn(() => ({ provider: 'pi-workbench', id: 'test-model' })),
  })
  sdk.continueRecent.mockImplementation(() => createFakeSessionManager('session-initial'))
  sdk.sessionCreate.mockImplementation(() => {
    sessionCounter += 1
    return createFakeSessionManager(`session-${sessionCounter}`)
  })
  sdk.sessionOpen.mockImplementation(() => createFakeSessionManager('session-opened'))
  sdk.sessionFindById.mockImplementation(() => null)
  sdk.sessionList.mockResolvedValue([])
  sdk.sessionListAll.mockResolvedValue([])
  sdk.createAgentSession.mockResolvedValue({ session })
}

describe('G1 扩展注入与剔除', () => {
  it('缺省装配三个内置扩展 + 压缩钩子，行为与历史一致', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig())
    const factories = lastFactoryList()
    expect(factories).toHaveLength(4)

    const mounted = mountAll(factories)
    expect(mounted.tools).toEqual(
      expect.arrayContaining(['submit_plan', 'switch_worktree'])
    )
    expect(mounted.handlers.has('tool_call')).toBe(true)
    expect(mounted.handlers.has('session_before_compact')).toBe(true)
  })

  it('关掉 worktree 后不再注册 switch_worktree（工单会话必须这样装）', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(
      makeConfig({ builtinExtensions: { worktree: false } })
    )
    const factories = lastFactoryList()
    expect(factories).toHaveLength(3)

    const mounted = mountAll(factories)
    expect(mounted.tools).not.toContain('switch_worktree')
    // 审批与计划仍然在：工单会话靠 mode=auto 放行，而不是靠拆掉钩子
    expect(mounted.handlers.has('tool_call')).toBe(true)
    expect(mounted.tools).toContain('submit_plan')
  })

  it('三个内置扩展都能单独剔除，压缩钩子仍然注入', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(
      makeConfig({ builtinExtensions: { approval: false, plan: false, worktree: false } })
    )
    const factories = lastFactoryList()
    expect(factories).toHaveLength(1)
    const mounted = mountAll(factories)
    expect(mounted.tools).toEqual([])
    expect(mounted.handlers.has('tool_call')).toBe(false)
    expect(mounted.handlers.has('session_before_compact')).toBe(true)
  })

  it('外部工厂追加在最后，能看到内置扩展注册的结果', async () => {
    primeSdk(createFakeSession())
    const order: string[] = []
    await manager.initialize(
      makeConfig({
        extensionFactories: [
          (pi: any) => {
            order.push('external')
            pi.registerTool({ name: 'guard_probe' })
          },
        ],
      })
    )
    const factories = lastFactoryList()
    expect(factories).toHaveLength(5)
    const mounted = mountAll(factories)
    expect(mounted.tools).toContain('guard_probe')
    expect(order).toEqual(['external'])
  })
})

describe('G2 工具白名单', () => {
  it('与模式白名单取交集后应用到会话', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(
      makeConfig({ toolAllowlist: ['read', 'ls', 'grep', 'find', 'edit', 'write', 'bash'] })
    )
    const created = await manager.createSession(workspaceDir)
    expect(created.success).toBe(true)
    const session = sdk.createAgentSession.mock.results[0].value
    const active = (await session).session.activeTools as string[]
    expect(active.sort()).toEqual(
      ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'].sort()
    )
  })

  it('缺省不裁剪：ask/auto 模式下保留全部已注册工具', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig())
    await manager.createSession(workspaceDir)
    const session = (await sdk.createAgentSession.mock.results[0].value).session
    expect(session.activeTools.sort()).toEqual([...REGISTERED_TOOLS].sort())
  })
})

describe('G3 工单权限种子', () => {
  it('新建会话可以种成 auto，不依赖全局默认档', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig({ getDefaultPermissionLevel: () => 'ask' }))
    const created = await manager.createSession(workspaceDir, {
      permission: { mode: 'auto', grants: [] },
    })
    expect(created.success).toBe(true)
    const extras = await readExtrasFile(created.session!.id)
    expect(extras.permission).toEqual({ mode: 'auto', grants: [] })
  })

  it('不传 permission 时仍走全局默认档', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig({ getDefaultPermissionLevel: () => 'readonly' }))
    const created = await manager.createSession(workspaceDir)
    const extras = await readExtrasFile(created.session!.id)
    expect(extras.permission).toEqual({ mode: 'readonly', grants: [] })
  })

  it('种子只对下一次创建生效，不污染后续会话', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig({ getDefaultPermissionLevel: () => 'ask' }))
    const first = await manager.createSession(workspaceDir, {
      permission: { mode: 'auto', grants: [] },
    })
    const second = await manager.createSession(workspaceDir)
    expect((await readExtrasFile(first.session!.id)).permission.mode).toBe('auto')
    expect((await readExtrasFile(second.session!.id)).permission.mode).toBe('ask')
  })
})

describe('常驻 trace 与事件唤醒', () => {
  it('订阅者能收到没有 chat() 调用的轮次事件，取消后不再收到', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())
    const created = await manager.createSession(workspaceDir)
    const id = created.session!.id

    const seen: any[] = []
    const unsubscribe = await manager.subscribeTrace(id, (event) => seen.push(event))
    session.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: {} })
    expect(seen).toEqual([
      expect.objectContaining({ type: 'tool_start', toolCallId: 't1', toolName: 'read' }),
    ])

    unsubscribe()
    session.emit({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'read', args: {} })
    expect(seen).toHaveLength(1)
  })

  it('订阅者抛错不会掀掉本轮事件分发', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())
    const created = await manager.createSession(workspaceDir)
    const id = created.session!.id

    const seen: any[] = []
    await manager.subscribeTrace(id, () => {
      throw new Error('sink boom')
    })
    await manager.subscribeTrace(id, (event) => seen.push(event))
    expect(() =>
      session.emit({
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'read',
        args: {},
      })
    ).not.toThrow()
    expect(seen).toHaveLength(1)
  })

  it('sendCustomMessage 原样转发 customType / details / deliverAs', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())
    const created = await manager.createSession(workspaceDir)

    const result = await manager.sendCustomMessage(
      created.session!.id,
      {
        customType: 'task-event',
        content: 'task T-1 finished',
        display: false,
        details: { eventId: 'evt-1' },
      },
      { triggerTurn: true, deliverAs: 'followUp' }
    )

    expect(result.success).toBe(true)
    expect(session.customMessages).toHaveLength(1)
    expect(session.customMessages[0].message).toEqual({
      customType: 'task-event',
      content: 'task T-1 finished',
      display: false,
      details: { eventId: 'evt-1' },
    })
    expect(session.customMessages[0].options).toEqual({
      triggerTurn: true,
      deliverAs: 'followUp',
    })
  })

  it('空 customType 直接拒绝，不触发 SDK 调用', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(makeConfig())
    const created = await manager.createSession(workspaceDir)

    const result = await manager.sendCustomMessage(created.session!.id, {
      customType: '  ',
      content: 'x',
    })
    expect(result.success).toBe(false)
    expect(session.customMessages).toHaveLength(0)
  })

  it('agent_settled 触发 onAgentSettled（事件唤醒轮次的结束信号）', async () => {
    const session = createFakeSession()
    primeSdk(session)
    const settled: string[] = []
    await manager.initialize(makeConfig({ onAgentSettled: (id) => settled.push(id) }))
    const created = await manager.createSession(workspaceDir)

    session.emit({ type: 'agent_settled', aborted: false })
    // initialize() 会先开一个“最近会话”，两个运行时共用一个假 session，都会收到事件
    expect(settled).toContain(created.session!.id)
  })
})

describe('压缩钩子转发', () => {
  it('把 branchEntries 规模与原样交给宿主，不阻塞压缩', async () => {
    const session = createFakeSession()
    primeSdk(session)
    const received: any[] = []
    await manager.initialize(
      makeConfig({ onSessionBeforeCompact: (id, event) => received.push({ id, event }) })
    )
    await manager.createSession(workspaceDir)

    const factories = lastFactoryList()
    const mounted = mountAll(factories)
    const handler = mounted.handlers.get('session_before_compact')!
    await handler({
      reason: 'threshold',
      preparation: { tokensBefore: 1234 },
      branchEntries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      willRetry: false,
    })

    expect(received).toEqual([
      {
        id: 'session-1',
        event: { reason: 'threshold', tokensBefore: 1234, entryCount: 3, willRetry: false },
      },
    ])
  })

  it('宿主回调抛错时钩子仍正常返回', async () => {
    const session = createFakeSession()
    primeSdk(session)
    await manager.initialize(
      makeConfig({
        onSessionBeforeCompact: () => {
          throw new Error('memory boom')
        },
      })
    )
    await manager.createSession(workspaceDir)

    const mounted = mountAll(lastFactoryList())
    const handler = mounted.handlers.get('session_before_compact')!
    await expect(
      handler({ reason: 'manual', preparation: {}, branchEntries: [], willRetry: false })
    ).resolves.toBeUndefined()
  })
})

describe('isSessionBusy', () => {
  it('未在跑轮次时返回 false，未知会话也不抛错', async () => {
    primeSdk(createFakeSession())
    await manager.initialize(makeConfig())
    const created = await manager.createSession(workspaceDir)
    expect(manager.isSessionBusy(created.session!.id)).toBe(false)
    expect(manager.isSessionBusy('session-unknown')).toBe(false)
  })
})
