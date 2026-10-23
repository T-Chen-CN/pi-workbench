import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { CheckpointStore, type CheckpointRecord } from '../pi-bridge/src/checkpoint-store'

let tmpRoot = ''

function record(overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
  return {
    version: 1,
    id: 'cp-1',
    sessionId: 'session-1',
    workspaceDir: 'F:/work',
    createdAt: 1000,
    leafId: 'leaf-1',
    files: [{ path: 'F:/work/a.ts', oldContent: 'old' }],
    ...overrides,
  }
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-test-'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('CheckpointStore', () => {
  it('saves, lists (newest first) and loads checkpoints', async () => {
    const store = new CheckpointStore(tmpRoot, 'F:/work')
    await store.save(record({ id: 'older', createdAt: 1000 }))
    await store.save(record({ id: 'newer', createdAt: 2000 }))

    const list = await store.list()
    expect(list.map((item) => item.id)).toEqual(['newer', 'older'])
    expect(list[0].fileCount).toBe(1)

    const loaded = await store.load('older')
    expect(loaded?.files[0]).toEqual({ path: 'F:/work/a.ts', oldContent: 'old' })
  })

  it('filters by session', async () => {
    const store = new CheckpointStore(tmpRoot, 'F:/work')
    await store.save(record({ id: 'a', sessionId: 'session-1' }))
    await store.save(record({ id: 'b', sessionId: 'session-2', createdAt: 3000 }))

    expect((await store.list('session-2')).map((item) => item.id)).toEqual(['b'])
  })

  it('does not create files for empty checkpoints', async () => {
    const store = new CheckpointStore(tmpRoot, 'F:/work')
    await store.save(record({ id: 'empty', files: [] }))
    expect(await store.list()).toEqual([])
  })

  it('prunes older checkpoints', async () => {
    const store = new CheckpointStore(tmpRoot, 'F:/work')
    for (let index = 0; index < 4; index++) {
      await store.save(record({ id: `cp-${index}`, createdAt: 1000 + index }))
    }
    await store.prune(2)
    expect((await store.list()).map((item) => item.id)).toEqual(['cp-3', 'cp-2'])
  })

  it('keeps workspaces separate', async () => {
    const first = new CheckpointStore(tmpRoot, 'F:/work-a')
    const second = new CheckpointStore(tmpRoot, 'F:/work-b')
    await first.save(record({ id: 'a' }))
    expect(await second.list()).toEqual([])
  })
})
