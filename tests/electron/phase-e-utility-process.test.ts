// @vitest-environment node

import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFileCredentialStore,
  createFileModelsStore,
  type AgentChatOptions,
  type AgentChatResult,
  type AgentConfig,
  type ApprovalRequestPayload,
} from 'pi-bridge'
import { AgentRegistry } from '../../electron/agent-registry'
import { ApprovalBroker } from '../../electron/approval-broker'
import { ChildRegistry } from '../../electron/child-registry'
import {
  AgentHostClient,
  type AgentHostCallbacks,
  type AgentHostCrashInfo,
  type MessageChannelLike,
  type StreamPortTarget,
  type UtilityProcessForkFn,
  type UtilityProcessLike,
} from '../../electron/agent-host-client'
import type {
  AgentHostSyncState,
  MessagePortLike,
  ParentPortLike,
  ParentPortMessageEvent,
} from '../../electron/agent-host-protocol'
import {
  attachAgentHostWorker,
  type AgentRuntimeInstance,
} from '../../electron/agent-host-worker'
import { attachPluginHostWorker } from '../../electron/plugin-host-worker'
import {
  PluginManager,
  type PluginUtilityProcessForkFn,
  type PluginUtilityProcessLike,
} from '../../electron/plugin-manager'
import { runShutdownSteps } from '../../electron/shutdown'

interface PairedMockPort extends MessagePortLike {
  onmessage: ((event: { data: unknown }) => void) | null
  readonly received: unknown[]
  closed: boolean
}

function createMockMessageChannel(): {
  channel: MessageChannelLike
  port1: PairedMockPort
  port2: PairedMockPort
} {
  const makeSide = (): PairedMockPort & {
    peer?: PairedMockPort
    emitter: EventEmitter
    started: boolean
    queue: unknown[]
  } => {
    const emitter = new EventEmitter()
    const port: PairedMockPort & {
      peer?: PairedMockPort
      emitter: EventEmitter
      started: boolean
      queue: unknown[]
    } = {
      emitter,
      started: false,
      queue: [],
      received: [],
      closed: false,
      onmessage: null,
      postMessage(message: unknown) {
        if (port.closed) throw new Error('Port is closed')
        const target = port.peer as typeof port | undefined
        if (!target || target.closed) return
        const deliver = () => {
          if (target.closed) return
          target.received.push(message)
          target.onmessage?.({ data: message })
          target.emitter.emit('message', { data: message })
        }
        if (target.started || target.onmessage || target.emitter.listenerCount('message') > 0) {
          deliver()
        } else {
          target.queue.push(message)
        }
      },
      start() {
        if (port.started) return
        port.started = true
        while (port.queue.length > 0) {
          const next = port.queue.shift()
          port.received.push(next)
          port.onmessage?.({ data: next })
          port.emitter.emit('message', { data: next })
        }
      },
      close() {
        if (port.closed) return
        port.closed = true
        port.emitter.emit('close')
        const peer = port.peer as typeof port | undefined
        if (peer && !peer.closed) {
          peer.emitter.emit('close')
        }
      },
      on(event, listener) {
        port.emitter.on(event, listener)
      },
      once(event, listener) {
        port.emitter.once(event, listener)
      },
    }
    return port
  }

  const port1 = makeSide()
  const port2 = makeSide()
  port1.peer = port2
  port2.peer = port1
  return { channel: { port1, port2 }, port1, port2 }
}

interface MockUtilityHarness {
  child: UtilityProcessLike
  workerPort: ParentPortLike
  parentInboundMessages: unknown[]
  parentOutboundMessages: unknown[]
  simulateExit: (code: number) => void
  env?: NodeJS.ProcessEnv
}

function createMockUtilityProcess(
  pid: number,
  env?: NodeJS.ProcessEnv
): MockUtilityHarness {
  const childEmitter = new EventEmitter()
  const workerEmitter = new EventEmitter()
  const parentInboundMessages: unknown[] = []
  const parentOutboundMessages: unknown[] = []
  let exited = false

  const workerPort: ParentPortLike = {
    on(event, listener) {
      workerEmitter.on(event, listener)
    },
    off(event, listener) {
      workerEmitter.off(event, listener)
    },
    removeListener(event, listener) {
      workerEmitter.removeListener(event, listener)
    },
    postMessage(message: unknown) {
      if (exited) return
      parentInboundMessages.push(message)
      queueMicrotask(() => {
        if (!exited) childEmitter.emit('message', message)
      })
    },
  }

  const simulateExit = (code: number): void => {
    if (exited) return
    exited = true
    queueMicrotask(() => {
      childEmitter.emit('exit', code)
    })
  }

  const child: UtilityProcessLike = {
    get pid() {
      return exited ? undefined : pid
    },
    stdout: null,
    stderr: null,
    postMessage(message: unknown, transfer?: unknown[]) {
      if (exited) throw new Error('UtilityProcess has already exited')
      parentOutboundMessages.push(message)
      const event: ParentPortMessageEvent = {
        data: message,
        ports: (transfer as MessagePortLike[] | undefined) ?? [],
      }
      queueMicrotask(() => {
        if (!exited) workerEmitter.emit('message', event)
      })
    },
    kill() {
      if (exited) return false
      simulateExit(1)
      return true
    },
    on(event: string, listener: (...args: any[]) => void) {
      childEmitter.on(event, listener)
      return child
    },
    once(event: string, listener: (...args: any[]) => void) {
      childEmitter.once(event, listener)
      return child
    },
  }

  queueMicrotask(() => {
    if (!exited) childEmitter.emit('spawn')
  })

  return { child, workerPort, parentInboundMessages, parentOutboundMessages, simulateExit, env }
}

