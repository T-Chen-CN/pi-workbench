/**
 * Track A 回归用例：覆盖 pi-bridge & Agent Runtime 修复的纯 Bug。
 *
 * 包含：
 * - PI_OFFLINE 门禁（isPiOffline / normalizePiOfflineEnv / refreshCatalog）
 * - extractTitleSourceTexts & recordFirstUserText 仅读当前活跃分支 getBranch()
 * - agent_end(willRetry: true) 保留 sdkStreaming 与后台看门狗
 * - disposeRuntime 覆盖 sdkStreaming/compaction 并支持 skipAbort
 * - openSession() 并发去重（creatingRuntimes）与 superseded runtime 清理
 * - requestSessionRoot 在 compaction / sdkStreaming 忙碌态返回 scheduled: true
 * - rejectPlan 在忙碌态拒绝
 * - deleteSession 清理无 .jsonl 落盘会话的 sidecar extras
 * - completeAuxiliaryPrompt 回退到 resolveActiveModel()
 * - worktree-extension Windows 路径大小写归一化
 * - cloudWorkspaceInfoSchema 校验 defaultBranch
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { AgentManager, type AgentConfig } from '../../pi-bridge/src/agent-manager'
import { isPiOffline, normalizePiOfflineEnv } from '../../pi-bridge/src/agent-catalog'
import { extractTitleSourceTexts } from '../../pi-bridge/src/agent-projections'
import { createWorktreeExtension } from '../../pi-bridge/src/worktree-extension'
import {
  CLOUD_PROTOCOL_VERSION,
  parseDeviceToServerFrame,
} from '../../pi-bridge/src/cloud-protocol'

const sdk = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  modelRuntimeCreate: vi.fn(),
  continueRecent: vi.fn(),
  sessionCreate: vi.fn(),
  sessionOpen: vi.fn(),
  sessionFindById: vi.fn(),
  sessionList: vi.fn(),
  sessionListAll: vi.fn(),
}))

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: sdk.createAgentSession,
  ModelRuntime: { create: sdk.modelRuntimeCreate },
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
    continueRecent: sdk.continueRecent,
    create: sdk.sessionCreate,
    open: sdk.sessionOpen,
    findById: sdk.sessionFindById,
    list: sdk.sessionList,
    listAll: sdk.sessionListAll,
  },
}))

interface FakeSession {
  messages: Array<Record<string, unknown>>
  disposed: boolean
  abort: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  compact: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  subscribe: (listener: (event: Record<string, unknown>) => void) => () => void
  emit: (event: Record<string, unknown>) => void
  getAllTools: () => Array<{ name: string; exposure: string }>
  setActiveToolsByName: () => void
  model: Record<string, unknown>
}

function createFakeSession(): FakeSession {
  const listeners = new Set<(event: Record<string, unknown>) => void>()
  const session: FakeSession = {
    messages: [],
    disposed: false,
    abort: vi.fn(async () => {}),
    dispose: vi.fn(() => {
      session.disposed = true
    }),
    compact: vi.fn(async () => ({
      summary: 'summary',
      firstKeptEntryId: 'e1',
      tokensBefore: 1000,
      estimatedTokensAfter: 200,
    })),
    prompt: vi.fn(async () => {}),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
    getAllTools: () => [{ name: 'read', exposure: 'direct' }],
    setActiveToolsByName: () => {},
    model: { provider: 'deepseek', id: 'deepseek-chat', api: 'openai-completions' },
  }
  return session
}

function createFakeManager(id: string, cwd: string, branch: any[] = [], allEntries = branch) {
  return {
    getSessionId: () => id,
    getCwd: () => cwd,
    getSessionFile: () => null,
    getHeader: () => ({ type: 'session', id, timestamp: new Date().toISOString(), cwd }),
    getSessionName: () => undefined,
    getBranch: () => branch,
    getEntries: () => allEntries,
    getTree: () => [],
    appendSessionInfo: () => 'info-1',
    isPersisted: () => false,
  }
}

let tmpRoot: string
let workspaceDir: string
let agentDir: string
let manager: AgentManager
const savedOffline = process.env.PI_OFFLINE

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    workspaceDir,
    agentDir,
    apiConfig: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    ...overrides,
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  delete process.env.PI_OFFLINE
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-track-a-'))
  workspaceDir = path.join(tmpRoot, 'workspace')
  agentDir = path.join(tmpRoot, 'agent')
  await fs.mkdir(workspaceDir, { recursive: true })
  manager = new AgentManager()
})

afterEach(async () => {
  await manager.dispose()
  if (savedOffline === undefined) delete process.env.PI_OFFLINE
  else process.env.PI_OFFLINE = savedOffline
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe('PI_OFFLINE 门禁', () => {
  it('按与主进程一致的语义识别 PI_OFFLINE 并规范化假值', () => {
    expect(isPiOffline({})).toBe(false)
    expect(isPiOffline({ PI_OFFLINE: '' })).toBe(false)
    expect(isPiOffline({ PI_OFFLINE: '0' })).toBe(false)
    expect(isPiOffline({ PI_OFFLINE: 'false' })).toBe(false)
    expect(isPiOffline({ PI_OFFLINE: '1' })).toBe(true)
    expect(isPiOffline({ PI_OFFLINE: 'true' })).toBe(true)
    expect(isPiOffline({ PI_OFFLINE: 'yes' })).toBe(true)

    const env: NodeJS.ProcessEnv = { PI_OFFLINE: 'false' }
    normalizePiOfflineEnv(env)
    expect('PI_OFFLINE' in env).toBe(false)
  })

  it('PI_OFFLINE=1 时 refreshCatalog 与初始化后台刷新绝不联网', async () => {
    process.env.PI_OFFLINE = '1'
    const refresh = vi.fn(async () => ({ errors: new Map() }))
    const session = createFakeSession()
    sdk.modelRuntimeCreate.mockResolvedValue({
      getModel: vi.fn(() => ({ provider: 'deepseek', id: 'deepseek-chat', api: 'openai-completions' })),
      getModels: vi.fn(() => [{ provider: 'deepseek', id: 'deepseek-chat', api: 'openai-completions' }]),
      refresh,
    })
    sdk.continueRecent.mockReturnValue(createFakeManager('s1', workspaceDir))
    sdk.createAgentSession.mockResolvedValue({ session })

    await manager.initialize(makeConfig({ allowModelNetwork: true }))
    // 初始化只应做一次 allowNetwork: false 的本地缓存恢复
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: false, providers: ['deepseek'] })

    refresh.mockClear()
    const result = await manager.refreshCatalog({ force: true })
    expect(result).toMatchObject({ success: false, error: 'PI_OFFLINE', added: 0, removed: 0 })
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe('标题提取仅读取当前活跃分支', () => {
  it('extractTitleSourceTexts 忽略已废弃分支的消息', () => {
    const activeBranch = [
      { id: 'u2', type: 'message', message: { role: 'user', content: 'active topic' } },
      { id: 'a2', type: 'message', message: { role: 'assistant', content: 'active answer' } },
    ]
    const allEntries = [
      { id: 'u1', type: 'message', message: { role: 'user', content: 'abandoned topic' } },
      { id: 'a1', type: 'message', message: { role: 'assistant', content: 'abandoned answer' } },
      ...activeBranch,
    ]
    const fakeSm = {
      getBranch: () => activeBranch,
      getEntries: () => allEntries,
    } as any
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

    expect(extractTitleSourceTexts(fakeSm, logger)).toEqual({
      userText: 'active topic',
      assistantText: 'active answer',
      imageOnly: false,
    })
  })

  it('runtimeSummary 的兜底标题忽略废弃分支', async () => {
    const session = createFakeSession()
    const activeBranch = [
      { id: 'u2', type: 'message', message: { role: 'user', content: 'current branch question' } },
    ]
    const allEntries = [
      { id: 'u1', type: 'message', message: { role: 'user', content: 'rewound question' } },
      ...activeBranch,
    ]
    sdk.modelRuntimeCreate.mockResolvedValue({
      getModel: vi.fn(() => ({ provider: 'deepseek', id: 'deepseek-chat', api: 'openai-completions' })),
      getModels: vi.fn(() => [{ provider: 'deepseek', id: 'deepseek-chat', api: 'openai-completions' }]),
    })
    sdk.continueRecent.mockReturnValue(createFakeManager('s1', workspaceDir, activeBranch, allEntries))
    sdk.createAgentSession.mockResolvedValue({ session })

    await manager.initialize(makeConfig())
    const opened = await manager.openSession('s1')
    expect(opened.session?.title).toBe('current branch question')
  })
})

describe('AgentManager 生命周期与并发修复', () => {
  function setupRuntimeSdk(session = createFakeSession()) {
    const model = { provider: 'deepseek', id: 'deepseek-chat', api: 'openai-completions' }
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: 'aux-ok' }],
    }))
    sdk.modelRuntimeCreate.mockResolvedValue({
      getModel: vi.fn((_p: string, id: string) => (id === 'deepseek-chat' ? model : undefined)),
      getModels: vi.fn(() => [model]),
      completeSimple,
    })
    sdk.continueRecent.mockReturnValue(createFakeManager('s1', workspaceDir))
    sdk.sessionCreate.mockImplementation(() => createFakeManager('s-new', workspaceDir))
    sdk.sessionFindById.mockReturnValue(null)
    sdk.sessionList.mockResolvedValue([])
    sdk.sessionListAll.mockResolvedValue([])
    sdk.createAgentSession.mockResolvedValue({ session })
    return { session, completeSimple, model }
  }

  it('agent_end(willRetry: true) 保持 sdkStreaming 与后台看门狗存活，直到 agent_settled 才释放', async () => {
    const { session } = setupRuntimeSdk()
    await manager.initialize(makeConfig())

    session.emit({ type: 'agent_start' })
    expect(manager.isSessionBusy('s1')).toBe(true)

    session.emit({ type: 'agent_end', messages: [], willRetry: true })
    expect(manager.isSessionBusy('s1')).toBe(true)

    const runtime = (manager as unknown as { runtimes: Map<string, { bgWatchdog: unknown }> }).runtimes.get('s1')
    expect(runtime?.bgWatchdog).not.toBeNull()

    session.emit({ type: 'agent_settled', aborted: false })
    expect(manager.isSessionBusy('s1')).toBe(false)
    expect(runtime?.bgWatchdog).toBeNull()
  })

  it('disposeRuntime 在 sdkStreaming 期间调用 abort 并清空 bgWatchdog', async () => {
    const { session } = setupRuntimeSdk()
    await manager.initialize(makeConfig())

    session.emit({ type: 'agent_start' })
    const runtime = (manager as unknown as { runtimes: Map<string, { bgWatchdog: unknown }> }).runtimes.get('s1')
    expect(runtime?.bgWatchdog).not.toBeNull()

    await manager.closeSession('s1')
    expect(session.abort).toHaveBeenCalledTimes(1)
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(runtime?.bgWatchdog).toBeNull()
  })

  it('openSession() 无参数并发调用按 sessionId 去重，只创建一个 AgentSession', async () => {
    const session = createFakeSession()
    const releaseCreateRef: { fn: (() => void) | null } = { fn: null }
    let markCreateStarted!: () => void
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve
    })
    setupRuntimeSdk(session)
    await manager.initialize(makeConfig())
    await manager.closeSession('s1')
    sdk.createAgentSession.mockClear()
    sdk.createAgentSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreateRef.fn = () => resolve({ session })
          markCreateStarted()
        })
    )

    const p1 = manager.openSession()
    const p2 = manager.openSession()
    try {
      await createStarted
      releaseCreateRef.fn?.()
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.success).toBe(true)
      expect(r2.success).toBe(true)
      expect(sdk.createAgentSession).toHaveBeenCalledTimes(1)
    } finally {
      releaseCreateRef.fn?.()
    }
  })

  it('requestSessionRoot 在手动压缩与事件流运行中返回 scheduled: true 而非误报失败', async () => {
    const { session } = setupRuntimeSdk()
    sdk.sessionCreate.mockImplementation((cwd: string, _dir: string, options?: { id?: string }) =>
      createFakeManager(options?.id ?? 's-new', cwd)
    )
    let finishCompact!: (value: unknown) => void
    session.compact.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCompact = resolve
        })
    )
    await manager.initialize(makeConfig())

    const compacting = manager.compactContext('s1')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const targetRoot = path.join(workspaceDir, 'wt-1')
    const duringCompact = await manager.requestSessionRoot('s1', targetRoot)
    expect(duringCompact).toEqual({ success: true, scheduled: true })

    finishCompact({ summary: 's', firstKeptEntryId: 'e', tokensBefore: 10, estimatedTokensAfter: 5 })
    await compacting
    // 等压缩收尾后异步派发的 applyPendingRoot 落定
    await new Promise((resolve) => setTimeout(resolve, 25))

    // 另测 sdkStreaming 忙碌分支
    session.emit({ type: 'agent_start' })
    const duringStream = await manager.requestSessionRoot('s1', path.join(workspaceDir, 'wt-2'))
    expect(duringStream).toEqual({ success: true, scheduled: true })
    session.emit({ type: 'agent_settled', aborted: false })
    await new Promise((resolve) => setTimeout(resolve, 25))
  })

  it('rejectPlan 在会话忙碌时拒绝执行', async () => {
    const { session } = setupRuntimeSdk()
    await fs.mkdir(path.join(agentDir, 'session-extras'), { recursive: true })
    await fs.writeFile(
      path.join(agentDir, 'session-extras', 's1.json'),
      JSON.stringify({
        version: 1,
        thinkingDurations: {},
        branchLeaves: {},
        plan: {
          id: 'plan-1',
          summary: 'S',
          status: 'proposed',
          createdAt: 1,
          updatedAt: 1,
          steps: [{ id: 'step-1', title: 'T', files: [], status: 'pending' }],
        },
      }),
      'utf-8'
    )
    await manager.initialize(makeConfig())

    session.emit({ type: 'agent_start' })
    const res = await manager.rejectPlan('s1', 'plan-1')
    expect(res.success).toBe(false)
    expect(res.error).toContain('Session is running')
    session.emit({ type: 'agent_settled', aborted: false })
  })

  it('deleteSession 即使无 .jsonl 落盘文件也会清理遗留的 session-extras sidecar', async () => {
    setupRuntimeSdk()
    await manager.initialize(makeConfig())
    const created = await manager.createSession(workspaceDir, {
      permission: { mode: 'auto', grants: [] },
    })
    const sid = created.session!.id
    const extrasPath = path.join(agentDir, 'session-extras', `${sid}.json`)
    // 等待种子权限写盘
    for (let i = 0; i < 20; i += 1) {
      try {
        await fs.access(extrasPath)
        break
      } catch {
        await new Promise((r) => setTimeout(r, 15))
      }
    }
    await expect(fs.access(extrasPath)).resolves.toBeUndefined()

    const deleted = await manager.deleteSession(sid)
    expect(deleted).toEqual({ success: true })
    await expect(fs.access(extrasPath)).rejects.toThrow()
  })

  it('completeAuxiliaryPrompt 在记录模型下架时回退到 resolveActiveModel', async () => {
    const { completeSimple, model } = setupRuntimeSdk()
    await manager.initialize(
      makeConfig({ apiConfig: { providerId: 'deepseek', modelId: 'deprecated-model' } })
    )

    const text = await manager.completeAuxiliaryPrompt('sys', 'user')
    expect(text).toBe('aux-ok')
    expect(completeSimple).toHaveBeenCalledWith(
      model,
      expect.anything(),
      expect.anything()
    )
  })
})

describe('worktree-extension 与 cloud-protocol 回归', () => {
  it('worktree-extension 在 Windows 下大小写不敏感地判定当前工作树相同', async () => {
    const scheduleRoot = vi.fn()
    const currentRoot = process.platform === 'win32' ? 'C:\\Repo\\Main' : '/repo/main'
    const returnedRoot = process.platform === 'win32' ? 'c:\\repo\\main' : '/repo/main'
    const ext = createWorktreeExtension({
      sessionId: 's1',
      workspaceDir: currentRoot,
      getRoot: () => currentRoot,
      onSwitch: async () => ({ success: true, root: returnedRoot, branch: 'main' }),
      scheduleRoot,
    })

    let tool: { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> } | null = null
    ext({
      on: () => {},
      registerTool: (def: any) => {
        tool = def
      },
    } as any)

    const out = await tool!.execute('call-1', { target: 'main' })
    expect(out.content[0].text).toContain('already using the requested worktree')
    expect(scheduleRoot).not.toHaveBeenCalled()
  })

  it('cloudWorkspaceInfoSchema 校验 defaultBranch 字段（接受合法字符串，拒绝非法类型与超长串）', () => {
    const valid = parseDeviceToServerFrame(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'workspaces',
        workspaces: [{ path: '/repo', name: 'repo', isGit: true, defaultBranch: 'main' }],
      })
    )
    expect(valid.ok).toBe(true)

    const badType = parseDeviceToServerFrame(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'workspaces',
        workspaces: [{ path: '/repo', name: 'repo', isGit: true, defaultBranch: 12345 }],
      })
    )
    expect(badType).toMatchObject({ ok: false, code: 'invalid-frame' })

    const tooLong = parseDeviceToServerFrame(
      JSON.stringify({
        v: CLOUD_PROTOCOL_VERSION,
        type: 'workspaces',
        workspaces: [{ path: '/repo', name: 'repo', isGit: true, defaultBranch: 'a'.repeat(300) }],
      })
    )
    expect(tooLong).toMatchObject({ ok: false, code: 'invalid-frame' })
  })
})
