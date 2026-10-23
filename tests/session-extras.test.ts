import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { SessionExtrasStore, emptyExtras } from '../pi-bridge/src/session-extras'

let tmpRoot = ''

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'session-extras-'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('SessionExtrasStore', () => {
  it('returns empty extras for unknown sessions', async () => {
    const store = new SessionExtrasStore(tmpRoot)
    await expect(store.load('missing')).resolves.toEqual(emptyExtras())
  })

  it('round-trips durations and tool edits', async () => {
    const store = new SessionExtrasStore(tmpRoot)
    const extras = emptyExtras()
    extras.thinkingDurations['111'] = [1200, 300]
    extras.toolEdits['call-1'] = { path: 'a.ts', oldContent: 'old', newContent: 'new' }
    await store.save('session-1', extras)

    const loaded = await store.load('session-1')
    expect(loaded.thinkingDurations['111']).toEqual([1200, 300])
    expect(loaded.toolEdits['call-1'].newContent).toBe('new')
  })

  it('round-trips branch leaves and tolerates older extras files', async () => {
    const store = new SessionExtrasStore(tmpRoot)
    const extras = emptyExtras()
    extras.branchLeaves['a1'] = 'leaf-9'
    await store.save('session-2', extras)

    await expect(store.load('session-2')).resolves.toMatchObject({
      branchLeaves: { a1: 'leaf-9' },
    })

    await fs.writeFile(
      path.join(tmpRoot, 'old.json'),
      JSON.stringify({ version: 1, thinkingDurations: {}, toolEdits: {} }),
      'utf-8'
    )
    await expect(store.load('old')).resolves.toEqual(emptyExtras())
  })

  it('round-trips the structured plan and defaults to null', async () => {
    const store = new SessionExtrasStore(tmpRoot)
    const extras = emptyExtras()
    extras.plan = {
      id: 'plan-1',
      summary: 'Do the thing',
      status: 'approved',
      createdAt: 1,
      updatedAt: 2,
      steps: [{ id: 'step-1', title: 'First', files: ['a.ts'], status: 'in_progress' }],
    }
    await store.save('session-plan', extras)

    const loaded = await store.load('session-plan')
    expect(loaded.plan?.steps[0].title).toBe('First')

    await fs.writeFile(
      path.join(tmpRoot, 'no-plan.json'),
      JSON.stringify({ version: 1, thinkingDurations: {}, toolEdits: {} }),
      'utf-8'
    )
    await expect(store.load('no-plan')).resolves.toEqual(emptyExtras())
  })

  it('ignores corrupt files', async () => {
    const store = new SessionExtrasStore(tmpRoot)
    await fs.writeFile(path.join(tmpRoot, 'broken.json'), '{oops', 'utf-8')
    await expect(store.load('broken')).resolves.toEqual(emptyExtras())
  })
})
