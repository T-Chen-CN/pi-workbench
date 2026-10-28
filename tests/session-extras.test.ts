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

  it('round-trips thinking durations', async () => {
    const store = new SessionExtrasStore(tmpRoot)
    const extras = emptyExtras()
    extras.thinkingDurations['111'] = [1200, 300]
    await store.save('session-1', extras)

    const loaded = await store.load('session-1')
    expect(loaded.thinkingDurations['111']).toEqual([1200, 300])
  })

  it('drops legacy tool edit contents when loading an old sidecar', async () => {
    const store = new SessionExtrasStore(tmpRoot)
    const target = path.join(tmpRoot, 'legacy.json')
    await fs.writeFile(
      target,
      JSON.stringify({
        version: 1,
        thinkingDurations: {},
        toolEdits: { call: { path: 'a.ts', oldContent: 'old', newContent: 'new' } },
      }),
      'utf-8'
    )

    await store.load('legacy')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const raw = JSON.parse(await fs.readFile(target, 'utf-8'))
    expect(raw).not.toHaveProperty('toolEdits')
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

  it('round-trips the session permission and removes it with the session', async () => {
    const store = new SessionExtrasStore(tmpRoot)
    const extras = emptyExtras()
    extras.permission = { mode: 'ask', grants: ['write'] }
    await store.save('session-perm', extras)

    await expect(store.load('session-perm')).resolves.toMatchObject({
      permission: { mode: 'ask', grants: ['write'] },
    })

    await store.delete('session-perm')
    await expect(store.load('session-perm')).resolves.toEqual(emptyExtras())
    await expect(store.delete('session-perm')).resolves.toBeUndefined()
  })

  it('normalizes invalid stored permissions', async () => {
    const store = new SessionExtrasStore(tmpRoot)
    await fs.writeFile(
      path.join(tmpRoot, 'bad-perm.json'),
      JSON.stringify({ version: 1, permission: { level: 'nonsense', grants: ['write'] } }),
      'utf-8'
    )
    await expect(store.load('bad-perm')).resolves.toMatchObject({
      permission: { mode: 'ask', grants: ['write'] },
    })
  })

  it('round-trips the settled title and drops invalid values', async () => {
    const store = new SessionExtrasStore(tmpRoot)
    const extras = emptyExtras()
    extras.title = 'Fix login redirect'
    await store.save('session-title', extras)
    await expect(store.load('session-title')).resolves.toMatchObject({
      title: 'Fix login redirect',
    })

    for (const [file, payload] of [
      ['numeric', { version: 1, title: 42 }],
      ['blank', { version: 1, title: '   ' }],
      ['missing', { version: 1 }],
    ] as const) {
      await fs.writeFile(path.join(tmpRoot, `${file}.json`), JSON.stringify(payload), 'utf-8')
      await expect(store.load(file)).resolves.toEqual(emptyExtras())
    }
  })

  it('ignores corrupt files', async () => {
    const store = new SessionExtrasStore(tmpRoot)
    await fs.writeFile(path.join(tmpRoot, 'broken.json'), '{oops', 'utf-8')
    await expect(store.load('broken')).resolves.toEqual(emptyExtras())
  })

  it('rejects session ids that could escape the extras directory', async () => {
    const base = path.join(tmpRoot, 'extras')
    await fs.mkdir(base)
    const outside = path.join(tmpRoot, 'outside.json')
    await fs.writeFile(outside, 'keep', 'utf-8')
    const store = new SessionExtrasStore(base)

    await expect(store.delete('../outside')).rejects.toThrow('Invalid session id')
    await expect(store.save('../outside', emptyExtras())).rejects.toThrow('Invalid session id')
    await expect(fs.readFile(outside, 'utf-8')).resolves.toBe('keep')
    await expect(store.load('../outside')).resolves.toEqual(emptyExtras())
  })
})
