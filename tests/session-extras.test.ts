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

  it('ignores corrupt files', async () => {
    const store = new SessionExtrasStore(tmpRoot)
    await fs.writeFile(path.join(tmpRoot, 'broken.json'), '{oops', 'utf-8')
    await expect(store.load('broken')).resolves.toEqual(emptyExtras())
  })
})
