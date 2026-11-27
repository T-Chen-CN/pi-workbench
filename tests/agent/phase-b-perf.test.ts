/**
 * Phase B · Track 3 性能与 Schema 回归测试：
 * - AgentManager.findSessionFile 优先走 O(1) findById，不触发全盘 listAll 扫盘，且强制工作区归属校验
 * - deriveMessages 维护每轮 toolPartsById Map，500 次工具调用保持 O(T) 精确投影且跨轮隔离
 * - appSaveSettingsSchema 与 app:saveSettings 对 panelWidths 的范围校验、部分合并与异常回落
 * - getRepoInfo 合并 rev-parse 后的常规 / 子目录 / unborn / detached / worktree / 非仓库语义
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { AgentManager, type AgentConfig } from '../../pi-bridge/src/agent-manager'
import { deriveMessages } from '../../pi-bridge/src/session-view'
import type { TimelineItem } from '../../pi-bridge/src/session-entries'
import { appSaveSettingsSchema, parseIpcInput } from '../../electron/ipc/schemas'
import { getRepoInfo } from '../../electron/git-worktrees'

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

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const state = { appDir: '' }
  return { handlers, state }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    isReady: () => false,
    getAppPath: () => electronMocks.state.appDir,
    getPath: () => electronMocks.state.appDir,
  },
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, listener)
    },
  },
}))

vi.mock('../../electron/tray', () => ({
  refreshTray: vi.fn(),
}))

vi.mock('../../electron/system-proxy', () => ({
  refreshSystemProxy: vi.fn(),
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

import { registerSettingsIpc } from '../../electron/ipc/settings'
import { resetAppPathsCache } from '../../electron/app-paths'

function createFakeSession() {
  return {
    messages: [] as Array<Record<string, unknown>>,
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    subscribe: () => () => {},
    getAllTools: () => [{ name: 'read', exposure: 'direct' }],
    setActiveToolsByName: () => {},
    model: { provider: 'deepseek', id: 'deepseek-chat', api: 'openai-completions' },
  }
}

function createFakeSessionManager(id: string, cwd: string, file: string | null = null) {
  return {
    getSessionId: () => id,
    getCwd: () => cwd,
    getSessionFile: () => file,
    getHeader: () => ({ type: 'session', id, timestamp: new Date().toISOString(), cwd }),
    getSessionName: () => undefined,
    getBranch: () => [],
    getEntries: () => [],
    getTree: () => [],
    appendSessionInfo: vi.fn(() => 'info-1'),
    isPersisted: () => Boolean(file),
  }
}

async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
  }
}

describe('AgentManager.findSessionFile O(1) findById 优先查找', () => {
  let tmpRoot = ''
  let workspaceDir = ''
  let agentDir = ''
  let sessionDir = ''
  let manager: AgentManager

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
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-phase-b-agent-'))
    workspaceDir = path.join(tmpRoot, 'WorkspaceRepo')
    agentDir = path.join(tmpRoot, 'agent')
    sessionDir = path.join(agentDir, 'sessions')
    await fs.mkdir(workspaceDir, { recursive: true })
    await fs.mkdir(sessionDir, { recursive: true })

    const model = { provider: 'deepseek', id: 'deepseek-chat', api: 'openai-completions' }
    sdk.modelRuntimeCreate.mockResolvedValue({
      getModel: vi.fn(() => model),
      getModels: vi.fn(() => [model]),
    })
    sdk.continueRecent.mockReturnValue(createFakeSessionManager('s-init', workspaceDir))
    sdk.createAgentSession.mockResolvedValue({ session: createFakeSession() })
    sdk.sessionList.mockResolvedValue([])
    sdk.sessionListAll.mockResolvedValue([])
    sdk.sessionFindById.mockReturnValue(undefined)

    manager = new AgentManager()
  })

  afterEach(async () => {
    await manager.dispose()
    await removeDirWithRetry(tmpRoot)
  })

  it('findById 命中当前工作区会话时直接返回，绝不触发 listAll 全量扫盘', async () => {
    await manager.initialize(makeConfig())

    const sessionFile = path.join(sessionDir, '2026-01-01_s-fast.jsonl')
    // Windows 下测试路径大小写不敏感匹配
    const headerCwd =
      process.platform === 'win32' ? workspaceDir.toLowerCase() : workspaceDir
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ type: 'session', id: 's-fast', cwd: headerCwd })}\n`,
      'utf-8'
    )

    sdk.sessionFindById.mockReturnValue(sessionFile)
    sdk.sessionOpen.mockReturnValue(createFakeSessionManager('s-fast', workspaceDir, sessionFile))

    const opened = await manager.openSession('s-fast')
    expect(opened.success).toBe(true)
    expect(opened.session?.id).toBe('s-fast')
    expect(sdk.sessionFindById).toHaveBeenCalledWith(workspaceDir, 's-fast', sessionDir)
    expect(sdk.sessionListAll).not.toHaveBeenCalled()
  })

  it('findById 命中其他工作区的会话文件时强制拒绝，不打开跨仓会话', async () => {
    await manager.initialize(makeConfig())

    const otherWorkspace = path.join(tmpRoot, 'OtherWorkspace')
    const foreignFile = path.join(sessionDir, '2026-01-01_s-foreign.jsonl')
    await fs.writeFile(
      foreignFile,
      `${JSON.stringify({ type: 'session', id: 's-foreign', cwd: otherWorkspace })}\n`,
      'utf-8'
    )

    sdk.sessionFindById.mockReturnValue(foreignFile)

    const opened = await manager.openSession('s-foreign')
    expect(opened.success).toBe(false)
    expect(opened.error).toBe('Session not found.')
    expect(sdk.sessionOpen).not.toHaveBeenCalled()
    expect(sdk.sessionListAll).not.toHaveBeenCalled()
  })

  it('findById 未命中时回退到 listAll（如历史已解绑工作树会话）', async () => {
    const oldWorktree = path.join(workspaceDir, '.pi-workbench', 'worktrees', 'wt-old')
    await manager.initialize(
      makeConfig({
        isSessionOfWorkspace: (_id, cwd) => cwd === oldWorktree || cwd === workspaceDir,
      })
    )

    const fallbackFile = path.join(sessionDir, '2026-01-01_s-wt.jsonl')
    sdk.sessionFindById.mockReturnValue(undefined)
    sdk.sessionListAll.mockResolvedValue([
      { id: 's-wt', cwd: oldWorktree, path: fallbackFile },
    ])
    sdk.sessionOpen.mockReturnValue(createFakeSessionManager('s-wt', workspaceDir, fallbackFile))

    const opened = await manager.openSession('s-wt')
    expect(opened.success).toBe(true)
    expect(opened.session?.id).toBe('s-wt')
    expect(sdk.sessionFindById).toHaveBeenCalled()
    expect(sdk.sessionListAll).toHaveBeenCalledWith(sessionDir)
  })
})

describe('deriveMessages O(1) toolPartsById 投影', () => {
  it('单轮 500 次工具调用与结果精确配对（含乱序、错误、嵌套调用）且无跨轮串台', () => {
    const count = 500
    const toolCalls = Array.from({ length: count }, (_, index) => ({
      type: 'toolCall',
      id: `call-${index}`,
      name: 'read',
      arguments: { path: `src/file-${index}.ts` },
    }))

    // 乱序回填工具结果（倒序），确保不依赖插入顺序
    const toolResults: TimelineItem[] = Array.from({ length: count }, (_, offset) => {
      const index = count - 1 - offset
      const isError = index % 17 === 0
      return {
        kind: 'message',
        entryId: `tr-${index}`,
        message: {
          role: 'toolResult',
          toolCallId: `call-${index}`,
          toolName: 'read',
          content: [{ type: 'text', text: `result-${index}` }],
          isError,
          durationMs: index + 1,
          timestamp: 2000 + offset,
          ...(index === 250
            ? {
                nestedCalls: {
                  complete: true,
                  calls: [
                    {
                      id: 'call-250/1',
                      name: 'bash',
                      arguments: { command: 'echo ok' },
                      status: 'ok',
                      durationMs: 7,
                    },
                  ],
                },
              }
            : {}),
        },
      }
    })

    // 第二轮复用相同 toolCallId `call-0`，验证 flushTurn 清空了 toolPartsById
    const items: TimelineItem[] = [
      { kind: 'message', entryId: 'u-1', message: { role: 'user', content: 'run 500 tools', timestamp: 1000 } },
      {
        kind: 'message',
        entryId: 'a-1',
        message: { role: 'assistant', content: toolCalls, timestamp: 1100 },
      },
      ...toolResults,
      { kind: 'message', entryId: 'u-2', message: { role: 'user', content: 'turn 2', timestamp: 5000 } },
      {
        kind: 'message',
        entryId: 'a-2',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-0', name: 'read', arguments: { path: 'second.ts' } }],
          timestamp: 5100,
        },
      },
      {
        kind: 'message',
        entryId: 'tr-turn2',
        message: {
          role: 'toolResult',
          toolCallId: 'call-0',
          toolName: 'read',
          content: [{ type: 'text', text: 'turn-2-result' }],
          isError: false,
          timestamp: 5200,
        },
      },
    ]

    const started = performance.now()
    const messages = deriveMessages(items, {
      thinkingDurations: {},
      toolFilePath: (_name, args) => (typeof args?.path === 'string' ? args.path : undefined),
    })
    const elapsedMs = performance.now() - started

    expect(messages).toHaveLength(4)
    const turn1Tools = (messages[1].parts ?? []).filter((part) => part.type === 'tool')
    // 500 个主工具 + 1 个嵌套工具
    expect(turn1Tools).toHaveLength(count + 1)

    const byId = new Map(turn1Tools.map((part) => [part.toolCallId, part]))
    for (let i = 0; i < count; i += 1) {
      const part = byId.get(`call-${i}`)
      expect(part).toBeDefined()
      expect(part?.status).toBe(i % 17 === 0 ? 'error' : 'success')
      expect(part?.isError).toBe(i % 17 === 0)
      expect(part?.durationMs).toBe(i + 1)
      expect(part?.resultPreview).toBe(`result-${i}`)
    }

    // 嵌套工具紧跟在 call-250 之后
    const parentIdx = turn1Tools.findIndex((part) => part.toolCallId === 'call-250')
    expect(turn1Tools[parentIdx + 1]).toMatchObject({
      toolCallId: 'call-250/1',
      parentToolCallId: 'call-250',
      status: 'success',
      durationMs: 7,
    })

    // 第二轮的 call-0 未修改第一轮，且自身拿到 turn-2-result
    expect(byId.get('call-0')?.resultPreview).toBe('result-0')
    expect(messages[3].parts?.[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'call-0',
      resultPreview: 'turn-2-result',
      status: 'success',
    })
    expect(elapsedMs).toBeLessThan(1000)
  })
})

describe('appSaveSettingsSchema & settings IPC panelWidths（D8）', () => {
  let tmpAppDir = ''

  beforeEach(async () => {
    electronMocks.handlers.clear()
    tmpAppDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-phase-b-settings-'))
    await fs.mkdir(path.join(tmpAppDir, 'config'), { recursive: true })
    electronMocks.state.appDir = tmpAppDir
    resetAppPathsCache()
    registerSettingsIpc()
  })

  afterEach(async () => {
    resetAppPathsCache()
    await removeDirWithRetry(tmpAppDir)
  })

  it('校验合法整数范围并让越界或非法 panelWidths 回落为 undefined', () => {
    const valid = parseIpcInput(appSaveSettingsSchema, {
      panelWidths: { sidebar: 160, chat: 900, terminalHeight: 320 },
    })
    expect(valid).toEqual({
      ok: true,
      data: { panelWidths: { sidebar: 160, chat: 900, terminalHeight: 320 } },
    })

    const partial = parseIpcInput(appSaveSettingsSchema, {
      panelWidths: { sidebar: 280 },
    })
    expect(partial).toEqual({
      ok: true,
      data: { panelWidths: { sidebar: 280 } },
    })

    // 越界 / 非整数 / 非对象通过 .catch(undefined) 安全回落，不阻塞整包保存
    for (const bad of [
      { sidebar: 159 },
      { sidebar: 601 },
      { chat: 259 },
      { chat: 901 },
      { terminalHeight: 99 },
      { terminalHeight: 701 },
      { sidebar: 240.5 },
      'invalid',
    ]) {
      const res = parseIpcInput(appSaveSettingsSchema, { theme: 'dark', panelWidths: bad })
      expect(res).toEqual({ ok: true, data: { theme: 'dark', panelWidths: undefined } })
    }
  })

  it('app:saveSettings 部分保存时合并保留 panelWidths，畸形输入不破坏已有有效尺寸', async () => {
    const save = (payload: unknown) =>
      Promise.resolve(electronMocks.handlers.get('app:saveSettings')!({}, payload)) as Promise<{
        success: boolean
      }>
    const load = () =>
      Promise.resolve(electronMocks.handlers.get('app:getSettings')!({})) as Promise<{
        success: boolean
        settings: Record<string, unknown>
      }>

    await expect(save({ panelWidths: { sidebar: 260, chat: 420 } })).resolves.toEqual({
      success: true,
    })
    // 仅更新 terminalHeight，不得擦除 sidebar / chat
    await expect(save({ panelWidths: { terminalHeight: 240 } })).resolves.toEqual({
      success: true,
    })
    // 仅更新无关字段，完整保留 panelWidths
    await expect(save({ theme: 'dark' })).resolves.toEqual({ success: true })

    let current = await load()
    expect(current.settings.theme).toBe('dark')
    expect(current.settings.panelWidths).toEqual({
      sidebar: 260,
      chat: 420,
      terminalHeight: 240,
    })

    // 畸形 panelWidths 回落 undefined 时沿用磁盘已有的有效 panelWidths
    await expect(save({ language: 'en', panelWidths: { sidebar: 9999 } })).resolves.toEqual({
      success: true,
    })
    current = await load()
    expect(current.settings.language).toBe('en')
    expect(current.settings.panelWidths).toEqual({
      sidebar: 260,
      chat: 420,
      terminalHeight: 240,
    })
  })
})

describe('getRepoInfo 合并 rev-parse 边缘场景', () => {
  const dirsToClean: string[] = []

  function runGit(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' })
  }

  afterEach(async () => {
    for (const dir of dirsToClean.splice(0).reverse()) {
      await removeDirWithRetry(dir)
    }
  })

  it('正确处理非仓库、unborn、常规、子目录、detached HEAD 与链接工作树', async () => {
    const nonGit = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-nongit-'))
    dirsToClean.push(nonGit)
    await expect(getRepoInfo(nonGit)).resolves.toBeNull()

    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-repoinfo-'))
    dirsToClean.push(repo)
    runGit(repo, ['init', '-b', 'main'])
    runGit(repo, ['config', 'user.email', 'dev@example.com'])
    runGit(repo, ['config', 'user.name', 'Dev'])
    runGit(repo, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])

    const realRepo = await fs.realpath(repo)
    const realGitDir = await fs.realpath(path.join(repo, '.git'))

    // 1. unborn 仓库（零提交）+ 子目录
    const subDir = path.join(repo, 'nested', 'dir')
    await fs.mkdir(subDir, { recursive: true })
    const unborn = await getRepoInfo(subDir)
    expect(unborn).toEqual({
      root: realRepo,
      gitDir: realGitDir,
      commonDir: realGitDir,
      bare: false,
      linkedWorktree: false,
      branch: 'main',
      head: null,
      detached: false,
      remoteUrl: 'https://github.com/acme/demo.git',
      github: { owner: 'acme', repo: 'demo' },
      userEmail: 'dev@example.com',
    })

    // 2. 提交后（含子目录）
    await fs.writeFile(path.join(repo, 'README.md'), 'hello\n', 'utf-8')
    runGit(repo, ['add', '.'])
    runGit(repo, ['commit', '-m', 'init'])
    const headSha = runGit(repo, ['rev-parse', 'HEAD']).trim()

    const fromSub = await getRepoInfo(subDir)
    expect(fromSub).toEqual({
      root: realRepo,
      gitDir: realGitDir,
      commonDir: realGitDir,
      bare: false,
      linkedWorktree: false,
      branch: 'main',
      head: headSha,
      detached: false,
      remoteUrl: 'https://github.com/acme/demo.git',
      github: { owner: 'acme', repo: 'demo' },
      userEmail: 'dev@example.com',
    })

    // 3. 链接工作树（及其子目录）
    const wtDir = path.join(os.tmpdir(), `pi-repoinfo-wt-${Date.now()}`)
    dirsToClean.push(wtDir)
    runGit(repo, ['worktree', 'add', '-b', 'pi/feature-x', wtDir])
    const wtSub = path.join(wtDir, 'sub')
    await fs.mkdir(wtSub, { recursive: true })
    const realWt = await fs.realpath(wtDir)

    const wtInfo = await getRepoInfo(wtSub)
    expect(wtInfo).toMatchObject({
      root: realWt,
      commonDir: realGitDir,
      bare: false,
      linkedWorktree: true,
      branch: 'pi/feature-x',
      head: headSha,
      detached: false,
    })
    expect(wtInfo?.gitDir).not.toBe(realGitDir)

    // 4. detached HEAD
    runGit(wtDir, ['checkout', '--detach', headSha])
    const detachedInfo = await getRepoInfo(wtDir)
    expect(detachedInfo).toMatchObject({
      root: realWt,
      linkedWorktree: true,
      branch: null,
      head: headSha,
      detached: true,
    })
  })
})
