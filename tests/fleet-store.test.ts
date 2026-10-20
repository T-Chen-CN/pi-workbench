import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { JsonFleetStore, type FleetTask } from '../electron/fleet-store'

let tmpDir: string
let storePath: string
let store: JsonFleetStore

function makeTask(overrides: Partial<FleetTask> = {}): FleetTask {
  const now = Date.now()
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    workspace: '/tmp/ws',
    name: 'demo',
    prompt: 'do work',
    status: 'queued',
    worktree: '/tmp/ws/.pi-worktrees/demo',
    branch: 'pi-fleet/demo',
    createdAt: now,
    updatedAt: now,
    output: '',
    ...overrides,
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-store-'))
  storePath = path.join(tmpDir, 'fleet-tasks.json')
  store = new JsonFleetStore(storePath)
})

afterEach(async () => {
  store.close()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('JsonFleetStore', () => {
  it('inserts and reads tasks', () => {
    const task = makeTask()
    store.insert(task)

    expect(store.get(task.id)).toMatchObject({ id: task.id, status: 'queued' })
    expect(store.list('/tmp/ws')).toHaveLength(1)
    expect(store.list('/tmp/other')).toEqual([])
    expect(store.all()).toHaveLength(1)
  })

  it('updates tasks and refreshes updatedAt', async () => {
    const task = makeTask({ createdAt: 1000 })
    store.insert(task)
    await new Promise((resolve) => setTimeout(resolve, 5))

    const updated = store.update(task.id, { status: 'running' })

    expect(updated?.status).toBe('running')
    expect(updated?.updatedAt).toBeGreaterThan(task.updatedAt)
    expect(store.get(task.id)?.status).toBe('running')
  })

  it('returns null when updating an unknown task', () => {
    expect(store.update('missing', { status: 'failed' })).toBeNull()
  })

  it('persists tasks across instances', () => {
    const task = makeTask({ name: 'persisted' })
    store.insert(task)
    store.close()

    const reopened = new JsonFleetStore(storePath)
    expect(reopened.get(task.id)?.name).toBe('persisted')
    reopened.close()
  })

  it('lists tasks newest first', () => {
    store.insert(makeTask({ id: 'old', createdAt: 1, updatedAt: 1 }))
    store.insert(makeTask({ id: 'new', createdAt: 2, updatedAt: 2 }))

    expect(store.list('/tmp/ws').map((task) => task.id)).toEqual(['new', 'old'])
  })
})
