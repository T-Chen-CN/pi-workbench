import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { JsonFleetStore, type FleetTask } from '../electron/fleet-store'
import { FleetManager, type FleetAgent } from '../electron/fleet-manager'
import type { FleetWorktree } from '../electron/fleet-worktree'

let tmpDir: string
let logDir: string
let store: JsonFleetStore
let manager: FleetManager | null = null

function fakeWorktrees(): FleetWorktree {
  return {
    create: vi.fn(async (_workspace: string, _name: string, id: string) => ({
      success: true,
      worktree: `/tmp/worktree-${id}`,
      branch: `pi-fleet/${id}`,
    })),
    cleanup: vi.fn(async () => ({ success: true })),
  } as unknown as FleetWorktree
}

function makeAgent(
  chat: FleetAgent['chat'],
  onDispose?: () => void
): FleetAgent & { disposed: boolean } {
  const state = { disposed: false }
  return {
    initialize: async () => ({ success: true }),
    chat,
    dispose: () => {
      state.disposed = true
      onDispose?.()
    },
    get disposed() {
      return state.disposed
    },
  }
}

function createManager(createAgent: () => FleetAgent | Promise<FleetAgent>, overrides: Partial<ConstructorParameters<typeof FleetManager>[0]> = {}): FleetManager {
  store = new JsonFleetStore(path.join(tmpDir, 'fleet-tasks.json'))
  manager = new FleetManager({
    store,
    worktrees: fakeWorktrees(),
    createAgent,
    getApiConfig: async () => ({
      provider: 'openai',
      apiUrl: 'https://api.example.com',
      apiKey: 'key',
      selectedModel: 'model',
    }),
    agentDir: path.join(tmpDir, 'agent'),
    logDir,
    maxConcurrent: 1,
    ...overrides,
  })
  return manager
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-manager-'))
  logDir = path.join(tmpDir, 'logs')
})

afterEach(async () => {
  await manager?.disposeAll()
  manager = null
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('FleetManager', () => {
  it('marks tasks left running by a previous process as failed', () => {
    const preStore = new JsonFleetStore(path.join(tmpDir, 'fleet-tasks.json'))
    preStore.insert({
      id: 'stale',
      workspace: '/tmp/workspace',
      name: 'stale task',
      prompt: 'work',
      status: 'running',
      worktree: '/tmp/worktree-stale',
      branch: 'pi-fleet/stale',
      createdAt: 1,
      updatedAt: 1,
      output: '',
    })
    preStore.close()

    createManager(() => makeAgent(async () => ({ success: true })))

    const task = store.get('stale')
    expect(task?.status).toBe('failed')
    expect(task?.error).toContain('interrupted')
  })

  it('runs a queued task to success and stores output and logs', async () => {
    const agent = makeAgent(async (_message, options) => {
      options?.onTextDelta?.('Hello ')
      options?.onTextDelta?.('world')
      return { success: true, response: 'Hello world' }
    })
    createManager(() => agent)

    const created = await manager!.createTask('/tmp/workspace', 'demo', 'write a note')
    expect(created.success).toBe(true)
    const id = created.task!.id

    await waitFor(() => store.get(id)?.status === 'succeeded')

    const task = store.get(id) as FleetTask
    expect(task.output).toBe('Hello world')
    expect(task.finishedAt).toBeTruthy()
    expect(task.error).toBeUndefined()
    expect(agent.disposed).toBe(true)

    const log = await fs.readFile(path.join(logDir, `fleet-${id}.log`), 'utf-8')
    expect(log).toContain('write a note')
    expect(log).toContain('Hello world')
  })

  it('fails when no API key is configured', async () => {
    const worktrees = fakeWorktrees()
    createManager(() => makeAgent(async () => ({ success: true })), {
      worktrees,
      getApiConfig: async () => null,
    })

    const result = await manager!.createTask('/tmp/workspace', 'demo', 'work')

    expect(result.success).toBe(false)
    expect(result.error).toContain('API key')
    expect(worktrees.create).not.toHaveBeenCalled()
  })

  it('marks tasks as failed when the agent fails', async () => {
    createManager(() => makeAgent(async () => ({ success: false, error: 'boom' })))

    const created = await manager!.createTask('/tmp/workspace', 'demo', 'work')
    const id = created.task!.id
    await waitFor(() => store.get(id)?.status === 'failed')

    expect(store.get(id)?.error).toBe('boom')
  })

  it('runs one task at a time and lets queued tasks be cancelled', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    createManager(() =>
      makeAgent(async () => {
        await gate
        return { success: true, response: 'done' }
      }, undefined)
    )

    const first = await manager!.createTask('/tmp/workspace', 'first', 'work one')
    const firstId = first.task!.id
    await waitFor(() => store.get(firstId)?.status === 'running')

    const second = await manager!.createTask('/tmp/workspace', 'second', 'work two')
    const secondId = second.task!.id
    expect(store.get(secondId)?.status).toBe('queued')

    await expect(manager!.cancel(secondId)).resolves.toMatchObject({ success: true })
    expect(store.get(secondId)?.status).toBe('cancelled')

    release()
    await waitFor(() => store.get(firstId)?.status === 'succeeded')
  })

  it('keeps a running task cancelled when its agent aborts', async () => {
    let rejectChat: (error: Error) => void = () => {}
    let disposed = false
    const agent = makeAgent(
      () =>
        new Promise((_resolve, reject) => {
          if (disposed) {
            reject(new Error('aborted'))
            return
          }
          rejectChat = reject
        }),
      () => {
        disposed = true
        rejectChat(new Error('aborted'))
      }
    )
    createManager(() => agent)

    const created = await manager!.createTask('/tmp/workspace', 'abort me', 'work')
    const id = created.task!.id
    await waitFor(() => store.get(id)?.status === 'running')

    await expect(manager!.cancel(id)).resolves.toMatchObject({ success: true })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(store.get(id)?.status).toBe('cancelled')
  })

  it('cleans up worktrees only for finished tasks', async () => {
    createManager(() => makeAgent(async () => ({ success: true, response: 'done' })))

    const created = await manager!.createTask('/tmp/workspace', 'cleanup', 'work')
    const id = created.task!.id
    await waitFor(() => store.get(id)?.status === 'succeeded')

    await expect(manager!.cleanupWorktree(id)).resolves.toMatchObject({ success: true })
    expect(store.get(id)?.worktreeRemoved).toBe(true)

    await expect(manager!.cleanupWorktree('missing')).resolves.toMatchObject({ success: false })
  })

  it('lists and retrieves tasks by workspace', async () => {
    createManager(() => makeAgent(async () => ({ success: true, response: 'done' })))

    const created = await manager!.createTask('/tmp/workspace', 'listed', 'work')
    const id = created.task!.id
    await waitFor(() => store.get(id)?.status === 'succeeded')

    expect(manager!.list('/tmp/workspace').map((task) => task.id)).toContain(id)
    expect(manager!.list('/tmp/other')).toEqual([])
    expect(manager!.get(id)?.name).toBe('listed')
  })
})