function createFakeAgentRuntime(options: {
  onInitialize?: (config: AgentConfig) => Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string }
  onChat?: (
    sessionId: string | undefined,
    message: string,
    chatOpts: AgentChatOptions | undefined,
    config: AgentConfig | null
  ) => Promise<AgentChatResult>
} = {}): {
  runtime: AgentRuntimeInstance
  getConfig: () => AgentConfig | null
  disposed: { count: number }
  aborted: string[]
} {
  let savedConfig: AgentConfig | null = null
  let currentSessionId: string | null = 'sess-1'
  const running = new Set<string>()
  const disposed = { count: 0 }
  const aborted: string[] = []

  const runtime: AgentRuntimeInstance = {
    async initialize(config) {
      savedConfig = config
      if (options.onInitialize) return await options.onInitialize(config)
      return { success: true }
    },
    async chat(
      sessionOrMessage: string,
      messageOrOptions?: string | AgentChatOptions,
      maybeOptions?: AgentChatOptions
    ): Promise<AgentChatResult> {
      const hasSession = typeof messageOrOptions === 'string'
      const sessionId = hasSession ? sessionOrMessage : currentSessionId ?? 'sess-1'
      const message = hasSession ? messageOrOptions : sessionOrMessage
      const chatOpts = hasSession ? maybeOptions : (messageOrOptions as AgentChatOptions | undefined)
      running.add(sessionId)
      try {
        if (options.onChat) {
          return await options.onChat(sessionId, message, chatOpts, savedConfig)
        }
        chatOpts?.onTrace?.({ type: 'thinking_delta', delta: 'thinking...' })
        chatOpts?.onTrace?.({ type: 'text_delta', delta: `Echo: ${message}` })
        chatOpts?.onTrace?.({
          type: 'tool_start',
          toolCallId: 'tc-1',
          toolName: 'read',
          argsSummary: 'README.md',
          startedAt: 100,
        })
        chatOpts?.onTrace?.({
          type: 'tool_end',
          toolCallId: 'tc-1',
          toolName: 'read',
          status: 'success',
          durationMs: 12,
        })
        return { success: true, response: `Echo: ${message}` }
      } finally {
        running.delete(sessionId)
      }
    },
    async abort(sessionId?: string) {
      aborted.push(sessionId ?? '*')
    },
    async steer(_sessionId, message) {
      return { success: Boolean(message) }
    },
    async dispose() {
      disposed.count += 1
      running.clear()
      currentSessionId = null
    },
    async requestSessionRoot(_sessionId, root) {
      savedConfig?.onSessionRootChanged?.('sess-1', root)
      return { success: true, scheduled: false }
    },
    async listSessions() {
      return [{ id: 'sess-1', title: 'Session 1', messageCount: 2, createdAt: 1, updatedAt: 2 }]
    },
    async openSession(sessionId?: string) {
      currentSessionId = sessionId ?? 'sess-1'
      return { success: true, session: { id: currentSessionId, title: 'Session 1' }, history: [] }
    },
    async createSession() {
      currentSessionId = 'sess-2'
      return { success: true, session: { id: 'sess-2', title: 'New' }, history: [] }
    },
    async closeSession(sessionId: string) {
      if (currentSessionId === sessionId) currentSessionId = null
    },
    async renameSession(_sessionId, name) {
      savedConfig?.onSessionTitle?.('sess-1', name)
      return { success: true }
    },
    async deleteSession() {
      return { success: true }
    },
    async getContextUsage() {
      return { success: true, usage: { tokens: 120, contextWindow: 128000, percent: 1 } }
    },
    async compactContext() {
      return { success: true, tokensBefore: 500, estimatedTokensAfter: 100 }
    },
    async rewindToLastUser() {
      return { success: true, text: 'previous' }
    },
    async listBranches() {
      return { success: true, groups: [] }
    },
    async switchBranch() {
      return { success: true, history: [] }
    },
    async getToolResultMeta() {
      return {
        success: true,
        meta: { toolName: 'read', kind: 'text', chars: 5, bytes: 5, lines: 1, imageCount: 0 },
      }
    },
    async readToolResultChunk() {
      return { success: true, text: 'hello', offset: 0, nextOffset: 5, chars: 5, done: true }
    },
    async getToolResultImage() {
      return { success: true, data: 'AQID', mimeType: 'image/png' }
    },
    async getToolResultText() {
      return { success: true, text: 'hello', toolName: 'read' }
    },
    async exportSessionMarkdown() {
      return { success: true, title: 'Session 1', content: '# Session 1' }
    },
    async exportSessionHtml() {
      return { success: true, title: 'Session 1', content: '<html></html>' }
    },
    async getSessionJsonlPath() {
      return { success: true, title: 'Session 1', path: '/tmp/sess-1.jsonl' }
    },
    async getModelCapabilities() {
      return { success: true, models: [], selected: 'gpt-4o' }
    },
    async listPromptResources() {
      return { success: true, templates: [], skills: [] }
    },
    async getPlan() {
      return { success: true, plan: null }
    },
    async approvePlan() {
      return { success: true }
    },
    async rejectPlan() {
      return { success: true }
    },
    async getSessionSettings() {
      return {
        success: true,
        modelId: 'gpt-4o',
        thinkingLevel: 'medium',
        permission: { mode: 'ask', grants: [] },
      }
    },
    async setSessionModel() {
      return { success: true }
    },
    async setSessionThinking() {
      return { success: true }
    },
    async setSessionPermission(_sessionId, permission) {
      return { success: true, permission }
    },
    async getSessionStats() {
      return {
        success: true,
        stats: { tokens: 10, input: 4, output: 6, cost: 0.001, toolCalls: 1, messages: 2 },
      }
    },
    getSessionMessages() {
      return [{ role: 'user', content: 'hi', timestamp: 1 }]
    },
    getMessageHistory() {
      return [{ role: 'user', content: 'hi', timestamp: 1 }]
    },
    getCurrentSessionId() {
      return currentSessionId
    },
    hasRunningSessions() {
      return [...running]
    },
  }

  return { runtime, getConfig: () => savedConfig, disposed, aborted }
}

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('Phase E · Step E1: utilityProcess Isolation & MessagePort Streaming', () => {
  it('completes full AgentHostClient <-> agent-host-worker RPC lifecycle and tracks utility PID', async () => {
    const tmpDir = await makeTempDir('pi-phase-e-rpc-')
    const registry = new ChildRegistry()
    const fakeAgent = createFakeAgentRuntime()
    const sessionTitles: Array<{ sessionId: string; title: string }> = []
    const rootChanges: Array<{ sessionId: string; root: string }> = []
    const crashes: AgentHostCrashInfo[] = []
    let harness: MockUtilityHarness | null = null

    const forkUtilityProcess: UtilityProcessForkFn = () => {
      harness = createMockUtilityProcess(42001)
      attachAgentHostWorker(harness.workerPort, { createAgent: () => fakeAgent.runtime })
      return harness.child
    }

    const credentials = createFileCredentialStore({
      path: path.join(tmpDir, 'credentials.json'),
      cipher: {
        encrypt: (plain) => `enc:${Buffer.from(plain, 'utf-8').toString('base64')}`,
        decrypt: (stored) => Buffer.from(stored.slice(4), 'base64').toString('utf-8'),
      },
    })
    const modelsStore = createFileModelsStore({ path: path.join(tmpDir, 'models-store.json') })

    const syncState: AgentHostSyncState = {
      defaultPermissionLevel: 'ask',
      language: 'zh',
      webAccessConfigVersion: 'v1',
      sessionRoots: { 'sess-1': tmpDir },
    }

    const callbacks: AgentHostCallbacks = {
      credentials,
      modelsStore,
      readDocument: async () => null,
      requestApproval: async () => ({ action: 'allow-once' }),
      getWorktreeContext: () => 'worktree-ctx',
      onWorktreeSwitch: async () => ({ success: true, root: tmpDir }),
      resolveSessionRoot: (id) => syncState.sessionRoots[id],
      isSessionOfWorkspace: () => true,
      getSyncState: () => syncState,
      onSessionTitle: (sessionId, title) => sessionTitles.push({ sessionId, title }),
      onSessionRootChanged: (sessionId, root) => rootChanges.push({ sessionId, root }),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }

    const client = new AgentHostClient({
      workspaceDir: tmpDir,
      hostCallbacks: callbacks,
      onCrash: (info) => crashes.push(info),
      workerModulePath: '/virtual/agent-host-worker.js',
      forkUtilityProcess,
      createMessageChannel: () => createMockMessageChannel().channel,
      childRegistry: registry,
    })

    const initRes = await client.initialize({
      workspaceDir: tmpDir,
      agentDir: path.join(tmpDir, 'agent'),
      apiConfig: { providerId: 'openai', modelId: 'gpt-4o' },
      allowModelNetwork: false,
      webAccessExtensionPaths: [],
    })
    expect(initRes).toEqual({ success: true })
    expect(client.isInitialized()).toBe(true)
    expect(client.getPid()).toBe(42001)
    expect(registry.list()).toEqual([expect.objectContaining({ pid: 42001, group: 'utility' })])

    // 验证所有核心 RPC 方法正常往返
    await expect(client.listSessions()).resolves.toHaveLength(1)
    await expect(client.getSessionSettings('sess-1')).resolves.toMatchObject({
      success: true,
      modelId: 'gpt-4o',
      thinkingLevel: 'medium',
    })
    await expect(client.renameSession('sess-1', 'Renamed')).resolves.toEqual({ success: true })
    expect(sessionTitles).toEqual([{ sessionId: 'sess-1', title: 'Renamed' }])

    await expect(client.requestSessionRoot('sess-1', path.join(tmpDir, 'wt'))).resolves.toEqual({
      success: true,
      scheduled: false,
    })
    expect(rootChanges).toEqual([{ sessionId: 'sess-1', root: path.join(tmpDir, 'wt') }])

    const fallbackTraces: Array<{ type: string }> = []
    const chatRes = await client.chat('sess-1', 'hello', {
      requestId: 'req-1',
      onTrace: (ev) => fallbackTraces.push(ev),
    })
    expect(chatRes).toEqual({ success: true, response: 'Echo: hello' })
    expect(fallbackTraces.map((t) => t.type)).toEqual([
      'thinking_delta',
      'text_delta',
      'tool_start',
      'tool_end',
    ])

    await client.abort('sess-1')
    expect(fakeAgent.aborted).toEqual(['sess-1'])
    expect(client.getCurrentSessionId()).toBe('sess-1')
    expect(client.hasRunningSessions()).toEqual([])

    await client.dispose()
    expect(fakeAgent.disposed.count).toBe(1)
    expect(client.isInitialized()).toBe(false)
    expect(registry.size()).toBe(0)
    expect(crashes).toEqual([])
  })

  it('streams high-frequency trace events directly over transferred MessagePort with zero main-process per-token hop', async () => {
    const tmpDir = await makeTempDir('pi-phase-e-port-')
    const fakeAgent = createFakeAgentRuntime()
    let harness!: MockUtilityHarness

    const client = new AgentHostClient({
      workspaceDir: tmpDir,
      hostCallbacks: {
        credentials: createFileCredentialStore({
          path: path.join(tmpDir, 'credentials.json'),
          cipher: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.slice(4) },
        }),
        modelsStore: createFileModelsStore({ path: path.join(tmpDir, 'models-store.json') }),
        readDocument: async () => null,
        requestApproval: async () => ({ action: 'allow-once' }),
        getWorktreeContext: () => '',
        onWorktreeSwitch: async () => ({ success: true, root: tmpDir }),
        resolveSessionRoot: () => tmpDir,
        isSessionOfWorkspace: () => true,
        getSyncState: () => ({
          defaultPermissionLevel: 'ask',
          language: 'zh',
          webAccessConfigVersion: '',
          sessionRoots: {},
        }),
        onSessionTitle: () => {},
        onSessionRootChanged: () => {},
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      },
      workerModulePath: '/virtual/agent-host-worker.js',
      forkUtilityProcess: () => {
        harness = createMockUtilityProcess(42002)
        attachAgentHostWorker(harness.workerPort, { createAgent: () => fakeAgent.runtime })
        return harness.child
      },
      createMessageChannel: () => createMockMessageChannel().channel,
      childRegistry: new ChildRegistry(),
    })

    await client.initialize({
      workspaceDir: tmpDir,
      agentDir: path.join(tmpDir, 'agent'),
      apiConfig: { providerId: 'openai', modelId: 'gpt-4o' },
      allowModelNetwork: false,
      webAccessExtensionPaths: [],
    })

    // 模拟渲染层 webContents 接收主进程转交的 port2
    const transferredPorts: PairedMockPort[] = []
    const senderEmitter = new EventEmitter()
    const rendererSender: StreamPortTarget = {
      id: 7,
      isDestroyed: () => false,
      postMessage: (channel, _meta, transfer) => {
        expect(channel).toBe('agent:stream-port')
        const port = transfer?.[0] as PairedMockPort | undefined
        if (port) {
          port.start?.()
          transferredPorts.push(port)
        }
      },
      once: (event, listener) => senderEmitter.once(event, listener),
    }

    expect(client.attachRendererStreamPort(rendererSender)).toBe(true)
    // 同 webContents 重复 attach 必须幂等去重
    expect(client.attachRendererStreamPort(rendererSender)).toBe(true)
    expect(transferredPorts).toHaveLength(1)

    const fallbackSpy = vi.fn()
    harness.parentInboundMessages.length = 0

    const result = await client.chat('sess-1', 'stream me', {
      requestId: 'req-port-1',
      onTrace: fallbackSpy,
    })
    expect(result).toEqual({ success: true, response: 'Echo: stream me' })

    // 直连端口直接收到全部 4 条流式轨迹，带齐路由字段
    const portFrames = transferredPorts[0].received as Array<Record<string, unknown>>
    expect(portFrames.map((f) => f.type)).toEqual([
      'thinking_delta',
      'text_delta',
      'tool_start',
      'tool_end',
    ])
    expect(portFrames[1]).toMatchObject({
      requestId: 'req-port-1',
      workspaceDir: tmpDir,
      sessionId: 'sess-1',
      type: 'text_delta',
      delta: 'Echo: stream me',
    })

    // 主进程 parentPort 收到 0 条 stream-event（严格零逐 token 主进程中转）
    const mainRelayFrames = harness.parentInboundMessages.filter(
      (msg) =>
        Boolean(msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'stream-event')
    )
    expect(mainRelayFrames).toEqual([])
    expect(fallbackSpy).not.toHaveBeenCalled()

    await client.dispose()
  })

  it('fetches safeStorage-backed credentials strictly via main-process RPC and never sends plaintext secrets in init payload', async () => {
    const tmpDir = await makeTempDir('pi-phase-e-creds-')
    const credPath = path.join(tmpDir, 'credentials.json')
    const secretKey = 'sk-top-secret-never-in-init-999'

    const credentials = createFileCredentialStore({
      path: credPath,
      cipher: {
        encrypt: (plain) => `enc:${Buffer.from(plain, 'utf-8').toString('base64')}`,
        decrypt: (stored) => Buffer.from(stored.slice(4), 'base64').toString('utf-8'),
      },
    })
    await credentials.modify('openai', async () => ({ type: 'api_key', key: secretKey }))

    // 确认落盘文件为密文
    const diskRaw = await fs.readFile(credPath, 'utf-8')
    expect(diskRaw).not.toContain(secretKey)

    let observedRead: unknown = null
    let observedList: unknown = null
    let observedModified: unknown = null
    let harness!: MockUtilityHarness

    const fakeAgent = createFakeAgentRuntime({
      async onChat(_sessionId, _message, _opts, config) {
        observedRead = await config?.credentials?.read('openai')
        observedList = await config?.credentials?.list()
        observedModified = await config?.credentials?.modify('openai', async (current) => {
          expect(current).toEqual({ type: 'api_key', key: secretKey })
          return {
            type: 'oauth',
            access: 'access-rotated',
            refresh: 'refresh-rotated',
            expires: 9999999,
          }
        })
        return { success: true, response: 'auth-ok' }
      },
    })

    const client = new AgentHostClient({
      workspaceDir: tmpDir,
      hostCallbacks: {
        credentials,
        modelsStore: createFileModelsStore({ path: path.join(tmpDir, 'models-store.json') }),
        readDocument: async () => null,
        requestApproval: async () => ({ action: 'allow-once' }),
        getWorktreeContext: () => '',
        onWorktreeSwitch: async () => ({ success: true, root: tmpDir }),
        resolveSessionRoot: () => tmpDir,
        isSessionOfWorkspace: () => true,
        getSyncState: () => ({
          defaultPermissionLevel: 'ask',
          language: 'zh',
          webAccessConfigVersion: '',
          sessionRoots: {},
        }),
        onSessionTitle: () => {},
        onSessionRootChanged: () => {},
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      },
      workerModulePath: '/virtual/agent-host-worker.js',
      forkUtilityProcess: () => {
        harness = createMockUtilityProcess(42003)
        attachAgentHostWorker(harness.workerPort, { createAgent: () => fakeAgent.runtime })
        return harness.child
      },
      createMessageChannel: () => createMockMessageChannel().channel,
      childRegistry: new ChildRegistry(),
    })

    await client.initialize({
      workspaceDir: tmpDir,
      agentDir: path.join(tmpDir, 'agent'),
      apiConfig: { providerId: 'openai', modelId: 'gpt-4o' },
      allowModelNetwork: false,
      webAccessExtensionPaths: [],
    })

    // 初始化载荷绝不包含明文密钥或 credentials 句柄
    const initMessages = harness.parentOutboundMessages.filter(
      (msg) =>
        Boolean(
          msg &&
            typeof msg === 'object' &&
            (msg as { method?: unknown }).method === 'initialize'
        )
    )
    expect(initMessages).toHaveLength(1)
    expect(JSON.stringify(initMessages[0])).not.toContain(secretKey)
    expect(JSON.stringify(initMessages[0])).not.toContain('credentials')

    // 运行期按需经主进程 RPC 读取与原子轮换凭证
    await expect(client.chat('sess-1', 'check auth')).resolves.toEqual({
      success: true,
      response: 'auth-ok',
    })
    expect(observedRead).toEqual({ type: 'api_key', key: secretKey })
    expect(observedList).toEqual([{ providerId: 'openai', type: 'api_key' }])
    expect(observedModified).toEqual({
      type: 'oauth',
      access: 'access-rotated',
      refresh: 'refresh-rotated',
      expires: 9999999,
    })

    // 轮换后的 OAuth 凭证已由主进程安全加密落盘（不含明文 token）
    const updatedDisk = await fs.readFile(credPath, 'utf-8')
    expect(updatedDisk).not.toContain('access-rotated')
    await expect(credentials.read('openai')).resolves.toMatchObject({
      type: 'oauth',
      access: 'access-rotated',
    })

    await client.dispose()
  })

  it('recovers cleanly from unexpected utilityProcess crash during an active turn and pending approval', async () => {
    const tmpDir = await makeTempDir('pi-phase-e-crash-')
    const agentRegistry = new AgentRegistry()
    const childReg = new ChildRegistry()
    const resolvedApprovals: Array<{ requestId: string; action: string }> = []
    const crashBroadcasts: AgentHostCrashInfo[] = []
    const approvalBroker = new ApprovalBroker(
      () => {},
      (res) => resolvedApprovals.push({ requestId: res.requestId, action: res.decision.action })
    )

    let nextPid = 43001
    let currentHarness: MockUtilityHarness | null = null
    let turnStartedResolve: () => void = () => {}
    const turnStarted = new Promise<void>((resolve) => {
      turnStartedResolve = resolve
    })

    const createClient = (hangOnChat: boolean): AgentHostClient => {
      const fakeAgent = createFakeAgentRuntime({
        async onChat(_sessionId, message, _opts, config) {
          if (hangOnChat) {
            turnStartedResolve()
            const req: ApprovalRequestPayload = {
              requestId: 'apr-crash-1',
              workspaceDir: tmpDir,
              sessionId: 'sess-1',
              toolCallId: 'tc-crash',
              toolName: 'bash',
              category: 'command',
              summary: 'run test',
              details: { command: 'echo 1' },
              createdAt: Date.now(),
              expiresAt: Date.now() + 60_000,
            }
            // 模拟轮次正挂在审批上时子进程崩溃
            await config?.requestApproval?.(req)
            return new Promise<AgentChatResult>(() => {})
          }
          return { success: true, response: `Recovered: ${message}` }
        },
      })

      const client = new AgentHostClient({
        workspaceDir: tmpDir,
        hostCallbacks: {
          credentials: createFileCredentialStore({
            path: path.join(tmpDir, 'credentials.json'),
            cipher: { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.slice(4) },
          }),
          modelsStore: createFileModelsStore({ path: path.join(tmpDir, 'models-store.json') }),
          readDocument: async () => null,
          requestApproval: (req) => approvalBroker.request(req),
          getWorktreeContext: () => '',
          onWorktreeSwitch: async () => ({ success: true, root: tmpDir }),
          resolveSessionRoot: () => tmpDir,
          isSessionOfWorkspace: () => true,
          getSyncState: () => ({
            defaultPermissionLevel: 'ask',
            language: 'zh',
            webAccessConfigVersion: '',
            sessionRoots: {},
          }),
          onSessionTitle: () => {},
          onSessionRootChanged: () => {},
          logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        },
        onCrash: (info) => {
          approvalBroker.cancelWorkspace(info.workspaceDir, `Agent crashed (${info.exitCode})`)
          agentRegistry.evictIfSame(info.workspaceDir, client)
          crashBroadcasts.push(info)
        },
        workerModulePath: '/virtual/agent-host-worker.js',
        forkUtilityProcess: () => {
          currentHarness = createMockUtilityProcess(nextPid++)
          attachAgentHostWorker(currentHarness.workerPort, {
            createAgent: () => fakeAgent.runtime,
          })
          return currentHarness.child
        },
        createMessageChannel: () => createMockMessageChannel().channel,
        childRegistry: childReg,
      })
      return client
    }

    const firstClient = createClient(true)
    await firstClient.initialize({
      workspaceDir: tmpDir,
      agentDir: path.join(tmpDir, 'agent'),
      apiConfig: { providerId: 'openai', modelId: 'gpt-4o' },
      allowModelNetwork: false,
      webAccessExtensionPaths: [],
    })
    await agentRegistry.set(tmpDir, firstClient, 'cfg-1')
    expect(firstClient.getPid()).toBe(43001)

    // 发起一个正在等待工具审批的活跃对话
    const inFlightChat = firstClient.chat('sess-1', 'run command')
    await turnStarted
    await vi.waitFor(() => expect(approvalBroker.pendingCount).toBe(1))
    expect(firstClient.hasRunningSessions()).toContain('sess-1')

    // 模拟 utilityProcess 意外崩溃（exit code 1）
    expect(firstClient.killForTest()).toBe(true)

    await expect(inFlightChat).rejects.toThrow(/Agent process crashed \(exit code 1\)/)
    expect(crashBroadcasts).toEqual([
      { workspaceDir: tmpDir, exitCode: 1, interruptedSessionIds: ['sess-1'] },
    ])
    expect(approvalBroker.pendingCount).toBe(0)
    expect(resolvedApprovals).toEqual([{ requestId: 'apr-crash-1', action: 'deny' }])
    expect(agentRegistry.get(tmpDir)).toBeNull()
    expect(firstClient.isInitialized()).toBe(false)
    expect(childReg.size()).toBe(0)

    // 下一次初始化/对话无缝拉起全新 utilityProcess 并恢复工作
    const respawnedClient = createClient(false)
    await respawnedClient.initialize({
      workspaceDir: tmpDir,
      agentDir: path.join(tmpDir, 'agent'),
      apiConfig: { providerId: 'openai', modelId: 'gpt-4o' },
      allowModelNetwork: false,
      webAccessExtensionPaths: [],
    })
    await agentRegistry.set(tmpDir, respawnedClient, 'cfg-1')
    expect(respawnedClient.getPid()).toBe(43002)
    await expect(respawnedClient.chat('sess-1', 'after crash')).resolves.toEqual({
      success: true,
      response: 'Recovered: after crash',
    })

    await agentRegistry.disposeAll()
    expect(childReg.size()).toBe(0)
  })

  it('isolates verified plugins in per-workspace utilityProcess, rejects tampered hashes before fork, and recovers on crash', async () => {
    const workspace = await makeTempDir('pi-phase-e-plugin-ws-')
    const stateDir = await makeTempDir('pi-phase-e-plugin-state-')
    const stateFilePath = path.join(stateDir, 'workspace-plugins.json')
    const pluginDir = path.join(workspace, '.pi-workbench', 'plugins', 'demo')
    await fs.mkdir(pluginDir, { recursive: true })
    await fs.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({
        id: 'demo',
        name: 'Demo Plugin',
        version: '1.0.0',
        main: 'index.js',
        contributes: {
          commands: [{ id: 'demo.ping', title: 'Ping' }],
        },
      }),
      'utf-8'
    )
    const hookMarkerFile = path.join(stateDir, 'hook-seen.txt')
    const deactivateMarkerFile = path.join(stateDir, 'deactivated.txt')
    await fs.writeFile(
      path.join(pluginDir, 'index.js'),
      `const fs = require('fs')
module.exports = {
  activate(api) {
    api.registerCommand('demo.ping', async (arg) => {
      if (arg === 'hang') return await new Promise(() => {})
      return { success: true, output: 'pong:' + String(arg || '') }
    })
    api.on('file:saved', (payload) => {
      fs.writeFileSync(${JSON.stringify(hookMarkerFile)}, String(payload && payload.path || ''), 'utf-8')
    })
  },
  deactivate() {
    fs.writeFileSync(${JSON.stringify(deactivateMarkerFile)}, 'yes', 'utf-8')
  },
}`,
      'utf-8'
    )

    // 注入敏感环境变量以确认插件进程环境已脱敏
    const prevSecret = process.env.PI_WORKBENCH_WEB_SEARCH_KEY_TAVILY
    process.env.PI_WORKBENCH_WEB_SEARCH_KEY_TAVILY = 'tvly-must-not-leak'

    const registry = new ChildRegistry()
    let nextPid = 44001
    const spawnedEnvs: Array<NodeJS.ProcessEnv | undefined> = []
    const forkSpy = vi.fn<PluginUtilityProcessForkFn>((_modulePath, _args, options) => {
      spawnedEnvs.push(options?.env)
      const harness = createMockUtilityProcess(nextPid++, options?.env)
      attachPluginHostWorker(harness.workerPort)
      return harness.child as unknown as PluginUtilityProcessLike
    })

    const manager = new PluginManager({
      watch: false,
      stateFilePath,
      isolateInUtilityProcess: true,
      workerModulePath: '/virtual/plugin-host-worker.js',
      forkUtilityProcess: forkSpy,
      childRegistry: registry,
    })

    try {
      // 1. 未启用插件绝不派生 utilityProcess
      const disabledList = manager.loadWorkspace(workspace)
      expect(disabledList[0]?.enabled).toBe(false)
      expect(forkSpy).not.toHaveBeenCalled()

      // 2. 启用并钉住 SHA-256 哈希后才派生隔离 worker，且敏感环境变量被剥离
      manager.setEnabled(workspace, 'demo', true)
      const readyList = await manager.whenReady(workspace)
      expect(readyList[0]).toMatchObject({ id: 'demo', enabled: true })
      expect(forkSpy).toHaveBeenCalledTimes(1)
      expect(spawnedEnvs[0]?.PI_WORKBENCH_WEB_SEARCH_KEY_TAVILY).toBeUndefined()
      expect(manager.getWorkerPid(workspace)).toBe(44001)
      expect(registry.list()).toEqual([expect.objectContaining({ pid: 44001, group: 'utility' })])

      // 3. 命令调用与钩子派发在隔离 worker 中执行
      await expect(manager.invoke(workspace, 'demo.ping', 'ok')).resolves.toEqual({
        success: true,
        output: 'pong:ok',
      })
      await manager.emit(workspace, 'file:saved', { path: '/ws/a.ts' })
      await expect(fs.readFile(hookMarkerFile, 'utf-8')).resolves.toBe('/ws/a.ts')

      // 4. 模拟插件 worker 在执行挂起命令时意外崩溃：在途调用返回结构化错误，不崩主进程，且下次调用自动重建
      const hangingCall = manager.invoke(workspace, 'demo.ping', 'hang')
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(manager.killWorkerForTest(workspace)).toBe(true)
      await expect(hangingCall).resolves.toMatchObject({
        success: false,
        error: expect.stringMatching(/Plugin process crashed \(exit code 1\)/),
      })
      expect(registry.size()).toBe(0)

      // 下一次 invoke 自动重新校验哈希并拉起新 worker（PID 44002）
      await expect(manager.invoke(workspace, 'demo.ping', 'recovered')).resolves.toEqual({
        success: true,
        output: 'pong:recovered',
      })
      expect(forkSpy).toHaveBeenCalledTimes(2)
      expect(manager.getWorkerPid(workspace)).toBe(44002)

      // 5. 篡改磁盘插件文件后重新加载：哈希校验在派生 worker 前拦截（forkSpy 次数不增）
      await fs.writeFile(
        path.join(pluginDir, 'index.js'),
        `module.exports = { activate() { throw new Error('must never execute') } }`,
        'utf-8'
      )
      const afterTamper = manager.loadWorkspace(workspace)
      expect(afterTamper[0]?.enabled).toBe(false)
      expect(afterTamper[0]?.error).toMatch(/changed since approval/i)
      expect(forkSpy).toHaveBeenCalledTimes(2)
      // 卸载旧 worker 时已调用 deactivate()
      await vi.waitFor(async () => {
        await expect(fs.readFile(deactivateMarkerFile, 'utf-8')).resolves.toBe('yes')
      })

      await manager.disposeAllAsync()
      expect(registry.size()).toBe(0)
    } finally {
      if (prevSecret === undefined) delete process.env.PI_WORKBENCH_WEB_SEARCH_KEY_TAVILY
      else process.env.PI_WORKBENCH_WEB_SEARCH_KEY_TAVILY = prevSecret
    }
  })

  it('tracks utility PIDs in ChildRegistry and terminates lingering utility processes during shutdown steps', async () => {
    const registry = new ChildRegistry()
    const gracefulAgentKill = vi.fn()
    const gracefulPluginKill = vi.fn()

    registry.register({ pid: 51001, group: 'utility', kill: gracefulAgentKill })
    registry.register({ pid: 51002, group: 'utility', kill: gracefulPluginKill })

    const killedPids: number[] = []
    const report = await runShutdownSteps(
      [
        {
          name: 'child-processes',
          timeoutMs: 1500,
          run: async () => {
            await registry.killAllAsync({
              platform: 'linux',
              kill: (pid) => {
                killedPids.push(pid)
              },
            })
          },
        },
      ],
      { logger: { log: () => {}, warn: () => {}, error: () => {} } }
    )

    expect(report.ok).toBe(true)
    expect(registry.size()).toBe(0)
    expect(gracefulAgentKill).toHaveBeenCalledTimes(1)
    expect(gracefulPluginKill).toHaveBeenCalledTimes(1)
    expect(killedPids).toEqual([-51001, -51002])
  })
})
