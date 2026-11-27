/**
 * Phase D · Track D1-B 单元测试：
 * - SessionRepository（O(1) 查找、列表、删除、导出、工具结果分页、extras / tabs 持久化）
 * - SessionController（显式轮次状态机 idle/running/aborting/disposed、abort/watchdog/hard-stop、审批/计划/工作树调度）
 * - pi-bridge 浏览器安全子路径（pi-bridge/protocol、pi-bridge/presets、pi-bridge/images 零 node:* 依赖验证）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

const sdk = vi.hoisted(() => ({
  sessionFindById: vi.fn(),
  sessionList: vi.fn(),
  sessionListAll: vi.fn(),
  sessionOpen: vi.fn(),
  sessionCreate: vi.fn(),
}))

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: vi.fn(),
  ModelRuntime: { create: vi.fn() },
  DefaultResourceLoader: class {
    async reload() {}
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
  createBashToolDefinition: () => ({
    name: 'bash',
    label: 'bash',
    description: 'Run bash',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    promptGuidelines: [],
    execute: async () => ({ content: [{ type: 'text', text: '' }] }),
  }),
  createPowerShellToolDefinition: () => ({
    name: 'powershell',
    label: 'powershell',
    description: 'Run PowerShell',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    promptGuidelines: [],
    execute: async () => ({ content: [{ type: 'text', text: '' }] }),
  }),
  SessionManager: {
    findById: sdk.sessionFindById,
    list: sdk.sessionList,
    listAll: sdk.sessionListAll,
    open: sdk.sessionOpen,
    create: sdk.sessionCreate,
  },
}))

import { AgentManager, AgentRuntimeHost, ABORT_GRACE_MS, STALL_TIMEOUT_MS } from '../../pi-bridge/src/agent-manager'
import { SessionController } from '../../pi-bridge/src/session-controller'
import { SessionRepository, readSessionHeaderInfo } from '../../pi-bridge/src/session-repository'
import { SessionExtrasStore, emptyExtras } from '../../pi-bridge/src/session-extras'
import type { SessionRuntime } from '../../pi-bridge/src/agent-runtime-types'
import type { AgentConfig, AgentLogger } from '../../pi-bridge/src/types'

const silentLogger: AgentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

function makeFakeSessionManager(
  id: string,
  cwd: string,
  options: {
    file?: string | null
    branch?: any[]
    name?: string
  } = {}
) {
  const branch = options.branch ?? []
  return {
    getSessionId: () => id,
    getCwd: () => cwd,
    getSessionFile: () => options.file ?? null,
    getHeader: () => ({ type: 'session', id, timestamp: new Date(1_000).toISOString(), cwd }),
    getSessionName: () => options.name,
    getLeafId: () => (branch.length > 0 ? branch[branch.length - 1].id : null),
    getEntry: (entryId: string) => branch.find((e) => e.id === entryId),
    getBranch: () => branch,
    getEntries: () => branch,
    getTree: () => [],
    appendSessionInfo: vi.fn(),
    isPersisted: () => Boolean(options.file),
  } as any
}

function makeControllerRuntime(
  id: string,
  cwd: string,
  sessionOverrides: Record<string, unknown> = {},
  branch: any[] = []
) {
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  const activeTools: string[] = ['read', 'write', 'edit', 'bash']
  const session: any = {
    messages: [] as any[],
    model: { provider: 'deepseek', id: 'deepseek-chat', api: 'openai-completions', maxTokens: 4096 },
    thinkingLevel: 'medium',
    subscribe: (listener: (event: Record<string, unknown>) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (event: Record<string, unknown>) => {
      for (const listener of [...listeners]) listener(event)
    },
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    compact: vi.fn(async () => ({
      summary: 'sum',
      firstKeptEntryId: 'e1',
      tokensBefore: 10_000,
      estimatedTokensAfter: 2_000,
    })),
    sendCustomMessage: vi.fn(async () => {}),
    setActiveToolsByName: vi.fn((names: string[]) => {
      activeTools.splice(0, activeTools.length, ...names)
    }),
    getAllTools: () => activeTools.map((name) => ({ name, exposure: 'direct' })),
    getContextUsage: () => ({ tokens: 2000, contextWindow: 100_000, percent: 2 }),
    getSessionStats: () => ({
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
      cost: 0.01,
      toolCalls: 1,
      totalMessages: 2,
    }),
    setModel: vi.fn(async (m: any) => {
      session.model = m
    }),
    setThinkingLevel: vi.fn((level: string) => {
      session.thinkingLevel = level
    }),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    ...sessionOverrides,
  }

  const runtime: SessionRuntime = {
    id,
    sessionManager: makeFakeSessionManager(id, cwd, { branch }),
    session,
    resourceLoader: null,
    unsubscribe: null,
    isProcessing: false,
    onTextDelta: null,
    turnTrace: null,
    traceSinks: new Set(),
    onTrace: () => {},
    watchdog: null,
    sdkStreaming: false,
    bgWatchdog: null,
    thinkingDeltaSeen: new Set(),
    thinkingStarts: new Map(),
    toolFiles: new Map(),
    editSnapshots: new Map(),
    pendingEdits: [],
    messageHistory: [],
    createdAt: 1_000,
    updatedAt: 2_000,
    titleAttempted: false,
    titleFailures: 0,
    pendingTitle: null,
    registeredTools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'],
    extras: emptyExtras(),
    extrasSave: Promise.resolve(),
    thinkingDurationsThisMessage: [],
    lastCompactionEntryId: null,
    lastCompactionEntry: null,
    compactingPromise: null,
  }

  return { runtime, session, activeTools }
}

describe('SessionRepository', () => {
  let tmpRoot = ''
  let workspaceDir = ''
  let sessionDir = ''
  let extrasStore: SessionExtrasStore
  let config: AgentConfig
  let repo: SessionRepository

  beforeEach(async () => {
    vi.clearAllMocks()
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-phase-d-repo-'))
    workspaceDir = path.join(tmpRoot, 'workspace')
    sessionDir = path.join(tmpRoot, 'agent', 'sessions')
    await fs.mkdir(workspaceDir, { recursive: true })
    await fs.mkdir(sessionDir, { recursive: true })
    extrasStore = new SessionExtrasStore(path.join(tmpRoot, 'agent', 'session-extras'))
    config = {
      workspaceDir,
      agentDir: path.join(tmpRoot, 'agent'),
      apiConfig: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    }
    sdk.sessionFindById.mockReturnValue(undefined)
    sdk.sessionListAll.mockResolvedValue([])
    sdk.sessionList.mockResolvedValue([])

    repo = new SessionRepository({
      getConfig: () => config,
      getSessionDir: () => sessionDir,
      getExtrasStore: () => extrasStore,
      getLogger: () => silentLogger,
      getSettledTitle: (id) => (id === 's-settled' ? 'Settled Title' : undefined),
    })
  })

  afterEach(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }
  })

  it('readSessionHeaderInfo reads cwd from first line and reports missing files', async () => {
    const missing = await readSessionHeaderInfo(path.join(sessionDir, 'missing.jsonl'))
    expect(missing).toEqual({ exists: false })

    const file = path.join(sessionDir, 'ok.jsonl')
    await fs.writeFile(
      file,
      `${JSON.stringify({ type: 'session', id: 's1', cwd: workspaceDir })}\n${'x'.repeat(20_000)}`,
      'utf-8'
    )
    expect(await readSessionHeaderInfo(file)).toEqual({ exists: true, cwd: workspaceDir })
  })

  it('findSessionFile prefers O(1) findById, enforces workspace ownership, and falls back to listAll', async () => {
    const ownedFile = path.join(sessionDir, 'owned.jsonl')
    await fs.writeFile(
      ownedFile,
      `${JSON.stringify({ type: 'session', id: 's-fast', cwd: workspaceDir })}\n`,
      'utf-8'
    )
    sdk.sessionFindById.mockReturnValueOnce(ownedFile)
    expect(await repo.findSessionFile('s-fast')).toBe(ownedFile)
    expect(sdk.sessionListAll).not.toHaveBeenCalled()

    // Foreign header cwd is rejected immediately without calling listAll
    const foreignFile = path.join(sessionDir, 'foreign.jsonl')
    await fs.writeFile(
      foreignFile,
      `${JSON.stringify({ type: 'session', id: 's-foreign', cwd: path.join(tmpRoot, 'other') })}\n`,
      'utf-8'
    )
    sdk.sessionFindById.mockReturnValueOnce(foreignFile)
    expect(await repo.findSessionFile('s-foreign')).toBeNull()
    expect(sdk.sessionListAll).not.toHaveBeenCalled()

    // Miss on findById falls back to listAll
    const fallbackFile = path.join(sessionDir, 'fallback.jsonl')
    sdk.sessionFindById.mockReturnValueOnce(undefined)
    sdk.sessionListAll.mockResolvedValueOnce([
      { id: 's-fb', cwd: workspaceDir, path: fallbackFile },
    ])
    expect(await repo.findSessionFile('s-fb')).toBe(fallbackFile)
    expect(sdk.sessionListAll).toHaveBeenCalledWith(sessionDir)
  })

  it('listSessions filters workspace, merges live summaries, and sorts descending by updatedAt', async () => {
    sdk.sessionListAll.mockResolvedValue([
      {
        id: 's-settled',
        cwd: workspaceDir,
        name: '',
        firstMessage: 'fallback text',
        messageCount: 2,
        created: new Date(1000),
        modified: new Date(2000),
      },
      {
        id: 's-other',
        cwd: path.join(tmpRoot, 'other'),
        name: 'Foreign',
        firstMessage: '',
        messageCount: 1,
        created: new Date(1000),
        modified: new Date(9000),
      },
    ])

    const list = await repo.listSessions([
      { id: 's-live', title: 'Live Unsaved', messageCount: 0, createdAt: 3000, updatedAt: 5000 },
    ])

    expect(list.map((item) => item.id)).toEqual(['s-live', 's-settled'])
    expect(list[1].title).toBe('Settled Title')
  })

  it('deleteSessionFiles enforces sessionDir boundary, cleans extras & file, and runs hook', async () => {
    // Rejects unsafe session id
    expect(
      await repo.deleteSessionFiles('../escape', { hadLocalRuntime: false })
    ).toMatchObject({ success: false, error: 'Invalid session id.' })

    // Refuses file outside sessionDir
    const outsideFile = path.join(tmpRoot, 'outside.jsonl')
    await fs.writeFile(
      outsideFile,
      `${JSON.stringify({ type: 'session', id: 's-out', cwd: workspaceDir })}\n`,
      'utf-8'
    )
    sdk.sessionFindById.mockReturnValueOnce(outsideFile)
    expect(
      await repo.deleteSessionFiles('s-out', { hadLocalRuntime: true })
    ).toMatchObject({ success: false })

    // Valid deletion removes jsonl + extras and triggers onBeforeCleanup
    const validFile = path.join(sessionDir, 's-del.jsonl')
    await fs.writeFile(
      validFile,
      `${JSON.stringify({ type: 'session', id: 's-del', cwd: workspaceDir })}\n`,
      'utf-8'
    )
    await repo.saveExtras('s-del', { ...emptyExtras(), title: 'Doomed' })
    sdk.sessionFindById.mockReturnValueOnce(validFile)
    const beforeCleanup = vi.fn(async () => {})

    const res = await repo.deleteSessionFiles('s-del', {
      hadLocalRuntime: true,
      onBeforeCleanup: beforeCleanup,
    })
    expect(res).toEqual({ success: true })
    expect(beforeCleanup).toHaveBeenCalledTimes(1)
    await expect(fs.access(validFile)).rejects.toThrow()
    expect((await repo.loadExtrasWithStatus('s-del')).extras.title).toBeNull()
  })

  it('exports Markdown, HTML, JSON, JSONL path, and paginates tool results', () => {
    const longOutput = `${'A'.repeat(10)}😀${'B'.repeat(10)}`
    const branch = [
      {
        id: 'u1',
        type: 'message',
        timestamp: 1000,
        message: { role: 'user', content: 'Run check', timestamp: 1000 },
      },
      {
        id: 'a1',
        type: 'message',
        timestamp: 1100,
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'echo hi' } },
          ],
        },
      },
      {
        id: 'tr1',
        type: 'message',
        timestamp: 1200,
        message: {
          role: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'bash',
          content: [
            { type: 'text', text: longOutput },
            { type: 'image', data: 'QUJD', mimeType: 'image/png' },
          ],
        },
      },
      {
        id: 'a2',
        type: 'message',
        timestamp: 1300,
        message: { role: 'assistant', content: [{ type: 'text', text: 'All good!' }] },
      },
    ]

    const sm = makeFakeSessionManager('s-exp', workspaceDir, {
      file: path.join(sessionDir, 's-exp.jsonl'),
      branch,
    })

    const md = repo.exportMarkdown(sm, 'Demo', 'en')
    expect(md.content).toContain('# Demo')
    expect(md.content).toContain('Run check')
    expect(md.content).toContain('All good!')

    const html = repo.exportHtml(sm, 'Demo', 'zh')
    expect(html.content).toContain('<h1>Demo</h1>')
    expect(html.content).toContain('All good!')

    const json = repo.exportJson(sm, 'Demo')
    expect(JSON.parse(json.content).turns).toHaveLength(1)

    expect(repo.getSessionJsonlPath(sm, 'Demo')).toEqual({
      success: true,
      title: 'Demo',
      path: path.join(sessionDir, 's-exp.jsonl'),
    })

    const meta = repo.getToolResultMeta(sm, [], 'tc-1')
    expect(meta).toMatchObject({ success: true, meta: { toolName: 'bash', imageCount: 1 } })

    // Pagination respects UTF-16 surrogate pair boundary at index 10..11
    const firstChunk = repo.readToolResultChunk(sm, [], 'tc-1', 0, 11)
    expect(firstChunk).toMatchObject({ success: true, text: `${'A'.repeat(10)}😀`, done: false })
    const secondChunk = repo.readToolResultChunk(sm, [], 'tc-1', firstChunk.nextOffset, 50)
    expect(secondChunk).toMatchObject({ success: true, text: 'B'.repeat(10), done: true })

    expect(repo.getToolResultImage(sm, [], 'tc-1', 0)).toEqual({
      success: true,
      data: 'QUJD',
      mimeType: 'image/png',
    })
    expect(repo.getToolResultText(sm, [], 'tc-1')).toEqual({
      success: true,
      text: longOutput,
      toolName: 'bash',
    })
  })

  it('persists and loads workspace open tabs with sanitization and cap of 20', async () => {
    expect(await repo.loadOpenTabs()).toEqual({ open: [], active: null })
    const many = Array.from({ length: 25 }, (_, i) => `s-${i}`)
    await repo.saveOpenTabs({ open: [...many, 123 as unknown as string], active: 's-2' })
    const loaded = await repo.loadOpenTabs()
    expect(loaded.open).toHaveLength(20)
    expect(loaded.active).toBe('s-2')
  })
})

describe('SessionController turn state machine & lifecycle', () => {
  const workspaceDir = '/ws/demo'
  const baseConfig: AgentConfig = {
    workspaceDir,
    apiConfig: { providerId: 'deepseek', modelId: 'deepseek-chat' },
  }

  function buildController(
    sessionOverrides: Record<string, unknown> = {},
    depOverrides: Record<string, unknown> = {}
  ) {
    const { runtime, session, activeTools } = makeControllerRuntime('s-ctrl', workspaceDir, sessionOverrides)
    const onPendingRootReady = vi.fn()
    const onAgentSettled = vi.fn()
    const onHardStop = vi.fn(async () => {})
    const saveExtras = vi.fn(async () => {})

    const controller = new SessionController(runtime, {
      getConfig: () => baseConfig,
      getLogger: () => silentLogger,
      saveExtras,
      resolveSessionModel: () => session.model,
      outputLimit: () => 4096,
      getSummaryTitle: () => 'Test Session',
      settleSessionTitle: vi.fn(),
      maybeGenerateTitle: vi.fn(async () => {}),
      deriveMessages: () => [],
      timelineMessages: () => [],
      onPendingRootReady,
      onAgentSettled,
      onHardStop,
      ...depOverrides,
    })

    return { controller, runtime, session, activeTools, onPendingRootReady, onAgentSettled, onHardStop, saveExtras }
  }

  it('transitions idle -> running -> aborting -> idle and rejects concurrent chat', async () => {
    let releasePrompt!: () => void
    let abortSawRunning = false
    const { controller, session } = buildController({
      prompt: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releasePrompt = resolve
          })
      ),
      abort: vi.fn(async () => {
        abortSawRunning = controller.getTurnState() === 'aborting'
        session.messages.push({ role: 'assistant', content: '', stopReason: 'aborted' })
        releasePrompt()
      }),
    })

    expect(controller.getTurnState()).toBe('idle')
    expect(controller.isBusy()).toBe(false)

    const chatPromise = controller.chat('hello')
    expect(controller.getTurnState()).toBe('running')
    expect(controller.isBusy()).toBe(true)

    const concurrent = await controller.chat('second')
    expect(concurrent).toMatchObject({
      success: false,
      error: 'This session is currently processing another request.',
    })

    await controller.abort()
    expect(abortSawRunning).toBe(true)
    const result = await chatPromise
    expect(result).toMatchObject({ success: false, error: 'Agent request was aborted.' })
    expect(controller.getTurnState()).toBe('idle')
    expect(controller.isBusy()).toBe(false)
  })

  it('triggers stall watchdog -> aborting -> hard stop callback and cleans up timers', async () => {
    vi.useFakeTimers()
    try {
      const { controller, runtime, session, onHardStop } = buildController({
        // Prompt and abort both hang to force the hard-stop grace timer
        prompt: vi.fn(() => new Promise<void>(() => {})),
        abort: vi.fn(() => new Promise<void>(() => {})),
      })

      const chatPromise = controller.chat('hang forever')
      expect(controller.getTurnState()).toBe('running')

      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS)
      expect(session.abort).toHaveBeenCalledTimes(1)
      expect(controller.getTurnState()).toBe('aborting')

      await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS)
      const outcome = await chatPromise
      expect(outcome.success).toBe(false)
      expect(outcome.error).toContain('stalled')
      expect(onHardStop).toHaveBeenCalledWith(controller)
      expect(runtime.watchdog).toBeNull()
      expect(controller.getTurnState()).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('transitions to disposed and rejects subsequent operations cleanly', async () => {
    const { controller, session } = buildController()

    session.emit({ type: 'agent_start' })
    expect(controller.getTurnState()).toBe('running')

    await controller.dispose()
    expect(controller.getTurnState()).toBe('disposed')
    expect(controller.isDisposed()).toBe(true)
    expect(session.abort).toHaveBeenCalledTimes(1)
    expect(session.dispose).toHaveBeenCalledTimes(1)

    expect(await controller.chat('after dispose')).toMatchObject({ success: false })
    expect(await controller.steer('after dispose')).toMatchObject({ success: false })
    expect(await controller.compactContext()).toMatchObject({ success: false })
    expect(
      await controller.sendCustomMessage({ customType: 'evt', content: 'hi' })
    ).toMatchObject({ success: false })
  })

  it('coordinates pending worktree root, approval fail-closed, and plan mode approval', async () => {
    const { controller, runtime, session, onPendingRootReady, onAgentSettled } = buildController()

    // Fail-closed approval when no channel is configured
    const denied = await controller.requestToolApproval({
      requestId: 'r1',
      workspaceDir,
      sessionId: 's-ctrl',
      toolCallId: 'tc-1',
      toolName: 'bash',
      category: 'command',
      summary: 'rm -rf',
      details: {},
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })
    expect(denied.action).toBe('deny')

    // Plan mode approval switches permission and activates tools
    runtime.extras.plan = {
      id: 'plan-1',
      summary: 'Refactor',
      status: 'proposed',
      createdAt: 1,
      updatedAt: 1,
      steps: [{ id: 'step-1', title: 'Step 1', files: [], status: 'pending' }],
    }
    const approved = await controller.approvePlan('plan-1', 'auto')
    expect(approved.success).toBe(true)
    expect(approved.plan?.status).toBe('approved')
    expect(approved.plan?.steps[0].status).toBe('in_progress')
    expect(approved.permission).toEqual({ mode: 'auto', grants: [] })

    // Pending root switch fires callback on agent_settled
    controller.schedulePendingRoot('/ws/wt-feature', 'feature')
    expect(controller.hasPendingRoot()).toBe(true)
    session.emit({ type: 'agent_settled', aborted: false })
    expect(onAgentSettled).toHaveBeenCalledWith('s-ctrl')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onPendingRootReady).toHaveBeenCalledWith(controller)

    expect(AgentRuntimeHost).toBe(AgentManager)
  })
})

describe('pi-bridge browser-safe subpaths (zero node:* imports)', () => {
  const repoRoot = path.resolve(__dirname, '../..')

  it('resolves pi-bridge/protocol, pi-bridge/presets, and pi-bridge/images exports', async () => {
    const protocol = await import('pi-bridge/protocol')
    const presets = await import('pi-bridge/presets')
    const images = await import('pi-bridge/images')

    expect(protocol.CLOUD_PROTOCOL_VERSION).toBe(1)
    expect(
      protocol.parseClientToServerFrame(
        JSON.stringify({ v: protocol.CLOUD_PROTOCOL_VERSION, type: 'ping', at: 123 })
      )
    ).toMatchObject({ ok: true })

    expect(presets.PROVIDER_PRESETS.length).toBeGreaterThan(0)
    expect(presets.isPresetProviderId('openai')).toBe(true)
    expect(presets.resolveLimits({ contextWindow: 128_000, maxTokens: 16_000 }, { maxTokens: 8_000 })).toEqual({
      contextWindow: 128_000,
      maxTokens: 8_000,
    })

    expect(images.MAX_CHAT_IMAGES).toBe(10)
    expect(images.validateChatImages([{ data: 'AAAA', mimeType: 'image/png' }])).toEqual({
      images: [{ data: 'AAAA', mimeType: 'image/png' }],
    })
    expect(images.validateChatImages([{ data: 'AAAA', mimeType: 'image/svg+xml' }]).error).toBeTruthy()
  })

  it('guarantees zero node:* or Node built-in imports in browser-safe source and dist files', async () => {
    const forbiddenImport =
      /\bfrom\s+['"](?:node:|fs(?:\/promises)?|path|os|crypto|child_process|http|https|net|tls|url|stream|worker_threads|@earendil-works\/pi-)/

    const files = [
      path.join(repoRoot, 'pi-bridge/src/protocol.ts'),
      path.join(repoRoot, 'pi-bridge/src/cloud-protocol.ts'),
      path.join(repoRoot, 'pi-bridge/src/presets.ts'),
      path.join(repoRoot, 'pi-bridge/src/images.ts'),
      path.join(repoRoot, 'pi-bridge/dist/protocol.js'),
      path.join(repoRoot, 'pi-bridge/dist/cloud-protocol.js'),
      path.join(repoRoot, 'pi-bridge/dist/presets.js'),
      path.join(repoRoot, 'pi-bridge/dist/images.js'),
    ]

    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8')
      expect(content, `${path.relative(repoRoot, file)} must not import Node or Pi SDK modules`).not.toMatch(
        forbiddenImport
      )
    }
  })
})
