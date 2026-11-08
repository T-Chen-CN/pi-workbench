/**
 * 派活执行器：把一条云端指令变成一次真实的本地会话调用。
 *
 * 这里用替身代替 `AgentManager`，测的是**接线**：反问出口有没有传进会话、
 * 摘要与改动文件怎么收敛、失败怎么如实上报。真实会话另有人工验收（§15）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  ensure: vi.fn(),
}))

vi.mock('../electron/ipc/agent.js', () => ({
  ensureWorkspaceAgent: hoisted.ensure,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  app: { getAppPath: () => '', getPath: () => '', isPackaged: false, isReady: () => false },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => {} },
  net: { fetch: async () => new Response('{}') }
}))

import { DispatchExecutor } from '../electron/dispatch/executor'

interface FakeAgent {
  createSession: ReturnType<typeof vi.fn>
  setSessionPermission: ReturnType<typeof vi.fn>
  chat: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
}

function makeAgent(chatResult: Record<string, unknown>): FakeAgent {
  return {
    createSession: vi.fn(async (_root: string, options?: unknown) => ({
      success: true,
      session: { id: 's-1' },
      options
    })),
    setSessionPermission: vi.fn(async () => undefined),
    chat: vi.fn(async () => chatResult),
    abort: vi.fn(async () => undefined)
  }
}

function makeExecutor(agent: FakeAgent, workspacePath = '/repo') {
  const registry = new Map<string, FakeAgent>([[workspacePath, agent]])
  return new DispatchExecutor({
    context: { agentRegistry: { get: (key: string) => registry.get(key) } } as never,
    readApiConfig: async () => ({
      provider: 'deepseek',
      apiUrl: 'https://api.example.com',
      apiKey: 'k-1',
      selectedModel: 'deepseek-flash'
    }),
    logger: { warn: () => {} }
  })
}

beforeEach(() => {
  hoisted.ensure.mockReset()
  hoisted.ensure.mockResolvedValue({ success: true })
})

describe('DispatchExecutor', () => {
  it('forwards the ask hook into the session and reports the outcome', async () => {
    const ask = async () => '删 feature/x'
    const agent = makeAgent({
      success: true,
      response: '按你说的删了 feature/x',
      edits: [{ path: '/repo/src/a.ts' }, { path: '/etc/passwd' }],
      usage: { totalTokens: 42 }
    })
    const executor = makeExecutor(agent)

    const outcome = await executor.run({
      taskId: 't-1',
      workspaceId: 'w-1',
      workspacePath: '/repo',
      prompt: '把那个删了',
      ask
    })

    const [, options] = agent.createSession.mock.calls[0] as [string, { dispatchAsk?: unknown }]
    expect(options).toEqual({ dispatchAsk: ask })
    expect(agent.setSessionPermission).toHaveBeenCalledWith('s-1', { mode: 'auto', grants: [] })
    expect(outcome.sessionId).toBe('s-1')
    expect(outcome.report).toMatchObject({ kind: 'done', summary: '按你说的删了 feature/x' })
    // 绝对路径与工作区外的路径都不许出现在上报里
    expect(outcome.report.files).toEqual(['src/a.ts'])
    expect(outcome.report.usage).toEqual({ totalTokens: 42 })
  })

  it('does not create the ask tool when no hook is given', async () => {
    const agent = makeAgent({ success: true, response: 'ok' })
    const executor = makeExecutor(agent)
    await executor.run({ taskId: 't-2', workspaceId: 'w-1', workspacePath: '/repo', prompt: 'x' })
    const [, options] = agent.createSession.mock.calls[0] as [string, unknown]
    expect(options).toBeUndefined()
  })

  it('reports a failed chat honestly instead of inventing success', async () => {
    const agent = makeAgent({ success: false, error: '模型没响应', errorCode: 'timeout' })
    const executor = makeExecutor(agent)
    const outcome = await executor.run({
      taskId: 't-3',
      workspaceId: 'w-1',
      workspacePath: '/repo',
      prompt: 'x'
    })
    expect(outcome.report).toMatchObject({ kind: 'failed', error: '模型没响应' })
  })

  it('fails with a readable message when the model is not configured', async () => {
    const executor = new DispatchExecutor({
      context: { agentRegistry: { get: () => undefined } } as never,
      readApiConfig: async () => null,
      logger: { warn: () => {} }
    })
    const outcome = await executor.run({
      taskId: 't-4',
      workspaceId: 'w-1',
      workspacePath: '/repo',
      prompt: 'x'
    })
    expect(outcome.report.kind).toBe('failed')
    expect(outcome.sessionId).toBeNull()
  })

  it('cancels the running session by task id', async () => {
    const agent = makeAgent({ success: true, response: 'ok' })
    let release: (() => void) | undefined
    agent.chat = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { success: true, response: 'ok' }
    })
    const executor = makeExecutor(agent)
    const running = executor.run({
      taskId: 't-5',
      workspaceId: 'w-1',
      workspacePath: '/repo',
      prompt: 'x'
    })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await executor.cancel('t-5')).toBe(true)
    expect(agent.abort).toHaveBeenCalledWith('s-1')
    release?.()
    await running
    expect(await executor.cancel('t-5')).toBe(false)
  })
})
